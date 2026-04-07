'use strict';

// ─── Task state store + concurrency queue ─────────────────────────────────────

const MAX_CONCURRENT = 5;

const taskMap = new Map();
let activeCount = 0;
const runQueue = []; // functions waiting for a slot

// ─── CRUD ─────────────────────────────────────────────────────────────────────

function createTask(taskId, userId, description, context) {
  const task = {
    taskId,
    userId,
    description,
    context: context || null,
    status: 'pending',
    result: null,
    error: null,
    screenshots: [],
    cancelled: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  taskMap.set(taskId, task);
  return task;
}

function getTask(taskId) {
  return taskMap.get(taskId) ?? null;
}

function updateTask(taskId, fields) {
  const task = taskMap.get(taskId);
  if (!task) return;
  Object.assign(task, fields, { updatedAt: new Date().toISOString() });
}

// ─── Concurrency helpers ──────────────────────────────────────────────────────

function getActiveCount() {
  return activeCount;
}

function atCapacity() {
  return activeCount >= MAX_CONCURRENT;
}

function incrementActive() {
  activeCount++;
}

function decrementActive() {
  activeCount = Math.max(0, activeCount - 1);
}

// Push a zero-arg runner fn onto the queue.
function enqueue(fn) {
  runQueue.push(fn);
}

// If there is capacity and work queued, pop and run the next item.
function drainQueue() {
  if (runQueue.length > 0 && !atCapacity()) {
    const next = runQueue.shift();
    next();
  }
}

module.exports = {
  MAX_CONCURRENT,
  createTask,
  getTask,
  updateTask,
  getActiveCount,
  atCapacity,
  incrementActive,
  decrementActive,
  enqueue,
  drainQueue,
};
