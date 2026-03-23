'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');

jest.mock('pg');

const { Pool } = require('pg');

// ─── Pool mock setup ──────────────────────────────────────────────────────────

let mockQuery;
let mockRelease;
let mockClient;

beforeEach(() => {
  mockQuery = jest.fn();
  mockRelease = jest.fn();
  mockClient = { query: mockQuery, release: mockRelease };

  Pool.mockImplementation(() => ({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue(mockClient),
    end: jest.fn().mockResolvedValue(undefined),
  }));
});

// ─── getOrCreateUser ──────────────────────────────────────────────────────────

describe('getOrCreateUser', () => {
  let db;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('pg');
    const { Pool: MockPool } = require('pg');
    mockQuery = jest.fn();
    MockPool.mockImplementation(() => ({
      query: mockQuery,
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
      end: jest.fn(),
    }));
    db = require('../src/db');
  });

  it('creates new user when phone not found', async () => {
    const newUser = { id: 1, phone_number: '+15551234567', name: null };
    // INSERT returns the new row
    mockQuery.mockResolvedValueOnce({ rows: [newUser], rowCount: 1 });

    const user = await db.getOrCreateUser('+15551234567');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toMatch(/INSERT INTO users/i);
    expect(user).toEqual(newUser);
  });

  it('returns existing user when phone found', async () => {
    const existingUser = { id: 2, phone_number: '+15559876543', name: 'Bob' };
    // INSERT finds conflict, returns no rows
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // SELECT returns the existing row
    mockQuery.mockResolvedValueOnce({ rows: [existingUser], rowCount: 1 });

    const user = await db.getOrCreateUser('+15559876543');

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][0]).toMatch(/SELECT \* FROM users WHERE phone_number/i);
    expect(user).toEqual(existingUser);
  });

  it('never creates duplicate for same phone', async () => {
    const existingUser = { id: 3, phone_number: '+15550001111' };
    // Both calls return the same existing user (ON CONFLICT DO NOTHING)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockQuery.mockResolvedValueOnce({ rows: [existingUser] });

    const user1 = await db.getOrCreateUser('+15550001111');

    // Reset and call again — simulating a second concurrent insert that also hits conflict
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockQuery.mockResolvedValueOnce({ rows: [existingUser] });

    const user2 = await db.getOrCreateUser('+15550001111');

    expect(user1.id).toBe(user2.id);
    expect(user1.phone_number).toBe(user2.phone_number);
  });
});

// ─── saveMessage and getRecentMessages ────────────────────────────────────────

describe('saveMessage and getRecentMessages', () => {
  let db;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('pg');
    const { Pool: MockPool } = require('pg');
    mockQuery = jest.fn();
    MockPool.mockImplementation(() => ({
      query: mockQuery,
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
      end: jest.fn(),
    }));
    db = require('../src/db');
  });

  it('saved messages returned in order', async () => {
    const messages = [
      { id: 1, user_id: 1, role: 'user', content: 'first', created_at: '2024-01-01T00:00:00Z' },
      { id: 2, user_id: 1, role: 'assistant', content: 'second', created_at: '2024-01-01T00:00:01Z' },
      { id: 3, user_id: 1, role: 'user', content: 'third', created_at: '2024-01-01T00:00:02Z' },
    ];

    mockQuery.mockResolvedValueOnce({ rows: messages });

    const result = await db.getRecentMessages(1, 15);

    expect(result).toHaveLength(3);
    expect(result[0].content).toBe('first');
    expect(result[2].content).toBe('third');
    // Query uses ASC order
    expect(mockQuery.mock.calls[0][0]).toMatch(/ORDER BY created_at ASC/i);
  });

  it('respects limit parameter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await db.getRecentMessages(1, 5);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/LIMIT \$2/i);
    expect(params[1]).toBe(5);
  });

  it('filters by userId correctly', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await db.getRecentMessages(42, 15);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE user_id = \$1/i);
    expect(params[0]).toBe(42);
  });
});

// ─── updatePreference ─────────────────────────────────────────────────────────

describe('updatePreference', () => {
  let db;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('pg');
    const { Pool: MockPool } = require('pg');
    mockQuery = jest.fn();
    MockPool.mockImplementation(() => ({
      query: mockQuery,
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
      end: jest.fn(),
    }));
    db = require('../src/db');
  });

  it('creates new preference record on first call', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await db.updatePreference(1, 'morning_brief', 'hash_abc', true);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO user_preferences/i);
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/i);
  });

  it('increments positive_count when wasPositive is true', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await db.updatePreference(1, 'morning_brief', 'hash_abc', true);

    const [, params] = mockQuery.mock.calls[0];
    // positive_count increment param should be 1
    expect(params[3]).toBe(1);
  });

  it('does not increment positive_count when wasPositive is false', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await db.updatePreference(1, 'morning_brief', 'hash_abc', false);

    const [, params] = mockQuery.mock.calls[0];
    // positive_count increment param should be 0
    expect(params[3]).toBe(0);
  });

  it('increments total_count every time', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    await db.updatePreference(1, 'morning_brief', 'hash_abc', true);
    await db.updatePreference(1, 'morning_brief', 'hash_abc', false);

    expect(mockQuery).toHaveBeenCalledTimes(2);
    // Both calls use the same upsert which always increments total_count by 1
    const [sql1] = mockQuery.mock.calls[0];
    const [sql2] = mockQuery.mock.calls[1];
    expect(sql1).toMatch(/total_count = user_preferences\.total_count \+ 1/i);
    expect(sql2).toMatch(/total_count = user_preferences\.total_count \+ 1/i);
  });
});

