// zoom-bot.js
const fs = require("fs").promises;
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { chromium } = require("playwright-core");
const {
  BotState,
  toWebClient,
  buildLaunchOptions,
  buildContextOptions,
  findNewText,
} = require("./utils.js");
const {
  startParticipantObserver,
  startCaptionLogging,
  enableCaptions,
} = require("./browser_utils.js");
const { createLogger } = require("../agent/logger");

/**
 * Zoom often joins guests muted. Click Unmute so browser_injection / TTS is audible.
 * @param {import("playwright-core").Page} page
 * @param {ReturnType<createLogger>} log
 * @param {string} [sessionId]
 */
async function ensureMicUnmutedForVoice(page, log, sessionId) {
  const unmute = page.getByRole("button", {
    name: /unmute.*microphone|unmute your microphone|unmute my microphone|^unmute$/i,
  });
  try {
    const btn = unmute.first();
    await btn.waitFor({ state: "visible", timeout: 8_000 });
    await btn.click({ timeout: 4_000 });
    log.info({ sessionId }, "zoom_bot_in_call_unmute_clicked");
  } catch (err) {
    log.info(
      { sessionId, msg: err?.message },
      "zoom_bot_in_call_mic_unmute_skipped"
    );
  }
}

/**
 * @param {string} origUrl
 * @param {string} transcriptPath
 * @param {boolean} headless
 * @param {{
 *   waitRoomLimitMs?: number,
 *   pulseSlot?: number,
 *   sessionId?: string,
 *   cancelToken?: import("../agent/cancel.js").CancelToken,
 *   agent?: { runInCall: (ctx: object) => Promise<unknown> },
 *   displayName?: string,
 * }} [options]
 */
