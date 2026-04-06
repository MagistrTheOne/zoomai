/**
 * Bounded conversation memory + structured answers per question id.
 */
class InterviewMemory {
  constructor() {
    /** @type {{ role: string, content: string }[]} */
    this.turns = [];
    /** @type {Record<string, string>} */
    this.answersByQuestionId = {};
    this.maxTurns = 20;
  }

  /**
   * @param {string} role
   * @param {string} content
   */
  push(role, content) {
    this.turns.push({ role, content });
    while (this.turns.length > this.maxTurns) {
      this.turns.shift();
    }
  }

  /**
   * @param {string} questionId
   * @param {string} answer
   */
  recordAnswer(questionId, answer) {
    this.answersByQuestionId[questionId] = answer;
  }

  snapshot() {
    return {
      turns: [...this.turns],
      answersByQuestionId: { ...this.answersByQuestionId },
    };
  }
}

module.exports = { InterviewMemory };
