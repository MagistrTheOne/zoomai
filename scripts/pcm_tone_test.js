/**
 * Manual verification: 1 kHz sine, PCM16 mono 16 kHz, 20 ms frames into PulseAudioSink.
 * Run inside Linux container with AUDIO_OUT_MODE=virtual_mic after joining Zoom with that mic.
 *
 *   node scripts/pcm_tone_test.js [slot]
 */
const { PulseAudioSink } = require("../src/agent/audio_sink_pulse");

const SR = 16000;
const FRAME_SAMPLES = 320;
const DURATION_SEC = 2;
const FREQ = 1000;
const slot = Number.parseInt(process.argv[2] || "0", 10);

function frameAt(index) {
  const buf = Buffer.alloc(FRAME_SAMPLES * 2);
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const t = (index * FRAME_SAMPLES + i) / SR;
    const s = Math.sin(2 * Math.PI * FREQ * t) * 0.2;
    const v = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
    buf.writeInt16LE(v, i * 2);
  }
  return buf;
}

async function main() {
  const sink = new PulseAudioSink({ slot, ownModules: true });
  const frames = Math.floor((DURATION_SEC * SR) / FRAME_SAMPLES);
  for (let f = 0; f < frames; f++) {
    sink.write(frameAt(f));
    await new Promise((r) => setTimeout(r, 20));
  }
  sink.close();
  console.log("pcm_tone_test: done", { slot, frames });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
