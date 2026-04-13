'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { classify, getAnthropicClient } = require('./utils/claude');
const { sendMessage, sendTypingIndicator } = require('./sms');
const { searchMemories } = require('./memory/store');
const { getStyleContext, getResponseFormatHint } = require('./learning/styleAnalyzer');
const { captureConversationFeedback, captureProactiveFeedback } = require('./learning/feedbackCapture');
const { isDeletionRequest, requestDeletion } = require('./deletion');
const { getWeeklySnapshot } = require('./integrations/canvas');
const { getTodaysEvents, getUpcomingEvents } = require('./integrations/outlook');
const { getAllEmailContext, getGoogleCalendarEvents } = require('./integrations/gmail');
const { getTodaysForecast } = require('./integrations/weather');
const { getClassSchedule } = require('./integrations/schedule');
const { daysUntilExams, isFinalsWeek, getCurrentSemesterWeek, isOnBreak } = require('./utils/academicCalendar');

const soulRaw = fs.readFileSync(path.join(__dirname, 'soul.md'), 'utf8');

function parseSoul() {
  const agentName = process.env.AGENT_NAME || 'Comet';
  return soulRaw.replace(/\$\{AGENT_NAME\}/g, agentName);
}

// ─── Tool definitions ─────────────────────────────────────────────────────────
// Only expose tools for integrations the user has actually connected.
// This keeps the tool list focused and avoids Claude hallucinating calls
// to services that aren't set up.

function getToolsForUser(user) {
  const tools = [];

  if (user.canvas_token) {
    tools.push({
      name: 'get_canvas_data',
      description:
        'Fetch live Canvas LMS data. Returns upcoming assignments with due dates, ' +
        'missing work, current grades, and announcements. Use whenever the user asks ' +
        'about assignments, homework, due dates, grades, missing work, or anything Canvas-related.',
      input_schema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['assignments', 'grades', 'all'],
            description: 'assignments = upcoming + missing only, grades = grades only, all = everything',
          },
        },
        required: ['type'],
      },
    });
  }

  if (user.microsoft_refresh_token || user.google_refresh_token) {
    tools.push({
      name: 'get_calendar',
      description:
        'Fetch the user\'s calendar events from connected Outlook and/or Google Calendar accounts.',
      input_schema: {
        type: 'object',
        properties: {
          timeframe: {
            type: 'string',
            enum: ['today', 'tomorrow', 'this_week'],
            description: 'Which time range to fetch',
          },
        },
        required: ['timeframe'],
      },
    });

    tools.push({
      name: 'get_emails',
      description:
        'Fetch important unread emails. Surfaces internship-related emails, ' +
        'emails from professors/advisors, and anything flagged as important.',
      input_schema: { type: 'object', properties: {} },
    });
  }

  tools.push({
    name: 'get_weather',
    description: "Get the current weather forecast for the user's location.",
    input_schema: { type: 'object', properties: {} },
  });

  tools.push({
    name: 'get_class_schedule',
    description: "Get the user's weekly class schedule — course names, days, times, and locations.",
    input_schema: { type: 'object', properties: {} },
  });

  tools.push({
    name: 'set_reminder',
    description:
      'Schedule a reminder to be sent to the user at a future time. ' +
      'Use when the user asks to be reminded about something, or when you identify ' +
      'something time-sensitive that warrants a follow-up.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What to remind the user about' },
        remind_at: {
          type: 'string',
          description: 'ISO 8601 datetime string for when to send the reminder',
        },
      },
      required: ['message', 'remind_at'],
    },
  });

  if (process.env.PLAYWRIGHT_AGENT_URL) {
    tools.push({
      name: 'browse_web',
      description:
        'Use a real headless browser to navigate websites, fill out forms, look things up, ' +
        'check job listings, submit assignments, or do anything requiring actual web browsing. ' +
        'Supports saved login sessions — if the user has logged in before, the session is reused. ' +
        'Use for: Handshake job search, Canvas web UI, VT Banner, any website task the user asks about. ' +
        'Provide a clear task description and starting URL when known.',
      input_schema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Detailed description of what to do on the web',
          },
          url: {
            type: 'string',
            description: 'Starting URL if known (e.g. https://app.joinhandshake.com)',
          },
        },
        required: ['task'],
      },
    });
  }

  return tools;
}

// ─── Tool executors ───────────────────────────────────────────────────────────

function fmtDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) +
    ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

