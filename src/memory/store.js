'use strict';

const { QdrantClient } = require('@qdrant/js-client-rest');
const { randomUUID } = require('crypto');
const { getEmbedding } = require('./embeddings');

const COLLECTION = 'memories';
const VECTOR_SIZE = 1536;
const SCORE_THRESHOLD = 0.65;

// ─── Client ───────────────────────────────────────────────────────────────────

let client = null;

async function initQdrant() {
  client = new QdrantClient({
    url: process.env.QDRANT_URL || 'http://localhost:6333',
    apiKey: process.env.QDRANT_API_KEY,
  });

  try {
    const { collections } = await client.getCollections();
    const exists = collections.some(c => c.name === COLLECTION);

    if (!exists) {
      await client.createCollection(COLLECTION, {
        vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
      });
      console.log(`Qdrant: created collection '${COLLECTION}'`);
    } else {
      console.log(`Qdrant: collection '${COLLECTION}' ready`);
    }
  } catch (err) {
    console.error('Qdrant init error:', err.message || err);
  }

  return client;
}

// ─── Store ────────────────────────────────────────────────────────────────────

async function storeMemory(userId, text, metadata = {}) {
  if (!client) return;

  const { type = 'preference', importance = 5, source = 'unknown' } = metadata;

  const vector = await getEmbedding(text);
  const id = randomUUID();
  const now = new Date();

  await client.upsert(COLLECTION, {
    wait: true,
    points: [
      {
        id,
        vector,
        payload: {
          userId,
          text,
          type,
          importance,
          source,
          timestamp: now.toISOString(),
          ts: now.getTime(), // numeric unix ms for range filtering
        },
      },
    ],
  });
}

// ─── Search ───────────────────────────────────────────────────────────────────

async function searchMemories(userId, query, limit = 5) {
  if (!client) return [];

  try {
    const vector = await getEmbedding(query);

    const results = await client.search(COLLECTION, {
      vector,
      limit,
      score_threshold: SCORE_THRESHOLD,
      filter: {
        must: [{ key: 'userId', match: { value: userId } }],
      },
      with_payload: true,
    });

    return results.map(r => ({
      text: r.payload.text,
      type: r.payload.type,
      importance: r.payload.importance,
      score: r.score,
    }));
  } catch (err) {
    console.error(`searchMemories error for user ${userId}:`, err.message || err);
    return [];
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

async function deleteOldMemories(userId) {
  if (!client) return;

  const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;

  try {
    await client.delete(COLLECTION, {
      filter: {
        must: [
          { key: 'userId', match: { value: userId } },
          { key: 'importance', range: { lt: 5 } },
          { key: 'ts', range: { lt: ninetyDaysAgo } },
        ],
      },
    });
  } catch (err) {
    console.error(`deleteOldMemories error for user ${userId}:`, err.message || err);
  }
}

async function deleteUserMemories(userId) {
  if (!client) return;

  try {
    await client.delete(COLLECTION, {
      filter: {
        must: [{ key: 'userId', match: { value: userId } }],
      },
    });
  } catch (err) {
    console.error(`deleteUserMemories error for user ${userId}:`, err.message || err);
  }
}

module.exports = { initQdrant, storeMemory, searchMemories, deleteOldMemories, deleteUserMemories };
