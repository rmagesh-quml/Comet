'use strict';

const { healStep, healStepWithVision } = require('./planner');

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

async function handleUploadFile(step, page, frameCtx) {
  const frame = getFrame(page, frameCtx);
  await frame.locator(step.selector).setInputFiles(step.path, { timeout: 10_000 });
}

// ─── Post-step validation ─────────────────────────────────────────────────────
// Optional field on any step: "expect": "url_change" | "selector_visible:<sel>" | "text_present:<text>"
// Returns true if the expectation passes, throws if it fails.

async function validateExpect(step, page, prevUrl) {
  const { expect: exp } = step;
  if (!exp) return true;

  if (exp === 'url_change') {
    const newUrl = page.url();
    if (newUrl === prevUrl) throw new Error(`expect url_change: URL did not change (still ${prevUrl})`);
    return true;
  }

  if (exp.startsWith('selector_visible:')) {
    const sel = exp.slice('selector_visible:'.length);
    try {
      await page.waitForSelector(sel, { state: 'visible', timeout: 5_000 });
    } catch {
      throw new Error(`expect selector_visible: "${sel}" not visible after step`);
    }
    return true;
  }

  if (exp.startsWith('text_present:')) {
    const text = exp.slice('text_present:'.length);
    try {
      await page.waitForSelector(`:has-text("${text.replace(/"/g, '\\"')}")`, { timeout: 5_000 });
    } catch {
      throw new Error(`expect text_present: "${text}" not found after step`);
    }
    return true;
  }

  return true; // unknown expect values pass silently
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
    case 'uploadFile':       await handleUploadFile(step, page, frameCtx); return frameCtx;
    case 'wait':             await handleWait(step); return frameCtx;
    case 'screenshot':       screenshots.push(await handleScreenshot(page)); return frameCtx;
    default:
      console.warn(`[executor] unknown action: ${step.action}`);
      return frameCtx;
  }
}

// ─── Plan executor with per-step self-healing ─────────────────────────────────
// Healing strategy (two-tier):
//   Tier 1: ARIA-based heal — ask Haiku with full task history + ARIA tree
//   Tier 2: Visual heal   — if tier 1 also fails, send a screenshot to Haiku vision
//
// completedSteps accumulates { action, params, outcome } for healer context.

const HEALABLE_ACTIONS = new Set([
  'click', 'type', 'scrape', 'scrapeAll', 'extractTable', 'select',
  'hover', 'scrollToElement', 'waitForSelector', 'waitForText', 'key',
  'evaluate', 'uploadFile',
]);

async function executePlan(steps, page) {
  const results = [];
  const screenshots = [];
  const completedSteps = []; // task history for healer context
  let frameCtx = null;

  for (const step of steps) {
    if (!step || typeof step.action !== 'string') continue;

    const prevUrl = page.url().catch(() => '');

    try {
      frameCtx = await dispatchStep(step, page, results, screenshots, frameCtx);

      // Post-step validation (opt-in via "expect" field on the step)
      if (step.expect) {
        const url = await prevUrl;
        await validateExpect(step, page, url);
      }

      completedSteps.push({
        action: step.action,
        params: { selector: step.selector, url: step.url, text: step.text },
        outcome: 'ok',
      });

    } catch (originalErr) {
      if (!HEALABLE_ACTIONS.has(step.action)) throw originalErr;

      console.warn(`[executor] step failed, attempting ARIA heal: ${step.action} — ${originalErr.message}`);

      const [ariaSnapshot, currentUrl] = await Promise.all([
        getAriaSnapshot(page),
        page.url().catch(() => ''),
      ]);

      // Tier 1: ARIA-based heal with full task history
      const healed = await healStep(step, originalErr.message, ariaSnapshot, currentUrl, completedSteps);

      if (healed) {
        try {
          console.log(`[executor] retrying with healed step: ${JSON.stringify(healed)}`);
          frameCtx = await dispatchStep(healed, page, results, screenshots, frameCtx);
          completedSteps.push({ action: healed.action, params: healed, outcome: 'healed' });
          continue;
        } catch (healErr) {
          console.warn(`[executor] healed step also failed: ${healErr.message} — trying visual heal`);

          // Tier 2: Visual fallback — take screenshot, send to vision model
          try {
            const screenshotBuf = await page.screenshot({ type: 'jpeg', quality: 60 });
            const b64 = screenshotBuf.toString('base64');
            const { healStepWithVision: healVision } = require('./planner');
            const visualHealed = await healVision(step, originalErr.message, b64, currentUrl);
            if (visualHealed) {
              console.log(`[executor] retrying with visually healed step: ${JSON.stringify(visualHealed)}`);
              frameCtx = await dispatchStep(visualHealed, page, results, screenshots, frameCtx);
              completedSteps.push({ action: visualHealed.action, params: visualHealed, outcome: 'visual-healed' });
              continue;
            }
          } catch (visualErr) {
            console.warn(`[executor] visual heal also failed: ${visualErr.message}`);
          }
        }
      }

      // All healing exhausted — propagate original error
      console.warn('[executor] all healing failed, propagating original error');
      throw originalErr;
    }
  }

  return { results, screenshots };
}

module.exports = { executePlan, isSsrfTarget, getAriaSnapshot };
