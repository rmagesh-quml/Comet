'use strict';

const { OpenAI } = require('openai');

// ─── Cache ────────────────────────────────────────────────────────────────────

const embeddingCache = new Map(); // hash → float[]

// Simple deterministic djb2 hash — no external dependency needed
function hashText(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    hash |= 0; // keep 32-bit
  }
  return (hash >>> 0).toString(36); // unsigned base-36 string
}

// ─── Embedding ────────────────────────────────────────────────────────────────

async function getEmbedding(text) {
  const key = hashText(text);
  if (embeddingCache.has(key)) return embeddingCache.get(key);

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  let response;
  try {
    response = await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
  } catch (err) {
    throw new Error(`Embedding API error: ${err.message || err}`);
  }

  const vector = response.data[0].embedding;
  embeddingCache.set(key, vector);
  return vector;
}

module.exports = { getEmbedding, hashText };
