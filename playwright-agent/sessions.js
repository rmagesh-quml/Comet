'use strict';

// ─── Browser session persistence ──────────────────────────────────────────────
// Stores Playwright storageState (cookies + localStorage) in PostgreSQL so
// authenticated sessions survive task boundaries.
//
// Keyed by (userId, hostname) — e.g. ('42', 'canvas.vt.edu').
// The full storageState blob captures cookies for ALL domains visited in that
// context, so a Canvas session also preserves VT CAS SSO cookies automatically.

const { Pool } = require('pg');

let _pool = null;

function getPool() {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      return null; // sessions disabled — DB not configured
    }
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 3,
      idleTimeoutMillis: 30_000,
    });
    _pool.on('error', (err) => {
      console.error('[sessions] pool error:', err.message);
    });
  }
  return _pool;
}

// Run once at startup to create the table if it doesn't exist.
async function ensureTable() {
  const pool = getPool();
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS browser_sessions (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL,
      hostname    TEXT NOT NULL,
      state       JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, hostname)
    )
  `);
}

// Extract the registrable hostname from a URL string (e.g. 'canvas.vt.edu').
// Returns null if the URL is invalid or SSRF-blocked.
function hostnameFromUrl(urlStr) {
  if (!urlStr) return null;
  try {
    return new URL(urlStr).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

// Load the saved storageState for a (userId, hostname) pair.
// Returns a Playwright-compatible storageState object or null.
async function loadSession(userId, hostname) {
  const pool = getPool();
  if (!pool || !userId || !hostname) return null;
  try {
    const res = await pool.query(
      'SELECT state FROM browser_sessions WHERE user_id = $1 AND hostname = $2',
      [String(userId), hostname]
    );
    return res.rows[0]?.state ?? null;
  } catch (err) {
    console.warn(`[sessions] loadSession failed for ${hostname}:`, err.message);
    return null;
  }
}

// Save (upsert) storageState for a (userId, hostname) pair.
// Only saves if there is something worth keeping (at least one cookie or origin).
async function saveSession(userId, hostname, storageState) {
  const pool = getPool();
  if (!pool || !userId || !hostname || !storageState) return;

  const hasCookies = Array.isArray(storageState.cookies) && storageState.cookies.length > 0;
  const hasOrigins = Array.isArray(storageState.origins) && storageState.origins.length > 0;
  if (!hasCookies && !hasOrigins) return; // nothing worth saving

  try {
    await pool.query(`
      INSERT INTO browser_sessions (user_id, hostname, state, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_id, hostname)
      DO UPDATE SET state = $3, updated_at = NOW()
    `, [String(userId), hostname, JSON.stringify(storageState)]);
  } catch (err) {
    console.warn(`[sessions] saveSession failed for ${hostname}:`, err.message);
  }
}

// Delete a saved session (e.g. when the user knows they've logged out or
// changed their password and the saved cookies are definitely stale).
async function clearSession(userId, hostname) {
  const pool = getPool();
  if (!pool || !userId || !hostname) return;
  try {
    await pool.query(
      'DELETE FROM browser_sessions WHERE user_id = $1 AND hostname = $2',
      [String(userId), hostname]
    );
  } catch (err) {
    console.warn(`[sessions] clearSession failed for ${hostname}:`, err.message);
  }
}

// List all saved session hostnames for a user.
async function listSessions(userId) {
  const pool = getPool();
  if (!pool || !userId) return [];
  try {
    const res = await pool.query(
      'SELECT hostname, updated_at FROM browser_sessions WHERE user_id = $1 ORDER BY updated_at DESC',
      [String(userId)]
    );
    return res.rows;
  } catch (err) {
    console.warn('[sessions] listSessions failed:', err.message);
    return [];
  }
}

module.exports = { ensureTable, hostnameFromUrl, loadSession, saveSession, clearSession, listSessions };