// ─── Pending actions lifecycle ────────────────────────────────────────────────

describe('pending actions lifecycle', () => {
  let db;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('pg');
    const { Pool: MockPool } = require('pg');
    mockQuery = jest.fn();
    MockPool.mockImplementation(() => ({
      query: mockQuery,
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
      end: jest.fn(),
    }));
    db = require('../src/db');
  });

  it('savePendingAction creates a record', async () => {
    const newAction = {
      id: 1,
      user_id: 1,
      action_type: 'reminder',
      action_data: { time: '8am' },
      proposal_message: 'set your alarm',
      status: 'pending',
    };
    mockQuery.mockResolvedValueOnce({ rows: [newAction], rowCount: 1 });

    const action = await db.savePendingAction(1, 'reminder', { time: '8am' }, 'set your alarm');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toMatch(/INSERT INTO pending_actions/i);
    expect(action).toEqual(newAction);
  });

  it('getPendingAction returns most recent pending', async () => {
    const pendingAction = {
      id: 5,
      user_id: 1,
      action_type: 'note',
      status: 'pending',
    };
    mockQuery.mockResolvedValueOnce({ rows: [pendingAction] });

    const action = await db.getPendingAction(1);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE user_id = \$1 AND status = 'pending'/i);
    expect(sql).toMatch(/ORDER BY created_at DESC LIMIT 1/i);
    expect(params[0]).toBe(1);
    expect(action).toEqual(pendingAction);
  });

  it('getPendingAction returns null when no pending actions', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const action = await db.getPendingAction(1);

    expect(action).toBeNull();
  });

  it('markActionApproved updates status to approved', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await db.markActionApproved(5);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE pending_actions SET status = 'approved'/i);
    expect(params[0]).toBe(5);
  });

  it('expireOldPendingActions marks expired records', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 3 });

    await db.expireOldPendingActions();

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE pending_actions SET status = 'expired'/i);
    expect(sql).toMatch(/WHERE status = 'pending' AND expires_at < NOW/i);
  });
});

// ─── Brief time preference ────────────────────────────────────────────────────

describe('updateBriefPreference', () => {
  let db;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('pg');
    const { Pool: MockPool } = require('pg');
    mockQuery = jest.fn();
    MockPool.mockImplementation(() => ({
      query: mockQuery,
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
      end: jest.fn(),
    }));
    db = require('../src/db');
  });

  it('updates preferred_brief_hour and minute and sets confirmed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await db.updateBriefPreference(1, 8, 30);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/preferred_brief_hour/i);
    expect(sql).toMatch(/preferred_brief_minute/i);
    expect(sql).toMatch(/brief_time_confirmed/i);
    expect(params).toEqual([1, 8, 30]);
  });

  it('defaults minute to 0 when not provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await db.updateBriefPreference(1, 9);

    const [, params] = mockQuery.mock.calls[0];
    expect(params[2]).toBe(0);
  });
});

describe('getBriefHour', () => {
  let db;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('pg');
    const { Pool: MockPool } = require('pg');
    mockQuery = jest.fn();
    MockPool.mockImplementation(() => ({
      query: mockQuery,
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
      end: jest.fn(),
    }));
    db = require('../src/db');
  });

  it('returns hour and minute from user row', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ preferred_brief_hour: 8, preferred_brief_minute: 30 }],
    });

    const result = await db.getBriefHour(1);
    expect(result.hour).toBe(8);
    expect(result.minute).toBe(30);
  });

  it('returns defaults of 9:00 when user has no preference set', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ preferred_brief_hour: null, preferred_brief_minute: null }],
    });

    const result = await db.getBriefHour(1);
    expect(result.hour).toBe(9);
    expect(result.minute).toBe(0);
  });
});

describe('wasEarlyBriefSent / markEarlyBriefSent', () => {
  let db;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('pg');
    const { Pool: MockPool } = require('pg');
    mockQuery = jest.fn();
    MockPool.mockImplementation(() => ({
      query: mockQuery,
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
      end: jest.fn(),
    }));
    db = require('../src/db');
  });

  it('wasEarlyBriefSent returns false when no matching row (date differs)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await db.wasEarlyBriefSent(1, '2026-03-23');
    expect(result).toBe(false);
  });

  it('wasEarlyBriefSent returns true when date matches', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ early_brief_sent_date: '2026-03-23' }] });
    const result = await db.wasEarlyBriefSent(1, '2026-03-23');
    expect(result).toBe(true);
  });

  it('markEarlyBriefSent runs UPDATE with userId and date', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await db.markEarlyBriefSent(1, '2026-03-23');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/early_brief_sent_date/i);
    expect(params).toEqual([1, '2026-03-23']);
  });
});

