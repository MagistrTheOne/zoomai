const OpenAI = require("openai/index.mjs");
const { createLogger } = require("./logger");

// verify against openai@^4.77

/**
 * @param {{ messages: import('openai/index.mjs').OpenAI.Chat.ChatCompletionMessageParam[], cancel: import('./cancel').CancelToken }} opts
 */
async function* streamReply(opts) {
  const log = createLogger();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY required");
  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_LLM_MODEL || "gpt-4o";

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      opts.cancel.throwIfCancelled();
      const stream = await client.chat.completions.create({
        model,
        messages: opts.messages,
        stream: true,
      });
      for await (const part of stream) {
        opts.cancel.throwIfCancelled();
        const d = part.choices[0]?.delta?.content;
        if (d) yield d;
      }
      return;
    } catch (e) {
      if (e?.code === "CANCELLED") throw e;
      if (attempt === 0) {
        log.warn({ err: String(e) }, "llm stream retry");
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      throw e;
    }
  }
}

module.exports = { streamReply };
