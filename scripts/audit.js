'use strict';

require('dotenv').config();

const db = require('../src/db');
const canvas = require('../src/integrations/canvas');
const outlook = require('../src/integrations/outlook');
const gmail = require('../src/integrations/gmail');
const { fetchAndStoreRealtimeData, getNextBuses } = require('../src/integrations/bt_bus');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const OK   = '\x1b[32m✓\x1b[0m';
const WARN = '\x1b[33m⚠\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const INFO = '\x1b[36m•\x1b[0m';

function pass(label, detail = '') { console.log(`  ${OK} ${label}${detail ? ' — ' + detail : ''}`); }
function warn(label, detail = '') { console.log(`  ${WARN} ${label}${detail ? ' — ' + detail : ''}`); }
function fail(label, detail = '') { console.log(`  ${FAIL} ${label}${detail ? ' — ' + detail : ''}`); }
function info(label, detail = '') { console.log(`  ${INFO} ${label}${detail ? ' — ' + detail : ''}`); }

const results = [];
function record(tool, status, detail) {
  results.push({ tool, status, detail });
}

// ─── 1. Canvas ────────────────────────────────────────────────────────────────

async function auditCanvas(userId) {
  console.log('\n\x1b[1m[1] Canvas API\x1b[0m');

  // Check token exists
  const user = await db.getUserById(userId);
  if (!user?.canvas_token) {
    fail('No canvas_token for this user');
    record('Canvas', 'broken', 'No token in DB');
    return;
  }
  pass('canvas_token present', user.canvas_base_url);

  // Enrolled courses
  try {
    const courses = await canvas.getEnrolledCourses(userId);
    if (!courses.length) {
      warn('getEnrolledCourses returned empty', 'may be break/end of semester');
      record('Canvas courses', 'warn', 'empty');
    } else {
      pass(`getEnrolledCourses: ${courses.length} active courses`, courses.slice(0, 3).map(c => c.name || c.course_code).join(', '));
    }
  } catch (err) {
    fail('getEnrolledCourses threw', err.message);
    record('Canvas courses', 'broken', err.message);
  }

  // Upcoming assignments — next 7 days
  try {
    const upcoming = await canvas.getUpcomingAssignments(userId, 7);
    if (!upcoming.length) {
      warn('getUpcomingAssignments (7 days) returned empty');
    } else {
      pass(`getUpcomingAssignments 7d: ${upcoming.length} items`);
      upcoming.slice(0, 3).forEach(a => {
        const due = a.end_at || a.due_at || 'no due date';
        info(`  ${a.title || a.assignment?.name || '(untitled)'} — due ${due}`);
      });
    }
  } catch (err) {
    fail('getUpcomingAssignments threw', err.message);
    record('Canvas upcoming', 'broken', err.message);
  }

  // Wider window — next 14 days (future bucket)
  try {
    const wider = await canvas.getUpcomingAssignments(userId, 14);
    if (!wider.length) {
      warn('getUpcomingAssignments (14 days) also empty — token may be expired or no active courses');
      record('Canvas upcoming 14d', 'warn', 'empty');
    } else {
      pass(`getUpcomingAssignments 14d: ${wider.length} items`);
      record('Canvas upcoming', 'ok', `${wider.length} items over 14 days`);
    }
  } catch (err) {
    fail('getUpcomingAssignments (14d) threw', err.message);
    record('Canvas upcoming 14d', 'broken', err.message);
  }

  // Missing assignments
  try {
    const missing = await canvas.getMissingAssignments(userId);
    if (missing.length) {
      warn(`getMissingAssignments: ${missing.length} missing`, missing.slice(0, 2).map(a => a.name || a.title).join(', '));
    } else {
      pass('getMissingAssignments: none missing');
    }
    record('Canvas missing', 'ok', `${missing.length} missing`);
  } catch (err) {
    fail('getMissingAssignments threw', err.message);
    record('Canvas missing', 'broken', err.message);
  }

  // Grades
  try {
    const grades = await canvas.getCourseGrades(userId);
    if (!grades.length) {
      warn('getCourseGrades returned empty');
      record('Canvas grades', 'warn', 'empty');
    } else {
      pass(`getCourseGrades: ${grades.length} courses with grade data`);
      grades.slice(0, 3).forEach(g => info(`  ${g.name}: ${g.currentGrade ?? g.current_grade ?? 'N/A'}`));
      record('Canvas grades', 'ok', `${grades.length} courses`);
    }
  } catch (err) {
    fail('getCourseGrades threw', err.message);
    record('Canvas grades', 'broken', err.message);
  }

  // Raw API check — call /api/v1/users/self to confirm token validity
  try {
    const { token, baseUrl } = await canvas.getCanvasClient(userId);
    const res = await fetch(`${baseUrl}/api/v1/users/self`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const self = await res.json();
      pass('Token valid — /api/v1/users/self', `${self.name} (id: ${self.id})`);
      record('Canvas token', 'ok', `${self.name}`);
    } else {
      fail(`Token check returned HTTP ${res.status}`, 'token may be expired');
      record('Canvas token', 'broken', `HTTP ${res.status}`);
    }
  } catch (err) {
    fail('Token check threw', err.message);
    record('Canvas token', 'broken', err.message);
  }
}

// ─── 2. Google Calendar ───────────────────────────────────────────────────────

async function auditGoogleCalendar(userId) {
  console.log('\n\x1b[1m[2] Google Calendar\x1b[0m');

  const user = await db.getUserById(userId);
  if (!user?.google_refresh_token) {
    fail('No google_refresh_token for this user');
    record('Google Calendar', 'broken', 'No token');
    return;
  }
  pass('google_refresh_token present', user.google_email || '(no email stored)');

  try {
    const { google } = require('googleapis');
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth2Client.setCredentials({ refresh_token: user.google_refresh_token });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 2);

    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: tomorrow.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 10,
    });

    const events = res.data.items || [];
    if (!events.length) {
      warn('Google Calendar: no events in next 48h');
      record('Google Calendar', 'warn', 'No events next 48h');
    } else {
      pass(`Google Calendar: ${events.length} events in next 48h`);
      events.slice(0, 5).forEach(e => {
        const start = e.start?.dateTime || e.start?.date || '?';
        info(`  ${e.summary || '(no title)'} @ ${start}`);
      });
      record('Google Calendar', 'ok', `${events.length} events`);
    }
  } catch (err) {
    fail('Google Calendar threw', err.message);
    if (err.message?.includes('invalid_grant') || err.message?.includes('Token has been expired')) {
      fail('Token is EXPIRED — user needs to re-auth Google');
      record('Google Calendar', 'broken', 'Token expired — re-auth required');
    } else {
      record('Google Calendar', 'broken', err.message);
    }
  }
}

