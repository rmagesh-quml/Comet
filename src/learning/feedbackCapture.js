'use strict';

const { classify } = require('../utils/claude');
const { storeMemory } = require('../memory/store');
const { updatePreference, query: dbQuery } = require('../db');

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

const FORMAT_BREVITY_REQUESTS = [
  'keep it short', 'shorter', 'tldr', 'tl;dr', 'too long',
  'shorter please', 'be brief', 'in short', 'summarize',
  'just the basics', 'just tell me', 'quick version',
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

  // CHECK 4 — Disengagement signal (raised threshold to 200 chars to reduce false positives)
  try {
    const isOnlyDisengagement =
      DISENGAGEMENT_SIGNALS.includes(userMessage.trim().toLowerCase()) &&
      previousAgentMessage.length > 200;
    if (isOnlyDisengagement) {
      await storeMemory(
        userId,
        'user gave dismissive reply to a long message — keep it shorter and more casual',
        { type: 'preference', importance: 6, source: 'feedback_capture' }
      );
      // Also record a negative format signal
      await updatePreference(userId, 'response_format', 'format', false);
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
      // Positive format signal — short messages work
      await updatePreference(userId, 'response_format', 'format', true);
    }
  } catch { /* silent */ }

  // CHECK 7 — Explicit brevity request
  try {
    const lower = userMessage.toLowerCase();
    if (FORMAT_BREVITY_REQUESTS.some(p => lower.includes(p))) {
      await storeMemory(
        userId,
        `user explicitly asked for shorter responses: "${userMessage.slice(0, 100)}"`,
        { type: 'preference', importance: 9, source: 'feedback_capture' }
      );
      // Strong negative format signal — record 3x to outweigh prior history
      await updatePreference(userId, 'response_format', 'format', false);
      await updatePreference(userId, 'response_format', 'format', false);
      await updatePreference(userId, 'response_format', 'format', false);
    }
  } catch { /* silent */ }

  // CHECK 8 — Repeated short replies to long agent messages (tracked across last 3 turns)
  try {
    const recentResult = await dbQuery(
      `SELECT role, content FROM messages
       WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 6`,
      [userId]
    );
    const turns = recentResult.rows;
    // Count alternating pairs where agent > 150 chars and user ≤ 3 words
    let shortReplyToLongCount = 0;
    for (let i = 0; i + 1 < turns.length; i++) {
      const userTurn = turns[i].role === 'user' ? turns[i] : null;
      const agentTurn = turns[i + 1]?.role === 'assistant' ? turns[i + 1] : null;
      if (userTurn && agentTurn) {
        const userWords = userTurn.content.trim().split(/\s+/).length;
        if (agentTurn.content.length > 150 && userWords <= 3) shortReplyToLongCount++;
      }
    }
    if (shortReplyToLongCount >= 3) {
      await updatePreference(userId, 'response_format', 'format', false);
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
