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

    // mute audio, hide video
    await page.waitForTimeout(4000); // wait for buttons to load
    await page.getByRole("button", { name: /mute/i }).click();
    await page.getByRole("button", { name: /stop video/i }).click();

    await page.getByRole("textbox", { name: /your name/i }).fill(displayName);

    await page.keyboard.press("Enter");

    // waiting room behavior
    const waitingBanner = page.locator(
      "text=/waiting for the host|host has joined|will let you in soon/i"
    );
    const inMeetingButton = page.getByRole("button", {
      name: /mute my microphone/i,
    });

    // bot will either join immediately or be placed in the waiting room
    transition(
      await Promise.race([
        waitingBanner
          .waitFor({ timeout: 15_000 })
          .then(() => BotState.IN_WAITING_ROOM),
        inMeetingButton
          .waitFor({ timeout: 15_000 })
          .then(() => BotState.IN_CALL),
      ])
    );

    // start waiting room timeout if we're in the waiting room
    if (state === BotState.IN_WAITING_ROOM) {
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
    }

    console.log("✅  inside meeting! hooking into captions...");

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
