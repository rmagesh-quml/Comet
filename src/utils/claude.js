'use strict';

const Anthropic = require('@anthropic-ai/sdk');

let _client = null;

function getClient() {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

/**
 * Generate a message the user will actually read.
 * Uses claude-sonnet-4-5 for quality output.
 */
async function generateUserMessage(systemPrompt, messages, maxTokens = 400) {
  try {
    const response = await getClient().messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    });
    return response.content[0].text;
  } catch (err) {
    console.error('generateUserMessage error:', err.message || err);
    return "hey, something went wrong on my end. try again in a bit";
  }
}

/**
 * Internal classification and extraction — user never sees output directly.
 * Uses claude-haiku-4-5-20251001 for speed and cost.
 */
async function classify(prompt, maxTokens = 200) {
  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    return response.content[0].text;
  } catch (err) {
    console.error('classify error:', err.message || err);
    return '';
  }
}

module.exports = { generateUserMessage, classify };
