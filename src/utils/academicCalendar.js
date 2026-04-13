'use strict';

// ─── VT Academic Calendar ─────────────────────────────────────────────────────
// Hard-coded key dates for Virginia Tech. Update each year.
// All dates are ISO strings interpreted as midnight local time.

const CALENDARS = {
  '2024-2025': {
    fallStart:       '2024-08-26',
    fallEnd:         '2024-12-20',
    fallExamsStart:  '2024-12-09',
    fallReadingDay:  '2024-12-07',
    springStart:     '2025-01-13',
    springEnd:       '2025-05-09',
    springExamsStart:'2025-04-28',
    springReadingDay:'2025-04-26',
    breaks: [
      { name: 'Fall Break',        start: '2024-10-14', end: '2024-10-15' },
      { name: 'Thanksgiving Break',start: '2024-11-27', end: '2024-12-01' },
      { name: 'Winter Break',      start: '2024-12-21', end: '2025-01-12' },
      { name: 'Spring Break',      start: '2025-03-08', end: '2025-03-16' },
    ],
  },
  '2025-2026': {
    fallStart:       '2025-08-25',
    fallEnd:         '2025-12-19',
    fallExamsStart:  '2025-12-10',
    fallReadingDay:  '2025-12-09',
    springStart:     '2026-01-12',
    springEnd:       '2026-05-08',
    springExamsStart:'2026-05-01',
    springReadingDay:'2026-04-30',
    breaks: [
      { name: 'Fall Break',        start: '2025-10-11', end: '2025-10-14' },
      { name: 'Thanksgiving Break',start: '2025-11-26', end: '2025-11-30' },
      { name: 'Winter Break',      start: '2025-12-20', end: '2026-01-11' },
      { name: 'Spring Break',      start: '2026-03-07', end: '2026-03-15' },
    ],
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toDate(str) {
  // Parse as local date (not UTC) to avoid timezone shift issues
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function getCalendarForDate(date) {
  const year = date.getFullYear();
  // Academic year: fall starts in August, so year 2025-2026 covers Aug 2025 – May 2026
  const academicYearKey = date.getMonth() >= 7
    ? `${year}-${year + 1}`
    : `${year - 1}-${year}`;
  return CALENDARS[academicYearKey] || null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if the given date falls within a scheduled academic break.
 */
function isOnBreak(date = new Date()) {
  const cal = getCalendarForDate(date);
  if (!cal) return false;
  const d = date.getTime();
  return cal.breaks.some(b => {
    const start = toDate(b.start).getTime();
    const end   = toDate(b.end).getTime() + 86400000; // inclusive end
    return d >= start && d <= end;
  });
}

/**
 * Returns the number of days until the next exam period starts,
 * or null if not currently in an active semester.
 */
function daysUntilExams(date = new Date()) {
  const cal = getCalendarForDate(date);
  if (!cal) return null;

  const candidates = [
    toDate(cal.fallExamsStart),
    toDate(cal.springExamsStart),
  ].filter(d => d > date);

  if (candidates.length === 0) return null;
  const next = candidates.reduce((a, b) => (a < b ? a : b));
  return Math.ceil((next.getTime() - date.getTime()) / 86400000);
}

/**
 * Returns true if we are currently in an exam period.
 */
function isFinalsWeek(date = new Date()) {
  const cal = getCalendarForDate(date);
  if (!cal) return false;
  const d = date.getTime();
  const check = (startStr, endStr) => {
    const start = toDate(startStr).getTime();
    const end   = toDate(endStr).getTime() + 86400000 * 7; // ~1 week of exams
    return d >= start && d <= end;
  };
  return check(cal.fallExamsStart, cal.fallEnd) || check(cal.springExamsStart, cal.springEnd);
}

/**
 * Returns the current week number within the semester (1-based), or null if not in session.
 */
function getCurrentSemesterWeek(date = new Date()) {
  const cal = getCalendarForDate(date);
  if (!cal) return null;
  const d = date.getTime();

  const ranges = [
    { start: toDate(cal.fallStart), end: toDate(cal.fallEnd) },
    { start: toDate(cal.springStart), end: toDate(cal.springEnd) },
  ];

  for (const range of ranges) {
    if (d >= range.start.getTime() && d <= range.end.getTime()) {
      const weekNum = Math.ceil((d - range.start.getTime()) / (7 * 86400000));
      return Math.max(1, weekNum);
    }
  }
  return null;
}

/**
 * Returns the next upcoming break within 30 days, or null.
 * { name: string, daysAway: number }
 */
function getUpcomingBreak(date = new Date()) {
  const cal = getCalendarForDate(date);
  if (!cal) return null;

  const d = date.getTime();
  const horizon = d + 30 * 86400000;

  for (const b of cal.breaks) {
    const start = toDate(b.start).getTime();
    if (start > d && start <= horizon) {
      return {
        name: b.name,
        daysAway: Math.ceil((start - d) / 86400000),
      };
    }
  }
  return null;
}

module.exports = {
  isOnBreak,
  daysUntilExams,
  isFinalsWeek,
  getCurrentSemesterWeek,
  getUpcomingBreak,
};
