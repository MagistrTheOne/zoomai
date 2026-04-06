const { spawn } = require("child_process");
const { execFileSync } = require("child_process");

const FRAME_BYTES = 640;

/**
 * Load PulseAudio null sink + remap source for a session slot. Returns module ids for unload.
 * @param {number} slot
 * @returns {{ sinkModule: number, sourceModule: number, sinkName: string, micName: string }}
 */
function loadPulseModulesForSlot(slot) {
  const sinkName = `nullxes_sink_${slot}`;
  const micName = `nullxes_mic_${slot}`;
  const sinkOut = execFileSync(
    "pactl",
    [
      "load-module",
      "module-null-sink",
      `sink_name=${sinkName}`,
      `sink_properties=device.description=nullxes_${slot}`,
    ],
    { encoding: "utf8" }
  ).trim();
  const sinkModule = Number.parseInt(sinkOut, 10);
  if (Number.isNaN(sinkModule)) {
    throw new Error(`pactl load-module null-sink: unexpected output: ${sinkOut}`);
  }
  const srcOut = execFileSync(
    "pactl",
    [
      "load-module",
      "module-remap-source",
      `master=${sinkName}.monitor`,
      `source_name=${micName}`,
      `source_properties=device.description=nullxes_mic_${slot}`,
    ],
    { encoding: "utf8" }
  ).trim();
  const sourceModule = Number.parseInt(srcOut, 10);
  if (Number.isNaN(sourceModule)) {
    try {
      execFileSync("pactl", ["unload-module", String(sinkModule)]);
    } catch {
      /* ignore */
    }
    throw new Error(`pactl load-module remap-source: unexpected output: ${srcOut}`);
  }
  return {
    sinkModule,
    sourceModule,
    sinkName,
    micName,
  };
}

function unloadPulseModules(sinkModule, sourceModule) {
  try {
    execFileSync("pactl", ["unload-module", String(sourceModule)]);
  } catch {
    /* ignore */
  }
  try {
    execFileSync("pactl", ["unload-module", String(sinkModule)]);
  } catch {
    /* ignore */
  }
}

/**
 * Play raw PCM16 mono 16 kHz into a PulseAudio null sink via pacat.
 * flush() kills pacat and respawns to drop queued audio (barge-in).
 */
class PulseAudioSink {
  /**
   * @param {{ slot: number, ownModules?: boolean }} opts
   */
  constructor(opts) {
    this.slot = opts.slot;
    this.ownModules = opts.ownModules !== false;
    this._mods = loadPulseModulesForSlot(opts.slot);
    this.sinkName = this._mods.sinkName;
    this.micName = this._mods.micName;
    /** @type {import('child_process').ChildProcessWithoutNullStreams | null} */
    this._pacat = null;
    this._spawnPacat();
  }

  _spawnPacat() {
    if (this._pacat) {
      try {
        this._pacat.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      this._pacat = null;
    }
    this._pacat = spawn(
      "pacat",
      [
        "--playback",
        `--device=${this.sinkName}`,
        "--format=s16le",
        "--channels=1",
        "--rate=16000",
      ],
      { stdio: ["pipe", "ignore", "pipe"] }
    );
    this._pacat.stderr?.on("data", () => {});
    this._pacat.on("error", () => {});
  }

  /**
   * @param {Buffer} pcm16Buffer
   */
  write(pcm16Buffer) {
    if (!this._pacat || !this._pacat.stdin) return;
    if (pcm16Buffer.length === 0) return;
    this._pacat.stdin.write(pcm16Buffer);
  }

  flush() {
    this._spawnPacat();
  }

  close() {
    if (this._pacat) {
      try {
        this._pacat.stdin?.end();
      } catch {
        /* ignore */
      }
      try {
        this._pacat.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      this._pacat = null;
    }
    if (this.ownModules) {
      unloadPulseModules(this._mods.sinkModule, this._mods.sourceModule);
    }
  }
}

module.exports = {
  PulseAudioSink,
  loadPulseModulesForSlot,
  unloadPulseModules,
  FRAME_BYTES,
};
