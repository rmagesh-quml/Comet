'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// ─── Planning system prompt (exact wording from spec) ─────────────────────────

const PLANNING_SYSTEM = `You are a browser automation planner. Respond ONLY with a valid JSON array of steps. Each step must be one of these exact shapes:
{ "action": "navigate", "url": string }
{ "action": "click", "selector": string }
{ "action": "type", "selector": string, "text": string }
{ "action": "scrape", "selector": string, "attribute": string }
{ "action": "wait", "ms": number }
{ "action": "screenshot" }
{ "action": "scroll", "direction": "up"|"down", "px": number }
Never include explanation. Only the JSON array.`;

let _client = null;

function getClient() {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// ─── Plan a task description into an array of executor steps ─────────────────

async function planTask(description, context) {
  const userContent = context
    ? `Task: ${description}\n\nAdditional context: ${context}`
    : `Task: ${description}`;

  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: PLANNING_SYSTEM,
    messages: [{ role: 'user', content: userContent }],
  });

  const raw = response.content[0].text.trim();

  // Strip markdown code fences if the model wraps its output
  const json = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const steps = JSON.parse(json);

  if (!Array.isArray(steps)) {
    throw new Error('Planner returned non-array response');
  }

  return steps;
}

module.exports = { planTask };
