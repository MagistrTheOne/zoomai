const fs = require("fs");
const YAML = require("yaml");

/**
 * @typedef {{ id: string, text: string, followups?: string[], required?: boolean, max_seconds?: number }} ScriptQuestion
 */

/**
 * @typedef {{
 *   vacancy: string,
 *   greeting: string,
 *   closing: string,
 *   time_budget_seconds: number,
 *   persona_style: string,
 *   questions: ScriptQuestion[],
 * }} InterviewScript
 */

/**
 * @param {string} filePath
 * @returns {InterviewScript}
 */
function loadScript(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const doc = YAML.parse(raw);
  if (!doc || typeof doc !== "object") {
    throw new Error("Invalid YAML script");
  }
  if (!doc.vacancy || !doc.greeting || !doc.closing) {
    throw new Error("Script must include vacancy, greeting, closing");
  }
  if (!Array.isArray(doc.questions) || doc.questions.length === 0) {
    throw new Error("Script must include questions array");
  }
  doc.time_budget_seconds = Number(doc.time_budget_seconds ?? 900);
  doc.persona_style = String(doc.persona_style || "professional");
  return /** @type {InterviewScript} */ (doc);
}

module.exports = { loadScript };
