'use strict';

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const db = require('./db');
const { sendMessage, sendMultiple } = require('./sms');
const { generateUserMessage } = require('./utils/claude');
const { resetAllCounts } = require('./utils/limiter');
const { getWeeklySnapshot, detectGradeChanges } = require('./integrations/canvas');
const { getTodaysEvents, getUnreadEmails: getOutlookEmails, isEmailImportant, renewWebhookSubscriptions } = require('./integrations/outlook');
const { getAllEmailContext, getGoogleCalendarEvents, parseVenmoEmails } = require('./integrations/gmail');
const { getMoodContext } = require('./integrations/spotify');
const { getTodaysForecast } = require('./integrations/weather');
const { isInClass, getClassSchedule } = require('./integrations/schedule');
const { downloadAndParseGTFS } = require('./integrations/bt_static');
const { fetchAndStoreRealtimeData, shouldLeaveAlert } = require('./integrations/bt_bus');
const { searchMemories, deleteOldMemories } = require('./memory/store');
const { nightlyExtraction } = require('./memory/extract');
const { extractInteractionPatterns } = require('./learning/patternExtractor');
const { refreshStyleCache } = require('./learning/styleAnalyzer');
const { getEffectiveBriefHour } = require('./briefTime');
const { renewGmailWatches } = require('./integrations/gmail');
const { hourInTz, dayOfWeekInTz, todayInTz, fmtDate, fmtTime } = require('./utils/timezone');

// ─── Soul helpers ─────────────────────────────────────────────────────────────

const soulRaw = fs.readFileSync(path.join(__dirname, 'soul.md'), 'utf8');

function loadSoul(userName) {
  const agentName = process.env.AGENT_NAME || 'Comet';
  let soul = soulRaw.replace(/\$\{AGENT_NAME\}/g, agentName);
  if (userName) soul += `\n\nUser's name: ${userName}`;
  return soul;
}

function buildMemoryContext(memories) {
  if (!memories || memories.length === 0) return '';
  return `\n\nWhat you remember about this user:\n${memories.map(m => m.text).join('\n')}\nUse naturally in conversation. Don't recite back.`;
}

function buildMorningBriefPrompt(context) {
  const parts = [];

  if (context.schedule && context.schedule.length > 0) {
    const day = context.dayOfWeek;
    const todayClasses = context.schedule.filter(c => {
      const DAY_ABBREVS = { Sunday: 'Su', Monday: 'M', Tuesday: 'T', Wednesday: 'W', Thursday: 'Th', Friday: 'F', Saturday: 'Sa' };
      return c.days && c.days.includes(DAY_ABBREVS[day]);
    });
    if (todayClasses.length > 0) {
      parts.push(`Classes today: ${todayClasses.map(c => `${c.name} at ${c.startTime}`).join(', ')}`);
    }
  }

  if (context.canvas) {
    const upcoming = (context.canvas.upcoming || []).filter(a => {
      const due = new Date(a.dueDate);
      const in48h = new Date(Date.now() + 48 * 60 * 60 * 1000);
      return due <= in48h;
    });
    const missing = context.canvas.missing || [];
    if (upcoming.length > 0) {
      parts.push(`Assignments due soon: ${upcoming.map(a => `${a.title} (${a.courseName})`).join(', ')}`);
    }
    if (missing.length > 0) {
      parts.push(`Missing work: ${missing.slice(0, 2).map(a => a.title).join(', ')}`);
    }
  }

  const allEmails = [
    ...((context.emails && context.emails.school) || []),
    ...((context.emails && context.emails.personal) || []),
  ].filter(e => e.isImportant || e.isInternship);
  if (allEmails.length > 0) {
    parts.push(`Important emails: ${allEmails.slice(0, 2).map(e => `"${e.subject}" from ${e.from}`).join('; ')}`);
  }

  const calEvents = [...(context.googleCal || []), ...(context.outlookCal || [])].slice(0, 3);
  if (calEvents.length > 0) {
    parts.push(`Calendar: ${calEvents.map(e => e.title || e.subject || '').filter(Boolean).join(', ')}`);
  }

  if (context.weather && context.weather.isNotable) {
    const rain = context.weather.rainProbability > 40 ? ` (${context.weather.rainProbability}% rain)` : '';
    parts.push(`Weather: ${context.weather.description}, ${context.weather.temp}°F${rain}`);
  }

  if (context.health && context.health.readiness < 55) {
    parts.push(`Health: low readiness today (${context.health.readiness}/100) — busy day ahead`);
  }

  if (context.mood && (context.mood.mood === 'stressed' || context.mood.mood === 'energized')) {
    parts.push(`Vibe: ${context.mood.mood}${context.mood.activity ? ` (${context.mood.activity})` : ''}`);
  }

  const dataStr = parts.length > 0 ? `\n\nContext:\n${parts.join('\n')}` : '';

  const stats = context.briefStats;
  let engagementHint = '';
  if (stats && stats.totalSent >= 5) {
    const rate = stats.engagementRate;
    const avgLen = stats.avgReplyLength;
    if (rate !== null && rate < 0.3) {
      engagementHint = '\n- keep it very short, 1-2 messages max, only the most critical item';
    } else if (rate !== null && rate > 0.7) {
      engagementHint = '\n- this person engages a lot, you can include a bit more detail and personality';
    }
    if (avgLen !== null && avgLen < 10) {
      engagementHint += '\n- their replies are brief, match their energy — keep it casual and short';
    }
  }

  return `Write 2-4 short casual texts for ${context.user.name || 'this student'}'s morning brief. Split each message with a blank line.${dataStr}

Rules:
- Only mention things that actually matter today
- Sound like a knowledgeable friend, not a system reading data
- Never use bullet points or formal structure
- Keep each message to 1-2 sentences
- If there's nothing urgent, just say good morning warmly${engagementHint}`;
}
const {
  processPendingTriggers,
  checkUpcomingEvents,
  nightlyPlan,
  canvasAlert,
  healthNudge,
  nightlyDigest,
  examCountdown,
  detectConflicts,
} = require('./proactive');

