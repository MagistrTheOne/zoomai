const { test } = require("node:test");
const assert = require("node:assert/strict");

const originalFetch = global.fetch;

function pcmResponse() {
  const pcm24 = Buffer.alloc(4800);
  return {
    ok: true,
    status: 200,
    async arrayBuffer() {
      return pcm24.buffer.slice(
        pcm24.byteOffset,
        pcm24.byteOffset + pcm24.byteLength
      );
    },
  };
}

test("streamSpeak with instructions sends instructions in JSON body", async () => {
  const bodies = [];
  global.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return pcmResponse();
  };

  try {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_LLM_MODEL = "gpt-4.1-mini";
    process.env.OPENAI_STT_MODEL = "gpt-4o-mini-transcribe";
    process.env.OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
    process.env.OPENAI_TTS_VOICE = "alloy";

    delete require.cache[require.resolve("../src/agent/config")];
    delete require.cache[require.resolve("../src/agent/tts_openai")];
    const { streamSpeak } = require("../src/agent/tts_openai");
    const { CancelToken } = require("../src/agent/cancel");

    async function* textIter() {
      yield "Hello.";
    }

    const cancel = new CancelToken();
    for await (const _ of streamSpeak({
      textIter: textIter(),
      cancel,
      instructions: "be warm and slow",
    })) {
      /* drain */
    }

    assert.ok(bodies.length >= 1);
    assert.equal(bodies[0].instructions, "be warm and slow");
    assert.equal(bodies[0].model, "gpt-4o-mini-tts");
  } finally {
    global.fetch = originalFetch;
  }
});

test("streamSpeak without instructions omits instructions key", async () => {
  const bodies = [];
  global.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return pcmResponse();
  };

  try {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_LLM_MODEL = "gpt-4.1-mini";
    process.env.OPENAI_STT_MODEL = "gpt-4o-mini-transcribe";
    process.env.OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
    process.env.OPENAI_TTS_VOICE = "alloy";

    delete require.cache[require.resolve("../src/agent/config")];
    delete require.cache[require.resolve("../src/agent/tts_openai")];
    const { streamSpeak } = require("../src/agent/tts_openai");
    const { CancelToken } = require("../src/agent/cancel");

    async function* textIter() {
      yield "Hi.";
    }

    const cancel = new CancelToken();
    for await (const _ of streamSpeak({ textIter: textIter(), cancel })) {
      /* drain */
    }

    assert.ok(bodies.length >= 1);
    assert.equal(
      Object.prototype.hasOwnProperty.call(bodies[0], "instructions"),
      false
    );
  } finally {
    global.fetch = originalFetch;
  }
});
