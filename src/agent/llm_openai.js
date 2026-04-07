const { OpenAI } = require("openai");
const { getResolvedModels } = require("./config");

// verify against openai@^4.77

/**
 * @param {{ messages: import('openai').OpenAI.Chat.ChatCompletionMessageParam[], cancel: import('./cancel').CancelToken }} opts
 */
async function* streamReply(opts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY required");
  const client = new OpenAI({ apiKey });
  const { llm: model } = getResolvedModels();

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
}

module.exports = { streamReply };
