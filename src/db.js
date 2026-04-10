'use strict';

require('dotenv').config();
const { Pool } = require('pg');

function getSslConfig() {
  const url = process.env.DATABASE_URL || '';
  if (!url || url.includes('localhost') || url.includes('127.0.0.1')) return false;
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: getSslConfig(),
});

async function query(text, params) {
  return pool.query(text, params);
}

// ─── Schema setup ─────────────────────────────────────────────────────────────

async function setup() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR UNIQUE NOT NULL,
        name VARCHAR,
        canvas_token VARCHAR,
        canvas_base_url VARCHAR,
        microsoft_refresh_token VARCHAR,
        microsoft_subscription_id VARCHAR,
        microsoft_subscription_expires TIMESTAMP,
        google_refresh_token VARCHAR,
        google_email VARCHAR,
        google_history_id VARCHAR,
        spotify_refresh_token VARCHAR,
        discord_digest_enabled BOOLEAN DEFAULT false,
        class_schedule JSONB,
        campus_lat DECIMAL,
        campus_lng DECIMAL,
        nearest_bus_stop_id VARCHAR,
        timezone VARCHAR DEFAULT 'America/New_York',
        health_enabled BOOLEAN DEFAULT false,
        onboarding_step INTEGER DEFAULT 0,
        onboarding_complete BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        is_summary BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sent_messages (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR NOT NULL,
        content TEXT,
        status VARCHAR DEFAULT 'sent',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS scheduled_messages (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        trigger_time TIMESTAMP NOT NULL,
        purpose VARCHAR NOT NULL,
        context JSONB,
        trigger_type VARCHAR,
        status VARCHAR DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'expired')),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS user_preferences (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        trigger_type VARCHAR NOT NULL,
        context_hash VARCHAR NOT NULL,
        positive_count INTEGER DEFAULT 0,
        total_count INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (user_id, trigger_type, context_hash)
      );

      CREATE TABLE IF NOT EXISTS pending_actions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        action_type VARCHAR NOT NULL,
        action_data JSONB NOT NULL,
        proposal_message TEXT,
        status VARCHAR DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executed')),
        expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '2 hours',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS daily_message_counts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        count INTEGER DEFAULT 0,
        UNIQUE (user_id, date)
      );

      CREATE TABLE IF NOT EXISTS canvas_grade_snapshots (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        grades JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS health_readings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        readiness INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS global_daily_counts (
        date DATE PRIMARY KEY,
        count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS morning_brief_engagement (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        sent_at TIMESTAMP DEFAULT NOW(),
        replied BOOLEAN DEFAULT false,
        replied_at TIMESTAMP,
        reply_length INTEGER
      );

      CREATE TABLE IF NOT EXISTS bus_stops (
        stop_id VARCHAR PRIMARY KEY,
        stop_name VARCHAR,
        stop_lat DECIMAL,
        stop_lng DECIMAL
      );

      CREATE TABLE IF NOT EXISTS bus_routes (
        route_id VARCHAR PRIMARY KEY,
        route_short_name VARCHAR,
        route_long_name VARCHAR
      );

      CREATE TABLE IF NOT EXISTS bus_predictions (
        trip_id VARCHAR,
        stop_id VARCHAR,
        route_short_name VARCHAR,
        arrival_time TIMESTAMP,
        delay_seconds INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (trip_id, stop_id)
      );
    `);

    // Migrations for existing installations
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS microsoft_subscription_expires TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS google_email VARCHAR;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_brief_hour INTEGER DEFAULT 9;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_brief_minute INTEGER DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS brief_time_confirmed BOOLEAN DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS early_brief_sent_date DATE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_code VARCHAR;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_code_expires_at TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id VARCHAR UNIQUE;
      ALTER TABLE users ALTER COLUMN phone_number DROP NOT NULL;
    `);
  } finally {
    client.release();
  }
}

// ─── Users ────────────────────────────────────────────────────────────────────

