'use strict';

const db = require('./db');
const { classify, generateUserMessage } = require('./utils/claude');
const { sendMessage, sendTypingIndicator, sendReaction, sendMultiple } = require('./sms');
const { isInClass, getFreeBlocksToday, getClassSchedule } = require('./integrations/schedule');
const { getWeeklySnapshot, detectGradeChanges, getUpcomingAssignments } = require('./integrations/canvas');
const { getTodaysEvents, getUpcomingEvents } = require('./integrations/outlook');
const { getGoogleCalendarEvents } = require('./integrations/gmail');
const { getMoodContext } = require('./integrations/spotify');
const { getTodaysForecast } = require('./integrations/weather');
const { isOnBreak } = require('./utils/academicCalendar');
const { hourInTz, dayOfWeekInTz, tomorrowInTz, fmtDate, fmtTime } = require('./utils/timezone');

// ─── Retry helper ─────────────────────────────────────────────────────────────
// Retries an async fn up to `retries` times with exponential backoff.
// Throws on final failure so callers can decide how to handle it.

async function withRetry(fn, retries = 2, baseDelayMs = 800) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, attempt)));
    }
  }
}

// ─── Context key hashing (djb2) ───────────────────────────────────────────────

function hashContextKey(key) {
  if (!key) return 'default';
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) + hash) ^ key.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(36);
}

// ─── Confidence gate ──────────────────────────────────────────────────────────

async function shouldSendProactive(userId, triggerType, contextKey = '', opts = {}) {
  // opts.force bypasses all gates (for admin/testing only)
  if (opts.force) {
    const contextHash = hashContextKey(contextKey);
    return { send: true, contextHash };
  }

  // Hard block: quiet hours (10pm–8am) in the user's local timezone
  const userRecord = await db.getUserById(userId);
  const tz = userRecord?.timezone || 'America/New_York';
  const hour = hourInTz(tz);
  if (hour < 8 || hour >= 22) {
    return { send: false, reason: 'quiet_hours' };
  }

  // Hard block: user is in class
  const inClass = await isInClass(userId);
  if (inClass) {
    return { send: false, reason: 'in_class' };
  }

  // Hard block: already sent this triggerType today
  const alreadySent = await db.hasSentProactiveTriggerToday(userId, triggerType);
  if (alreadySent) {
    return { send: false, reason: 'already_sent_today' };
  }

  // Hard block: total proactive messages today >= 8 (unless important email)
  if (!opts.skipDailyLimit) {
    const totalToday = await db.getProactiveCountToday(userId);
    if (totalToday >= 8) {
      return { send: false, reason: 'daily_limit' };
    }
  }

  // Preference check with time-decay: recent feedback (14 days) weighted 2x
  const contextHash = hashContextKey(contextKey);
  const [pref, recentPref] = await Promise.all([
    db.getPreference(userId, triggerType, contextHash),
    db.query(
      `SELECT positive_count, total_count FROM user_preferences
       WHERE user_id = $1 AND trigger_type = $2 AND context_hash = $3
         AND updated_at >= NOW() - INTERVAL '14 days'`,
      [userId, triggerType, contextHash]
    ).then(r => r.rows[0] || null).catch(() => null),
  ]);

  if (pref && pref.total_count >= 5) {
    // Weight recent feedback 2x
    const allPos   = pref.positive_count   + (recentPref ? recentPref.positive_count   : 0);
    const allTotal = pref.total_count      + (recentPref ? recentPref.total_count      : 0);
    const positiveRate = allPos / allTotal;
    if (positiveRate < 0.4) {
      await db.logSentMessage(userId, `proactive:${triggerType}:${contextHash}`, '', 'skipped');
      return { send: false, reason: 'negative_preference', contextHash };
    }
  }

  // Log the send decision
  await db.logSentMessage(userId, `proactive:${triggerType}:${contextHash}`, '', 'sent');
  return { send: true, contextHash };
}

// ─── Trigger handlers ─────────────────────────────────────────────────────────

