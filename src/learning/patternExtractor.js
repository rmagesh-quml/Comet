'use strict';

const db = require('../db');
const { classify } = require('../utils/claude');
const { storeMemory } = require('../memory/store');

async function extractInteractionPatterns(userId) {
  let messages;
  try {
    const result = await db.query(
      `SELECT role, content FROM messages
       WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 40`,
      [userId]
    );
    messages = result.rows;
  } catch {
    return;
  }

  if (messages.length < 12) return;

  let parsed;
  try {
    const raw = await classify(
      `Analyze how this person interacts with their AI agent. Look at the full conversation flow.\nReturn JSON only:\n{\n  "respondsWellTo": [],\n  "disengagesFrom": [],\n  "peakEngagementTimes": "",\n  "topicsTheyBringUp": [],\n  "topicsTheyAvoid": [],\n  "communicationRhythm": "",\n  "emotionalPatterns": ""\n}\n\nGuidelines:\nrespondsWellTo: list specific things like 'short casual check-ins' or 'specific actionable suggestions'\ndisengagesFrom: things like 'long explanations' or 'multiple questions'\npeakEngagementTimes: time patterns like 'late night 11pm-1am' or 'morning before class'\ntopicsTheyBringUp: recurring themes\ntopicsTheyAvoid: things they change subject on\ncommunicationRhythm: 'quick back and forth' or 'long gaps between responses' etc\nemotionalPatterns: 'tends to vent before exams' or 'more upbeat on weekends' etc\n\nConversation: ${JSON.stringify(messages)}`,
      500
    );
    parsed = JSON.parse(raw.trim());
  } catch {
    return;
  }

  if (!parsed) return;

  const stores = [];

  if (Array.isArray(parsed.respondsWellTo) && parsed.respondsWellTo.length > 0) {
    stores.push(storeMemory(
      userId,
      `responds well to: ${parsed.respondsWellTo.join(', ')}`,
      { type: 'preference', importance: 8, source: 'pattern_extractor' }
    ).catch(() => {}));
  }

  if (Array.isArray(parsed.disengagesFrom) && parsed.disengagesFrom.length > 0) {
    stores.push(storeMemory(
      userId,
      `disengages from: ${parsed.disengagesFrom.join(', ')}`,
      { type: 'preference', importance: 8, source: 'pattern_extractor' }
    ).catch(() => {}));
  }

  if (parsed.peakEngagementTimes && parsed.peakEngagementTimes.trim()) {
    stores.push(storeMemory(
      userId,
      `most engaged and responsive around: ${parsed.peakEngagementTimes}`,
      { type: 'habit', importance: 7, source: 'pattern_extractor' }
    ).catch(() => {}));
  }

  if (Array.isArray(parsed.topicsTheyBringUp) && parsed.topicsTheyBringUp.length > 0) {
    stores.push(storeMemory(
      userId,
      `frequently brings up: ${parsed.topicsTheyBringUp.join(', ')}`,
      { type: 'preference', importance: 6, source: 'pattern_extractor' }
    ).catch(() => {}));
  }

  if (parsed.emotionalPatterns && parsed.emotionalPatterns.trim()) {
    stores.push(storeMemory(
      userId,
      parsed.emotionalPatterns,
      { type: 'habit', importance: 7, source: 'pattern_extractor' }
    ).catch(() => {}));
  }

  await Promise.all(stores);
}

module.exports = { extractInteractionPatterns };
