'use strict';

const db = require('./db');
const { sendMessage } = require('./sms');
const { deleteUserMemories } = require('./memory/store');

// ─── Request deletion ─────────────────────────────────────────────────────────

async function requestDeletion(userId) {
  const user = await db.getUserById(userId);
  if (!user) return;

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await db.setDeletionCode(userId, code);

  await sendMessage(
    user.phone_number,
    `to delete your account, reply with this code: ${code}\n\nthis will permanently delete all your data and cannot be undone. code expires in 10 minutes.`,
    userId
  );
}

// ─── Confirm deletion ─────────────────────────────────────────────────────────

async function confirmDeletion(userId, code, { userCrons, cancelGraphSubscription } = {}) {
  const valid = await db.verifyDeletionCode(userId, code);
  if (!valid) return false;

  const user = await db.getUserById(userId);
  if (!user) return false;

  // Stop per-user cron jobs
  if (userCrons && userCrons.has(userId)) {
    for (const job of userCrons.get(userId)) {
      try { job.stop(); } catch (_) {}
    }
    userCrons.delete(userId);
  }

  // Cancel Microsoft Graph subscription
  if (cancelGraphSubscription && user.microsoft_subscription_id) {
    try {
      await cancelGraphSubscription(user.microsoft_subscription_id);
    } catch (_) {}
  }

  // Delete Qdrant memories
  try {
    await deleteUserMemories(userId);
  } catch (_) {}

  // Delete user (CASCADE deletes messages, preferences, etc.)
  await db.deleteUser(userId);

  return true;
}

// ─── Deletion phrase detection ────────────────────────────────────────────────

const DELETION_PHRASES = [
  'delete my account',
  'delete account',
  'remove my account',
  'stop texting me',
  'unsubscribe',
  'delete my data',
  'remove me',
  'opt out',
];

function isDeletionRequest(message) {
  const lower = message.toLowerCase();
  return DELETION_PHRASES.some(phrase => lower.includes(phrase));
}

module.exports = { requestDeletion, confirmDeletion, isDeletionRequest };
