'use strict';

require('dotenv').config();

const express = require('express');
const { launch, newContext, newPage, closeContext, closeBrowser } = require('./browser');
const { planTask } = require('./planner');
const { executePlan, getAriaSnapshot, isSsrfTarget } = require('./executor');
const { ensureTable, hostnameFromUrl, loadSession, saveSession, clearSession, listSessions } = require('./sessions');
const {
  createTask,
  getTask,
  updateTask,
  getActiveCount,
  atCapacity,
  incrementActive,
  decrementActive,
  enqueue,
  drainQueue,
  getTaskCount,
} = require('./tasks');

const app = express();
const PORT = process.env.PORT || 3001;

// Default 4 min; tasks may request up to 10 min via timeoutMs body field.
const DEFAULT_TIMEOUT_MS = Number(process.env.DEFAULT_TASK_TIMEOUT_MS) || 240_000;
const MAX_TIMEOUT_MS = 600_000;

app.use(express.json());

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const secret = process.env.AGENT_SECRET;
  if (!secret) return next();

  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ') || header.slice(7) !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── GET /health ──────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeTasks: getActiveCount(), totalTasks: getTaskCount() });
});

// ─── GET /.well-known/agent.json ──────────────────────────────────────────────

app.get('/.well-known/agent.json', (req, res) => {
  res.json({
    name: 'playwright-agent',
    version: '1.3.0',
    capabilities: [
      'web_search', 'form_fill', 'page_scrape', 'scrape_list',
      'click_navigate', 'screenshot', 'dropdown_select',
      'keyboard_input', 'hover', 'smart_wait', 'self_healing',
      'table_extract', 'js_evaluate', 'iframe_support',
      'network_wait', 'scroll_to_element', 'login_flows',
      'multi_step_forms', 'pagination', 'spa_support',
      'persistent_sessions',
    ],
    endpoint: `${process.env.PUBLIC_URL || `http://localhost:${PORT}`}/tasks`,
  });
});

// ─── Core task runner ─────────────────────────────────────────────────────────

async function runTask(taskId) {
  const task = getTask(taskId);
  if (!task) return;

  let context = null;
  let page = null;
  incrementActive();
  updateTask(taskId, { status: 'running' });

  let timeoutHandle = null;

  // Determine the primary hostname from the task description so we can load
  // and save the right session.
  const urlMatch = task.description.match(/https?:\/\/[^\s,)"']+/i);
  const startUrl = urlMatch ? urlMatch[0].replace(/[.,;:!?]+$/, '') : null;
  const sessionHostname = hostnameFromUrl(startUrl);

  try {
    // ── Phase 0: load saved session (if any) ─────────────────────────────────
    let storageState = null;
    if (task.userId && sessionHostname) {
      storageState = await loadSession(task.userId, sessionHostname);
      if (storageState) {
        console.log(`[runTask] loaded session for ${task.userId}@${sessionHostname}`);
        updateTask(taskId, { sessionLoaded: true, sessionHostname });
      }
    }

    // ── Phase 1: create context + page ───────────────────────────────────────
    context = await newContext(storageState);
    page = await newPage(context);

    // ── Phase 2: pre-navigate if the description contains a URL ──────────────
    if (startUrl && !isSsrfTarget(startUrl)) {
      try {
        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      } catch (e) {
        console.warn(`[runTask] pre-navigate failed (non-fatal): ${e.message}`);
      }
    }

    // ── Phase 3: snapshot the ARIA tree and feed it to the planner ────────────
    const ariaSnapshot = await getAriaSnapshot(page);
    const steps = await planTask(task.description, task.context, ariaSnapshot);

    if (task.cancelled) {
      updateTask(taskId, { status: 'cancelled', error: 'Task cancelled before execution' });
      return;
    }

    // ── Phase 4: execute with timeout ────────────────────────────────────────
    const timeoutMs = Math.min(
      Math.max(Number(task.timeoutMs) || DEFAULT_TIMEOUT_MS, 30_000),
      MAX_TIMEOUT_MS
    );

    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Task timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
    });

    const { results, screenshots } = await Promise.race([
      executePlan(steps, page),
      timeoutPromise,
    ]);

    updateTask(taskId, {
      status: 'done',
      result: { steps, results },
      screenshots,
    });

  } catch (err) {
    // Best-effort error screenshot
    const errorScreenshots = [];
    if (page) {
      try {
        const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
        errorScreenshots.push(buf.toString('base64'));
      } catch { /* ignore */ }
    }

    updateTask(taskId, {
      status: task.cancelled ? 'cancelled' : 'error',
      error: err.message,
      screenshots: errorScreenshots,
    });

  } finally {
    clearTimeout(timeoutHandle);

    // ── Always save the session state, even on failure ────────────────────────
    // A partially-completed auth flow (e.g. got through SSO but hit a timeout)
    // still has useful cookies that can be reused on the next attempt.
    if (context && task.userId && sessionHostname) {
      try {
        const updatedState = await context.storageState();
        await saveSession(task.userId, sessionHostname, updatedState);
      } catch (err) {
        console.warn(`[runTask] session save failed for ${sessionHostname}:`, err.message);
      }
    }

    await closeContext(context);
    decrementActive();
    drainQueue();
  }
}

