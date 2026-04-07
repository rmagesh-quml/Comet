'use strict';

// ─── SSRF guard ───────────────────────────────────────────────────────────────
// Block navigation to private/loopback address space.

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
    // Only allow http/https
    if (protocol !== 'http:' && protocol !== 'https:') return true;
    return SSRF_PATTERNS.some(re => re.test(hostname));
  } catch {
    return true; // unparseable URL → block
  }
}

// ─── Individual step handlers ─────────────────────────────────────────────────

async function handleNavigate(step, page) {
  if (isSsrfTarget(step.url)) {
    throw new Error(`Navigation blocked (SSRF): ${step.url}`);
  }
  await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
}

async function handleClick(step, page) {
  await page.click(step.selector, { timeout: 10_000 });
}

async function handleType(step, page) {
  // fill() clears the field first — prefer it over type() for form inputs
  await page.fill(step.selector, String(step.text ?? ''), { timeout: 10_000 });
}

async function handleScrape(step, page) {
  const value = await page.evaluate(
    ({ sel, attr }) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return attr ? el.getAttribute(attr) : (el.textContent?.trim() ?? null);
    },
    { sel: step.selector, attr: step.attribute ?? null }
  );
  return { selector: step.selector, value };
}

async function handleWait(step, page) {
  const ms = Math.min(Math.max(Number(step.ms) || 500, 0), 10_000);
  await page.waitForTimeout(ms);
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

// ─── Plan executor ────────────────────────────────────────────────────────────

async function executePlan(steps, page) {
  const results = [];
  const screenshots = [];

  for (const step of steps) {
    if (!step || typeof step.action !== 'string') continue;

    switch (step.action) {
      case 'navigate':
        await handleNavigate(step, page);
        break;

      case 'click':
        await handleClick(step, page);
        break;

      case 'type':
        await handleType(step, page);
        break;

      case 'scrape': {
        const result = await handleScrape(step, page);
        results.push(result);
        break;
      }

      case 'wait':
        await handleWait(step, page);
        break;

      case 'screenshot': {
        const b64 = await handleScreenshot(page);
        screenshots.push(b64);
        break;
      }

      case 'scroll':
        await handleScroll(step, page);
        break;

      default:
        console.warn(`[executor] unknown action: ${step.action}`);
    }
  }

  return { results, screenshots };
}

module.exports = { executePlan, isSsrfTarget };