async function eventReminder(userId, event) {
  const gate = await shouldSendProactive(userId, 'event_reminder', event.id || event.title || '');
  if (!gate.send) return;

  const user = await db.getUserById(userId);
  if (!user) return;

  const minutesOut = event.start
    ? Math.round((new Date(event.start) - new Date()) / 60000)
    : 30;

  const message = await generateUserMessage(
    `You are a helpful assistant texting a college student. Send a casual one-sentence reminder about an upcoming event. No emojis unless natural.
Event: ${event.title}
Starts in: ~${minutesOut} minutes${event.location ? `\nLocation: ${event.location}` : ''}`,
    [{ role: 'user', content: `remind me about ${event.title}` }],
    400, 'proactive'
  );

  await sendTypingIndicator(user.phone_number, userId);
  await sendMessage(user.phone_number, message, userId);
}

async function canvasAlert(userId) {
  const gate = await shouldSendProactive(userId, 'canvas_alert');
  if (!gate.send) return;

  const user = await db.getUserById(userId);
  if (!user) return;

  let snapshot;
  try {
    snapshot = await withRetry(() => getWeeklySnapshot(userId));
  } catch (err) {
    console.warn(`canvasAlert: Canvas unavailable for user ${userId}:`, err.message || err);
    return;
  }

  const tz = user.timezone || 'America/New_York';
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const dueSoon = (snapshot.upcoming || []).filter(a => new Date(a.dueDate) <= in24h);
  const missing = snapshot.missing || [];
  const isMonday9am = dayOfWeekInTz(tz) === 1 && hourInTz(tz) === 9;
  const weeklyAssignments = snapshot.upcoming || [];

  // Detect assignment bunching: 3+ assignments due on the same calendar day (in user's tz)
  const dueDateCounts = new Map();
  for (const a of weeklyAssignments) {
    const day = a.dueDate
      ? new Date(a.dueDate).toLocaleDateString('en-CA', { timeZone: tz })
      : null;
    if (day) dueDateCounts.set(day, (dueDateCounts.get(day) || 0) + 1);
  }
  const hasBunchDay = [...dueDateCounts.values()].some(count => count >= 3);

  const shouldFire =
    dueSoon.length >= 2 ||
    missing.length > 0 ||
    hasBunchDay ||
    (isMonday9am && weeklyAssignments.length >= 3);

  if (!shouldFire) return;

  let freeBlocks = [];
  try {
    freeBlocks = await getFreeBlocksToday(userId);
  } catch (err) {
    console.warn(`canvasAlert: could not get free blocks for user ${userId}:`, err.message || err);
  }

  const context = {
    dueSoon: dueSoon.map(a => `${a.title} (${a.courseName}, due ${a.dueDate ? fmtDate(a.dueDate, tz) : 'TBD'})`),
    missing: missing.slice(0, 3).map(a => `${a.title} (${a.courseName})`),
    freeBlocks: freeBlocks.map(b => `${b.start}–${b.end}`),
  };

  const message = await generateUserMessage(
    `You are a helpful assistant texting a college student. Be casual and brief, max 2 sentences.
Canvas update: ${JSON.stringify(context)}
Remind them about upcoming/missing work. Suggest a free block for studying if available.`,
    [{ role: 'user', content: "what do i have due?" }],
    400, 'proactive'
  );

  await sendMessage(user.phone_number, message, userId);
}

async function importantEmailAlert(userId, email, fullBody) {
  // Skip daily limit for truly important emails — still respect quiet hours
  const gate = await shouldSendProactive(
    userId, 'email_alert', email.messageId || email.id || '',
    { skipDailyLimit: true }
  );
  if (!gate.send) return;

  const user = await db.getUserById(userId);
  if (!user) return;

  const message = await generateUserMessage(
    `You are a helpful assistant. Alert a college student about an important email. 1-2 sentences, casual, no subject line quoting.
From: ${email.from}
Subject: ${email.subject}
Preview: ${(fullBody || '').slice(0, 200)}`,
    [{ role: 'user', content: `email from ${email.from}` }],
    400, 'proactive'
  );

  await sendMessage(user.phone_number, message, userId);

  // React to show awareness (fire and forget — may fail silently if not a Linq message)
  if (email.messageId) {
    sendReaction(user.phone_number, email.messageId, 'exclamation', userId);
  }
}

