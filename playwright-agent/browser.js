'use strict';

const fs = require('fs');
const { chromium } = require('playwright');

// ─── Singleton browser instance ───────────────────────────────────────────────

let _browser = null;

async function launch() {
  if (_browser) return _browser;

  _browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',                 // critical in Docker
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });

  _browser.on('disconnected', () => {
    console.warn('Browser disconnected — will relaunch on next request');
    _browser = null;
  });

  console.log('Playwright: browser launched');
  return _browser;
}

// ─── Context management ───────────────────────────────────────────────────────
// Each task gets its own BrowserContext so sessions are isolated.
// Pass a Playwright storageState to pre-seed cookies and localStorage
// (e.g. from a saved database session).

async function newContext(storageState = null) {
  const browser = await launch();
  const opts = {
    viewport: { width: 1280, height: 720 },
    // Mimic a real Chrome user-agent to avoid trivial bot detection
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  };
  if (storageState) opts.storageState = storageState;
  return browser.newContext(opts);
}

// Returns a fresh page inside an existing context.
async function newPage(context) {
  const page = await context.newPage();
  page.on('console', () => {});
  page.on('pageerror', () => {});
  return page;
}

// Close a context and all pages inside it.
async function closeContext(context) {
  if (context) await context.close().catch(() => {});
}

async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
    console.log('Playwright: browser closed');
  }
}

// ─── Startup validation ───────────────────────────────────────────────────────
// Call this at process startup to fail fast if Chromium isn't where we expect.

function validateChromium() {
  const chromiumPath =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium-browser';
  if (!fs.existsSync(chromiumPath)) {
    throw new Error(
      `Chromium binary not found at: ${chromiumPath}. ` +
      `Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or install Chromium.`
    );
  }
  console.log(`Playwright: Chromium validated at ${chromiumPath}`);
}

module.exports = { launch, newContext, newPage, closeContext, closeBrowser, validateChromium };
