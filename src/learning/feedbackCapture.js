'use strict';

const { classify } = require('../utils/claude');
const { storeMemory } = require('../memory/store');
const { updatePreference } = require('../db');

const CORRECTION_PHRASES = [
  'no that', 'not really', 'actually',
  'thats wrong', "that's wrong",
  'you got that wrong', 'i never said',
  'thats not right', "that's not right",
  'wrong', 'incorrect', 'not what i said',
  'i didnt say', "i didn't say",
];

const POSITIVE_SIGNALS = [
  'omg', 'wait how did you know',
  'thats exactly', "that's exactly",
  'yes exactly', 'love that', 'perfect',
  'lol yes', 'haha yes', 'literally',
  'so true', 'facts', 'exactly right',
  'you know me so well', 'how did you know',
  'wait yes', 'omg yes', 'pls', 'plss',
];

const DISENGAGEMENT_SIGNALS = [
  'ok', 'okay', 'k', 'sure', 'whatever',
  'fine', 'noted', 'got it', 'ok cool',
  'kk', 'yep', 'yup',
];

async function captureConversationFeedback(userId, userMessage, previousAgentMessage) {
  if (!previousAgentMessage) return;

  const lower = userMessage.toLowerCase();
  const wordCount = userMessage.trim().split(/\s+/).length;

  // CHECK 1 — Response length mismatch
  try {
    if (previousAgentMessage.length > 200 && wordCount <= 4) {
      await storeMemory(
        userId,
        'prefers very short responses, gives one-word replies to long messages',
        { type: 'preference', importance: 7, source: 'feedback_capture' }
      );
    }
  } catch { /* silent */ }

  // CHECK 2 — Explicit correction
  try {
    if (CORRECTION_PHRASES.some(p => lower.includes(p))) {
      await storeMemory(
        userId,
        `agent made an error, user corrected: "${userMessage.slice(0, 150)}"`,
        { type: 'preference', importance: 9, source: 'feedback_capture' }
      );
    }
  } catch { /* silent */ }

  // CHECK 3 — Positive reaction
  try {
    if (POSITIVE_SIGNALS.some(s => lower.includes(s))) {
      await storeMemory(
        userId,
        `this type of response landed really well: "${previousAgentMessage.slice(0, 150)}"`,
        { type: 'preference', importance: 7, source: 'feedback_capture' }
      );
    }
  } catch { /* silent */ }

  // CHECK 4 — Disengagement signal
  try {
    const isOnlyDisengagement =
      DISENGAGEMENT_SIGNALS.includes(userMessage.trim().toLowerCase()) &&
      previousAgentMessage.length > 100;
    if (isOnlyDisengagement) {
      await storeMemory(
        userId,
        'user gave dismissive reply to a long message — keep it shorter and more casual',
        { type: 'preference', importance: 6, source: 'feedback_capture' }
      );
    }
  } catch { /* silent */ }

  // CHECK 5 — Question ignored
  try {
    const agentAskedQuestion = previousAgentMessage.includes('?');
    const userAnsweredQuestion = userMessage.length > 15;
    if (agentAskedQuestion && !userAnsweredQuestion) {
      await storeMemory(
        userId,
        'user ignored agent question — ask fewer questions, be more direct',
        { type: 'preference', importance: 6, source: 'feedback_capture' }
      );
    }
  } catch { /* silent */ }

  // CHECK 6 — Engagement spike
  try {
    if (userMessage.length > 200 && previousAgentMessage.length < 100) {
      await storeMemory(
        userId,
        'user opened up and wrote a lot after a short casual message — short messages get more engagement from this person',
        { type: 'preference', importance: 8, source: 'feedback_capture' }
      );
    }
  } catch { /* silent */ }
}

async function captureProactiveFeedback(userId, triggerType, contextHash, userMessage) {
  let parsed;
  try {
    const raw = await classify(
      `Did this person respond positively, negatively, or neutrally to a proactive message?\nPositive = engaged, confirmed, said yes, showed appreciation or interest.\nNegative = said no, ignored, seemed annoyed, asked to stop.\nNeutral = acknowledged without real engagement.\nReturn JSON only: {"sentiment": "positive|negative|neutral", "confidence": 0.0-1.0}\nMessage: ${userMessage}`,
      80
    );
    parsed = JSON.parse(raw.trim());
  } catch {
    return;
  }

  if (!parsed || parsed.confidence < 0.6) return;
  await updatePreference(userId, triggerType, contextHash, parsed.sentiment === 'positive');
}

module.exports = { captureConversationFeedback, captureProactiveFeedback };
