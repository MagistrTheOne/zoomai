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

/** EN/RU (and common) accessible names for "unmute mic" in Zoom web client. */
const MIC_UNMUTE_NAME_RE =
  /unmute your microphone|unmute my microphone|\bunmute\b|turn on (?:the )?microphone|включить звук|включить микрофон|включить мик\b/i;

/**
 * Close banners that steal focus (e.g. live transcription / OK).
 * @param {import("playwright-core").Page} page
 * @param {ReturnType<createLogger>} log
 * @param {string} [sessionId]
 */
async function dismissZoomFocusBlockers(page, log, sessionId) {
  const dismissers = [
    page.getByRole("button", { name: /^ok$|^ок$/i }),
    page.getByRole("button", { name: /got it|понятно|пропустить|^да$/i }),
  ];
  for (let round = 0; round < 4; round++) {
    let clicked = false;
    for (const loc of dismissers) {
      try {
        const b = loc.first();
        await b.waitFor({ state: "visible", timeout: 1_200 });
        await b.click({ timeout: 2_000 });
        log.info({ sessionId, round }, "zoom_bot_focus_blocker_dismissed");
        clicked = true;
        await new Promise((r) => setTimeout(r, 350));
        break;
      } catch {
        /* next */
      }
    }
    if (!clicked) break;
  }
}

/**
 * Zoom often joins guests muted. Click Unmute / «Включить звук» so TTS is audible.
 * Tries visible toolbar buttons (DOM order can hide English match on RU UI).
 * @param {import("playwright-core").Page} page
 * @param {ReturnType<createLogger>} log
 * @param {string} [sessionId]
 */
async function ensureMicUnmutedForVoice(page, log, sessionId) {
  await dismissZoomFocusBlockers(page, log, sessionId);

  const candidates = page.getByRole("button", { name: MIC_UNMUTE_NAME_RE });
  let clicked = false;
  let n = 0;
  try {
    await new Promise((r) => setTimeout(r, 400));
    n = await candidates.count();
    for (let i = n - 1; i >= 0; i--) {
      const btn = candidates.nth(i);
      try {
        if (!(await btn.isVisible())) continue;
        await btn.click({ timeout: 4_000 });
        clicked = true;
        log.info({ sessionId, index: i }, "zoom_bot_in_call_unmute_clicked");
        break;
      } catch {
        /* try previous */
      }
    }
    if (!clicked && n > 0) {
      await candidates.first().click({ timeout: 4_000 });
      clicked = true;
      log.info({ sessionId }, "zoom_bot_in_call_unmute_clicked_fallback_first");
    }
  } catch (err) {
    log.warn(
      { sessionId, msg: err?.message, clicked, n },
      "zoom_bot_in_call_mic_unmute_error"
    );
  }
  if (!clicked) {
    log.info({ sessionId, n }, "zoom_bot_in_call_mic_unmute_skipped");
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
 *   agent?: {
 *     preinjectAudio?: (page: import("playwright-core").Page) => Promise<unknown>,
 *     runInCall: (ctx: object) => Promise<unknown>,
 *   },
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
  if (agent && typeof agent.preinjectAudio === "function") {
    await agent.preinjectAudio(page);
  }

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
