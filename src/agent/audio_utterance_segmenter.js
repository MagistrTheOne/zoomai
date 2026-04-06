/**
 * Energy-based VAD: PCM16 mono 16 kHz, 20 ms frames (640 bytes) → utterance PCM buffers.
 */

const FRAME_BYTES = 640;

/**
 * RMS normalized 0..1 for PCM16 little-endian frame
 * @param {Buffer} frame
 */
function frameRmsNorm(frame) {
  if (frame.length < 2) return 0;
  const n = frame.length / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = frame.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / n) / 32768;
}

/**
 * @param {AsyncIterable<Buffer>} frameIter
 * @param {import('./cancel').CancelToken} cancel
 */
async function* segmentUtterances(frameIter, cancel) {
  const threshold = Number(process.env.OPENAI_STT_VAD_RMS_THRESHOLD || 0.015);
  const silenceMs = Number(process.env.OPENAI_STT_SILENCE_MS || 450);
  const minUtteranceMs = Number(process.env.OPENAI_STT_MIN_UTTERANCE_MS || 120);
  const maxUtteranceMs = Number(process.env.OPENAI_STT_MAX_UTTERANCE_MS || 28000);

  const silenceFrames = Math.ceil(silenceMs / 20);
  const minFrames = Math.ceil(minUtteranceMs / 20);
  const maxFrames = Math.floor(maxUtteranceMs / 20);

  let buf = Buffer.alloc(0);
  let speechActive = false;
  let silenceRun = 0;
  let framesInUtterance = 0;
  let pending = Buffer.alloc(0);

  for await (const chunk of frameIter) {
    cancel.throwIfCancelled();
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= FRAME_BYTES) {
      const frame = pending.subarray(0, FRAME_BYTES);
      pending = pending.subarray(FRAME_BYTES);

      const rms = frameRmsNorm(frame);
      const speech = rms >= threshold;

      if (!speechActive) {
        if (speech) {
          speechActive = true;
          buf = Buffer.from(frame);
          framesInUtterance = 1;
          silenceRun = 0;
        }
        continue;
      }

      buf = Buffer.concat([buf, frame]);
      framesInUtterance += 1;

      if (speech) {
        silenceRun = 0;
      } else {
        silenceRun += 1;
      }

      const hitMax = framesInUtterance >= maxFrames;
      const hitSilence =
        silenceRun >= silenceFrames && framesInUtterance >= minFrames;

      if (hitMax || hitSilence) {
        if (buf.length >= minFrames * FRAME_BYTES) {
          yield buf;
        }
        buf = Buffer.alloc(0);
        speechActive = false;
        silenceRun = 0;
        framesInUtterance = 0;
      }
    }
  }

  if (buf.length >= minFrames * FRAME_BYTES) {
    yield buf;
  }
}

module.exports = {
  segmentUtterances,
  frameRmsNorm,
  FRAME_BYTES,
};