// ─── 3. Microsoft Outlook ─────────────────────────────────────────────────────

async function auditOutlook(userId) {
  console.log('\n\x1b[1m[3] Microsoft Outlook\x1b[0m');

  const user = await db.getUserById(userId);
  if (!user?.microsoft_refresh_token) {
    fail('No microsoft_refresh_token for this user');
    record('Outlook', 'broken', 'No token');
    return;
  }
  pass('microsoft_refresh_token present');

  // Emails
  try {
    const emails = await outlook.getUnreadEmails(userId, 5);
    if (!emails.length) {
      warn('getUnreadEmails returned 0 — inbox may be clear or token expired');
      record('Outlook email', 'warn', 'empty');
    } else {
      pass(`getUnreadEmails: ${emails.length} unread emails`);
      emails.slice(0, 3).forEach(e => info(`  "${e.subject}" from ${e.from?.emailAddress?.name}`));
      record('Outlook email', 'ok', `${emails.length} unread`);
    }
  } catch (err) {
    fail('getUnreadEmails threw', err.message);
    if (err.message?.includes('expired') || err.message?.includes('invalid') || err.message?.includes('unauthorized')) {
      fail('Outlook token appears EXPIRED');
      record('Outlook email', 'broken', 'Token expired');
    } else {
      record('Outlook email', 'broken', err.message);
    }
  }

  // Calendar
  try {
    const events = await outlook.getTodaysEvents(userId);
    if (!events.length) {
      warn('getTodaysEvents returned 0 — no meetings today');
      record('Outlook calendar', 'warn', 'No events today');
    } else {
      pass(`getTodaysEvents: ${events.length} events today`);
      events.slice(0, 3).forEach(e => {
        const start = e.start?.dateTime || e.start?.date || '?';
        info(`  ${e.subject || '(no title)'} @ ${start}`);
      });
      record('Outlook calendar', 'ok', `${events.length} events`);
    }
  } catch (err) {
    fail('getTodaysEvents threw', err.message);
    record('Outlook calendar', 'broken', err.message);
  }
}

// ─── 4. Gmail ─────────────────────────────────────────────────────────────────

