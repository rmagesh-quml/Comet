'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getModel } = require('../models/router');

// ─── AgentOps observability ───────────────────────────────────────────────────

let _agentops = null;
try {
  const agentopsModule = require('agentops');
  _agentops = agentopsModule.agentops || agentopsModule.default || agentopsModule;
  if (typeof _agentops.init === 'function' && process.env.AGENTOPS_API_KEY) {
    _agentops.init({ apiKey: process.env.AGENTOPS_API_KEY });
  }
} catch {
  // agentops is optional — tracing degrades gracefully if unavailable
}

function _recordTrace(model, response, latencyMs, userId) {
  if (!_agentops) return;
  try {
    const event = {
      eventType: 'llms',
      model,
      promptTokens:     response.usage?.input_tokens,
      completionTokens: response.usage?.output_tokens,
      latencyMs,
      ...(userId != null ? { metadata: { userId } } : {}),
    };
    if (typeof _agentops.record === 'function') _agentops.record(event);
  } catch { /* non-critical */ }
}

// ─── Anthropic client ─────────────────────────────────────────────────────────

let _client = null;

function getClient() {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a message the user will actually read.
 * taskType controls model selection via the router (default: 'conversation').
 */
async function generateUserMessage(systemPrompt, messages, maxTokens = 400, taskType = 'conversation') {
  const model = getModel(taskType);
  const t0 = Date.now();
  try {
    const response = await getClient().messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    });
    _recordTrace(model, response, Date.now() - t0);
    return response.content[0].text;
  } catch (err) {
    console.error('generateUserMessage error:', err.message || err);
    return "hey, something went wrong on my end. try again in a bit";
  }
}

/**
 * Internal classification and extraction — user never sees output directly.
 * taskType controls model selection via the router (default: 'classification').
 */
async function classify(prompt, maxTokens = 200, taskType = 'classification') {
  const model = getModel(taskType);
  const t0 = Date.now();
  try {
    const response = await getClient().messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    _recordTrace(model, response, Date.now() - t0);
    return response.content[0].text;
  } catch (err) {
    console.error('classify error:', err.message || err);
    return '';
  }
}

module.exports = { generateUserMessage, classify };
