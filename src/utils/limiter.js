'use strict';

const db = require('../db');

const DAILY_LIMIT = parseInt(process.env.DAILY_MESSAGE_LIMIT, 10) || 30;

async function checkLimit(userId) {
  const count = await db.getMessageCountToday(userId);
  return count < DAILY_LIMIT;
}

async function incrementCount(userId) {
  await db.incrementMessageCount(userId);
}

async function resetAllCounts() {
  await db.resetAllMessageCounts();
}

module.exports = {
  checkLimit,
  incrementCount,
  resetAllCounts,
  DAILY_LIMIT,
};
