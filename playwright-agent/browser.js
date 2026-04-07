'use strict';

const { chromium } = require('playwright');

// ─── Singleton browser instance ───────────────────────────────────────────────

let _browser = null;

async function launch() {
  if (_browser) return _browser;

  _browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // critical in Docker to avoid /dev/shm exhaustion
      '--disable-gpu',
      '--disable-extensions',
      '--single-process',        // reduces memory in containers
    ],
  });

  _browser.on('disconnected', () => {
    console.warn('Browser disconnected — will relaunch on next page request');
    _browser = null;
  });

  console.log('Playwright: browser launched');
  return _browser;
}

// Returns a fresh page with a standard viewport. Automatically relaunches
// the browser singleton if it crashed/disconnected.
async function newPage() {
  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });
  // Suppress noisy console output from pages
  page.on('console', () => {});
  page.on('pageerror', () => {});
  return page;
}

async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
    console.log('Playwright: browser closed');
  }
}

module.exports = { launch, newPage, closeBrowser };
