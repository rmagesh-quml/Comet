'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');
const request = require('supertest');

// ─── All mocks must be declared before require('../../src/index') ─────────────

const mockIsLinqAvailable = jest.fn().mockReturnValue(false);
const mockVerifyLinqWebhook = jest.fn((req, res, next) => next());
const mockSendMessage = jest.fn().mockResolvedValue(undefined);
const mockDetectAndUpdateMessagingService = jest.fn().mockResolvedValue(undefined);
const mockRegisterLinqWebhook = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/sms', () => ({
  isLinqAvailable: (...args) => mockIsLinqAvailable(...args),
  verifyLinqWebhook: (...args) => mockVerifyLinqWebhook(...args),
  sendMessage: (...args) => mockSendMessage(...args),
  detectAndUpdateMessagingService: (...args) => mockDetectAndUpdateMessagingService(...args),
  registerLinqWebhook: (...args) => mockRegisterLinqWebhook(...args),
}));

const mockGetResponse = jest.fn().mockResolvedValue('hey there!');
jest.mock('../../src/brain', () => ({
  getResponse: (...args) => mockGetResponse(...args),
}));

const mockGetOrCreateUser = jest.fn();
const mockUpdateUser = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/db', () => ({
  getOrCreateUser: (...args) => mockGetOrCreateUser(...args),
  updateUser: (...args) => mockUpdateUser(...args),
  setup: jest.fn().mockResolvedValue(undefined),
  close: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/scheduler', () => ({ scheduleAllJobs: jest.fn() }));

jest.mock('../../src/memory/store', () => ({
  initQdrant: jest.fn().mockResolvedValue(undefined),
}));

const mockHandleOnboardingMessage = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/onboarding', () => ({
  handleOnboardingMessage: (...args) => mockHandleOnboardingMessage(...args),
}));

jest.mock('../../src/integrations/bt_static', () => ({
  downloadAndParseGTFS: jest.fn().mockResolvedValue(undefined),
}));

const mockGraphWebhookHandler = jest.fn((req, res) => res.sendStatus(200));
jest.mock('../../src/integrations/outlook', () => ({
  graphWebhookHandler: (...args) => mockGraphWebhookHandler(...args),
  renewWebhookSubscriptions: jest.fn().mockResolvedValue(undefined),
}));

const mockHandleGmailNotification = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/integrations/gmail', () => ({
  handleGmailNotification: (...args) => mockHandleGmailNotification(...args),
}));

const mockHandleDiscordDigest = jest.fn((req, res) => res.sendStatus(200));
jest.mock('../../src/integrations/discord', () => ({
  handleDiscordDigest: (...args) => mockHandleDiscordDigest(...args),
}));

const mockValidateRequest = jest.fn().mockReturnValue(true);
jest.mock('twilio', () => {
  const mock = jest.fn(() => ({}));
  mock.validateRequest = (...args) => mockValidateRequest(...args);
  return mock;
});

// ─── Load app after mocks are in place ───────────────────────────────────────

const app = require('../../src/index');

function flush() {
  return new Promise(resolve => setTimeout(resolve, 10));
}

