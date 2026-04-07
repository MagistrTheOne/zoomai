const { PulseAudioSink } = require("./audio_sink_pulse");
const { BrowserAudioSink } = require("./audio_sink_browser");

/**
 * @typedef {'virtual_mic' | 'browser_injection'} AudioOutMode
 */

/**
 * @param {AudioOutMode | string} mode
 * @param {{
 *   slot?: number,
 *   page?: import('playwright-core').Page,
 *   log?: ReturnType<typeof import('./logger').createLogger>,
 * }} ctx
 * @returns {PulseAudioSink | BrowserAudioSink}
 */
function createAudioSink(mode, ctx) {
  const m = mode || process.env.AUDIO_OUT_MODE || "browser_injection";
  if (m === "virtual_mic") {
    const slot = ctx.slot ?? 0;
    return new PulseAudioSink({ slot, ownModules: true, log: ctx.log });
  }
  if (m === "browser_injection") {
    if (!ctx.page) {
      throw new Error("browser_injection mode requires ctx.page");
    }
    return new BrowserAudioSink({ page: ctx.page });
  }
  throw new Error(`Unknown AUDIO_OUT_MODE: ${m}`);
}

module.exports = { createAudioSink };