async function healthNudge(userId) {
  const user = await db.getUserById(userId);
  if (!user || !user.health_enabled) return;

  const gate = await shouldSendProactive(userId, 'health_nudge');
  if (!gate.send) return;

  let readiness = null;
  try {
    const reading = await db.getLatestHealthReading(userId);
    readiness = reading?.readiness ?? null;
  } catch (err) {
    console.warn(`healthNudge: could not get health reading for user ${userId}:`, err.message || err);
  }

  let todayEventCount = 0;
  try {
    const events = await getTodaysEvents(userId);
    todayEventCount = (events || []).length;
  } catch (err) {
    console.warn(`healthNudge: could not get events for user ${userId}:`, err.message || err);
  }

  let consecutiveLow = 0;
  try {
    const readings = await db.getRecentHealthReadings(userId, 3);
    if (readings.length === 3 && readings.every(r => r.readiness < 55)) {
      consecutiveLow = 3;
    }
  } catch (err) {
    console.warn(`healthNudge: could not get health readings for user ${userId}:`, err.message || err);
  }

  const shouldFire =
    (readiness !== null && readiness < 55 && todayEventCount >= 3) ||
    consecutiveLow >= 3;

  if (!shouldFire) return;

  const message = await generateUserMessage(
    `You are a caring friend. Send a gentle, empathetic message to a college student who seems tired/worn down.
Never preachy. 1-2 sentences. Warm and human, not a wellness lecture.
Context: readiness score ${readiness ?? 'low'}/100, ${todayEventCount} events today${consecutiveLow >= 3 ? ', low energy 3 days in a row' : ''}.`,
    [{ role: 'user', content: 'how am i doing?' }],
    400, 'proactive'
  );

  await sendMessage(user.phone_number, message, userId);
}

async function nightlyDigest(userId) {
  const gate = await shouldSendProactive(userId, 'nightly_digest');
  if (!gate.send) return;

  const user = await db.getUserById(userId);
  if (!user) return;

  // Only if user hasn't texted in last 4 hours
  const lastMsgTime = await db.getLastUserMessageTime(userId);
  if (lastMsgTime) {
    const msSinceLast = Date.now() - new Date(lastMsgTime).getTime();
    if (msSinceLast < 4 * 60 * 60 * 1000) return;
  }

  let tomorrowEvents = [];
  let dueTomorrow = [];
  let forecast = null;

  const digestUser = await db.getUserById(userId);
  const digestTz = digestUser?.timezone || 'America/New_York';
  const digestTomorrowStr = tomorrowInTz(digestTz);

  try {
    tomorrowEvents = await getUpcomingEvents(userId, 2);
    // Filter to tomorrow's date in the user's timezone
    tomorrowEvents = tomorrowEvents.filter(e => {
      if (!e.start) return false;
      const evDate = new Date(e.start).toLocaleDateString('en-CA', { timeZone: digestTz });
      return evDate === digestTomorrowStr;
    });
  } catch (err) {
    console.warn(`nightlyDigest: could not get upcoming events for user ${userId}:`, err.message || err);
  }

  try {
    const snapshot = await withRetry(() => getWeeklySnapshot(userId));
    // "due tomorrow" = anything whose due date falls on tomorrow's date in user's tz
    dueTomorrow = (snapshot.upcoming || []).filter(a => {
      if (!a.dueDate) return false;
      const dueLocalDate = new Date(a.dueDate).toLocaleDateString('en-CA', { timeZone: digestTz });
      return dueLocalDate === digestTomorrowStr;
    });
  } catch (err) {
    console.warn(`nightlyDigest: Canvas unavailable for user ${userId}:`, err.message || err);
  }

  try {
    forecast = await getTodaysForecast(userId);
  } catch (err) {
    console.warn(`nightlyDigest: could not get forecast for user ${userId}:`, err.message || err);
  }

  const context = {
    name: user.name || '',
    tomorrowEvents: tomorrowEvents.slice(0, 3).map(e => e.title),
    dueTomorrow: dueTomorrow.slice(0, 3).map(a => a.title),
    weather: forecast && forecast.isNotable ? `${forecast.description}, ${forecast.temp}°F` : null,
  };

  const response = await generateUserMessage(
    `You are a friendly assistant sending a warm nightly check-in to a college student.
Preview tomorrow briefly and end warmly. Human tone, not a bulleted list. 2-3 short messages worth of content.
Context: ${JSON.stringify(context)}`,
    [{ role: 'user', content: "what's tomorrow looking like?" }],
    400, 'proactive'
  );

  // Split on double newlines for multi-message delivery
  const parts = response.split(/\n\n+/).map(s => s.trim()).filter(Boolean).slice(0, 3);
  if (parts.length > 1) {
    await sendMultiple(user.phone_number, parts, userId);
  } else {
    await sendMessage(user.phone_number, response, userId);
  }
}