async function auditGmail(userId) {
  console.log('\n\x1b[1m[4] Gmail\x1b[0m');

  const user = await db.getUserById(userId);
  if (!user?.google_refresh_token) {
    fail('No google_refresh_token for Gmail');
    record('Gmail', 'broken', 'No token');
    return;
  }
  pass('google_refresh_token present', user.google_email || '(no email stored)');

  try {
    const emails = await gmail.getUnreadEmails(userId, 5);
    if (!emails.length) {
      warn('getUnreadEmails (Gmail) returned 0 — inbox may be clear');
      record('Gmail', 'warn', 'empty');
    } else {
      pass(`getUnreadEmails (Gmail): ${emails.length} unread`);
      emails.slice(0, 3).forEach(e => info(`  "${e.subject}" from ${e.from}`));
      record('Gmail', 'ok', `${emails.length} unread`);
    }
  } catch (err) {
    fail('Gmail getUnreadEmails threw', err.message);
    if (err.message?.includes('invalid_grant') || err.message?.includes('Token has been expired')) {
      fail('Gmail token is EXPIRED — user needs to re-auth Google');
      record('Gmail', 'broken', 'Token expired');
    } else {
      record('Gmail', 'broken', err.message);
    }
  }
}

// ─── 5. Telegram ─────────────────────────────────────────────────────────────

async function auditTelegram() {
  console.log('\n\x1b[1m[5] Telegram\x1b[0m');

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    fail('TELEGRAM_BOT_TOKEN not set in .env');
    record('Telegram', 'broken', 'No bot token configured');
    return;
  }
  pass('TELEGRAM_BOT_TOKEN set');

  // Check getMe
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json();
    if (!data.ok) {
      fail('getMe failed', JSON.stringify(data.description));
      record('Telegram bot', 'broken', data.description);
      return;
    }
    pass('Bot identity', `@${data.result.username} (${data.result.first_name})`);
    record('Telegram bot', 'ok', `@${data.result.username}`);
  } catch (err) {
    fail('getMe threw', err.message);
    record('Telegram bot', 'broken', err.message);
    return;
  }

  // Check webhook
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const data = await res.json();
    if (!data.ok) {
      fail('getWebhookInfo failed');
      record('Telegram webhook', 'broken', 'API error');
      return;
    }
    const wh = data.result;
    if (!wh.url) {
      warn('No webhook URL registered — bot will not receive messages unless polling');
      record('Telegram webhook', 'warn', 'No webhook set');
    } else {
      pass('Webhook URL', wh.url);
      if (wh.last_error_message) {
        warn(`Last webhook error: ${wh.last_error_message} (${wh.last_error_date ? new Date(wh.last_error_date * 1000).toISOString() : 'unknown time'})`);
        record('Telegram webhook', 'warn', wh.last_error_message);
      } else {
        pass('Webhook: no recent errors');
        record('Telegram webhook', 'ok', wh.url);
      }
      info(`  Pending updates: ${wh.pending_update_count}`);
      info(`  Max connections: ${wh.max_connections}`);
    }
  } catch (err) {
    fail('getWebhookInfo threw', err.message);
    record('Telegram webhook', 'broken', err.message);
  }

  // Check if any DB user has telegram_chat_id
  try {
    const pool = db._pool || db.pool;
    // Use raw query via db module
    const users = await db.getAllActiveUsers();
    const tgUsers = users.filter(u => u.telegram_chat_id);
    if (!tgUsers.length) {
      warn('No users have telegram_chat_id in DB — no Telegram users onboarded yet');
      record('Telegram users', 'warn', 'No users');
    } else {
      pass(`${tgUsers.length} user(s) have telegram_chat_id`);
      record('Telegram users', 'ok', `${tgUsers.length} users`);
    }
  } catch (err) {
    info('Could not check DB for Telegram users: ' + err.message);
  }
}

// ─── 6. Playwright Agent ──────────────────────────────────────────────────────

