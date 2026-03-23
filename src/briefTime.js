'use strict';

const db = require('./db');

// ─── Class schedule helpers ───────────────────────────────────────────────────

const DAY_ABBREVS = {
  0: 'Su', 1: 'M', 2: 'T', 3: 'W', 4: 'Th', 5: 'F', 6: 'Sa',
};

/**
 * Returns the start hour (24h) of the earliest class on the given date,
 * or null if no classes that day.
 */
async function getEarliestClassHour(userId, date) {
  const user = await db.getUserById(userId);
  if (!user || !user.class_schedule) return null;

  const schedule = Array.isArray(user.class_schedule) ? user.class_schedule : [];
  if (schedule.length === 0) return null;

  const dayAbbrev = DAY_ABBREVS[date.getDay()];

  let earliest = null;
  for (const cls of schedule) {
    if (!cls.days || !cls.days.includes(dayAbbrev)) continue;
    if (!cls.startTime) continue;
    const [h] = cls.startTime.split(':').map(Number);
    if (earliest === null || h < earliest) earliest = h;
  }

  return earliest;
}

/**
 * Returns the effective brief hour for a user today:
 * - If there's a class before preferred_brief_hour + 1, use max(6, classHour - 1)
 * - Otherwise use preferred_brief_hour (default 9)
 */
async function getEffectiveBriefHour(userId) {
  const { hour: preferred } = await db.getBriefHour(userId);
  const today = new Date();
  const earliestClass = await getEarliestClassHour(userId, today);

  if (earliestClass !== null && earliestClass <= preferred) {
    // Class starts at or before our preferred time — send brief 1h earlier
    const effectiveHour = Math.max(6, earliestClass - 1);
    return effectiveHour;
  }

  return preferred;
}

/**
 * Parse a time string from the user during onboarding.
 * Accepts: "8am", "8:30am", "9", "21:00", "9:30 am"
 * Returns { hour, minute } in 24h, or null if unparseable.
 */
function parseBriefTime(text) {
  const lower = text.toLowerCase().trim();

  // Match patterns like "8am", "8:30am", "8:30 am", "8 am"
  const ampm = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (ampm) {
    let hour = parseInt(ampm[1], 10);
    const minute = ampm[2] ? parseInt(ampm[2], 10) : 0;
    const period = ampm[3];
    if (period === 'pm' && hour !== 12) hour += 12;
    if (period === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }

  // Match bare number like "9" or "09"
  const bare = lower.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (bare) {
    const hour = parseInt(bare[1], 10);
    const minute = bare[2] ? parseInt(bare[2], 10) : 0;
    return { hour, minute };
  }

  return null;
}

module.exports = { getEarliestClassHour, getEffectiveBriefHour, parseBriefTime };
