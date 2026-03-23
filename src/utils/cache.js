'use strict';

const cache = new Map();

function set(key, data, ttlMinutes) {
  cache.set(key, {
    data,
    expiresAt: Date.now() + ttlMinutes * 60 * 1000,
  });
}

function get(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function clear(key) {
  cache.delete(key);
}

function clearAll() {
  cache.clear();
}

module.exports = { set, get, clear, clearAll };
