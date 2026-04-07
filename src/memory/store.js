'use strict';

const { MemoryClient } = require('mem0ai');

// ─── Singleton client ─────────────────────────────────────────────────────────

let _client = null;

function getClient() {
  if (!_client) {
    _client = new MemoryClient({ apiKey: process.env.MEM0_API_KEY });
  }
  return _client;
}

// ─── Init (called on startup — kept for API compatibility with index.js) ──────
// Performs a lightweight connectivity check against the Mem0 cloud API.

async function initQdrant() {
  try {
    await getClient().getAll({ user_id: '__healthcheck__', limit: 1 });
    console.log('Mem0: cloud connection ready');
  } catch (err) {
    // Surface the error but don't crash — memory degrades gracefully
    console.warn('Mem0: startup health check failed (non-fatal):', err.message || err);
  }
}

// ─── Store ────────────────────────────────────────────────────────────────────
// Mem0's add() expects an array of {role, content} messages and extracts
// memories automatically using its own LLM pipeline.

async function storeMemory(userId, text, metadata = {}) {
  try {
    await getClient().add(
      [{ role: 'user', content: text }],
      { user_id: String(userId), metadata }
    );
  } catch (err) {
    console.error(`storeMemory error for user ${userId}:`, err.message || err);
  }
}

// ─── Search ───────────────────────────────────────────────────────────────────
// Mem0 v1 search returns a plain array:
//   [{ id, memory, user_id, metadata, score, ... }]

async function searchMemories(userId, query, limit = 5) {
  try {
    const raw = await getClient().search(query, {
      user_id: String(userId),
      limit,
    });

    // Normalise: v1 → array directly, v2 → { results: [] }
    const results = Array.isArray(raw) ? raw : (raw?.results ?? []);

    return results.map(r => ({
      text:       r.memory,
      type:       r.metadata?.type       ?? 'preference',
      importance: r.metadata?.importance ?? 5,
      score:      r.score                ?? 1,
    }));
  } catch (err) {
    console.error(`searchMemories error for user ${userId}:`, err.message || err);
    return [];
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────
// deleteOldMemories: Mem0 manages its own memory lifecycle in the cloud —
// no manual TTL pruning needed.

async function deleteOldMemories(_userId) {
  // no-op: Mem0 cloud handles memory consolidation and expiry automatically
}

async function deleteUserMemories(userId) {
  try {
    await getClient().deleteAll({ user_id: String(userId) });
  } catch (err) {
    console.error(`deleteUserMemories error for user ${userId}:`, err.message || err);
  }
}

module.exports = { initQdrant, storeMemory, searchMemories, deleteOldMemories, deleteUserMemories };
