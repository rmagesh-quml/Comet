'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');
const crypto = require('crypto');

// Mock twilio before requiring sms.js
jest.mock('twilio');
jest.mock('../src/db');

const twilio = require('twilio');
const db = require('../src/db');

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeLinqEnv() {
  process.env.LINQ_API_TOKEN = 'test_linq_token';
  process.env.LINQ_PHONE_NUMBER = '+15005550006';
}

function clearLinqEnv() {
  delete process.env.LINQ_API_TOKEN;
}

function makeSignedRequest(secret, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const signedPayload = `${timestamp}.${rawBody}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');
  return { timestamp, signature, rawBody };
}

// ─── Provider detection tests ─────────────────────────────────────────────────

describe('isLinqAvailable', () => {
  let sms;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('twilio');
    jest.mock('../src/db');
  });

  it('returns true when token set', () => {
    process.env.LINQ_API_TOKEN = 'sometoken';
    sms = require('../src/sms');
    expect(sms.isLinqAvailable()).toBe(true);
  });

  it('returns false when token missing', () => {
    delete process.env.LINQ_API_TOKEN;
    sms = require('../src/sms');
    expect(sms.isLinqAvailable()).toBe(false);
  });

  it('returns false when token is empty string', () => {
    process.env.LINQ_API_TOKEN = '';
    sms = require('../src/sms');
    expect(sms.isLinqAvailable()).toBe(false);
  });

  afterEach(() => {
    delete process.env.LINQ_API_TOKEN;
  });
});

// ─── Linq mode tests ──────────────────────────────────────────────────────────

describe('Linq mode (LINQ_API_TOKEN set)', () => {
  let sms;
  let mockFetch;
  let mockTwilioCreate;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('twilio');
    jest.mock('../src/db');
    jest.mock('../src/utils/limiter', () => ({
      checkLimit: jest.fn().mockResolvedValue(true),
      incrementCount: jest.fn().mockResolvedValue(undefined),
    }));

    makeLinqEnv();

    // Mock global fetch
    mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'msg_linq_123' }),
      text: () => Promise.resolve(''),
    });
    global.fetch = mockFetch;

    // Mock Twilio
    mockTwilioCreate = jest.fn().mockResolvedValue({ sid: 'SM_twilio_123' });
    const twilioMock = require('twilio');
    twilioMock.mockReturnValue({
      messages: { create: mockTwilioCreate },
    });

    // Mock DB
    const dbMock = require('../src/db');
    dbMock.getUserById.mockResolvedValue({ id: 1, phone_number: '+15551234567' });
    dbMock.logSentMessage.mockResolvedValue(undefined);
    dbMock.checkAndIncrementGlobalLimit.mockResolvedValue(true);

    sms = require('../src/sms');
  });

  afterEach(() => {
    clearLinqEnv();
    delete global.fetch;
  });

  it('sendMessage POSTs to correct v3 endpoint', async () => {
    await sms.sendMessage('+15551234567', 'hello', 1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.linqapp.com/api/partner/v3/messages',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('sendMessage uses Authorization Bearer header', async () => {
    await sms.sendMessage('+15551234567', 'hello', 1);
    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers['Authorization']).toBe('Bearer test_linq_token');
  });

  it('sendMessage body has correct to/from/body/preferred_service fields', async () => {
    await sms.sendMessage('+15551234567', 'hello world', 1);
    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.to).toBe('+15551234567');
    expect(body.from).toBe('+15005550006');
    expect(body.body).toBe('hello world');
    expect(body.preferred_service).toBe('iMessage');
  });

  it('sendMessage falls back to Twilio on Linq error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Linq network error'));
    const result = await sms.sendMessage('+15551234567', 'hello', 1);
    expect(mockTwilioCreate).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('sendMessage does not send when over per-user limit', async () => {
    jest.resetModules();
    jest.mock('twilio');
    jest.mock('../src/db');
    jest.mock('../src/utils/limiter', () => ({
      checkLimit: jest.fn().mockResolvedValue(false),
      incrementCount: jest.fn().mockResolvedValue(undefined),
    }));
    makeLinqEnv();
    global.fetch = mockFetch;
    sms = require('../src/sms');

    const result = await sms.sendMessage('+15551234567', 'hello', 1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('sendMessage logs to sent_messages on success', async () => {
    const dbMock = require('../src/db');
    await sms.sendMessage('+15551234567', 'hello', 1);
    expect(dbMock.logSentMessage).toHaveBeenCalledWith(1, 'outbound', 'hello', 'sent');
  });

  it('sendMessage returns {success: false} on total failure without throwing', async () => {
    mockFetch.mockRejectedValue(new Error('Linq down'));
    mockTwilioCreate.mockRejectedValue(new Error('Twilio down'));
    const result = await sms.sendMessage('+15551234567', 'hello', 1);
    expect(result).toEqual({ success: false });
  });

  it('sendMultiple sends with 1500ms delays', async () => {
    jest.useFakeTimers();
    const texts = ['msg1', 'msg2', 'msg3'];

    try {
      const promise = sms.sendMultiple('+15551234567', texts, 1, 1500);
      // Flush all pending timers and microtasks
      await jest.runAllTimersAsync();
      const results = await promise;
      expect(results).toHaveLength(3);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('sendTypingIndicator POSTs to typing-indicators endpoint', async () => {
    // linqSendTypingIndicator calls fetch synchronously before any await,
    // so fetch is guaranteed to be called by the time sendTypingIndicator resolves.
    await sms.sendTypingIndicator('+15551234567', 1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.linqapp.com/api/partner/v3/typing-indicators',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('sendReaction POSTs to reactions endpoint', async () => {
    await sms.sendReaction('+15551234567', 'msg_123', '❤️', 1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.linqapp.com/api/partner/v3/reactions',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('sendTypingIndicator swallows errors silently', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    await expect(sms.sendTypingIndicator('+15551234567', 1)).resolves.not.toThrow();
  });

  it('sendReaction swallows errors silently', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    await expect(sms.sendReaction('+15551234567', 'msg_x', '👍', 1)).resolves.not.toThrow();
  });
});

// ─── Twilio mode tests ────────────────────────────────────────────────────────

describe('Twilio mode (LINQ_API_TOKEN not set)', () => {
  let sms;
  let mockTwilioCreate;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('twilio');
    jest.mock('../src/db');
    jest.mock('../src/utils/limiter', () => ({
      checkLimit: jest.fn().mockResolvedValue(true),
      incrementCount: jest.fn().mockResolvedValue(undefined),
    }));

    clearLinqEnv();

    mockTwilioCreate = jest.fn().mockResolvedValue({ sid: 'SM_twilio_123' });
    const twilioMock = require('twilio');
    twilioMock.mockReturnValue({
      messages: { create: mockTwilioCreate },
    });

    const dbMock = require('../src/db');
    dbMock.getUserById.mockResolvedValue({ id: 1, phone_number: '+15551234567' });
    dbMock.logSentMessage.mockResolvedValue(undefined);
    dbMock.checkAndIncrementGlobalLimit.mockResolvedValue(true);

    sms = require('../src/sms');
  });

  it('sendMessage calls twilio client not fetch', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;
    await sms.sendMessage('+15551234567', 'hello', 1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockTwilioCreate).toHaveBeenCalled();
    delete global.fetch;
  });

  it('sendMessage sends correct body/from/to', async () => {
    await sms.sendMessage('+15551234567', 'test message', 1);
    expect(mockTwilioCreate).toHaveBeenCalledWith({
      body: 'test message',
      from: process.env.TWILIO_PHONE_NUMBER,
      to: '+15551234567',
    });
  });

  it('sendTypingIndicator is no-op (no error thrown)', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;
    await expect(sms.sendTypingIndicator('+15551234567', 1)).resolves.not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    delete global.fetch;
  });

  it('sendReaction is no-op (no error thrown)', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;
    await expect(sms.sendReaction('+15551234567', 'msg_x', '❤️', 1)).resolves.not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    delete global.fetch;
  });
});

// ─── Webhook verification tests ───────────────────────────────────────────────

describe('verifyLinqWebhook', () => {
  // must be prefixed with 'mock' to be allowed in jest.mock() factories
  const mockWebhookSecret = 'test_webhook_secret';
  let sms;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('twilio');
    jest.mock('../src/db');

    // Mock fs to return our test secret
    jest.mock('fs', () => ({
      ...jest.requireActual('fs'),
      existsSync: jest.fn().mockReturnValue(true),
      readFileSync: jest.fn().mockReturnValue(mockWebhookSecret),
      writeFileSync: jest.fn(),
    }));

    makeLinqEnv();
    sms = require('../src/sms');
  });

  afterEach(() => {
    clearLinqEnv();
  });

  function mockRes() {
    const res = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      sendStatus: jest.fn().mockReturnThis(),
    };
    return res;
  }

  it('passes valid signature and timestamp', () => {
    const { timestamp, signature, rawBody } = makeSignedRequest(mockWebhookSecret, '{"event":"test"}');
    const req = {
      headers: {
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': signature,
      },
      rawBody,
    };
    const res = mockRes();
    const next = jest.fn();

    sms.verifyLinqWebhook(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects missing headers with 401', () => {
    const req = { headers: {}, rawBody: '{}' };
    const res = mockRes();
    const next = jest.fn();

    sms.verifyLinqWebhook(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects stale timestamp with 401', () => {
    const staleTimestamp = (Math.floor(Date.now() / 1000) - 400).toString();
    const rawBody = '{"event":"test"}';
    const signedPayload = `${staleTimestamp}.${rawBody}`;
    const signature = crypto
      .createHmac('sha256', mockWebhookSecret)
      .update(signedPayload)
      .digest('hex');

    const req = {
      headers: {
        'x-webhook-timestamp': staleTimestamp,
        'x-webhook-signature': signature,
      },
      rawBody,
    };
    const res = mockRes();
    const next = jest.fn();

    sms.verifyLinqWebhook(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects wrong signature with 401', () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const req = {
      headers: {
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': 'deadbeefdeadbeef',
      },
      rawBody: '{"event":"test"}',
    };
    const res = mockRes();
    const next = jest.fn();

    sms.verifyLinqWebhook(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── Health endpoint provider detection ──────────────────────────────────────

describe('health endpoint provider field', () => {
  it('shows linq when token set', async () => {
    jest.resetModules();
    jest.mock('twilio');
    jest.mock('../src/db');
    jest.mock('../src/utils/limiter', () => ({
      checkLimit: jest.fn(),
      incrementCount: jest.fn(),
    }));
    makeLinqEnv();
    const sms = require('../src/sms');
    expect(sms.isLinqAvailable()).toBe(true);
    clearLinqEnv();
  });

  it('shows twilio when token missing', () => {
    jest.resetModules();
    jest.mock('twilio');
    jest.mock('../src/db');
    clearLinqEnv();
    const sms = require('../src/sms');
    expect(sms.isLinqAvailable()).toBe(false);
  });
});