async function auditPlaywright() {
  console.log('\n\x1b[1m[6] Playwright Agent\x1b[0m');

  const agentUrl = process.env.PLAYWRIGHT_AGENT_URL;
  if (!agentUrl) {
    warn('PLAYWRIGHT_AGENT_URL not set — checking local port 3001');
  }

  // Try local first, then configured URL
  const urls = [];
  if (agentUrl) urls.push(agentUrl.replace(/\/$/, ''));
  urls.push('http://localhost:3001');

  let reachable = false;
  let baseUrl = null;

  for (const url of urls) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        pass(`Playwright agent reachable at ${url}`, `activeTasks=${data.activeTasks}, totalTasks=${data.totalTasks}`);
        record('Playwright health', 'ok', url);
        reachable = true;
        baseUrl = url;
        break;
      } else {
        warn(`${url}/health returned HTTP ${res.status}`);
      }
    } catch (err) {
      if (err.name === 'TimeoutError') {
        fail(`${url}/health timed out`);
      } else {
        fail(`${url}/health unreachable`, err.message);
      }
    }
  }

  if (!reachable) {
    fail('Playwright agent is NOT reachable on any configured URL');
    record('Playwright agent', 'broken', 'Not reachable — not running or wrong URL');
    info('  Start it with: cd playwright-agent && node index.js');
    info('  Or check Fly.io deployment: fly status -a comet-playwright');
    return;
  }

  // Check agent.json capabilities
  try {
    const res = await fetch(`${baseUrl}/.well-known/agent.json`, { signal: AbortSignal.timeout(5000) });
    const meta = await res.json();
    pass(`Agent version ${meta.version}, endpoint: ${meta.endpoint}`);
    pass(`Capabilities: ${meta.capabilities.join(', ')}`);
    record('Playwright capabilities', 'ok', `v${meta.version}`);
  } catch (err) {
    warn('Could not fetch agent.json: ' + err.message);
  }

  // Submit a real test task
  const taskId = `audit-${Date.now()}`;
  try {
    const postRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        userId: 'audit-test',
        description: 'Navigate to https://example.com and scrape the h1 heading text',
        timeoutMs: 30000,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!postRes.ok) {
      fail(`POST /tasks returned HTTP ${postRes.status}`, await postRes.text());
      record('Playwright task', 'broken', `HTTP ${postRes.status}`);
      return;
    }

    const queued = await postRes.json();
    pass(`Task queued: ${queued.taskId} (${queued.status})`);

    // Poll for result (max 40s)
    let taskResult = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const pollRes = await fetch(`${baseUrl}/tasks/${taskId}`, { signal: AbortSignal.timeout(5000) });
      const data = await pollRes.json();
      if (['done', 'error', 'cancelled'].includes(data.status)) {
        taskResult = data;
        break;
      }
      process.stdout.write('.');
    }
    console.log('');

    if (!taskResult) {
      warn('Task did not complete within 40s');
      record('Playwright task', 'warn', 'timeout polling for result');
      return;
    }

    if (taskResult.status === 'done') {
      const results = taskResult.result?.results || [];
      pass(`Task completed — ${results.length} scraped result(s)`);
      results.forEach(r => info(`  selector=${r.selector}: "${r.value}"`));
      if (taskResult.screenshots?.length) pass(`Screenshot captured (${taskResult.screenshots.length})`);
      record('Playwright task', 'ok', `${results.length} results`);
    } else {
      fail(`Task ended with status=${taskResult.status}`, taskResult.error);
      record('Playwright task', 'broken', taskResult.error);
    }
  } catch (err) {
    fail('Playwright task submission threw', err.message);
    record('Playwright task', 'broken', err.message);
  }
}

// ─── 7. VT Bus ────────────────────────────────────────────────────────────────