async function executeTool(name, input, userId, user) {
  console.log(`[brain] executing tool: ${name}`, input);

  switch (name) {

    case 'get_canvas_data': {
      const snap = await getWeeklySnapshot(userId);
      if (!snap) return 'Canvas data unavailable right now.';
      const lines = [];

      if (input.type === 'assignments' || input.type === 'all') {
        const in7d = new Date(Date.now() + 7 * 86400000);
        const upcoming = (snap.upcoming || []).filter(a => new Date(a.dueDate) <= in7d);
        if (upcoming.length > 0) {
          lines.push('Upcoming assignments (next 7 days):');
          upcoming.forEach(a => lines.push(`• ${a.title} — ${a.courseName} — due ${fmtDate(a.dueDate)}`));
        } else {
          lines.push('No assignments due in the next 7 days.');
        }
        const missing = (snap.missing || []).slice(0, 5);
        if (missing.length > 0) {
          lines.push('\nMissing work:');
          missing.forEach(a => lines.push(`• ${a.title} — ${a.courseName}`));
        }
      }

      if (input.type === 'grades' || input.type === 'all') {
        const grades = snap.grades || [];
        if (grades.length > 0) {
          lines.push('\nCurrent grades:');
          grades.forEach(g => lines.push(`• ${g.courseName}: ${g.score ?? 'N/A'}`));
        }
      }

      return lines.join('\n') || 'Nothing found in Canvas.';
    }

    case 'get_calendar': {
      const parts = [];

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];

      if (user.microsoft_refresh_token) {
        const events = await getTodaysEvents(userId).catch(() => []) || [];
        const filtered = input.timeframe === 'tomorrow'
          ? events.filter(e => e.start && e.start.startsWith(tomorrowStr))
          : events;
        if (filtered.length > 0) {
          parts.push('Outlook:');
          filtered.slice(0, 6).forEach(e => {
            const time = e.start
              ? new Date(e.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
              : '';
            parts.push(`• ${e.title || e.subject}${time ? ` at ${time}` : ''}${e.location ? ` — ${e.location}` : ''}`);
          });
        }
      }

      if (user.google_refresh_token) {
        const events = await getGoogleCalendarEvents(userId).catch(() => []) || [];
        if (events.length > 0) {
          parts.push('Google Calendar:');
          events.slice(0, 6).forEach(e => {
            const time = e.start
              ? new Date(e.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
              : '';
            parts.push(`• ${e.title || e.summary}${time ? ` at ${time}` : ''}`);
          });
        }
      }

      return parts.join('\n') || 'No calendar events found.';
    }

    case 'get_emails': {
      const ctx = await getAllEmailContext(userId).catch(() => null);
      if (!ctx) return 'Email unavailable right now.';
      const all = [...(ctx.school || []), ...(ctx.personal || [])];
      if (all.length === 0) return 'Inbox looks clear — nothing important unread.';
      const lines = ['Important unread emails:'];
      all.slice(0, 6).forEach(e => {
        lines.push(`• "${e.subject}" from ${e.from}${e.isInternship ? ' [internship]' : ''}`);
      });
      return lines.join('\n');
    }

    case 'get_weather': {
      const w = await getTodaysForecast(userId).catch(() => null);
      if (!w) return 'Weather unavailable.';
      const rain = w.rainProbability > 30 ? `, ${w.rainProbability}% chance of rain` : '';
      return `${w.description}, ${w.temp}°F${rain}`;
    }

    case 'get_class_schedule': {
      const schedule = await getClassSchedule(userId).catch(() => null);
      if (!schedule || schedule.length === 0) return 'No class schedule on file yet.';
      const lines = ['Class schedule:'];
      schedule.forEach(c =>
        lines.push(`• ${c.name} — ${c.days} ${c.startTime}–${c.endTime}${c.location ? ` @ ${c.location}` : ''}`)
      );
      return lines.join('\n');
    }

    case 'set_reminder': {
      const remindAt = new Date(input.remind_at);
      if (isNaN(remindAt.getTime()) || remindAt <= new Date()) {
        return 'Could not set reminder — time must be in the future.';
      }
      await db.scheduleMessage(userId, remindAt, input.message, {}, 'reminder');
      return `Reminder set for ${remindAt.toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      })}.`;
    }

    case 'browse_web': {
      const agentUrl = process.env.PLAYWRIGHT_AGENT_URL;
      if (!agentUrl) return 'Browser agent not configured.';

      // Let the user know something is happening before we wait
      await sendMessage(user.phone_number ?? null, 'on it, give me a sec 🔍', userId)
        .catch(() => {});

      const taskId = `brain-${userId}-${Date.now()}`;
      const desc = input.url
        ? `${input.task} — start at ${input.url}`
        : input.task;

      const headers = {
        'Content-Type': 'application/json',
        ...(process.env.AGENT_SECRET ? { Authorization: `Bearer ${process.env.AGENT_SECRET}` } : {}),
      };

      const submitRes = await fetch(`${agentUrl}/tasks`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ taskId, userId: String(userId), description: desc }),
      }).catch(() => null);

      if (!submitRes || !submitRes.ok) return 'Browser task failed to start.';

      // Poll up to 4 minutes
      const deadline = Date.now() + 4 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 3000));
        const poll = await fetch(`${agentUrl}/tasks/${taskId}`, { headers }).catch(() => null);
        if (!poll || !poll.ok) continue;

        const task = await poll.json();

        if (task.status === 'done') {
          const results = (task.result?.results || [])
            .filter(r => r != null)
            .map(r => (typeof r === 'string' ? r : JSON.stringify(r, null, 2)))
            .join('\n\n');
          return results || 'Task completed but returned no text data.';
        }

        if (task.status === 'error' || task.status === 'cancelled') {
          return `Browser task failed: ${task.error || 'unknown error'}`;
        }
      }

      return 'Browser task timed out after 4 minutes.';
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ─── Tool retry helper ────────────────────────────────────────────────────────
// Retries transient failures (network, 5xx) but not auth errors (401/403).