function scheduleTask(taskId) {
  if (atCapacity()) {
    enqueue(() => runTask(taskId));
  } else {
    setImmediate(() => runTask(taskId));
  }
}

// ─── POST /tasks ──────────────────────────────────────────────────────────────

app.post('/tasks', requireAuth, (req, res) => {
  const { taskId, description, context, userId, timeoutMs } = req.body ?? {};

  if (!taskId || typeof taskId !== 'string') {
    return res.status(400).json({ error: 'taskId is required' });
  }
  if (!description || typeof description !== 'string') {
    return res.status(400).json({ error: 'description is required' });
  }
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }
  if (getTask(taskId)) {
    return res.status(409).json({ error: 'taskId already exists' });
  }

  createTask(taskId, userId, description, context, timeoutMs);
  scheduleTask(taskId);

  res.status(202).json({ taskId, status: 'queued' });
});

// ─── GET /tasks/:taskId ───────────────────────────────────────────────────────

app.get('/tasks/:taskId', requireAuth, (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const { taskId, status, result, error, screenshots, sessionLoaded, sessionHostname } = task;
  res.json({ taskId, status, result, error, screenshots, sessionLoaded, sessionHostname });
});

// ─── POST /tasks/:taskId/cancel ───────────────────────────────────────────────

app.post('/tasks/:taskId/cancel', requireAuth, (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  if (['done', 'error', 'cancelled'].includes(task.status)) {
    return res.json({ taskId: task.taskId, status: task.status, message: 'Task already finished' });
  }

  updateTask(req.params.taskId, { cancelled: true, status: 'cancelled', error: 'Cancelled by request' });
  res.json({ taskId: task.taskId, status: 'cancelled' });
});

// ─── Session management ───────────────────────────────────────────────────────

// GET /sessions/:userId — list all saved sessions for a user
app.get('/sessions/:userId', requireAuth, async (req, res) => {
  try {
    const sessions = await listSessions(req.params.userId);
    res.json({ userId: req.params.userId, sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /sessions/:userId/:hostname — clear a specific saved session
// Useful when a user changes their password or explicitly logs out.
app.delete('/sessions/:userId/:hostname', requireAuth, async (req, res) => {
  try {
    await clearSession(req.params.userId, req.params.hostname);
    res.json({ ok: true, userId: req.params.userId, hostname: req.params.hostname });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /sessions/:userId — clear ALL saved sessions for a user
app.delete('/sessions/:userId', requireAuth, async (req, res) => {
  try {
    const sessions = await listSessions(req.params.userId);
    for (const s of sessions) {
      await clearSession(req.params.userId, s.hostname);
    }
    res.json({ ok: true, userId: req.params.userId, cleared: sessions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function startup() {
  await ensureTable();
  await launch();

  app.listen(PORT, () => {
    console.log(`playwright-agent listening on port ${PORT}`);
  });
}

process.on('SIGTERM', async () => {
  console.log('SIGTERM — shutting down');
  await closeBrowser();
  process.exit(0);
});

if (require.main === module) {
  startup().catch(err => {
    console.error('startup failed:', err);
    process.exit(1);
  });
}

module.exports = app;
