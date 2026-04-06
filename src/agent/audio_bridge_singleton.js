const { AudioCaptureBridge } = require("./audio_capture_bridge");

let bridge = null;
let startPromise = null;

/**
 * @returns {Promise<AudioCaptureBridge>}
 */
async function getOrCreateAudioBridge() {
  if (bridge) return bridge;
  if (!startPromise) {
    const port = Number(process.env.AUDIO_CAPTURE_WS_PORT || 47001);
    bridge = new AudioCaptureBridge({ port, host: "127.0.0.1" });
    startPromise = bridge.start().then(() => bridge);
  }
  return startPromise;
}

function getBridgePort() {
  return Number(process.env.AUDIO_CAPTURE_WS_PORT || 47001);
}

module.exports = { getOrCreateAudioBridge, getBridgePort };
