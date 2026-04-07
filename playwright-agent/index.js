'use strict';

require('dotenv').config();

const express = require('express');
const { launch, newPage, closeBrowser } = require('./browser');
const { planTask } = require('./planner');
const { executePlan } = require('./executor');
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
} = require('./tasks');

const app = express();
const PORT = process.env.PORT || 3001;
const TASK_TIMEOUT_MS = 90_000;

app.use(express.json());

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const secret = process.env.AGENT_SECRET;
  if (!secret) return next(); // no secret configured → open (dev only)

  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ') || header.slice(7) !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── GET /health ──────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeTasks: getActiveCount() });
});

// ─── GET /.well-known/agent.json ──────────────────────────────────────────────

app.get('/.well-known/agent.json', (req, res) => {
  res.json({
    name: 'playwright-agent',
    version: '1.0.0',
    capabilities: ['web_search', 'form_fill', 'page_scrape', 'click_navigate', 'screenshot'],
    endpoint: `${process.env.PUBLIC_URL || `http://localhost:${PORT}`}/tasks`,
  });
});

// ─── Core task runner (async, called after POST /tasks returns) ───────────────

async function runTask(taskId) {
  const task = getTask(taskId);
  if (!task) return;

  let page = null;
  incrementActive();
  updateTask(taskId, { status: 'running' });

  // Hard timeout: close the page after 90 s which causes all pending
  // Playwright calls to reject, then the catch block handles cleanup.
  let timeoutHandle = null;

  try {
    const steps = await planTask(task.description, task.context);

    if (task.cancelled) {
      updateTask(taskId, { status: 'cancelled', error: 'Task cancelled before execution' });
      return;
    }

    page = await newPage();

    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Task timed out after ${TASK_TIMEOUT_MS / 1000}s`));
      }, TASK_TIMEOUT_MS);
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
    if (page) await page.close().catch(() => {});
    decrementActive();
    drainQueue(); // give the next queued task a slot
  }
}

function scheduleTask(taskId) {
  if (atCapacity()) {
    enqueue(() => runTask(taskId));
  } else {
    // Run on next tick so POST /tasks can return first
    setImmediate(() => runTask(taskId));
  }
}

// ─── POST /tasks ──────────────────────────────────────────────────────────────

app.post('/tasks', requireAuth, (req, res) => {
  const { taskId, description, context, userId } = req.body ?? {};

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

  createTask(taskId, userId, description, context);
  scheduleTask(taskId);

  res.status(202).json({ taskId, status: 'running' });
});

// ─── GET /tasks/:taskId ───────────────────────────────────────────────────────

app.get('/tasks/:taskId', requireAuth, (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const { taskId, status, result, error, screenshots } = task;
  res.json({ taskId, status, result, error, screenshots });
});

// ─── POST /tasks/:taskId/cancel ───────────────────────────────────────────────

app.post('/tasks/:taskId/cancel', requireAuth, (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  if (task.status === 'done' || task.status === 'error' || task.status === 'cancelled') {
    return res.json({ taskId: task.taskId, status: task.status, message: 'Task already finished' });
  }

  updateTask(req.params.taskId, { cancelled: true, status: 'cancelled', error: 'Cancelled by request' });
  res.json({ taskId: task.taskId, status: 'cancelled' });
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function startup() {
  // Pre-launch the browser so the first task doesn't pay the cold-start cost
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
