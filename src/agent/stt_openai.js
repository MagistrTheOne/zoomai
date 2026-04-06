const WebSocket = require("ws");
const OpenAI = require("openai/index.mjs");
const fs = require("fs");
const fsp = require("fs").promises;
const os = require("os");
const path = require("path");
const { createLogger } = require("./logger");
const { segmentUtterances } = require("./audio_utterance_segmenter");
const {
  interpretTranscriptionStreamEvent,
  appendSseChunk,
} = require("./stt_transcription_sse");
const { resolveSttMode, getSttModel } = require("./config");

/**
 * @param {Buffer} pcm16 mono 16kHz
 * @returns {Buffer}
 */
function pcm16ToWav(pcm16) {
  const numChannels = 1;
  const sampleRate = 16000;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm16.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm16]);
}

/**
 * @param {import('stream/web').ReadableStream<Uint8Array>} body
 * @param {import('./cancel').CancelToken} cancel
 * @param {{ accumulated: string }} state
 * @param {(t: string) => void} [onPartial]
 * @param {ReturnType<typeof createLogger>} log
 */
async function* parseSseResponseBody(body, cancel, state, onPartial, log) {
  const decoder = new TextDecoder();
  let carry = "";
  const reader = body.getReader();
  try {
    while (true) {
      cancel.throwIfCancelled();
      const { done, value } = await reader.read();
      if (done) break;
      const decoded = decoder.decode(value, { stream: true });
      const { lines, carry: next } = appendSseChunk(carry, decoded);
      carry = next;
      for (const line of lines) {
        yield* processSseDataLine(line, state, onPartial, log);
      }
    }
    if (carry.trim()) {
      const { lines } = appendSseChunk(carry, "\n");
      for (const line of lines) {
        yield* processSseDataLine(line, state, onPartial, log);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string} line
 * @param {{ accumulated: string }} state
 * @param {(t: string) => void} [onPartial]
 * @param {ReturnType<typeof createLogger>} log
 */
function* processSseDataLine(line, state, onPartial, log) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return;
  if (!trimmed.startsWith("data:")) return;
  const raw = trimmed.slice(5).trim();
  if (raw === "[DONE]") return;
  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    return;
  }
  const out = interpretTranscriptionStreamEvent(evt, state);
  if (out.kind === "partial") {
    if (onPartial) onPartial(out.text);
    yield {
      text: out.text,
      isFinal: false,
      tStart: undefined,
      tEnd: undefined,
    };
  } else if (out.kind === "final") {
    yield {
      text: out.text,
      isFinal: true,
      confidence: 1,
      tStart: undefined,
      tEnd: undefined,
    };
  }
}

/**
 * @param {Buffer} pcm16
 * @param {{ model: string, apiKey: string, cancel: import('./cancel').CancelToken, onPartial?: (t: string) => void, log: ReturnType<typeof createLogger>, vadSpeechEndMs: number }} opts
 */
async function* transcribeOneUtteranceHttpStream(pcm16, opts) {
  const { model, apiKey, cancel, onPartial, log, vadSpeechEndMs } = opts;
  const wav = pcm16ToWav(pcm16);
  const blob = new Blob([wav], { type: "audio/wav" });
  const form = new FormData();
  form.append("file", blob, "utterance.wav");
  form.append("model", model);
  form.append("stream", "true");
  form.append("response_format", "json");

  const ac = new AbortController();
  const unsub = cancel.subscribe(() => ac.abort());
  try {
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: ac.signal,
    });
    if (!res.ok) {
      const t = await res.text();
      log.warn(
        { status: res.status, body: t.slice(0, 500) },
        "transcription HTTP error"
      );
      throw new Error(`transcription HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    if (!res.body) {
      throw new Error("transcription response has no body");
    }
    const state = { accumulated: "" };
    for await (const seg of parseSseResponseBody(
      res.body,
      cancel,
      state,
      onPartial,
      log
    )) {
      if (seg.isFinal) {
        yield {
          ...seg,
          vadSpeechEndMs,
          sttFinalMs: Date.now(),
        };
      } else {
        yield seg;
      }
    }
  } finally {
    unsub();
  }
}

/**
 * @param {AsyncIterable<Buffer>} frameIter
 * @param {{ cancel: import('./cancel').CancelToken, sessionId?: string, onPartial?: (t: string) => void }} opts
 */
async function* streamTranscribeHttpStream(frameIter, opts) {
  const log = createLogger(opts.sessionId);
  const cancel = opts.cancel;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for STT");
  }
  const model = getSttModel();

  for await (const utterancePcm of segmentUtterances(frameIter, cancel)) {
    cancel.throwIfCancelled();
    const vadSpeechEndMs = Date.now();
    yield* transcribeOneUtteranceHttpStream(utterancePcm, {
      model,
      apiKey,
      cancel,
      onPartial: opts.onPartial,
      log,
      vadSpeechEndMs,
    });
  }
}

/**
 * @param {AsyncIterable<Buffer>} frameIter PCM16 20ms frames
 * @param {{ cancel: import('./cancel').CancelToken, sessionId?: string, onPartial?: (t: string) => void }} opts
 * @returns {AsyncGenerator<{ text: string, isFinal: boolean, confidence?: number, tStart?: number, tEnd?: number }>}
 */
async function* streamTranscribe(frameIter, opts) {
  const log = createLogger(opts.sessionId);
  const cancel = opts.cancel;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for STT");
  }

  const mode = resolveSttMode();
  const model = getSttModel();

  if (mode === "realtime_ws") {
    yield* streamTranscribeRealtime(frameIter, {
      cancel,
      model,
      sessionId: opts.sessionId,
      onPartial: opts.onPartial,
    });
    return;
  }

  if (mode === "whisper_chunked") {
    const openai = new OpenAI({ apiKey });
    log.info(
      "STT using whisper_chunked (set STT_MODE=http_stream for default streaming HTTP)"
    );
    yield* streamTranscribeWhisperChunks(openai, frameIter, cancel, opts.sessionId);
    return;
  }

  if (mode === "http_stream") {
    log.info("STT using http_stream (VAD + POST /v1/audio/transcriptions stream=true)");
    yield* streamTranscribeHttpStream(frameIter, opts);
    return;
  }

  throw new Error(`unhandled STT_MODE: ${mode}`);
}

async function* streamTranscribeRealtime(frameIter, opts) {
  const { cancel, model, onPartial } = opts;
  const apiKey = process.env.OPENAI_API_KEY;
  const realtimeModel = process.env.OPENAI_REALTIME_MODEL?.trim();
  if (!realtimeModel) {
    throw new Error("OPENAI_REALTIME_MODEL is required for STT_MODE=realtime_ws");
  }

  const wsUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    realtimeModel
  )}`;

  const ws = new WebSocket(wsUrl, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  ws.send(
    JSON.stringify({
      type: "session.update",
      session: {
        input_audio_format: "pcm16",
        input_audio_transcription: { model },
      },
    })
  );

  const inbox = [];
  let inboxResolver = null;
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (inboxResolver) {
      inboxResolver(msg);
      inboxResolver = null;
    } else {
      inbox.push(msg);
    }
  });

  async function recv() {
    if (inbox.length) return inbox.shift();
    return new Promise((r) => {
      inboxResolver = r;
    });
  }

  let sendDone = false;
  const sendErr = { e: null };
  const sender = (async () => {
    try {
      for await (const frame of frameIter) {
        cancel.throwIfCancelled();
        ws.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: frame.toString("base64"),
          })
        );
      }
    } catch (e) {
      sendErr.e = e;
    } finally {
      sendDone = true;
      try {
        ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      } catch {
        /* ignore */
      }
    }
  })();

  try {
    while (!cancel.cancelled) {
      const msg = await Promise.race([
        recv(),
        new Promise((r) => setTimeout(() => r(null), 250)),
      ]);
      if (sendErr.e) throw sendErr.e;
      if (!msg) {
        if (sendDone && inbox.length === 0) break;
        continue;
      }
      const t = msg.type;
      if (
        t === "conversation.item.input_audio_transcription.delta" &&
        msg.delta
      ) {
        if (onPartial) onPartial(msg.delta);
        yield {
          text: msg.delta,
          isFinal: false,
          tStart: undefined,
          tEnd: undefined,
        };
      }
      if (
        t === "conversation.item.input_audio_transcription.completed" &&
        msg.transcript
      ) {
        yield {
          text: msg.transcript,
          isFinal: true,
          confidence: 1,
          tStart: undefined,
          tEnd: undefined,
        };
      }
      if (t === "error") {
        throw new Error(msg.error?.message || "realtime error");
      }
    }
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    await sender.catch(() => {});
  }
}