async function executeToolWithRetry(name, input, userId, user, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await executeTool(name, input, userId, user);
    } catch (err) {
      const isAuth = err.message && (err.message.includes('401') || err.message.includes('403'));
      if (isAuth || attempt === retries) {
        return `Error: ${err.message}`;
      }
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return 'Tool failed after retries.';
}

// ─── Urgency detection ─────────────────────────────────────────────────────────
// Fast heuristic — no LLM call needed for obvious cases.

function isUrgentMessage(message) {
  const text = message.trim();
  // ALL CAPS message (3+ words uppercase)
  const words = text.split(/\s+/);
  const upperWords = words.filter(w => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w));
  if (upperWords.length >= 3) return true;

  const lower = text.toLowerCase();
  const urgentPhrases = ['emergency', 'urgent', 'asap', 'right now', 'immediately', 'help me', 'please help'];
  return urgentPhrases.some(p => lower.includes(p)) && text.length < 120;
}

// ─── Status command detection ─────────────────────────────────────────────────

const STATUS_PHRASES = [
  'what do you know about me',
  'what do you know',
  'what can you do',
  'what are your capabilities',
  "what's on my plate",
  'whats on my plate',
  'give me a summary',
  'show me everything',
  'what do i have',
  'catch me up',
];

function isStatusRequest(message) {
  const lower = message.toLowerCase().trim();
  return STATUS_PHRASES.some(p => lower.includes(p));
}

// ─── Agent loop ───────────────────────────────────────────────────────────────
// Runs the Claude tool-use loop until the model stops requesting tools
// (stop_reason === 'end_turn') or we hit MAX_ITERS to prevent runaway loops.

const MAX_TOOL_ITERS = 6;

async function runAgentLoop(systemPrompt, messages, tools, userId, user, opts = {}) {
  const client = getAnthropicClient();
  let loopMessages = [...messages];

  for (let i = 0; i < MAX_TOOL_ITERS; i++) {
    const apiOpts = {
      model: 'claude-sonnet-4-6',
      max_tokens: opts.maxTokens || 1024,
      system: systemPrompt,
      messages: loopMessages,
    };
    if (tools.length > 0) apiOpts.tools = tools;

    const res = await client.messages.create(apiOpts);

    const hasToolUse = res.content.some(b => b.type === 'tool_use');

    if (res.stop_reason === 'end_turn' || !hasToolUse) {
      return res.content.find(b => b.type === 'text')?.text?.trim() || '';
    }

    // Execute all requested tool calls (in parallel where safe)
    const toolUseBlocks = res.content.filter(b => b.type === 'tool_use');

    // browse_web must run sequentially (sends intermediate messages, long-running)
    // all other tools can run in parallel
    const browseBlocks = toolUseBlocks.filter(b => b.name === 'browse_web');
    const fastBlocks   = toolUseBlocks.filter(b => b.name !== 'browse_web');

    const fastResults = await Promise.all(
      fastBlocks.map(async b => ({
        type: 'tool_result',
        tool_use_id: b.id,
        content: await executeToolWithRetry(b.name, b.input, userId, user),
      }))
    );

    const browseResults = [];
    for (const b of browseBlocks) {
      browseResults.push({
        type: 'tool_result',
        tool_use_id: b.id,
        content: await executeToolWithRetry(b.name, b.input, userId, user, 0), // no retries for browse
      });
    }

    const toolResults = [...fastResults, ...browseResults];

    loopMessages = [
      ...loopMessages,
      { role: 'assistant', content: res.content },
      { role: 'user',      content: toolResults },
    ];
  }

  return '';
}