const PHONE = '+15551234567';
const ONBOARDED_USER = {
  id: 1,
  phone_number: PHONE,
  onboarding_complete: true,
  onboarding_step: 8,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('HTTP integration — webhook routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsLinqAvailable.mockReturnValue(false);
    mockGetResponse.mockResolvedValue('hey there!');
    mockGetOrCreateUser.mockResolvedValue(ONBOARDED_USER);
    mockValidateRequest.mockReturnValue(true);
    mockVerifyLinqWebhook.mockImplementation((req, res, next) => next());
  });

  // ─── Health endpoint ────────────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns 200 with status ok', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(typeof res.body.uptime).toBe('number');
    });

    it('reports provider: twilio when Linq unavailable', async () => {
      mockIsLinqAvailable.mockReturnValue(false);
      const res = await request(app).get('/health');
      expect(res.body.provider).toBe('twilio');
    });

    it('reports provider: linq when Linq available', async () => {
      mockIsLinqAvailable.mockReturnValue(true);
      const res = await request(app).get('/health');
      expect(res.body.provider).toBe('linq');
    });
  });

  // ─── POST /webhook — Twilio mode ────────────────────────────────────────

  describe('POST /webhook (Twilio mode)', () => {
    it('returns 200 immediately', async () => {
      const res = await request(app)
        .post('/webhook')
        .type('form')
        .send({ From: PHONE, Body: 'hello' });
      expect(res.status).toBe(200);
    });

    it('calls getResponse and sendMessage for onboarded user', async () => {
      await request(app)
        .post('/webhook')
        .type('form')
        .send({ From: PHONE, Body: 'how am i doing?' });
      await flush();
      expect(mockGetResponse).toHaveBeenCalledWith(1, 'how am i doing?');
      expect(mockSendMessage).toHaveBeenCalledWith(PHONE, 'hey there!', 1);
    });

    it('routes to onboarding for user not yet onboarded', async () => {
      mockGetOrCreateUser.mockResolvedValue({
        id: 2, phone_number: '+15559999999',
        onboarding_complete: false, onboarding_step: 0,
      });
      await request(app)
        .post('/webhook')
        .type('form')
        .send({ From: '+15559999999', Body: 'hi' });
      await flush();
      expect(mockHandleOnboardingMessage).toHaveBeenCalled();
      expect(mockGetResponse).not.toHaveBeenCalled();
    });

    it('ignores empty body', async () => {
      await request(app)
        .post('/webhook')
        .type('form')
        .send({ From: PHONE, Body: '   ' });
      await flush();
      expect(mockGetResponse).not.toHaveBeenCalled();
    });

    it('returns 403 when Twilio signature is invalid outside test env', async () => {
      const orig = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      mockValidateRequest.mockReturnValue(false);
      const res = await request(app)
        .post('/webhook')
        .type('form')
        .send({ From: PHONE, Body: 'test' });
      process.env.NODE_ENV = orig;
      expect(res.status).toBe(403);
    });
  });

  // ─── POST /webhook — Linq mode ───────────────────────────────────────────

  describe('POST /webhook (Linq mode)', () => {
    beforeEach(() => {
      mockIsLinqAvailable.mockReturnValue(true);
    });

    it('ignores non-message events', async () => {
      const res = await request(app)
        .post('/webhook')
        .send({ event: 'message.sent', data: { from: PHONE, body: 'hi' } });
      expect(res.status).toBe(200);
      await flush();
      expect(mockGetResponse).not.toHaveBeenCalled();
    });

    it('processes message.received events', async () => {
      const res = await request(app)
        .post('/webhook')
        .send({ event: 'message.received', data: { from: PHONE, body: 'yo', id: 'linq-1', service: 'iMessage' } });
      expect(res.status).toBe(200);
      await flush();
      expect(mockGetResponse).toHaveBeenCalledWith(1, 'yo');
    });

    it('deduplicates messages with the same id', async () => {
      const body = {
        event: 'message.received',
        data: { from: PHONE, body: 'dupe', id: 'linq-dedup-99' },
      };
      await request(app).post('/webhook').send(body);
      await flush();
      await request(app).post('/webhook').send(body);
      await flush();
      expect(mockGetResponse).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Graph webhook ──────────────────────────────────────────────────────

  describe('/graph-webhook', () => {
    it('GET /graph-webhook calls graphWebhookHandler', async () => {
      await request(app).get('/graph-webhook').query({ validationToken: 'abc' });
      expect(mockGraphWebhookHandler).toHaveBeenCalled();
    });

    it('POST /graph-webhook calls graphWebhookHandler', async () => {
      await request(app).post('/graph-webhook').send({ value: [] });
      expect(mockGraphWebhookHandler).toHaveBeenCalled();
    });
  });

  // ─── Gmail webhook ──────────────────────────────────────────────────────

  describe('POST /gmail-webhook', () => {
    it('returns 204 immediately', async () => {
      const res = await request(app)
        .post('/gmail-webhook')
        .send({ message: { data: Buffer.from('{}').toString('base64') } });
      expect(res.status).toBe(204);
    });

    it('calls handleGmailNotification asynchronously', async () => {
      await request(app).post('/gmail-webhook').send({ message: { data: 'test' } });
      await flush();
      expect(mockHandleGmailNotification).toHaveBeenCalled();
    });
  });

  // ─── Discord digest ─────────────────────────────────────────────────────

  describe('POST /discord-digest', () => {
    it('delegates to handleDiscordDigest handler', async () => {
      await request(app).post('/discord-digest').send({ data: 'test' });
      expect(mockHandleDiscordDigest).toHaveBeenCalled();
    });
  });
});