// ─── Exam countdown ───────────────────────────────────────────────────────────
// Fires once within 48h of any assignment named like an exam/quiz.

const EXAM_KEYWORDS = ['exam', 'midterm', 'final', 'quiz', 'test'];

async function examCountdown(userId) {
  if (isOnBreak()) return; // no exam alerts during breaks

  const user = await db.getUserById(userId);
  if (!user || !user.canvas_token) return;

  let upcoming = [];
  try {
    upcoming = await withRetry(() => getUpcomingAssignments(userId, 2)); // next 48h
  } catch (err) {
    console.warn(`examCountdown: Canvas unavailable for user ${userId}:`, err.message || err);
    return;
  }

  const exams = upcoming.filter(a =>
    EXAM_KEYWORDS.some(kw => a.title.toLowerCase().includes(kw))
  );

  for (const exam of exams.slice(0, 2)) {
    const gate = await shouldSendProactive(userId, 'exam_countdown', exam.title);
    if (!gate.send) continue;

    const examTz = user.timezone || 'America/New_York';
    const dueDate = new Date(exam.dueDate);
    const hoursOut = Math.round((dueDate - new Date()) / 3600000);
    const timeStr = hoursOut <= 24 ? 'tomorrow' : fmtDate(dueDate, examTz);

    const message = await generateUserMessage(
      `You are a supportive friend texting a college student. Send a brief, warm good-luck message for an upcoming exam. 1 sentence max. No lecture.
Exam: ${exam.title}
Course: ${exam.courseName}
Due: ${timeStr}`,
      [{ role: 'user', content: `exam reminder` }],
      200, 'proactive'
    );

    await sendTypingIndicator(user.phone_number, userId);
    await sendMessage(user.phone_number, message, userId);
  }
}

// ─── Conflict detection ────────────────────────────────────────────────────────
// Cross-references Canvas due dates with calendar events to surface busy days.

async function detectConflicts(userId) {
  const user = await db.getUserById(userId);
  if (!user) return;

  let assignments = [];
  let events = [];

  try {
    const snap = await withRetry(() => getWeeklySnapshot(userId));
    assignments = snap.upcoming || [];
  } catch (err) {
    console.warn(`detectConflicts: Canvas unavailable for user ${userId}:`, err.message || err);
    return;
  }

  try {
    const [outlookEvents, googleEvents] = await Promise.allSettled([
      getTodaysEvents(userId),
      getGoogleCalendarEvents(userId, 7),
    ]);
    events = [
      ...(outlookEvents.status === 'fulfilled' ? outlookEvents.value || [] : []),
      ...(googleEvents.status === 'fulfilled'  ? googleEvents.value  || [] : []),
    ];
  } catch (err) {
    console.warn(`detectConflicts: calendar unavailable for user ${userId}:`, err.message || err);
  }

  // Group events by date
  const eventsByDate = new Map();
  for (const e of events) {
    if (!e.start) continue;
    const day = e.start.split('T')[0];
    eventsByDate.set(day, (eventsByDate.get(day) || 0) + 1);
  }

  // Find assignment due dates with 5+ calendar events the same day
  const conflicts = assignments.filter(a => {
    const day = a.dueDate ? a.dueDate.split('T')[0] : null;
    return day && (eventsByDate.get(day) || 0) >= 5;
  });

  if (conflicts.length === 0) return;

  const gate = await shouldSendProactive(userId, 'conflict_alert');
  if (!gate.send) return;

  const conflictList = conflicts.slice(0, 2)
    .map(a => `${a.title} (${a.courseName})`).join(' and ');

  const message = await generateUserMessage(
    `You are a caring friend. Alert a college student that they have a packed day coming up. 2 sentences max, casual, actionable.
Conflict: ${conflictList} due on a day with many calendar events. Help them plan ahead.`,
    [{ role: 'user', content: 'heads up' }],
    300, 'proactive'
  );

  await sendMessage(user.phone_number, message, userId);
}

