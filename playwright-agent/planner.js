'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// ─── Action vocabulary ────────────────────────────────────────────────────────

const ACTION_SHAPES = `\
{ "action": "navigate", "url": string }
{ "action": "click", "selector": string }
{ "action": "type", "selector": string, "text": string }
{ "action": "scrape", "selector": string, "attribute"?: string }
{ "action": "scrapeAll", "selector": string, "attribute"?: string, "limit"?: number }
{ "action": "extractTable", "selector": string }
{ "action": "evaluate", "script": string, "description": string }
{ "action": "select", "selector": string, "value": string }
{ "action": "key", "key": string }
{ "action": "hover", "selector": string }
{ "action": "scrollToElement", "selector": string }
{ "action": "scroll", "direction": "up"|"down", "px": number }
{ "action": "waitForSelector", "selector": string, "timeout"?: number }
{ "action": "waitForNavigation", "waitUntil"?: "load"|"domcontentloaded"|"networkidle" }
{ "action": "waitForText", "text": string }
{ "action": "waitForResponse", "urlPattern": string, "timeout"?: number }
{ "action": "switchFrame", "selector": string }
{ "action": "mainFrame" }
{ "action": "wait", "ms": number }
{ "action": "screenshot" }`;

const PLANNING_SYSTEM = `You are a browser automation planner for complex multi-step web tasks. Respond ONLY with a valid JSON array of steps.

Each step must be one of these exact shapes:
${ACTION_SHAPES}

## Selector guidance (priority order)
1. When an ARIA tree is provided, use role/name selectors: button[name="Submit"], heading[name="Login"]
2. Prefer text-content selectors: text="Sign in", :has-text("Continue")
3. Use aria-label or data-testid attributes when visible in the ARIA tree
4. Fall back to CSS only when no semantic selector exists

## Navigation and loading
- After navigate or any click that triggers a page load: insert waitForNavigation or waitForSelector before next interaction
- For SPAs (React/Vue/Angular): use waitForSelector to wait for content, or waitForResponse to wait for the XHR/API call that loads data
- For pages that load via infinite scroll: use scroll then waitForSelector for the new content

## Login and auth flows
- Fill username field, fill password field, then click submit
- Always waitForNavigation or waitForSelector after form submit
- If there's a "remember me" checkbox, click it before submitting
- For 2FA: stop at the code entry step (you can't complete 2FA)

## Form wizards
- Complete each step fully before looking for a "next" or "continue" button
- After clicking next on a multi-page form, waitForSelector for the next step's first field
- For dropdowns: use select action for <select> elements, click+waitForSelector for custom dropdowns

## Data extraction
- Use scrape for a single element's text or attribute
- Use scrapeAll for lists of repeated elements (search results, table rows, cards)
- Use extractTable for proper HTML tables — returns array of row objects keyed by column headers
- Use evaluate for complex JS-based extraction when CSS selectors alone aren't enough

## iframes
- Use switchFrame with the iframe's CSS selector to enter it
- Use mainFrame to return to the main document after working inside the iframe

## Self-healing hints
- If a selector might be fragile, add a scrollToElement step first
- For elements below the fold, scroll before clicking

Never include explanation. Only the JSON array.`;

let _client = null;

function getClient() {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

function parseJson(raw) {
  const json = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('Planner returned non-array response');
  return parsed;
}

// ─── Smart ARIA truncation ────────────────────────────────────────────────────
// Keep the first 5000 chars (page header, navigation, main content) and the
// last 2000 chars (footer controls, submit buttons, pagination) so we don't
// lose interactable elements that live at the bottom of the ARIA tree.

function truncateAria(snapshot, maxTotal = 8000) {
  if (!snapshot || snapshot.length <= maxTotal) return snapshot;
  const headLen = Math.floor(maxTotal * 0.7);
  const tailLen = maxTotal - headLen - 40;
  const head = snapshot.slice(0, headLen);
  const tail = snapshot.slice(-tailLen);
  return `${head}\n...(middle truncated)...\n${tail}`;
}

// ─── Primary planner ──────────────────────────────────────────────────────────
// Uses Sonnet for reliable planning of complex multi-step tasks.

async function planTask(description, context, ariaSnapshot = null) {
  const parts = [`Task: ${description}`];
  if (context) parts.push(`Context: ${context}`);
  if (ariaSnapshot) {
    const trimmed = truncateAria(ariaSnapshot, 8000);
    parts.push(`Current page ARIA tree (use these labels for selectors):\n${trimmed}`);
  }

  const response = await getClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2500,
    system: PLANNING_SYSTEM,
    messages: [{ role: 'user', content: parts.join('\n\n') }],
  });

  return parseJson(response.content[0].text.trim());
}

// ─── Step healer ──────────────────────────────────────────────────────────────
// Returns a single replacement step, or null if healing fails.
// Uses Haiku — fast and cheap, called only on failure.

async function healStep(failedStep, errorMessage, ariaSnapshot, currentUrl = '') {
  const snap = ariaSnapshot
    ? truncateAria(ariaSnapshot, 3000)
    : '(not available)';

  const urlContext = currentUrl ? `\nCurrent page URL: ${currentUrl}` : '';

  const prompt = `A browser automation step failed. Return ONLY a single corrected JSON step object.

Failed step: ${JSON.stringify(failedStep)}
Error: ${errorMessage}${urlContext}

Current page ARIA tree:
${snap}

Available action shapes:
${ACTION_SHAPES}

Return a single JSON object. No array, no explanation.`;

  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content[0].text.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    const step = JSON.parse(raw);
    if (!step || typeof step.action !== 'string') return null;
    return step;
  } catch {
    return null;
  }
}

module.exports = { planTask, healStep, ACTION_SHAPES, truncateAria };