async function getOrCreateUser(phoneNumber) {
  const inserted = await pool.query(
    `INSERT INTO users (phone_number) VALUES ($1)
     ON CONFLICT (phone_number) DO NOTHING
     RETURNING *`,
    [phoneNumber]
  );
  if (inserted.rows.length > 0) return inserted.rows[0];

  const existing = await pool.query(
    'SELECT * FROM users WHERE phone_number = $1',
    [phoneNumber]
  );
  return existing.rows[0];
}

async function getUserById(id) {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function getUserByPhone(phoneNumber) {
  const result = await pool.query(
    'SELECT * FROM users WHERE phone_number = $1',
    [phoneNumber]
  );
  return result.rows[0] || null;
}

async function getOrCreateUserByTelegram(chatId, firstName) {
  const chatIdStr = String(chatId);

  // Try existing user
  const existing = await pool.query(
    'SELECT * FROM users WHERE telegram_chat_id = $1',
    [chatIdStr]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  // Create Telegram-only user (phone_number is NULL — allowed after migration)
  const result = await pool.query(
    `INSERT INTO users (telegram_chat_id, name)
     VALUES ($1, $2)
     ON CONFLICT (telegram_chat_id) DO NOTHING
     RETURNING *`,
    [chatIdStr, firstName || null]
  );
  if (result.rows.length > 0) return result.rows[0];

  // Race condition: another request inserted first
  const retry = await pool.query(
    'SELECT * FROM users WHERE telegram_chat_id = $1',
    [chatIdStr]
  );
  return retry.rows[0];
}

async function getUserByTelegramChatId(chatId) {
  const result = await pool.query(
    'SELECT * FROM users WHERE telegram_chat_id = $1',
    [String(chatId)]
  );
  return result.rows[0] || null;
}

async function updateUser(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const values = Object.values(fields);
  const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await pool.query(
    `UPDATE users SET ${setClause} WHERE id = $1`,
    [id, ...values]
  );
}

async function getAllActiveUsers() {
  const result = await pool.query(
    'SELECT * FROM users WHERE onboarding_complete = true'
  );
  return result.rows;
}

async function deleteUser(id) {
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
}

// ─── Messages ─────────────────────────────────────────────────────────────────

async function saveMessage(userId, role, content, isSummary = false) {
  const result = await pool.query(
    'INSERT INTO messages (user_id, role, content, is_summary) VALUES ($1, $2, $3, $4) RETURNING *',
    [userId, role, content, isSummary]
  );
  return result.rows[0];
}

async function getRecentMessages(userId, limit = 15) {
  const result = await pool.query(
    'SELECT * FROM messages WHERE user_id = $1 ORDER BY created_at ASC LIMIT $2',
    [userId, limit]
  );
  return result.rows;
}

async function getTodaysMessages(userId) {
  const today = new Date().toISOString().split('T')[0];
  const result = await pool.query(
    `SELECT * FROM messages
     WHERE user_id = $1
       AND created_at >= $2::date
       AND is_summary = false
     ORDER BY created_at ASC`,
    [userId, today]
  );
  return result.rows;
}

async function getMessageCount(userId) {
  const result = await pool.query(
    'SELECT COUNT(*) FROM messages WHERE user_id = $1',
    [userId]
  );
  return parseInt(result.rows[0].count, 10);
}

async function deleteMessages(userId, ids) {
  if (!ids || ids.length === 0) return;
  await pool.query(
    'DELETE FROM messages WHERE user_id = $1 AND id = ANY($2)',
    [userId, ids]
  );
}

async function insertSummaryMessage(userId, summaryText) {
  return saveMessage(
    userId,
    'system',
    `[Summary of earlier conversation]: ${summaryText}`,
    true
  );
}

// ─── Sent messages ────────────────────────────────────────────────────────────

async function logSentMessage(userId, type, content, status = 'sent') {
  await pool.query(
    'INSERT INTO sent_messages (user_id, type, content, status) VALUES ($1, $2, $3, $4)',
    [userId, type, content, status]
  );
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

async function getMessageCountToday(userId) {
  const today = new Date().toISOString().split('T')[0];
  const result = await pool.query(
    'SELECT count FROM daily_message_counts WHERE user_id = $1 AND date = $2',
    [userId, today]
  );
  return result.rows.length > 0 ? parseInt(result.rows[0].count, 10) : 0;
}

async function incrementMessageCount(userId) {
  const today = new Date().toISOString().split('T')[0];
  await pool.query(
    `INSERT INTO daily_message_counts (user_id, date, count) VALUES ($1, $2, 1)
     ON CONFLICT (user_id, date) DO UPDATE SET count = daily_message_counts.count + 1`,
    [userId, today]
  );
}

async function resetAllMessageCounts() {
  const today = new Date().toISOString().split('T')[0];
  await pool.query(
    'DELETE FROM daily_message_counts WHERE date < $1',
    [today]
  );
}

// ─── Scheduled messages ───────────────────────────────────────────────────────

async function scheduleMessage(userId, triggerTime, purpose, context, triggerType) {
  const result = await pool.query(
    `INSERT INTO scheduled_messages (user_id, trigger_time, purpose, context, trigger_type)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, triggerTime, purpose, JSON.stringify(context), triggerType]
  );
  return result.rows[0];
}

async function getPendingScheduledMessages() {
  const result = await pool.query(
    `SELECT sm.*, u.phone_number
     FROM scheduled_messages sm
     JOIN users u ON sm.user_id = u.id
     WHERE sm.status = 'pending' AND sm.trigger_time <= NOW()`
  );
  return result.rows;
}

async function markMessageSent(id) {
  await pool.query(
    "UPDATE scheduled_messages SET status = 'sent' WHERE id = $1",
    [id]
  );
}

async function markMessageSkipped(id) {
  await pool.query(
    "UPDATE scheduled_messages SET status = 'skipped' WHERE id = $1",
    [id]
  );
}

async function expireOldScheduledMessages() {
  await pool.query(
    `UPDATE scheduled_messages SET status = 'expired'
     WHERE status = 'pending' AND trigger_time < NOW() - INTERVAL '1 hour'`
  );
}

// ─── User preferences ─────────────────────────────────────────────────────────

async function updatePreference(userId, triggerType, contextHash, wasPositive) {
  const positiveIncrement = wasPositive ? 1 : 0;
  await pool.query(
    `INSERT INTO user_preferences (user_id, trigger_type, context_hash, positive_count, total_count, updated_at)
     VALUES ($1, $2, $3, $4, 1, NOW())
     ON CONFLICT (user_id, trigger_type, context_hash) DO UPDATE SET
       positive_count = user_preferences.positive_count + $4,
       total_count = user_preferences.total_count + 1,
       updated_at = NOW()`,
    [userId, triggerType, contextHash, positiveIncrement]
  );
}

async function getPreference(userId, triggerType, contextHash) {
  const result = await pool.query(
    'SELECT * FROM user_preferences WHERE user_id = $1 AND trigger_type = $2 AND context_hash = $3',
    [userId, triggerType, contextHash]
  );
  return result.rows[0] || null;
}

// ─── Pending actions ──────────────────────────────────────────────────────────

async function savePendingAction(userId, type, data, proposalMsg) {
  const result = await pool.query(
    `INSERT INTO pending_actions (user_id, action_type, action_data, proposal_message)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [userId, type, JSON.stringify(data), proposalMsg]
  );
  return result.rows[0];
}

async function getPendingAction(userId) {
  const result = await pool.query(
    `SELECT * FROM pending_actions
     WHERE user_id = $1 AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function markActionApproved(id) {
  await pool.query(
    "UPDATE pending_actions SET status = 'approved' WHERE id = $1",
    [id]
  );
}

async function markActionRejected(id) {
  await pool.query(
    "UPDATE pending_actions SET status = 'rejected' WHERE id = $1",
    [id]
  );
}

async function markActionExecuted(id) {
  await pool.query(
    "UPDATE pending_actions SET status = 'executed' WHERE id = $1",
    [id]
  );
}

async function expireOldPendingActions() {
  await pool.query(
    `UPDATE pending_actions SET status = 'expired'
     WHERE status = 'pending' AND expires_at < NOW()`
  );
}

async function getUserByGoogleEmail(email) {
  const result = await pool.query(
    'SELECT * FROM users WHERE google_email = $1',
    [email]
  );
  return result.rows[0] || null;
}

// ─── Canvas grade snapshots ───────────────────────────────────────────────────

async function getLatestGradeSnapshot(userId) {
  const result = await pool.query(
    'SELECT * FROM canvas_grade_snapshots WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [userId]
  );
  return result.rows[0] || null;
}

async function saveGradeSnapshot(userId, grades) {
  const result = await pool.query(
    'INSERT INTO canvas_grade_snapshots (user_id, grades) VALUES ($1, $2) RETURNING *',
    [userId, JSON.stringify(grades)]
  );
  return result.rows[0];
}

// ─── Bus stops / routes / predictions ────────────────────────────────────────

async function isBusStopsTableEmpty() {
  const result = await pool.query('SELECT COUNT(*) FROM bus_stops');
  return parseInt(result.rows[0].count, 10) === 0;
}

async function getAllBusStops() {
  const result = await pool.query('SELECT * FROM bus_stops');
  return result.rows;
}

async function getBusStopById(stopId) {
  const result = await pool.query('SELECT * FROM bus_stops WHERE stop_id = $1', [stopId]);
  return result.rows[0] || null;
}

async function getAllBusRoutes() {
  const result = await pool.query('SELECT * FROM bus_routes');
  return result.rows;
}

async function upsertBusStop(stopId, stopName, stopLat, stopLng) {
  await pool.query(
    `INSERT INTO bus_stops (stop_id, stop_name, stop_lat, stop_lng)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (stop_id) DO UPDATE SET
       stop_name = EXCLUDED.stop_name,
       stop_lat = EXCLUDED.stop_lat,
       stop_lng = EXCLUDED.stop_lng`,
    [stopId, stopName, stopLat, stopLng]
  );
}

async function upsertBusRoute(routeId, routeShortName, routeLongName) {
  await pool.query(
    `INSERT INTO bus_routes (route_id, route_short_name, route_long_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (route_id) DO UPDATE SET
       route_short_name = EXCLUDED.route_short_name,
       route_long_name = EXCLUDED.route_long_name`,
    [routeId, routeShortName, routeLongName]
  );
}

async function upsertBusPrediction(tripId, stopId, routeShortName, arrivalTime, delaySeconds) {
  await pool.query(
    `INSERT INTO bus_predictions (trip_id, stop_id, route_short_name, arrival_time, delay_seconds, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (trip_id, stop_id) DO UPDATE SET
       route_short_name = EXCLUDED.route_short_name,
       arrival_time = EXCLUDED.arrival_time,
       delay_seconds = EXCLUDED.delay_seconds,
       updated_at = NOW()`,
    [tripId, stopId, routeShortName, arrivalTime, delaySeconds]
  );
}

async function getNextBusArrivals(stopId) {
  const result = await pool.query(
    `SELECT * FROM bus_predictions
     WHERE stop_id = $1
       AND arrival_time BETWEEN NOW() AND NOW() + INTERVAL '60 minutes'
       AND updated_at > NOW() - INTERVAL '2 minutes'
     ORDER BY arrival_time ASC`,
    [stopId]
  );
  return result.rows;
}

// ─── Proactive trigger helpers ────────────────────────────────────────────────

async function hasSentProactiveTriggerToday(userId, triggerType) {
  const today = new Date().toISOString().split('T')[0];
  const result = await pool.query(
    `SELECT 1 FROM sent_messages
     WHERE user_id = $1
       AND type LIKE $2
       AND status = 'sent'
       AND created_at >= $3::date
     LIMIT 1`,
    [userId, `proactive:${triggerType}:%`, today]
  );
  return result.rows.length > 0;
}

async function getProactiveCountToday(userId) {
  const today = new Date().toISOString().split('T')[0];
  const result = await pool.query(
    `SELECT COUNT(*) FROM sent_messages
     WHERE user_id = $1
       AND type LIKE 'proactive:%'
       AND status = 'sent'
       AND created_at >= $2::date`,
    [userId, today]
  );
  return parseInt(result.rows[0].count, 10);
}

async function getMostRecentProactiveSent(userId, withinMinutes = 30) {
  const result = await pool.query(
    `SELECT * FROM sent_messages
     WHERE user_id = $1
       AND type LIKE 'proactive:%'
       AND status = 'sent'
       AND created_at >= NOW() - INTERVAL '1 minute' * $2
     ORDER BY created_at DESC LIMIT 1`,
    [userId, withinMinutes]
  );
  return result.rows[0] || null;
}

async function getLastUserMessageTime(userId) {
  const result = await pool.query(
    `SELECT created_at FROM messages
     WHERE user_id = $1 AND role = 'user'
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return result.rows[0]?.created_at || null;
}

// ─── Health readings ──────────────────────────────────────────────────────────

async function saveHealthReading(userId, readiness) {
  const result = await pool.query(
    'INSERT INTO health_readings (user_id, readiness) VALUES ($1, $2) RETURNING *',
    [userId, readiness]
  );
  return result.rows[0];
}

async function getTodaysHealth(userId) {
  const today = new Date().toISOString().split('T')[0];
  const result = await pool.query(
    `SELECT * FROM health_readings
     WHERE user_id = $1 AND created_at >= $2::date
     ORDER BY created_at DESC LIMIT 1`,
    [userId, today]
  );
  return result.rows[0] || null;
}

async function getLatestHealthReading(userId) {
  const result = await pool.query(
    'SELECT * FROM health_readings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [userId]
  );
  return result.rows[0] || null;
}

async function getRecentHealthReadings(userId, days = 3) {
  const result = await pool.query(
    `SELECT * FROM health_readings
     WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '1 day' * $2
     ORDER BY created_at DESC`,
    [userId, days]
  );
  return result.rows;
}

// ─── Morning brief time preference ───────────────────────────────────────────

async function updateBriefPreference(userId, hour, minute = 0) {
  await pool.query(
    'UPDATE users SET preferred_brief_hour = $2, preferred_brief_minute = $3, brief_time_confirmed = true WHERE id = $1',
    [userId, hour, minute]
  );
}

async function getBriefHour(userId) {
  const result = await pool.query(
    'SELECT preferred_brief_hour, preferred_brief_minute FROM users WHERE id = $1',
    [userId]
  );
  const row = result.rows[0];
  return row ? { hour: row.preferred_brief_hour ?? 9, minute: row.preferred_brief_minute ?? 0 } : { hour: 9, minute: 0 };
}

// ─── Early brief tracking ─────────────────────────────────────────────────────

async function wasEarlyBriefSent(userId, date) {
  const result = await pool.query(
    'SELECT 1 FROM users WHERE id = $1 AND early_brief_sent_date = $2',
    [userId, date]
  );
  return result.rows.length > 0;
}

async function markEarlyBriefSent(userId, date) {
  await pool.query(
    'UPDATE users SET early_brief_sent_date = $2 WHERE id = $1',
    [userId, date]
  );
}

// ─── Global daily limit ───────────────────────────────────────────────────────

async function checkAndIncrementGlobalLimit() {
  const today = new Date().toISOString().split('T')[0];
  const limit = parseInt(process.env.GLOBAL_DAILY_LIMIT, 10) || 500;
  const result = await pool.query(
    `INSERT INTO global_daily_counts (date, count) VALUES ($1, 1)
     ON CONFLICT (date) DO UPDATE SET count = global_daily_counts.count + 1
     RETURNING count`,
    [today]
  );
  return result.rows[0].count <= limit;
}

// ─── Morning brief engagement ─────────────────────────────────────────────────

async function logMorningBriefSent(userId) {
  await pool.query(
    'INSERT INTO morning_brief_engagement (user_id) VALUES ($1)',
    [userId]
  );
}

async function updateMorningBriefEngagement(userId, replyLength) {
  await pool.query(
    `UPDATE morning_brief_engagement SET replied = true, replied_at = NOW(), reply_length = $2
     WHERE id = (
       SELECT id FROM morning_brief_engagement
       WHERE user_id = $1 AND replied = false AND sent_at > NOW() - INTERVAL '4 hours'
       ORDER BY sent_at DESC LIMIT 1
     )`,
    [userId, replyLength]
  );
}

async function getMorningBriefStats(userId) {
  const result = await pool.query(
    `SELECT
       COUNT(*) AS total_sent,
       SUM(CASE WHEN replied THEN 1 ELSE 0 END) AS total_replied,
       AVG(CASE WHEN replied THEN reply_length ELSE NULL END) AS avg_reply_length
     FROM morning_brief_engagement
     WHERE user_id = $1 AND sent_at > NOW() - INTERVAL '14 days'`,
    [userId]
  );
  const row = result.rows[0];
  const totalSent = parseInt(row.total_sent, 10) || 0;
  const totalReplied = parseInt(row.total_replied, 10) || 0;
  return {
    engagementRate: totalSent > 0 ? totalReplied / totalSent : null,
    avgReplyLength: row.avg_reply_length ? Math.round(parseFloat(row.avg_reply_length)) : null,
    totalSent,
  };
}

// ─── Deletion ─────────────────────────────────────────────────────────────────

async function setDeletionCode(userId, code) {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
  await pool.query(
    'UPDATE users SET deletion_code = $2, deletion_code_expires_at = $3 WHERE id = $1',
    [userId, code, expiresAt]
  );
}

async function verifyDeletionCode(userId, code) {
  const result = await pool.query(
    'SELECT 1 FROM users WHERE id = $1 AND deletion_code = $2 AND deletion_code_expires_at > NOW()',
    [userId, code]
  );
  return result.rows.length > 0;
}

async function clearDeletionCode(userId) {
  await pool.query(
    'UPDATE users SET deletion_code = NULL, deletion_code_expires_at = NULL WHERE id = $1',
    [userId]
  );
}

// ─── Pool close ───────────────────────────────────────────────────────────────

async function close() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  setup,
  // Users
  getOrCreateUser,
  getOrCreateUserByTelegram,
  getUserById,
  getUserByPhone,
  getUserByTelegramChatId,
  getUserByGoogleEmail,
  updateUser,
  getAllActiveUsers,
  deleteUser,
  // Messages
  saveMessage,
  getRecentMessages,
  getTodaysMessages,
  getMessageCount,
  deleteMessages,
  insertSummaryMessage,
  // Sent messages
  logSentMessage,
  // Rate limiting
  getMessageCountToday,
  incrementMessageCount,
  resetAllMessageCounts,
  // Scheduled messages
  scheduleMessage,
  getPendingScheduledMessages,
  markMessageSent,
  markMessageSkipped,
  expireOldScheduledMessages,
  // User preferences
  updatePreference,
  getPreference,
  // Pending actions
  savePendingAction,
  getPendingAction,
  markActionApproved,
  markActionRejected,
  markActionExecuted,
  expireOldPendingActions,
  // Canvas grade snapshots
  getLatestGradeSnapshot,
  saveGradeSnapshot,
  // Proactive trigger helpers
  hasSentProactiveTriggerToday,
  getProactiveCountToday,
  getMostRecentProactiveSent,
  getLastUserMessageTime,
  // Health readings
  getTodaysHealth,
  saveHealthReading,
  getLatestHealthReading,
  getRecentHealthReadings,
  // Bus stops / routes / predictions
  isBusStopsTableEmpty,
  getAllBusStops,
  getBusStopById,
  getAllBusRoutes,
  upsertBusStop,
  upsertBusRoute,
  upsertBusPrediction,
  getNextBusArrivals,
  // Morning brief time preference
  updateBriefPreference,
  getBriefHour,
  // Early brief tracking
  wasEarlyBriefSent,
  markEarlyBriefSent,
  // Global daily limit
  checkAndIncrementGlobalLimit,
  // Morning brief engagement
  logMorningBriefSent,
  updateMorningBriefEngagement,
  getMorningBriefStats,
  // Deletion
  setDeletionCode,
  verifyDeletionCode,
  clearDeletionCode,
  // Connection
  close,
};