function buildCanvasContext(snapshot, gradeChanges) {
  const parts = [];

  if (snapshot.upcoming && snapshot.upcoming.length > 0) {
    const threeDaysOut = new Date();
    threeDaysOut.setDate(threeDaysOut.getDate() + 3);
    const soon = snapshot.upcoming.filter(a => new Date(a.dueDate) <= threeDaysOut);
    if (soon.length > 0) {
      const briefTz = user?.timezone || 'America/New_York';
      const list = soon.map(a => `${a.title} (${a.courseName}, due ${a.dueDate ? fmtDate(a.dueDate, briefTz) : 'TBD'})`).join('; ');
      parts.push(`assignments due soon: ${list}`);
    }
  }

  if (snapshot.missing && snapshot.missing.length > 0) {
    const list = snapshot.missing.slice(0, 3).map(a => `${a.title} (${a.courseName})`).join('; ');
    parts.push(`missing work: ${list}`);
  }

  if (gradeChanges && gradeChanges.length > 0) {
    const list = gradeChanges.map(g => `${g.courseName} went ${g.direction} (${g.oldScore}→${g.newScore})`).join('; ');
    parts.push(`grade changes: ${list}`);
  }

  if (snapshot.announcements && snapshot.announcements.length > 0) {
    const list = snapshot.announcements.slice(0, 2).map(a => `${a.courseName}: ${a.title}`).join('; ');
    parts.push(`new announcements: ${list}`);
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

function buildOutlookContext(events, emails, tz = 'America/New_York') {
  const parts = [];

  if (events && events.length > 0) {
    const list = events.slice(0, 3).map(e => {
      const time = e.start ? fmtTime(e.start, tz) : '';
      return `${e.title}${time ? ` at ${time}` : ''}${e.isOnlineMeeting ? ' (online)' : ''}`;
    }).join(', ');
    parts.push(`calendar today: ${list}`);
  }

  if (emails && emails.length > 0) {
    const important = emails.filter(e => isEmailImportant(e).important);
    if (important.length > 0) {
      const list = important.slice(0, 2).map(e => `"${e.subject}" from ${e.from}`).join('; ');
      parts.push(`important unread: ${list}`);
    }
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

function buildGmailContext(emailContext, venmoData) {
  const parts = [];

  if (emailContext) {
    const allImportant = [...(emailContext.school || []), ...(emailContext.personal || [])];

    const internship = allImportant.filter(e => e.isInternship);
    if (internship.length > 0) {
      const list = internship.slice(0, 2).map(e => `"${e.subject}" from ${e.from}`).join('; ');
      parts.push(`internship emails: ${list}`);
    }

    const regular = allImportant.filter(e => !e.isInternship && e.isImportant);
    if (regular.length > 0) {
      const list = regular.slice(0, 2).map(e => `"${e.subject}" from ${e.from}`).join('; ');
      parts.push(`important emails: ${list}`);
    }
  }

  if (venmoData && venmoData.isLowOnFunds) {
    parts.push(`spending alert: you've spent $${venmoData.monthlySpend.toFixed(2)} on venmo this month — pacing high`);
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

async function sendMorningBrief(userId) {
  const user = await db.getUserById(userId);
  if (!user) return;

  const results = await Promise.allSettled([
    getWeeklySnapshot(userId),
    getAllEmailContext(userId),
    getGoogleCalendarEvents(userId),
    getTodaysEvents(userId),
    getTodaysForecast(userId),
    db.getTodaysHealth(userId),
    searchMemories(userId, 'morning routine today assignments', 3),
    getMoodContext(userId),
    getClassSchedule(userId),
    db.getMorningBriefStats(userId),
  ]);

  const safeVal = (r, fallback) => r.status === 'fulfilled' ? r.value : fallback;

  const briefStats = safeVal(results[9], null);

  const context = {
    user: { name: user.name, timezone: user.timezone },
    canvas: safeVal(results[0], {}),
    emails: safeVal(results[1], { school: [], personal: [] }),
    googleCal: safeVal(results[2], []),
    outlookCal: safeVal(results[3], []),
    weather: safeVal(results[4], null),
    health: safeVal(results[5], null),
    memories: safeVal(results[6], []),
    mood: safeVal(results[7], null),
    schedule: safeVal(results[8], []),
    dayOfWeek: new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: user.timezone || 'America/New_York' }),
    briefStats,
  };

  const systemPrompt = loadSoul(user.name) + buildMemoryContext(context.memories);
  const response = await generateUserMessage(
    systemPrompt,
    [{ role: 'user', content: buildMorningBriefPrompt(context) }],
    500
  );

  const messages = response.split(/\n\n+/).map(m => m.trim()).filter(Boolean).slice(0, 4);
  await sendMultiple(user.phone_number, messages, userId);
  await db.logSentMessage(userId, 'morning_brief', response);
  await db.logMorningBriefSent(userId).catch(() => {});
}


// ─── Per-user timezone-aware cron jobs ───────────────────────────────────────

const userCrons = new Map(); // userId → [CronJob, ...]

function scheduleUserJobs(user) {
  // Stop any previously scheduled jobs for this user
  if (userCrons.has(user.id)) {
    for (const job of userCrons.get(user.id)) {
      try { job.stop(); } catch (_) {}
    }
  }

  const tz = user.timezone || 'America/New_York';
  const jobs = [];

  // Morning brief at user's preferred hour
  const briefHour = user.preferred_brief_hour ?? 9;
  const briefMinute = user.preferred_brief_minute ?? 0;
  jobs.push(cron.schedule(
    `${briefMinute} ${briefHour} * * *`,
    async () => {
      try {
        const today = new Date().toISOString().split('T')[0];
        const alreadySent = await db.wasEarlyBriefSent(user.id, today);
        if (alreadySent) return;
        if (await isInClass(user.id)) return;
        await sendMorningBrief(user.id);
      } catch (err) {
        console.error(`Morning brief error for user ${user.id}:`, err.message || err);
      }
    },
    { timezone: tz }
  ));

  // Early-class check at 6:15am — send brief early if first class is before preferred hour
  jobs.push(cron.schedule(
    '15 6 * * *',
    async () => {
      try {
        const effectiveHour = await getEffectiveBriefHour(user.id);
        const todayStr = todayInTz(tz);
        const alreadySent = await db.wasEarlyBriefSent(user.id, todayStr);
        if (alreadySent) return;
        if (effectiveHour < (user.preferred_brief_hour ?? 9)) {
          // There's an early class — send brief now if it's past effectiveHour in user's tz
          const nowHour = hourInTz(tz);
          if (nowHour >= effectiveHour) {
            await sendMorningBrief(user.id);
            await db.markEarlyBriefSent(user.id, todayStr);
          }
        }
      } catch (err) {
        console.error(`Early class brief error for user ${user.id}:`, err.message || err);
      }
    },
    { timezone: tz }
  ));

  // NOTE: Canvas alert (10am), nightly digest (9pm), and memory extraction (2:30am)
  // are handled by single global fan-out crons in scheduleAllJobs() below.
  // Only brief timing jobs belong here (they require per-user timezone awareness).

  userCrons.set(user.id, jobs);
}

async function scheduleAllJobs() {
  // Bootstrap per-user jobs at startup — awaited so briefs are scheduled
  // before any other startup code runs
  try {
    const users = await db.getAllActiveUsers();
    for (const user of users) {
      scheduleUserJobs(user);
    }
    console.log(`Bootstrapped cron jobs for ${users.length} users`);
  } catch (err) {
    console.error('Failed to bootstrap per-user cron jobs:', err.message || err);
    // Non-fatal: global crons below still register
  }

  // Reset per-user message counts at midnight
  cron.schedule('0 0 * * *', async () => {
    try {
      await resetAllCounts();
    } catch (err) {
      console.error('Reset counts error:', err.message || err);
    }
  });

  // Every 5 minutes: process AI-planned triggers + check for upcoming events
  cron.schedule('*/5 * * * *', async () => {
    try {
      await processPendingTriggers();
    } catch (err) {
      console.error('processPendingTriggers error:', err.message || err);
    }
    try {
      await checkUpcomingEvents();
    } catch (err) {
      console.error('checkUpcomingEvents error:', err.message || err);
    }
  });

  // Renew Microsoft Graph webhook subscriptions daily at 3am
  cron.schedule('0 3 * * *', async () => {
    try {
      await renewWebhookSubscriptions();
    } catch (err) {
      console.error('Webhook renewal error:', err.message || err);
    }
  });

  // ─── Global fan-out jobs ────────────────────────────────────────────────────
  // These replace per-user crons — one job iterates all users instead of N jobs.

  // 10am: Canvas alert + health nudge for all active users
  cron.schedule('0 10 * * *', async () => {
    try {
      const users = await db.getAllActiveUsers();
      for (const user of users) {
        canvasAlert(user.id).catch(e =>
          console.error(`canvasAlert error for user ${user.id}:`, e.message || e)
        );
        healthNudge(user.id).catch(e =>
          console.error(`healthNudge error for user ${user.id}:`, e.message || e)
        );
      }
    } catch (err) {
      console.error('10am global proactive error:', err.message || err);
    }
  });

  // 8:30am: Exam countdown for all active users (fires after morning briefs)
  cron.schedule('30 8 * * *', async () => {
    try {
      const users = await db.getAllActiveUsers();
      for (const user of users) {
        examCountdown(user.id).catch(e =>
          console.error(`examCountdown error for user ${user.id}:`, e.message || e)
        );
      }
    } catch (err) {
      console.error('Exam countdown cron error:', err.message || err);
    }
  });

  // 9pm: Nightly digest for all active users
  cron.schedule('0 21 * * *', async () => {
    try {
      const users = await db.getAllActiveUsers();
      for (const user of users) {
        nightlyDigest(user.id).catch(e =>
          console.error(`nightlyDigest error for user ${user.id}:`, e.message || e)
        );
      }
    } catch (err) {
      console.error('9pm nightly digest error:', err.message || err);
    }
  });

  // 2:30am: Memory extraction + pattern extraction for all active users
  cron.schedule('30 2 * * *', async () => {
    try {
      const users = await db.getAllActiveUsers();
      for (const user of users) {
        nightlyExtraction(user.id).catch(e =>
          console.error(`Nightly extraction error for user ${user.id}:`, e.message || e)
        );
        extractInteractionPatterns(user.id).catch(e =>
          console.error(`Pattern extraction error for user ${user.id}:`, e.message || e)
        );
      }
    } catch (err) {
      console.error('2:30am extraction error:', err.message || err);
    }
  });

  // Fetch BT real-time predictions every 2 minutes (was 30s — 93% reduction in API calls)
  // Skip between 10pm and 6am when buses aren't running
  let _btFetchRunning = false;
  cron.schedule('*/2 * * * *', async () => {
    const hour = hourInTz('America/New_York'); // BT serves Blacksburg, VA — always Eastern
    if (hour < 6 || hour >= 22) return; // buses not running
    if (_btFetchRunning) return;
    _btFetchRunning = true;
    try {
      await fetchAndStoreRealtimeData();
    } catch (err) {
      console.error('BT realtime fetch error:', err.message || err);
    } finally {
      _btFetchRunning = false;
    }
  });

  // Check for bus departure alerts every 5 minutes
  // Track sent alerts in-memory to avoid duplicates
  const sentBusAlerts = new Map(); // `${userId}:${eventKey}` → sentAt timestamp

  cron.schedule('*/5 * * * *', async () => {
    try {
      // Prune alerts older than 4 hours
      const cutoff = Date.now() - 4 * 60 * 60 * 1000;
      for (const [key, sentAt] of sentBusAlerts.entries()) {
        if (sentAt < cutoff) sentBusAlerts.delete(key);
      }

      const users = await db.getAllActiveUsers();
      for (const user of users) {
        try {
          const schedule = await getClassSchedule(user.id);
          if (!schedule || schedule.length === 0) continue;

          const busNow = new Date();
          const busUserTz = user.timezone || 'America/New_York';
          const DAY_ABBREVS = { 0: 'Su', 1: 'M', 2: 'T', 3: 'W', 4: 'Th', 5: 'F', 6: 'Sa' };
          const dayAbbrev = DAY_ABBREVS[dayOfWeekInTz(busUserTz)];
          const fortyFiveMinsOut = new Date(busNow.getTime() + 45 * 60 * 1000);

          // Build classStart by parsing the class's start time as if it were in the user's tz
          const tzDateStr = todayInTz(busUserTz); // "YYYY-MM-DD"
          const upcomingClasses = schedule
            .filter(cls => cls.days && cls.days.includes(dayAbbrev) && cls.startTime)
            .map(cls => {
              // Parse "HH:MM" in user's timezone → UTC Date
              const classStart = new Date(`${tzDateStr}T${cls.startTime}:00`);
              return { ...cls, classStart };
            })
            .filter(cls => cls.classStart > busNow && cls.classStart <= fortyFiveMinsOut);

          for (const cls of upcomingClasses) {
            const alertKey = `${user.id}:${cls.name}:${cls.classStart.toDateString()}`;
            if (sentBusAlerts.has(alertKey)) continue;

            const alert = await shouldLeaveAlert(user.id, {
              title: cls.name,
              location: cls.location || cls.name,
              start: cls.classStart,
            });

            if (alert && alert.shouldAlert) {
              const { sendMessage } = require('./sms');
              await sendMessage(user.phone_number, alert.message, user.id);
              sentBusAlerts.set(alertKey, Date.now());
            }
          }
        } catch (err) {
          console.error(`Bus alert error for user ${user.id}:`, err.message || err);
        }
      }
    } catch (err) {
      console.error('Bus alert cron error:', err.message || err);
    }
  });

  // Refresh BT static GTFS data weekly on Sunday at 3am
  cron.schedule('0 3 * * 0', async () => {
    try {
      await downloadAndParseGTFS();
    } catch (err) {
      console.error('GTFS weekly refresh error:', err.message || err);
    }
  });

  // Nightly planning at 2am — schedule tomorrow's proactive messages + conflict detection
  cron.schedule('0 2 * * *', async () => {
    try {
      const users = await db.getAllActiveUsers();
      for (const user of users) {
        await nightlyPlan(user.id);
        detectConflicts(user.id).catch(e =>
          console.error(`detectConflicts error for user ${user.id}:`, e.message || e)
        );
      }
    } catch (err) {
      console.error('Nightly plan error:', err.message || err);
    }
  });

  // Weekly style cache refresh on Sunday at 4am (global — supplements per-user jobs)
  cron.schedule('0 4 * * 0', async () => {
    try {
      const users = await db.getAllActiveUsers();
      for (const user of users) {
        await refreshStyleCache(user.id).catch(e =>
          console.error(`Style cache refresh error for user ${user.id}:`, e.message || e)
        );
      }
    } catch (err) {
      console.error('Style cache refresh error:', err.message || err);
    }
  });

  // Weekly memory cleanup on Sunday at 3am
  cron.schedule('0 3 * * 0', async () => {
    try {
      const users = await db.getAllActiveUsers();
      for (const user of users) {
        await deleteOldMemories(user.id);
      }
    } catch (err) {
      console.error('Memory cleanup error:', err.message || err);
    }
  });

  // Gmail watch renewal every 6 days at 10am
  cron.schedule('0 10 */6 * *', async () => {
    try {
      await renewGmailWatches();
    } catch (err) {
      console.error('Gmail watch renewal error:', err.message || err);
    }
  });

  console.log('All cron jobs scheduled');
}

module.exports = { scheduleAllJobs, scheduleUserJobs, userCrons, sendMorningBrief, buildMorningBriefPrompt };
