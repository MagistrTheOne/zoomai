/**
 * OpenAI audio/transcriptions streaming (SSE) — event interpretation for tests and runtime.
 * Events: transcript.text.delta, transcript.text.done (see OpenAI API reference).
 */

/**
 * @param {object} evt Parsed JSON from `data: {...}` line
 * @param {{ accumulated: string }} state Mutated accumulator for current utterance
 * @returns {{ kind: 'partial', text: string } | { kind: 'final', text: string } | { kind: 'skip' }}
 */
function interpretTranscriptionStreamEvent(evt, state) {
  if (!evt || typeof evt !== "object") {
    return { kind: "skip" };
  }
  const type = evt.type;
  if (type === "transcript.text.delta") {
    const delta =
      typeof evt.delta === "string"
        ? evt.delta
        : typeof evt.text === "string"
          ? evt.text
          : "";
    state.accumulated += delta;
    return { kind: "partial", text: state.accumulated };
  }
  if (type === "transcript.text.done") {
    const text =
      typeof evt.text === "string" ? evt.text : state.accumulated;
    state.accumulated = "";
    return { kind: "final", text };
  }
  return { kind: "skip" };
}

/**
 * Split SSE buffer into complete lines; keep incomplete tail in `carry`.
 * @param {string} carry
 * @param {string} chunk
 * @returns {{ lines: string[], carry: string }}
 */
function appendSseChunk(carry, chunk) {
  const s = carry + chunk;
  const parts = s.split(/\r?\n/);
  const carryOut = parts.pop() ?? "";
  return { lines: parts, carry: carryOut };
}

module.exports = {
  interpretTranscriptionStreamEvent,
  appendSseChunk,
};
