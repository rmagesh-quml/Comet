'use strict';

const db = require('../db');
const { classify } = require('../utils/claude');
const cache = require('../utils/cache');

const STYLE_CACHE_TTL = 4320; // 3 days in minutes (was 7 — adapts faster to style changes)

async function analyzeUserStyle(userId) {
  const result = await db.query(
    `SELECT content FROM messages
     WHERE user_id = $1 AND role = 'user'
     ORDER BY created_at DESC LIMIT 50`,
    [userId]
  );
  const messages = result.rows.map(r => r.content);

  if (messages.length < 10) return null;

  const cacheKey = `style:${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let parsed;
  try {
    const raw = await classify(
      `Analyze this person's texting style.\nReturn JSON only, no explanation:\n{\n  "averageLength": "short|medium|long",\n  "casing": "lowercase|mixed|proper",\n  "punctuation": "minimal|normal|heavy",\n  "emoji": "never|sometimes|often",\n  "tone": "casual|neutral|formal",\n  "sharesPersonally": "low|medium|high",\n  "prefersResponses": "brief|conversational|detailed",\n  "commonPatterns": "string (one sentence describing any notable patterns like abbreviations, slang, or unique habits)"\n}\nMessages: ${JSON.stringify(messages)}`,
      300
    );
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }

  cache.set(cacheKey, parsed, STYLE_CACHE_TTL);

  // Persist concrete format preference to user_preferences so brain.js can read it
  // without re-analyzing style on every message.
  if (parsed.prefersResponses === 'brief' && parsed.averageLength === 'short') {
    db.query(
      `INSERT INTO user_preferences (user_id, trigger_type, context_hash, positive_count, total_count, updated_at)
       VALUES ($1, 'response_format', 'format', 1, 1, NOW())
       ON CONFLICT (user_id, trigger_type, context_hash) DO UPDATE SET
         positive_count = user_preferences.positive_count + 1,
         total_count = user_preferences.total_count + 1,
         updated_at = NOW()`,
      [userId]
    ).catch(() => {}); // fire and forget
  }

  return parsed;
}

// ─── Response format hint ─────────────────────────────────────────────────────
// Reads the learned format preference for a user.
// Returns 'brief' | 'detailed' | null.

async function getResponseFormatHint(userId) {
  try {
    const pref = await db.getPreferenceByType(userId, 'response_format');
    if (!pref || pref.total_count < 3) return null; // not enough signal yet
    const rate = pref.positive_count / pref.total_count;
    if (rate >= 0.6) return 'brief';
    if (rate <= 0.3) return 'detailed';
    return null;
  } catch {
    return null;
  }
}

function formatStyleContext(style) {
  if (!style) return '';
  return `Communication style for this person:
They text in ${style.casing} with ${style.punctuation} punctuation and use emoji ${style.emoji}.
They prefer ${style.prefersResponses} responses — match their energy, don't over-explain.
Their tone is ${style.tone}.
${style.commonPatterns}
Mirror this naturally. Don't mention that you're doing it.`;
}

async function getStyleContext(userId) {
  try {
    const style = await analyzeUserStyle(userId);
    return formatStyleContext(style);
  } catch {
    return '';
  }
}

async function refreshStyleCache(userId) {
  cache.clear(`style:${userId}`);
  return analyzeUserStyle(userId);
}

module.exports = { analyzeUserStyle, formatStyleContext, getStyleContext, getResponseFormatHint, refreshStyleCache };