// ─── Scheduled trigger processor ──────────────────────────────────────────────

async function processPendingTriggers() {
  try {
    await db.expireOldScheduledMessages();
    const pending = await db.getPendingScheduledMessages();

    for (const msg of pending) {
      // morning_brief type is handled by the dedicated 8am cron
      if (msg.trigger_type === 'morning_brief') continue;

      try {
        const triggerType = msg.trigger_type || 'scheduled';
        const context = msg.context || {};
        const contextKey = context.contextKey || '';

        const gate = await shouldSendProactive(msg.user_id, triggerType, contextKey);

        if (!gate.send) {
          await db.markMessageSkipped(msg.id);
          continue;
        }

        const text = await generateUserMessage(
          `You are a helpful assistant texting a college student. Be casual and brief.
Scheduled message: ${msg.purpose}
Context: ${JSON.stringify(context)}`,
          [{ role: 'user', content: msg.purpose }],
          400, 'proactive'
        );

        await sendMessage(msg.phone_number, text, msg.user_id);
        await db.markMessageSent(msg.id);
      } catch (err) {
        console.error(`processPendingTriggers error for msg ${msg.id}:`, err.message || err);
      }
    }
  } catch (err) {
    console.error('processPendingTriggers error:', err.message || err);
  }
}

// ─── Event checker ────────────────────────────────────────────────────────────

// In-memory dedup for event reminders (key → sentAt timestamp)
const sentEventReminders = new Map();

async function checkUpcomingEvents() {
  // Prune entries older than 4 hours
  const cutoff = Date.now() - 4 * 60 * 60 * 1000;
  for (const [key, sentAt] of sentEventReminders.entries()) {
    if (sentAt < cutoff) sentEventReminders.delete(key);
  }

  try {
    const users = await db.getAllActiveUsers();
    const now = new Date();
    const windowStart = new Date(now.getTime() + 25 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + 35 * 60 * 1000);

    for (const user of users) {
      try {
        const events = await getTodaysEvents(user.id);
        const upcoming = (events || []).filter(e => {
          if (!e.start) return false;
          const start = new Date(e.start);
          return start >= windowStart && start <= windowEnd;
        });

        for (const event of upcoming) {
          const key = `${user.id}:${event.id || event.title}:${now.toDateString()}`;
          if (sentEventReminders.has(key)) continue;

          await eventReminder(user.id, event);
          sentEventReminders.set(key, Date.now());
        }
      } catch (err) {
        console.error(`checkUpcomingEvents error for user ${user.id}:`, err.message || err);
      }
    }
  } catch (err) {
    console.error('checkUpcomingEvents error:', err.message || err);
  }
}

// ─── Nightly planning job ─────────────────────────────────────────────────────