// ─── Gap context ──────────────────────────────────────────────────────────────

async function getGapContext(userId) {
  try {
    const lastMsg = await db.getLastUserMessageTime(userId);
    if (!lastMsg) return null;
    const hours = (Date.now() - new Date(lastMsg)) / 3600000;
    if (hours < 12) return null;
    if (hours < 24) return "user hasn't texted since yesterday";
    const days = Math.floor(hours / 24);
    if (days < 3) return `user hasn't texted in ${days} days`;
    return `user hasn't texted in ${days} days — a notable absence. acknowledge it warmly but don't make it weird`;
  } catch {
    return null;
  }
}

// ─── Academic calendar context ────────────────────────────────────────────────

function getAcademicContext() {
  try {
    const now = new Date();
    const parts = [];
    if (isFinalsWeek(now)) {
      parts.push('It is currently finals week — acknowledge heightened stress naturally.');
    } else {
      const daysLeft = daysUntilExams(now);
      if (daysLeft !== null && daysLeft <= 14) {
        parts.push(`Finals are ${daysLeft} days away — students are starting to feel the pressure.`);
      }
    }
    if (isOnBreak(now)) {
      parts.push('School is currently on break — be more relaxed and conversational.');
    }
    const week = getCurrentSemesterWeek(now);
    if (week !== null) {
      parts.push(`It is week ${week} of the semester.`);
    }
    return parts.length > 0 ? `\n\nAcademic calendar: ${parts.join(' ')}` : '';
  } catch {
    return '';
  }
}

// ─── Main response generator ──────────────────────────────────────────────────

