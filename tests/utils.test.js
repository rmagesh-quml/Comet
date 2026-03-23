'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');

// ─── cache.js tests ───────────────────────────────────────────────────────────

describe('cache', () => {
  let cache;

  beforeEach(() => {
    jest.resetModules();
    cache = require('../src/utils/cache');
    cache.clearAll();
  });

  it('set and get within TTL returns data', () => {
    cache.set('key1', { foo: 'bar' }, 5);
    expect(cache.get('key1')).toEqual({ foo: 'bar' });
  });

  it('get after TTL returns null', () => {
    jest.useFakeTimers();
    cache.set('expiring', 'data', 1); // 1 minute TTL
    jest.advanceTimersByTime(61 * 1000); // advance 61 seconds past expiry
    expect(cache.get('expiring')).toBeNull();
    jest.useRealTimers();
  });

  it('clear removes key', () => {
    cache.set('toRemove', 'value', 10);
    expect(cache.get('toRemove')).toBe('value');
    cache.clear('toRemove');
    expect(cache.get('toRemove')).toBeNull();
  });

  it('clearAll removes all keys', () => {
    cache.set('a', 1, 10);
    cache.set('b', 2, 10);
    cache.set('c', 3, 10);
    cache.clearAll();
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBeNull();
    expect(cache.get('c')).toBeNull();
  });
});

// ─── limiter.js tests ─────────────────────────────────────────────────────────

jest.mock('../src/db');

describe('limiter', () => {
  let limiter;
  let db;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../src/db');
    db = require('../src/db');
    limiter = require('../src/utils/limiter');
  });

  it('checkLimit returns true when under limit', async () => {
    db.getMessageCountToday.mockResolvedValue(5);
    const result = await limiter.checkLimit(1);
    expect(result).toBe(true);
  });

  it('checkLimit returns false when at limit', async () => {
    db.getMessageCountToday.mockResolvedValue(30);
    const result = await limiter.checkLimit(1);
    expect(result).toBe(false);
  });

  it('incrementCount increases count', async () => {
    db.incrementMessageCount.mockResolvedValue(undefined);
    await limiter.incrementCount(1);
    expect(db.incrementMessageCount).toHaveBeenCalledWith(1);
  });

  it('resetAllCounts resets counts', async () => {
    db.resetAllMessageCounts.mockResolvedValue(undefined);
    await limiter.resetAllCounts();
    expect(db.resetAllMessageCounts).toHaveBeenCalled();
  });
});