async function runZoomBot(origUrl, transcriptPath, headless, options = {}) {
  const log = createLogger(options.sessionId);
  const waitRoomLimitMs = options.waitRoomLimitMs ?? 5 * 60_000;
  const agent = options.agent;
  const pulseSlot = options.pulseSlot;
  const displayName = options.displayName || "NULLXES AI AGENT BOT";

  let state = BotState.JOINING_CALL;
  const transition = (next) => {
    state = next;
    console.log(`↪  state → ${state}`);
  };

  const browser = await chromium.launch(
    buildLaunchOptions(headless, { pulseSlot })
  );
  const context = await browser.newContext(buildContextOptions(headless));
  await context.route("zoommtg://*", (r) => r.abort());
  const page = await context.newPage();

  // Track caption state per speaker for sliding window deduplication
  const lastTextBySpeaker = new Map();

  // handle extracting captions from the webpage
  page.on("console", async (msg) => {
    if (msg.type() === "log" && msg.text().startsWith("CAPTION: ")) {
      try {
        const jsonStr = msg.text().slice(9);
        const newChunks = JSON.parse(jsonStr);

        const processedChunks = [];

        for (const chunk of newChunks) {
          const { speaker, text, time } = chunk;
          const lastText = lastTextBySpeaker.get(speaker) || "";

          const newText = findNewText(lastText, text);

          if (newText) {
            processedChunks.push({ speaker, text: newText, time });
          }

          lastTextBySpeaker.set(speaker, text);
        }

        if (processedChunks.length > 0) {
          const lines = processedChunks
            .map((c) => JSON.stringify(c))
            .join("\n");
          await fs.appendFile(transcriptPath, lines + "\n");
        }
      } catch (e) {
        console.warn("⚠️  Could not parse or write caption chunk:", e);
      }
    }
  });

  try {
    await page.goto(toWebClient(origUrl), { waitUntil: "domcontentloaded" });

    // Wait up to 60s for the prejoin name field — this is the real "we are on
    // the prejoin page" signal, more reliable than a fixed sleep.
    // Zoom prejoin name field. Multiple strategies because the input has no
    // placeholder and no aria-label — only a sibling <label>Your Name</label>.
    const nameField = page
      .locator(
        [
          'label:has-text("Your Name") + input',
          'label:has-text("Your Name") ~ input',
          'input[type="text"]:visible',
          'input[type="text"][placeholder*="name" i]',
          'input[aria-label*="name" i]',
          'input:visible',
        ].join(', ')
      )
      .first();
    try {
      await nameField.waitFor({ state: "visible", timeout: 60_000 });
      log.info({ sessionId: options.sessionId }, "zoom_bot_prejoin_ready");
    } catch (err) {
      const screenshotPath = `./transcripts/prejoin_failed_${Date.now()}.png`;
      await page
        .screenshot({ path: screenshotPath, fullPage: true })
        .catch(() => {});
      log.error(
        { err: err.message, screenshot: screenshotPath, url: page.url() },
        "zoom_bot_prejoin_not_ready"
      );
      throw err;
    }

    await nameField.fill(displayName);
    log.info(
      { sessionId: options.sessionId, name: options.displayName },
      "zoom_bot_prejoin_name_filled"
    );

    const joinBtn = page.getByRole("button", { name: /^join$/i });
    await joinBtn.waitFor({ state: "visible", timeout: 10_000 });
    await joinBtn.click();
    log.info({ sessionId: options.sessionId }, "zoom_bot_prejoin_join_clicked");

    // Do not click prejoin mic toggles: Zoom labels the button "Mute" when the
    // mic is live — an ambiguous /^mute|unmute$/ click was muting the bot before
    // join. Voice agents need the mic unmuted for real-time TTS.

    // Confirm we're inside the meeting by waiting for the bottom toolbar.
    // The button label depends on camera state ("Stop video" if camera on,
    // "Start video" if camera off). Headless bots usually have no camera.
    try {
      await page
        .locator("button")
        .filter({ hasText: /start video|stop video/i })
        .first()
        .waitFor({ timeout: 30000 });
    } catch (err) {
      const screenshotPath = path.join(
        process.cwd(),
        "transcripts",
        `join_failed_${Date.now()}.png`
      );
      await page
        .screenshot({ path: screenshotPath, fullPage: true })
        .catch(() => {});
      log.error(
        { err: err.message, screenshot: screenshotPath },
        "zoom_bot_join_detect_failed"
      );
      throw err;
    }
    log.info({ sessionId: options.sessionId }, "zoom_bot_inside_meeting");

    // Optional waiting-room handler. If we're already in the meeting (which
    // is the normal case when the host is present), this text never appears
    // and we just continue. Only useful when the host hasn't joined yet.
    let sawWaitingRoomBanner = false;
    try {
      await page
        .locator(
          "text=/waiting for the host|host has joined|will let you in soon/i"
        )
        .waitFor({ state: "visible", timeout: 3_000 });
      sawWaitingRoomBanner = true;
      log.info({ sessionId: options.sessionId }, "zoom_bot_was_in_waiting_room");
    } catch {
      // Not in a waiting room — already inside the meeting. Continue.
    }

    const inMeetingButton = page.getByRole("button", {
      name: /mute my microphone/i,
    });

    if (sawWaitingRoomBanner) {
      transition(BotState.IN_WAITING_ROOM);
      console.log(`⏳  host absent; will wait ${waitRoomLimitMs / 60000} min`);
      await Promise.race([
        inMeetingButton.waitFor({ timeout: waitRoomLimitMs }),
        new Promise((_, rej) =>
          setTimeout(
            () => rej(new Error("waiting_room_timeout")),
            waitRoomLimitMs
          )
        ),
      ]);
      transition(BotState.IN_CALL);
    } else {
      transition(BotState.IN_CALL);
    }

    console.log("✅  inside meeting! hooking into captions...");

    await ensureMicUnmutedForVoice(page, log, options.sessionId);

    // handle extracting captions from the webpage
    await startParticipantObserver(page);
    await enableCaptions(page);
    const transcriptStartTs = Date.now();
    await startCaptionLogging(page, transcriptStartTs);

    const meetingEndLocator = page
      .locator("text=/this meeting has been ended|you have been removed/i")
      .first();

    const meetingEndPromise = meetingEndLocator.waitFor({ timeout: 0 });

    if (agent && typeof agent.runInCall === "function") {
      const ctx = {
        page,
        browser,
        context,
        transcriptPath,
        sessionId: options.sessionId,
        cancelToken: options.cancelToken,
      };
      await Promise.all([meetingEndPromise, agent.runInCall(ctx)]);
    } else {
      await meetingEndPromise;
    }

    transition(BotState.CALL_ENDED);
  } catch (err) {
    if (err.message === "waiting_room_timeout") {
      console.warn("⚠️  host never admitted the bot - exiting");
    } else {
      console.error("💥  unexpected error:", err);
    }
  } finally {
    await browser.close();
    console.log(`🚪  browser closed - final state: ${state}`);
    return state;
  }
}

if (require.main === module) {
  const meetingUrl = process.argv[2];
  const botId = process.argv[3] || uuidv4();

  if (!meetingUrl) {
    console.error("Usage: node zoom_bot.js <meetingUrl> [botId]");
    throw new Error("A Zoom join URL must be provided as the first argument.");
  }

  const transcriptPath = path.join(
    process.cwd(),
    "transcripts",
    `${botId}.jsonl`
  );

  console.log(
    `[bot:${botId}] starting. transcript will be saved to ${transcriptPath}`
  );

  // Headless in container; local debug uses runZoomBot from backend with headless false
  runZoomBot(meetingUrl, transcriptPath, true).catch((err) => {
    console.error(`[bot:${botId}] uncaught error:`, err);
    process.exit(1);
  });
}

module.exports = { runZoomBot };
