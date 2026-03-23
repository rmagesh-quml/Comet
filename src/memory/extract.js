'use strict';

const db = require('../db');
const { classify } = require('../utils/claude');
const { storeMemory } = require('./store');

const VALID_TYPES = new Set([
  'habit', 'preference', 'goal', 'relationship',
  'academic', 'social', 'financial', 'health_pattern',
]);

async function nightlyExtraction(userId) {
  let messages;
  try {
    messages = await db.getTodaysMessages(userId);
  } catch (err) {
    console.error(`nightlyExtraction DB error for user ${userId}:`, err.message || err);
    return;
  }

  if (!messages || messages.length < 4) return;

  const prompt = `Extract important facts and patterns from these messages for future reference.
Return ONLY valid JSON array, no other text.
Each item:
  text: one clear sentence
  type: habit|preference|goal|relationship|academic|social|financial|health_pattern
  importance: integer 1-10
Only include importance >= 6. Max 8 items.
Focus on: recurring behaviors, stated preferences, goals, relationship context, academic stress, financial patterns.
Messages: ${JSON.stringify(messages.map(m => ({ role: m.role, content: m.content })))}`;

  let raw;
  try {
    raw = await classify(prompt, 400);
  } catch (err) {
    console.error(`nightlyExtraction classify error for user ${userId}:`, err.message || err);
    return;
  }

  let memories;
  try {
    memories = JSON.parse(raw.trim());
  } catch (err) {
    console.error(`nightlyExtraction JSON parse error for user ${userId}:`, err.message || err);
    return;
  }

  if (!Array.isArray(memories)) {
    console.error(`nightlyExtraction: expected array for user ${userId}, got ${typeof memories}`);
    return;
  }

  for (const mem of memories) {
    if (!mem || typeof mem !== 'object') continue;
    if (!mem.text || typeof mem.text !== 'string') continue;
    if (!Number.isInteger(mem.importance) || mem.importance < 6) continue;

    const type = VALID_TYPES.has(mem.type) ? mem.type : 'preference';

    try {
      await storeMemory(userId, mem.text.trim(), {
        type,
        importance: mem.importance,
        source: 'nightly_extraction',
      });
    } catch (err) {
      console.error(`nightlyExtraction storeMemory error for user ${userId}:`, err.message || err);
    }
  }
}

module.exports = { nightlyExtraction };
