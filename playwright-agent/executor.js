'use strict';

const { healStep } = require('./planner');

// ─── SSRF guard ───────────────────────────────────────────────────────────────

const SSRF_PATTERNS = [
  /^localhost$/i,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^169\.254\.\d{1,3}\.\d{1,3}$/,
  /^::1$/,
  /^0\.0\.0\.0$/,
];

function isSsrfTarget(urlStr) {
  try {
    const { hostname, protocol } = new URL(urlStr);
    if (protocol !== 'http:' && protocol !== 'https:') return true;
    return SSRF_PATTERNS.some(re => re.test(hostname));
  } catch {
    return true;
  }
}

// ─── ARIA snapshot helper ─────────────────────────────────────────────────────

async function getAriaSnapshot(page) {
  try {
    const snap = await page.locator('body').ariaSnapshot({ timeout: 5000 });
    return snap ?? null;
  } catch {
    return null;
  }
}

// ─── Frame context ────────────────────────────────────────────────────────────
// We track the current frame so iframe-aware steps work correctly.

function getFrame(page, frameCtx) {
  return frameCtx || page;
}

// ─── Step handlers ────────────────────────────────────────────────────────────

async function handleNavigate(step, page) {
  if (isSsrfTarget(step.url)) throw new Error(`Navigation blocked (SSRF): ${step.url}`);
  await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  return null; // reset frame context after navigation
}

async function handleClick(step, page, frameCtx) {
  await getFrame(page, frameCtx).click(step.selector, { timeout: 10_000 });
}

async function handleType(step, page, frameCtx) {
  await getFrame(page, frameCtx).fill(step.selector, String(step.text ?? ''), { timeout: 10_000 });
}

async function handleScrape(step, page, frameCtx) {
  const frame = getFrame(page, frameCtx);
  const value = await frame.evaluate(
    ({ sel, attr }) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return attr ? el.getAttribute(attr) : (el.textContent?.trim() ?? null);
    },
    { sel: step.selector, attr: step.attribute ?? null }
  );
  return { selector: step.selector, value };
}

async function handleScrapeAll(step, page, frameCtx) {
  const frame = getFrame(page, frameCtx);
  const limit = Math.min(Number(step.limit) || 50, 200);
  const values = await frame.evaluate(
    ({ sel, attr, max }) => {
      const els = Array.from(document.querySelectorAll(sel)).slice(0, max);
      return els.map(el => attr ? el.getAttribute(attr) : (el.textContent?.trim() ?? null));
    },
    { sel: step.selector, attr: step.attribute ?? null, max: limit }
  );
  return { selector: step.selector, values };
}

// Extract a proper HTML table as an array of row objects keyed by column headers.
async function handleExtractTable(step, page, frameCtx) {
  const frame = getFrame(page, frameCtx);
  const rows = await frame.evaluate((sel) => {
    const table = document.querySelector(sel);
    if (!table) return null;
    const headers = Array.from(table.querySelectorAll('thead th, thead td'))
      .map(th => th.textContent?.trim() ?? '');
    const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
    return bodyRows.map(row => {
      const cells = Array.from(row.querySelectorAll('td, th')).map(td => td.textContent?.trim() ?? '');
      if (headers.length > 0) {
        return Object.fromEntries(headers.map((h, i) => [h || `col${i}`, cells[i] ?? '']));
      }
      return cells;
    });
  }, step.selector);
  return { selector: step.selector, rows };
}

// Safe page evaluation — returns whatever the script returns.
// Script must be a function body (no "function" keyword — just the body expression).
async function handleEvaluate(step, page, frameCtx) {
  const frame = getFrame(page, frameCtx);
  // Wrap in an async IIFE for safety
  const result = await frame.evaluate(new Function(`return (async () => { ${step.script} })()`));
  return { description: step.description || 'evaluate', result };
}

async function handleSelect(step, page, frameCtx) {
  await getFrame(page, frameCtx).selectOption(step.selector, step.value, { timeout: 10_000 });
}

async function handleKey(step, page) {
  await page.keyboard.press(step.key);
}

async function handleHover(step, page, frameCtx) {
  await getFrame(page, frameCtx).hover(step.selector, { timeout: 10_000 });
}

async function handleScrollToElement(step, page, frameCtx) {
  await getFrame(page, frameCtx).locator(step.selector).scrollIntoViewIfNeeded({ timeout: 10_000 });
}

async function handleWaitForSelector(step, page, frameCtx) {
  const timeout = Math.min(Number(step.timeout) || 15_000, 30_000);
  await getFrame(page, frameCtx).waitForSelector(step.selector, { timeout });
}

async function handleWaitForNavigation(step, page) {
  const state = ['load', 'domcontentloaded', 'networkidle'].includes(step.waitUntil)
    ? step.waitUntil
    : 'domcontentloaded';
  await page.waitForLoadState(state, { timeout: 30_000 });
}

async function handleWaitForText(step, page, frameCtx) {
  await getFrame(page, frameCtx).waitForSelector(
    `:has-text("${step.text.replace(/"/g, '\\"')}")`,
    { timeout: 15_000 }
  );
}