async function auditBus() {
  console.log('\n\x1b[1m[7] VT Bus (Blacksburg Transit)\x1b[0m');

  const realtimeUrl = process.env.BT_REALTIME_TRIP_UPDATES_URL;
  if (!realtimeUrl) {
    fail('BT_REALTIME_TRIP_UPDATES_URL not set');
    record('VT Bus', 'broken', 'No realtime URL configured');
    return;
  }
  pass('BT_REALTIME_TRIP_UPDATES_URL set');

  // Fetch raw protobuf feed to verify it's reachable
  try {
    const res = await fetch(realtimeUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      fail(`Realtime feed returned HTTP ${res.status}`);
      record('VT Bus feed', 'broken', `HTTP ${res.status}`);
      return;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    pass(`Realtime feed reachable — ${buf.byteLength} bytes received`);
    record('VT Bus feed', 'ok', `${buf.byteLength} bytes`);
  } catch (err) {
    fail('Realtime feed request threw', err.message);
    record('VT Bus feed', 'broken', err.message);
    return;
  }

  // Parse and store via fetchAndStoreRealtimeData
  try {
    const count = await fetchAndStoreRealtimeData();
    if (count === 0 || count == null) {
      warn('fetchAndStoreRealtimeData returned 0 rows stored — may be off-hours');
      record('VT Bus parse', 'warn', '0 rows stored');
    } else {
      pass(`fetchAndStoreRealtimeData: ${count} arrival rows stored`);
      record('VT Bus parse', 'ok', `${count} rows`);
    }
  } catch (err) {
    fail('fetchAndStoreRealtimeData threw', err.message);
    record('VT Bus parse', 'broken', err.message);
  }

  // Query a known stop
  const testStops = ['CPAT', 'COLG', 'SQRS', 'LIBR'];
  let foundAny = false;
  for (const stopId of testStops) {
    try {
      const buses = await getNextBuses(stopId, 3);
      if (buses.length) {
        pass(`getNextBuses(${stopId}): ${buses.length} upcoming arrivals`);
        buses.forEach(b => info(`  Route ${b.route_id || b.routeId}: ~${b.arrival_time || b.arrivalTime}`));
        record('VT Bus stops', 'ok', `${stopId} has arrivals`);
        foundAny = true;
        break;
      }
    } catch (err) {
      info(`getNextBuses(${stopId}): ${err.message}`);
    }
  }
  if (!foundAny) {
    warn('No arrivals found at any test stop (CPAT, COLG, SQRS, LIBR) — may be off-hours or weekend');
    record('VT Bus stops', 'warn', 'No arrivals at test stops');
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\x1b[1m\x1b[35m═══════════════════════════════════════════');
  console.log('  Comet Integration Audit');
  console.log('  ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════\x1b[0m');

  // Find an active user with Canvas token to test with
  let testUserId = null;
  let testUserName = '';
  try {
    const users = await db.getAllActiveUsers();
    const withCanvas = users.find(u => u.canvas_token);
    if (withCanvas) {
      testUserId = withCanvas.id;
      testUserName = withCanvas.name || `user#${withCanvas.id}`;
      console.log(`\n${INFO} Testing with user: ${testUserName} (id=${testUserId})`);
    } else if (users.length) {
      testUserId = users[0].id;
      testUserName = users[0].name || `user#${users[0].id}`;
      console.log(`\n${WARN} No Canvas user found — using ${testUserName} (id=${testUserId}) for other checks`);
    } else {
      console.log(`\n${FAIL} No active users in DB — cannot test per-user integrations`);
    }
  } catch (err) {
    console.log(`\n${FAIL} DB connection failed: ${err.message}`);
    process.exit(1);
  }

  // Run all audits
  if (testUserId) {
    await auditCanvas(testUserId);
    await auditGoogleCalendar(testUserId);
    await auditOutlook(testUserId);
    await auditGmail(testUserId);
  } else {
    [1,2,3,4].forEach(i => {
      console.log(`\n[${i}] Skipped — no active user in DB`);
    });
  }

  await auditTelegram();
  await auditPlaywright();
  await auditBus();

  // ─── Summary ────────────────────────────────────────────────────────────────

  console.log('\n\x1b[1m\x1b[35m═══════════════════════════════════════════');
  console.log('  AUDIT SUMMARY');
  console.log('═══════════════════════════════════════════\x1b[0m');

  const grouped = { ok: [], warn: [], broken: [] };
  for (const r of results) {
    grouped[r.status]?.push(r) ?? grouped.warn.push(r);
  }

  if (grouped.ok.length) {
    console.log(`\n${OK} \x1b[32mWORKING (${grouped.ok.length})\x1b[0m`);
    grouped.ok.forEach(r => console.log(`  ${r.tool}: ${r.detail}`));
  }

  if (grouped.warn.length) {
    console.log(`\n${WARN} \x1b[33mWARNINGS / EMPTY (${grouped.warn.length})\x1b[0m`);
    grouped.warn.forEach(r => console.log(`  ${r.tool}: ${r.detail}`));
  }

  if (grouped.broken.length) {
    console.log(`\n${FAIL} \x1b[31mBROKEN (${grouped.broken.length})\x1b[0m`);
    grouped.broken.forEach(r => console.log(`  ${r.tool}: ${r.detail}`));
  }

  const total = results.length;
  const score = grouped.ok.length;
  console.log(`\n\x1b[1mScore: ${score}/${total} checks passing\x1b[0m`);

  if (grouped.broken.length === 0 && grouped.warn.length === 0) {
    console.log('\x1b[32mAll integrations healthy!\x1b[0m');
  }

  // pg pool doesn't export end() from db module — process.exit handles cleanup
  process.exit(0);
}

main().catch(err => {
  console.error('\x1b[31mAudit script crashed:\x1b[0m', err);
  process.exit(1);
});