// ─── Deletion code ────────────────────────────────────────────────────────────

describe('setDeletionCode / verifyDeletionCode / clearDeletionCode', () => {
  let db;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('pg');
    const { Pool: MockPool } = require('pg');
    mockQuery = jest.fn();
    MockPool.mockImplementation(() => ({
      query: mockQuery,
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
      end: jest.fn(),
    }));
    db = require('../src/db');
  });

  it('setDeletionCode writes code and expiry to users table', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await db.setDeletionCode(1, '123456');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/deletion_code/i);
    expect(params[0]).toBe(1);
    expect(params[1]).toBe('123456');
    expect(params[2]).toBeInstanceOf(Date);
  });

  it('verifyDeletionCode returns true when code matches and not expired', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ 1: 1 }] });
    const result = await db.verifyDeletionCode(1, '123456');
    expect(result).toBe(true);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/deletion_code_expires_at > NOW/i);
  });

  it('verifyDeletionCode returns false when no matching row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await db.verifyDeletionCode(1, 'wrongcode');
    expect(result).toBe(false);
  });

  it('clearDeletionCode nulls both fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await db.clearDeletionCode(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/deletion_code = NULL/i);
    expect(params[0]).toBe(1);
  });
});

// ─── Morning brief engagement ─────────────────────────────────────────────────

describe('logMorningBriefSent', () => {
  let db;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('pg');
    const { Pool: MockPool } = require('pg');
    mockQuery = jest.fn();
    MockPool.mockImplementation(() => ({
      query: mockQuery,
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
      end: jest.fn(),
    }));
    db = require('../src/db');
  });

  it('inserts a row into morning_brief_engagement', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await db.logMorningBriefSent(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO morning_brief_engagement/i);
    expect(params[0]).toBe(1);
  });
});

describe('updateMorningBriefEngagement', () => {
  let db;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('pg');
    const { Pool: MockPool } = require('pg');
    mockQuery = jest.fn();
    MockPool.mockImplementation(() => ({
      query: mockQuery,
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
      end: jest.fn(),
    }));
    db = require('../src/db');
  });

  it('updates the most recent unreplied brief row within 4h', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await db.updateMorningBriefEngagement(1, 42);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/replied = true/i);
    expect(sql).toMatch(/reply_length/i);
    expect(sql).toMatch(/4 hours/i);
    expect(params[0]).toBe(1);
    expect(params[1]).toBe(42);
  });
});

describe('getMorningBriefStats', () => {
  let db;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('pg');
    const { Pool: MockPool } = require('pg');
    mockQuery = jest.fn();
    MockPool.mockImplementation(() => ({
      query: mockQuery,
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
      end: jest.fn(),
    }));
    db = require('../src/db');
  });

  it('returns correct engagementRate and totalSent', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ total_sent: '10', total_replied: '7', avg_reply_length: '35.5' }],
    });
    const stats = await db.getMorningBriefStats(1);
    expect(stats.totalSent).toBe(10);
    expect(stats.engagementRate).toBeCloseTo(0.7);
    expect(stats.avgReplyLength).toBe(36);
  });

  it('returns null engagementRate when no briefs sent', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ total_sent: '0', total_replied: '0', avg_reply_length: null }],
    });
    const stats = await db.getMorningBriefStats(1);
    expect(stats.engagementRate).toBeNull();
    expect(stats.totalSent).toBe(0);
  });
});

// ─── Global daily limit ───────────────────────────────────────────────────────

describe('checkAndIncrementGlobalLimit', () => {
  let db;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('pg');
    const { Pool: MockPool } = require('pg');
    mockQuery = jest.fn();
    MockPool.mockImplementation(() => ({
      query: mockQuery,
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
      end: jest.fn(),
    }));
    db = require('../src/db');
  });

  it('returns true when count is under the limit', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: 100 }] });
    process.env.GLOBAL_DAILY_LIMIT = '500';
    const result = await db.checkAndIncrementGlobalLimit();
    expect(result).toBe(true);
  });

  it('returns false when count exceeds the limit', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: 501 }] });
    process.env.GLOBAL_DAILY_LIMIT = '500';
    const result = await db.checkAndIncrementGlobalLimit();
    expect(result).toBe(false);
  });

  it('uses upsert pattern on global_daily_counts', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: 1 }] });
    await db.checkAndIncrementGlobalLimit();
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/global_daily_counts/i);
    expect(sql).toMatch(/ON CONFLICT/i);
  });
});