// Wait for a network response whose URL contains urlPattern.
async function handleWaitForResponse(step, page) {
  const timeout = Math.min(Number(step.timeout) || 15_000, 30_000);
  await page.waitForResponse(
    res => res.url().includes(step.urlPattern),
    { timeout }
  );
}

// Switch into an iframe identified by CSS selector.
// Returns the new frame context (stored in executor state).
async function handleSwitchFrame(step, page) {
  const frameEl = await page.$(step.selector);
  if (!frameEl) throw new Error(`Frame not found: ${step.selector}`);
  const frame = await frameEl.contentFrame();
  if (!frame) throw new Error(`Could not get content frame from: ${step.selector}`);
  return frame; // caller stores this as frameCtx
}

async function handleWait(step) {
  const ms = Math.min(Math.max(Number(step.ms) || 500, 0), 10_000);
  await new Promise(res => setTimeout(res, ms));
}

async function handleScreenshot(page) {
  const buffer = await page.screenshot({ type: 'jpeg', quality: 80 });
  return buffer.toString('base64');
}

async function handleScroll(step, page) {
  const direction = step.direction === 'up' ? 'up' : 'down';
  const px = Math.min(Math.max(Number(step.px) || 300, 0), 5_000);
  await page.evaluate(
    ({ dir, amount }) => window.scrollBy(0, dir === 'down' ? amount : -amount),
    { dir: direction, amount: px }
  );
}

// ─── Step dispatcher ──────────────────────────────────────────────────────────
// frameCtx: current frame (null = main page). Some handlers update it.
// Returns { frameCtx, result?, screenshot? }.

async function dispatchStep(step, page, results, screenshots, frameCtx) {
  switch (step.action) {
    case 'navigate': {
      await handleNavigate(step, page);
      return null; // reset frame after navigation
    }
    case 'click':            await handleClick(step, page, frameCtx); return frameCtx;
    case 'type':             await handleType(step, page, frameCtx); return frameCtx;
    case 'scrape':           results.push(await handleScrape(step, page, frameCtx)); return frameCtx;
    case 'scrapeAll':        results.push(await handleScrapeAll(step, page, frameCtx)); return frameCtx;
    case 'extractTable':     results.push(await handleExtractTable(step, page, frameCtx)); return frameCtx;
    case 'evaluate':         results.push(await handleEvaluate(step, page, frameCtx)); return frameCtx;
    case 'select':           await handleSelect(step, page, frameCtx); return frameCtx;
    case 'key':              await handleKey(step, page); return frameCtx;
    case 'hover':            await handleHover(step, page, frameCtx); return frameCtx;
    case 'scrollToElement':  await handleScrollToElement(step, page, frameCtx); return frameCtx;
    case 'scroll':           await handleScroll(step, page); return frameCtx;
    case 'waitForSelector':  await handleWaitForSelector(step, page, frameCtx); return frameCtx;
    case 'waitForNavigation': await handleWaitForNavigation(step, page); return frameCtx;
    case 'waitForText':      await handleWaitForText(step, page, frameCtx); return frameCtx;
    case 'waitForResponse':  await handleWaitForResponse(step, page); return frameCtx;
    case 'switchFrame': {
      const newFrame = await handleSwitchFrame(step, page);
      return newFrame;
    }
    case 'mainFrame':        return null; // reset to main page
    case 'wait':             await handleWait(step); return frameCtx;
    case 'screenshot':       screenshots.push(await handleScreenshot(page)); return frameCtx;
    default:
      console.warn(`[executor] unknown action: ${step.action}`);
      return frameCtx;
  }
}

// ─── Plan executor with per-step self-healing ─────────────────────────────────
// Healing strategy:
//   1. Snapshot current ARIA tree + capture current URL for context
//   2. Ask Claude Haiku for a corrected replacement step
//   3. Retry once — if that also fails, propagate the original error

const HEALABLE_ACTIONS = new Set([
  'click', 'type', 'scrape', 'scrapeAll', 'extractTable', 'select',
  'hover', 'scrollToElement', 'waitForSelector', 'waitForText', 'key',
  'evaluate',
]);

async function executePlan(steps, page) {
  const results = [];
  const screenshots = [];
  let frameCtx = null; // current frame context (null = main page)

  for (const step of steps) {
    if (!step || typeof step.action !== 'string') continue;

    try {
      frameCtx = await dispatchStep(step, page, results, screenshots, frameCtx);
    } catch (originalErr) {
      if (!HEALABLE_ACTIONS.has(step.action)) throw originalErr;

      console.warn(`[executor] step failed, attempting heal: ${step.action} — ${originalErr.message}`);

      const [ariaSnapshot, currentUrl] = await Promise.all([
        getAriaSnapshot(page),
        page.url().catch(() => ''),
      ]);

      const healed = await healStep(step, originalErr.message, ariaSnapshot, currentUrl);

      if (!healed) {
        console.warn('[executor] healer returned nothing, propagating original error');
        throw originalErr;
      }

      console.log(`[executor] retrying with healed step: ${JSON.stringify(healed)}`);
      frameCtx = await dispatchStep(healed, page, results, screenshots, frameCtx);
    }
  }

  return { results, screenshots };
}

module.exports = { executePlan, isSsrfTarget, getAriaSnapshot };