async function getResponse(userId, userMessage) {
  const user = await db.getUserById(userId);

  if (isDeletionRequest(userMessage)) {
    await requestDeletion(userId);
    return '';
  }

  const urgent = isUrgentMessage(userMessage);

  // Fire typing indicator immediately — don't await (skip for urgent, reply faster)
  if (!urgent) {
    sendTypingIndicator(user?.phone_number ?? null, userId);
  }

  // Fetch supporting context in parallel
  const [memories, styleContext, gapContext, formatHint] = await Promise.all([
    searchMemories(userId, userMessage, 5).catch(() => []),
    getStyleContext(userId),
    getGapContext(userId),
    Promise.resolve().then(() => getResponseFormatHint(userId)).catch(() => null),
  ]);

  const memoryBlock = memories.length > 0
    ? `\n\nWhat you remember about ${user?.name || 'this user'}:\n${memories.map(m => m.text).join('\n')}\nUse naturally. Don't recite back.`
    : '';

  const gapBlock = gapContext
    ? `\n\nNote: ${gapContext}. A real friend would notice — react naturally, don't ignore it.`
    : '';

  const formatBlock = formatHint === 'brief'
    ? '\n\nThis person strongly prefers very short responses — 1-2 sentences max. Be direct.'
    : '';

  const academicBlock = getAcademicContext();

  const systemPrompt =
    parseSoul() +
    (user?.name ? `\n\nUser's name: ${user.name}` : '') +
    (styleContext ? `\n\n${styleContext}` : '') +
    memoryBlock +
    gapBlock +
    formatBlock +
    academicBlock;

  const history = await db.getRecentMessages(userId, 15);

  // ── Fix: map history correctly, keeping summaries as system context not fake user turns ──
  const historyMessages = history
    .filter(m => m.role !== 'system') // system summaries injected separately below
    .map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));

  // Inject any summary rows as a single leading context note (not as fake messages)
  const summaries = history.filter(m => m.role === 'system' && m.is_summary);
  const summaryBlock = summaries.length > 0
    ? `\n\n[Earlier conversation summary]: ${summaries.map(m => m.content.replace('[Summary of earlier conversation]: ', '')).join(' | ')}`
    : '';

  // ── Proactive threading: if user is replying to a recent proactive message, inject it ──
  let proactiveThreadBlock = '';
  try {
    const recentProactive = await db.getRecentProactiveSent(userId, 120);
    if (recentProactive && recentProactive.content) {
      proactiveThreadBlock = `\n\nContext: You recently sent this proactive message to the user (${Math.round((Date.now() - new Date(recentProactive.created_at)) / 60000)} minutes ago): "${recentProactive.content.slice(0, 300)}" — the user may be responding to this.`;
    }
  } catch { /* non-critical */ }

  const finalSystemPrompt = systemPrompt + summaryBlock + proactiveThreadBlock;

  const messages = [
    ...historyMessages,
    { role: 'user', content: userMessage },
  ];

  const tools = getToolsForUser(user);

  // Handle status/capability requests with a focused handler
  if (isStatusRequest(userMessage)) {
    const rawResponse = await runAgentLoop(
      finalSystemPrompt,
      messages,
      tools,
      userId,
      user,
      { maxTokens: 600 }
    );
    if (rawResponse) {
      await db.saveMessage(userId, 'user', userMessage);
      await db.saveMessage(userId, 'assistant', rawResponse);
      return rawResponse;
    }
  }

  // Run the agent loop — Claude decides which tools to call, executes them,
  // and generates a final response grounded in real data.
  const loopOpts = urgent ? { maxTokens: 512 } : {};
  if (urgent) console.log(`[brain] urgent message detected for user ${userId}`);

  const rawResponse = await runAgentLoop(finalSystemPrompt, messages, tools, userId, user, loopOpts);

  // Strip any accidental ACTION tags (legacy)
  const actionMatch = rawResponse.match(/\[ACTION:\s*([^|]+)\|([^|]+)\|([^\]]+)\]/);
  const cleanResponse = actionMatch
    ? rawResponse.replace(actionMatch[0], '').trim()
    : rawResponse;

  if (!cleanResponse) return '';

  await db.saveMessage(userId, 'user', userMessage);
  await db.saveMessage(userId, 'assistant', cleanResponse);

  await compactHistory(userId);

  db.updateMorningBriefEngagement(userId, userMessage.length).catch(() => {});

  // Fire-and-forget feedback capture
  const prevAgentResult = await db.query(
    `SELECT content FROM messages
     WHERE user_id = $1 AND role = 'assistant'
     ORDER BY created_at DESC LIMIT 1 OFFSET 1`,
    [userId]
  );
  captureConversationFeedback(
    userId,
    userMessage,
    prevAgentResult.rows[0]?.content || null
  ).catch(() => {});

  captureFeedback(userId, userMessage).catch(() => {});

  const lastSentResult = await db.query(
    `SELECT type, content FROM sent_messages
     WHERE user_id = $1
     AND type IN ('proactive','event_reminder','canvas_alert','health_nudge','nightly_digest','important_email_alert')
     AND created_at > NOW() - INTERVAL '30 minutes'
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (lastSentResult.rows.length > 0) {
    const { type: trigType, content: trigContent } = lastSentResult.rows[0];
    captureProactiveFeedback(userId, trigType, hashContext(trigContent), userMessage).catch(() => {});
  }

  return cleanResponse;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hashContext(text) {
  if (!text) return 'default';
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

async function captureFeedback(userId, userMessage) {
  const recentProactive = await db.getMostRecentProactiveSent(userId, 30);
  if (!recentProactive) return;

  const parts = recentProactive.type.split(':');
  if (parts.length < 3) return;
  const triggerType = parts[1];
  const contextHash = parts[2];

  let sentiment;
  try {
    const raw = await classify(
      `Did this user reply positively, negatively, or neutrally to a proactive message?\nReturn JSON: {"sentiment": "positive"|"negative"|"neutral"}\nUser message: ${userMessage}`,
      50
    );
    const parsed = JSON.parse(raw.trim());
    sentiment = parsed.sentiment;
  } catch {
    return;
  }

  if (!['positive', 'negative', 'neutral'].includes(sentiment)) return;
  await db.updatePreference(userId, triggerType, contextHash, sentiment === 'positive');
}

async function compactHistory(userId) {
  const count = await db.getMessageCount(userId);
  if (count <= 20) return;

  const messages = await db.getRecentMessages(userId, count);
  const oldest = messages.slice(0, 10);

  const summaryPrompt =
    `Summarize this conversation snippet concisely in 2-3 sentences, capturing key facts and context:\n\n` +
    oldest.map(m => `${m.role}: ${m.content}`).join('\n');

  const summary = await classify(summaryPrompt);

  if (!summary || summary.trim().length < 15) {
    console.warn(`[compactHistory] skipping compaction for user ${userId} — summary too short`);
    return;
  }

  const ids = oldest.map(m => m.id);
  await db.deleteMessages(userId, ids);
  await db.saveMessage(userId, 'system', `[Summary of earlier conversation]: ${summary}`, true);
}

module.exports = { getResponse, compactHistory, hashContext, getGapContext };