async function* streamTranscribeWhisperChunks(openai, frameIter, cancel, sessionId) {
  const log = createLogger(sessionId);
  let buffer = Buffer.alloc(0);
  const chunkMs = Number(process.env.OPENAI_STT_CHUNK_MS || 1500);
  const bytesPerMs = 32;
  const targetBytes = chunkMs * bytesPerMs;
  const whisperModel = process.env.OPENAI_STT_WHISPER_MODEL?.trim();
  if (!whisperModel) {
    throw new Error(
      "OPENAI_STT_WHISPER_MODEL is required for STT_MODE=whisper_chunked"
    );
  }

  for await (const frame of frameIter) {
    cancel.throwIfCancelled();
    buffer = Buffer.concat([buffer, frame]);
    while (buffer.length >= targetBytes) {
      const chunk = buffer.subarray(0, targetBytes);
      buffer = buffer.subarray(targetBytes);
      const vadSpeechEndMs = Date.now();
      const wav = pcm16ToWav(chunk);
      const f = path.join(
        os.tmpdir(),
        `stt-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`
      );
      await fsp.writeFile(f, wav);
      try {
        const tr = await openai.audio.transcriptions.create({
          file: fs.createReadStream(f),
          model: whisperModel,
        });
        if (tr.text && tr.text.trim()) {
          yield {
            text: tr.text.trim(),
            isFinal: true,
            confidence: 1,
            tStart: undefined,
            tEnd: undefined,
            vadSpeechEndMs,
            sttFinalMs: Date.now(),
          };
        }
      } catch (e) {
        log.error({ err: String(e) }, "whisper chunk failed");
        throw e;
      } finally {
        try {
          await fsp.unlink(f);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

module.exports = {
  streamTranscribe,
  pcm16ToWav,
  parseSseResponseBody,
  processSseDataLine,
};
