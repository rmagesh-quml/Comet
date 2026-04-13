'use strict';

// ─── Timezone-aware date helpers ──────────────────────────────────────────────
// All helpers accept an IANA timezone string (e.g. 'America/New_York').
// The server runs in UTC on Railway; never rely on new Date().getHours() etc.
// for user-facing logic — always pass the user's timezone.

const DEFAULT_TZ = 'America/New_York';

/**
 * Returns the current hour (0–23) in the given timezone.
 */
function hourInTz(tz = DEFAULT_TZ) {
  const str = new Date().toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false });
  const h = parseInt(str, 10);
  return isNaN(h) ? new Date().getUTCHours() : h % 24;
}

/**
 * Returns the current day-of-week (0=Sun … 6=Sat) in the given timezone.
 */
function dayOfWeekInTz(tz = DEFAULT_TZ) {
  const str = new Date().toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' });
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[str] ?? new Date().getUTCDay();
}

/**
 * Returns today's date string "YYYY-MM-DD" in the given timezone.
 */
function todayInTz(tz = DEFAULT_TZ) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz }); // en-CA gives ISO format
}

/**
 * Returns tomorrow's date string "YYYY-MM-DD" in the given timezone.
 */
function tomorrowInTz(tz = DEFAULT_TZ) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

/**
 * Formats a Date (or ISO string) as a human-readable date in the user's timezone.
 * e.g. "Mon, Apr 14"
 */
function fmtDate(dateOrStr, tz = DEFAULT_TZ) {
  const d = typeof dateOrStr === 'string' ? new Date(dateOrStr) : dateOrStr;
  return d.toLocaleDateString('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Formats a Date (or ISO string) as a human-readable time in the user's timezone.
 * e.g. "10:30 AM"
 */
function fmtTime(dateOrStr, tz = DEFAULT_TZ) {
  const d = typeof dateOrStr === 'string' ? new Date(dateOrStr) : dateOrStr;
  return d.toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Formats as "Mon, Apr 14 at 10:30 AM" in the user's timezone.
 */
function fmtDateTime(dateOrStr, tz = DEFAULT_TZ) {
  return fmtDate(dateOrStr, tz) + ' at ' + fmtTime(dateOrStr, tz);
}

module.exports = { hourInTz, dayOfWeekInTz, todayInTz, tomorrowInTz, fmtDate, fmtTime, fmtDateTime, DEFAULT_TZ };
