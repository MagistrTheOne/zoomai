const pino = require("pino");

const level = process.env.LOG_LEVEL || "info";

const base = pino({
  level,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * @param {string} [sessionId]
 */
function createLogger(sessionId) {
  if (!sessionId) return base;
  return base.child({ sessionId });
}

module.exports = { createLogger, base };