async function nightlyPlan(userId) {
  try {
    const user = await db.getUserById(userId);
    if (!user) return;

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [
      tomorrowEventsResult,
      snapshotResult,
      healthResult,
      freeBlocksResult,
      moodResult,
      forecastResult,
    ] = await Promise.allSettled([
      getTodaysEvents(userId),
      getWeeklySnapshot(userId),
      db.getLatestHealthReading(userId),
      getFreeBlocksToday(userId, tomorrow),
      getMoodContext(userId),
      getTodaysForecast(userId),
    ]);

    const context = {
      tomorrow: fmtDate(tomorrow, user.timezone || 'America/New_York'),
      events: tomorrowEventsResult.status === 'fulfilled'
        ? (tomorrowEventsResult.value || []).slice(0, 5).map(e => ({
            title: e.title,
            time: e.start ? fmtTime(e.start, user.timezone || 'America/New_York') : null,
          }))
        : [],
      assignments: snapshotResult.status === 'fulfilled' && snapshotResult.value
        ? (snapshotResult.value.upcoming || []).slice(0, 5).map(a => ({
            title: a.title,
            course: a.courseName,
            due: a.dueDate,
          }))
        : [],
      freeBlocks: freeBlocksResult.status === 'fulfilled'
        ? (freeBlocksResult.value || []).map(b => `${b.start}–${b.end}`)
        : [],
      mood: moodResult.status === 'fulfilled' ? moodResult.value?.mood : null,
      weather: forecastResult.status === 'fulfilled' && forecastResult.value?.isNotable
        ? `${forecastResult.value.description}, ${forecastResult.value.temp}°F`
        : null,
      readiness: healthResult.status === 'fulfilled' ? healthResult.value?.readiness ?? null : null,
    };

    const prompt =
      `Plan proactive messages for a college student for tomorrow. Based on context below, what 1-3 genuinely useful messages should be sent and when?\n` +
      `Return JSON array only:\n` +
      `[{"triggerTime": ISO string, "purpose": string, "triggerType": string, "contextSummary": string}]\n` +
      `Return [] if nothing clearly needed.\n` +
      `Context: ${JSON.stringify(context)}`;

    let triggers = [];
    try {
      const raw = await withRetry(() => classify(prompt, 500, 'classification'));
      try {
        const parsed = JSON.parse(raw.trim());
        if (Array.isArray(parsed)) triggers = parsed;
      } catch (parseErr) {
        console.warn(`nightlyPlan: JSON parse failed for user ${userId}:`, parseErr.message, '| raw:', (raw || '').slice(0, 100));
        return;
      }
    } catch (err) {
      console.warn(`nightlyPlan: classify failed for user ${userId}:`, err.message || err);
      return;
    }

    let scheduled = 0;
    for (const trigger of triggers) {
      if (scheduled >= 2) break; // cap at 2 AI-planned messages per night to control cost
      if (!trigger.triggerTime || !trigger.purpose || !trigger.triggerType) continue;
      const triggerTime = new Date(trigger.triggerTime);
      if (isNaN(triggerTime.getTime())) continue;

      await db.scheduleMessage(
        userId,
        triggerTime,
        trigger.purpose,
        { contextSummary: trigger.contextSummary || '', contextKey: '' },
        trigger.triggerType
      );
      scheduled++;
    }

    // Grade change alert
    try {
      const snapshot = snapshotResult.status === 'fulfilled' ? snapshotResult.value : null;
      if (snapshot && snapshot.grades && snapshot.grades.length > 0) {
        const gradeChanges = await detectGradeChanges(userId, snapshot.grades);
        const dropped = (gradeChanges || []).filter(g => g.direction === 'down');
        if (dropped.length > 0) {
          const gateResult = await shouldSendProactive(userId, 'grade_alert');
          if (gateResult.send) {
            const list = dropped.map(g => `${g.courseName} (${g.oldScore}→${g.newScore})`).join(', ');
            await sendMessage(user.phone_number, `heads up — grade dropped: ${list}`, userId);
          }
        }
      }
    } catch (err) {
      console.warn(`nightlyPlan: grade check failed for user ${userId}:`, err.message || err);
    }

  } catch (err) {
    console.error(`nightlyPlan error for user ${userId}:`, err.message || err);
  }
}

module.exports = {
  withRetry,
  shouldSendProactive,
  eventReminder,
  canvasAlert,
  importantEmailAlert,
  healthNudge,
  nightlyDigest,
  examCountdown,
  detectConflicts,
  processPendingTriggers,
  checkUpcomingEvents,
  nightlyPlan,
  // Exported for testing
  hashContextKey,
  sentEventReminders,
};
