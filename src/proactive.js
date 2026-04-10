'use strict';

const db = require('./db');
const { classify, generateUserMessage } = require('./utils/claude');
const { sendMessage, sendTypingIndicator, sendReaction, sendMultiple } = require('./sms');
const { isInClass, getFreeBlocksToday, getClassSchedule } = require('./integrations/schedule');
const { getWeeklySnapshot, detectGradeChanges } = require('./integrations/canvas');
const { getTodaysEvents, getUpcomingEvents } = require('./integrations/outlook');
const { getMoodContext } = require('./integrations/spotify');
const { getTodaysForecast } = require('./integrations/weather');

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
  // Hard block: quiet hours (10pm–7am)
  const hour = new Date().getHours();
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

  // Preference check
  const contextHash = hashContextKey(contextKey);
  const pref = await db.getPreference(userId, triggerType, contextHash);

  if (pref && pref.total_count >= 5) {
    const positiveRate = pref.positive_count / pref.total_count;
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
    snapshot = await getWeeklySnapshot(userId);
  } catch {
    return;
  }

  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const dueSoon = (snapshot.upcoming || []).filter(a => new Date(a.dueDate) <= in24h);
  const missing = snapshot.missing || [];
  const isMonday9am = now.getDay() === 1 && now.getHours() === 9;
  const weeklyAssignments = snapshot.upcoming || [];

  const shouldFire =
    dueSoon.length >= 2 ||
    missing.length > 0 ||
    (isMonday9am && weeklyAssignments.length >= 3);

  if (!shouldFire) return;

  let freeBlocks = [];
  try {
    freeBlocks = await getFreeBlocksToday(userId);
  } catch { /* skip */ }

  const context = {
    dueSoon: dueSoon.map(a => `${a.title} (${a.courseName}, due ${new Date(a.dueDate).toLocaleDateString()})`),
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
  } catch { /* no reading */ }

  let todayEventCount = 0;
  try {
    const events = await getTodaysEvents(userId);
    todayEventCount = (events || []).length;
  } catch { /* skip */ }

  let consecutiveLow = 0;
  try {
    const readings = await db.getRecentHealthReadings(userId, 3);
    if (readings.length === 3 && readings.every(r => r.readiness < 55)) {
      consecutiveLow = 3;
    }
  } catch { /* skip */ }

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

  try {
    tomorrowEvents = await getUpcomingEvents(userId, 2);
    // Filter to tomorrow's events
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    tomorrowEvents = tomorrowEvents.filter(e => e.start && e.start.startsWith(tomorrowStr));
  } catch { /* skip */ }

  try {
    const snapshot = await getWeeklySnapshot(userId);
    const tomorrowEnd = new Date();
    tomorrowEnd.setDate(tomorrowEnd.getDate() + 2);
    tomorrowEnd.setHours(23, 59, 59, 0);
    dueTomorrow = (snapshot.upcoming || []).filter(a => new Date(a.dueDate) <= tomorrowEnd);
  } catch { /* skip */ }

  try {
    forecast = await getTodaysForecast(userId);
  } catch { /* skip */ }

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
      tomorrow: tomorrow.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
      events: tomorrowEventsResult.status === 'fulfilled'
        ? (tomorrowEventsResult.value || []).slice(0, 5).map(e => ({
            title: e.title,
            time: e.start
              ? new Date(e.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
              : null,
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
      const raw = await classify(prompt, 500, 'classification');
      const parsed = JSON.parse(raw.trim());
      if (Array.isArray(parsed)) triggers = parsed;
    } catch {
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
    } catch { /* grade check is best-effort */ }

  } catch (err) {
    console.error(`nightlyPlan error for user ${userId}:`, err.message || err);
  }
}

module.exports = {
  shouldSendProactive,
  eventReminder,
  canvasAlert,
  importantEmailAlert,
  healthNudge,
  nightlyDigest,
  processPendingTriggers,
  checkUpcomingEvents,
  nightlyPlan,
  // Exported for testing
  hashContextKey,
  sentEventReminders,
};
