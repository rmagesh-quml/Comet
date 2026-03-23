'use strict';

const db = require('../db');
const { classify } = require('../utils/claude');

const DAY_ABBREVS = {
  0: 'Su', // Sunday
  1: 'M',
  2: 'T',
  3: 'W',
  4: 'Th',
  5: 'F',
  6: 'Sa',
};

async function storeClassSchedule(userId, rawText) {
  const prompt = `Parse this class schedule into a JSON array. Each object must have:
- name: course name (string)
- days: array of day abbreviations from [M, T, W, Th, F, Sa, Su]
- startTime: "HH:MM" in 24-hour format
- endTime: "HH:MM" in 24-hour format
- location: room/building (string or null)
- professor: instructor name (string or null)

Schedule text:
${rawText}

Respond with a JSON array only, no other text.`;

  try {
    const raw = await classify(prompt, 400);
    const parsed = JSON.parse(raw.trim());
    if (!Array.isArray(parsed)) throw new Error('not an array');
    await db.updateUser(userId, { class_schedule: parsed });
    return parsed;
  } catch (err) {
    console.error(`storeClassSchedule error for user ${userId}:`, err.message || err);
    return [];
  }
}

async function getClassSchedule(userId) {
  const user = await db.getUserById(userId);
  return user?.class_schedule || [];
}

async function isInClass(userId, dateTime = new Date()) {
  const schedule = await getClassSchedule(userId);
  if (!schedule || schedule.length === 0) return false;

  const dayAbbrev = DAY_ABBREVS[dateTime.getDay()];
  const hours = String(dateTime.getHours()).padStart(2, '0');
  const minutes = String(dateTime.getMinutes()).padStart(2, '0');
  const timeStr = `${hours}:${minutes}`;

  return schedule.some(cls => {
    if (!cls.days || !cls.startTime || !cls.endTime) return false;
    if (!cls.days.includes(dayAbbrev)) return false;
    // Half-open interval: startTime <= time < endTime
    return timeStr >= cls.startTime && timeStr < cls.endTime;
  });
}

async function getFreeBlocksToday(userId, date = new Date()) {
  const schedule = await getClassSchedule(userId);

  const dayAbbrev = DAY_ABBREVS[date.getDay()];
  const todaysClasses = (schedule || [])
    .filter(cls => cls.days && cls.days.includes(dayAbbrev) && cls.startTime && cls.endTime)
    .sort((a, b) => (a.startTime < b.startTime ? -1 : 1));

  const DAY_START = '08:00';
  const DAY_END = '22:00';
  const MIN_BLOCK = 45; // minutes

  function toMinutes(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }

  function toHHMM(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  const blocks = [];
  let cursor = toMinutes(DAY_START);
  const end = toMinutes(DAY_END);

  for (const cls of todaysClasses) {
    const clsStart = toMinutes(cls.startTime);
    const clsEnd = toMinutes(cls.endTime);

    if (clsStart > cursor) {
      const duration = clsStart - cursor;
      if (duration >= MIN_BLOCK) {
        blocks.push({ start: toHHMM(cursor), end: toHHMM(clsStart), durationMins: duration });
      }
    }
    cursor = Math.max(cursor, clsEnd);
  }

  // Gap from last class to end of day
  if (end > cursor) {
    const duration = end - cursor;
    if (duration >= MIN_BLOCK) {
      blocks.push({ start: toHHMM(cursor), end: toHHMM(end), durationMins: duration });
    }
  }

  return blocks;
}

module.exports = { storeClassSchedule, getClassSchedule, isInClass, getFreeBlocksToday };
