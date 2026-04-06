/** @typedef {import('./script').InterviewScript} InterviewScript */

const States = {
  GREETING: "GREETING",
  ASKING: "ASKING",
  LISTENING: "LISTENING",
  FOLLOWUP: "FOLLOWUP",
  NEXT: "NEXT",
  WRAPPING_UP: "WRAPPING_UP",
  CLOSED: "CLOSED",
};

const Events = {
  AGENT_DONE_SPEAKING: "AGENT_DONE_SPEAKING",
  USER_FINAL: "USER_FINAL",
  BARGE_IN: "BARGE_IN",
  TIME_LOW: "TIME_LOW",
  TIME_UP: "TIME_UP",
};

/**
 * @param {string} state
 * @param {string} event
 * @param {{ script: InterviewScript, questionIndex: number }} ctx
 * @returns {{ state: string, action?: string }}
 */
function next(state, event, ctx) {
  const { script, questionIndex } = ctx;
  const nq = script.questions.length;

  if (state === States.CLOSED) {
    return { state: States.CLOSED };
  }

  if (event === Events.TIME_UP) {
    return { state: States.WRAPPING_UP, action: "say_closing" };
  }

  if (event === Events.TIME_LOW) {
    return { state, action: "shorten_replies" };
  }

  if (event === Events.BARGE_IN) {
    return { state: States.LISTENING, action: "interrupt" };
  }

  if (state === States.GREETING && event === Events.AGENT_DONE_SPEAKING) {
    return { state: States.ASKING, action: "ask_question" };
  }

  if (state === States.ASKING && event === Events.AGENT_DONE_SPEAKING) {
    return { state: States.LISTENING, action: "listen" };
  }

  if (state === States.LISTENING && event === Events.USER_FINAL) {
    return { state: States.NEXT, action: "advance_or_followup" };
  }

  if (state === States.FOLLOWUP && event === Events.AGENT_DONE_SPEAKING) {
    return { state: States.LISTENING, action: "listen" };
  }

  if (state === States.NEXT && event === Events.AGENT_DONE_SPEAKING) {
    if (questionIndex + 1 < nq) {
      return { state: States.ASKING, action: "ask_question" };
    }
    return { state: States.WRAPPING_UP, action: "say_closing" };
  }

  if (state === States.WRAPPING_UP && event === Events.AGENT_DONE_SPEAKING) {
    return { state: States.CLOSED, action: "leave" };
  }

  return { state };
}

module.exports = { States, Events, next };
