'use strict';

const { MemoryClient } = require('mem0ai');
const db = require('../db');

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
// Dual-write: also persists to local Postgres user_memories as fallback.

async function storeMemory(userId, text, metadata = {}) {
  // Always write to local Postgres first (resilient, guaranteed)
  try {
    await db.saveLocalMemory(
      userId,
      text,
      metadata.type || 'preference',
      metadata.importance || 5,
      metadata.source || null
    );
  } catch (err) {
    console.error(`storeMemory local write error for user ${userId}:`, err.message || err);
  }

  // Also write to Mem0 cloud (best-effort, non-blocking)
  if (process.env.MEM0_API_KEY) {
    getClient().add(
      [{ role: 'user', content: text }],
      { user_id: String(userId), metadata }
    ).catch(err => {
      // Non-fatal — local Postgres copy is the source of truth
      console.warn(`storeMemory Mem0 write failed for user ${userId}:`, err.message || err);
    });
  }
}

// ─── Search ───────────────────────────────────────────────────────────────────
// Try Mem0 cloud first. If it fails or returns empty, fall back to local Postgres.

async function searchMemories(userId, query, limit = 5) {
  // Attempt Mem0 cloud search
  if (process.env.MEM0_API_KEY) {
    try {
      const raw = await getClient().search(query, {
        user_id: String(userId),
        limit,
      });

      // Normalise: v1 → array directly, v2 → { results: [] }
      const results = Array.isArray(raw) ? raw : (raw?.results ?? []);

      if (results.length > 0) {
        return results.map(r => ({
          text:       r.memory,
          type:       r.metadata?.type       ?? 'preference',
          importance: r.metadata?.importance ?? 5,
          score:      r.score                ?? 1,
        }));
      }
    } catch (err) {
      console.warn(`searchMemories Mem0 failed for user ${userId}, using local fallback:`, err.message || err);
    }
  }

  // Fallback: local Postgres user_memories table
  try {
    return await db.searchLocalMemories(userId, limit);
  } catch (err) {
    console.error(`searchMemories local fallback error for user ${userId}:`, err.message || err);
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
  // Delete from local Postgres
  try {
    await db.deleteLocalMemories(userId);
  } catch (err) {
    console.error(`deleteUserMemories local error for user ${userId}:`, err.message || err);
  }

  // Delete from Mem0 cloud (best-effort)
  if (process.env.MEM0_API_KEY) {
    getClient().deleteAll({ user_id: String(userId) }).catch(err => {
      console.warn(`deleteUserMemories Mem0 error for user ${userId}:`, err.message || err);
    });
  }
}

module.exports = { initQdrant, storeMemory, searchMemories, deleteOldMemories, deleteUserMemories };
