'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');
const request = require('supertest');

// ─── All mocks must be declared before require of app ────────────────────────

const mockIsLinqAvailable = jest.fn().mockReturnValue(false);
const mockSendMessage = jest.fn().mockResolvedValue(undefined);
const mockDetectAndUpdateMessagingService = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/sms', () => ({
  isLinqAvailable: (...args) => mockIsLinqAvailable(...args),
  verifyLinqWebhook: jest.fn((req, res, next) => next()),
  sendMessage: (...args) => mockSendMessage(...args),
  detectAndUpdateMessagingService: (...args) => mockDetectAndUpdateMessagingService(...args),
  registerLinqWebhook: jest.fn().mockResolvedValue(undefined),
}));

const mockGetResponse = jest.fn().mockResolvedValue('sure thing!');
jest.mock('../../src/brain', () => ({
  getResponse: (...args) => mockGetResponse(...args),
}));

const mockGetOrCreateUser = jest.fn();
const mockUpdateUser = jest.fn().mockResolvedValue(undefined);
const mockScheduleMessage = jest.fn().mockResolvedValue({ id: 1 });
jest.mock('../../src/db', () => ({
  getOrCreateUser: (...args) => mockGetOrCreateUser(...args),
  updateUser: (...args) => mockUpdateUser(...args),
  scheduleMessage: (...args) => mockScheduleMessage(...args),
  setup: jest.fn().mockResolvedValue(undefined),
  close: jest.fn().mockResolvedValue(undefined),
}));

const mockClassify = jest.fn().mockResolvedValue(JSON.stringify({ name: 'Alex' }));
jest.mock('../../src/utils/claude', () => ({
  classify: (...args) => mockClassify(...args),
  generateUserMessage: jest.fn().mockResolvedValue('good morning!'),
}));

const mockStoreClassSchedule = jest.fn().mockResolvedValue([]);
jest.mock('../../src/integrations/schedule', () => ({
  storeClassSchedule: (...args) => mockStoreClassSchedule(...args),
  isInClass: jest.fn().mockResolvedValue(false),
}));

const mockStoreMemory = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/memory/store', () => ({
  initQdrant: jest.fn().mockResolvedValue(undefined),
  storeMemory: (...args) => mockStoreMemory(...args),
  searchMemories: jest.fn().mockResolvedValue([]),
}));

const mockGetNearestStops = jest.fn().mockResolvedValue([{ stopId: 'STOP1', distanceMeters: 100 }]);
jest.mock('../../src/integrations/bt_static', () => ({
  downloadAndParseGTFS: jest.fn().mockResolvedValue(undefined),
  getNearestStops: (...args) => mockGetNearestStops(...args),
}));

jest.mock('../../src/scheduler', () => ({ scheduleAllJobs: jest.fn() }));

jest.mock('../../src/integrations/outlook', () => ({
  graphWebhookHandler: jest.fn((req, res) => res.sendStatus(200)),
  renewWebhookSubscriptions: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/integrations/gmail', () => ({
  handleGmailNotification: jest.fn().mockResolvedValue(undefined),
  renewGmailWatches: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/deletion', () => ({
  isDeletionRequest: jest.fn().mockReturnValue(false),
  requestDeletion: jest.fn().mockResolvedValue(undefined),
  confirmDeletion: jest.fn().mockResolvedValue(false),
}));

jest.mock('../../src/briefTime', () => ({
  parseBriefTime: jest.fn().mockReturnValue(null),
  getEffectiveBriefHour: jest.fn().mockResolvedValue(9),
}));

jest.mock('../../src/integrations/discord', () => ({
  handleDiscordDigest: jest.fn((req, res) => res.sendStatus(200)),
}));

jest.mock('twilio', () => {
  const mock = jest.fn(() => ({}));
  mock.validateRequest = jest.fn().mockReturnValue(true);
  return mock;
});

// ─── Load app after all mocks ─────────────────────────────────────────────────

const app = require('../../src/index');

function flush() {
  return new Promise(resolve => setTimeout(resolve, 10));
}

function webhookPost(from, body) {
  return request(app).post('/webhook').type('form').send({ From: from, Body: body });
}

const PHONE = '+15551234567';

function makeUser(step, overrides = {}) {
  return {
    id: 1,
    phone_number: PHONE,
    onboarding_complete: false,
    onboarding_step: step,
    name: step >= 2 ? 'Alex' : null,
    canvas_base_url: step >= 3 ? 'https://canvas.vt.edu' : null,
    canvas_token: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('onboarding integration — full HTTP flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsLinqAvailable.mockReturnValue(false);
    mockUpdateUser.mockResolvedValue(undefined);
    mockScheduleMessage.mockResolvedValue({ id: 1 });
    mockClassify.mockResolvedValue(JSON.stringify({ name: 'Alex' }));
    mockStoreClassSchedule.mockResolvedValue([]);
    mockGetNearestStops.mockResolvedValue([{ stopId: 'STOP1', distanceMeters: 100 }]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  // ─── Step 0 — first contact ────────────────────────────────────────────

  it('step 0: new user receives intro messages and advances to step 1', async () => {
    mockGetOrCreateUser.mockResolvedValue(makeUser(0));

    const res = await webhookPost(PHONE, 'hi');
    expect(res.status).toBe(200);
    await flush();

    const messages = mockSendMessage.mock.calls.map(c => c[1]);
    expect(messages.some(m => /here|proactive|ai/i.test(m))).toBe(true);
    expect(messages.some(m => /name/i.test(m))).toBe(true);
    expect(mockUpdateUser).toHaveBeenCalledWith(1, { onboarding_step: 1 });
  });

  // ─── Step 1 — name ─────────────────────────────────────────────────────

  it('step 1: saves extracted name and asks for Canvas URL', async () => {
    mockGetOrCreateUser.mockResolvedValue(makeUser(1));

    const res = await webhookPost(PHONE, 'Alex');
    expect(res.status).toBe(200);
    await flush();

    expect(mockUpdateUser).toHaveBeenCalledWith(
      1, expect.objectContaining({ name: 'Alex', onboarding_step: 2 })
    );
    const messages = mockSendMessage.mock.calls.map(c => c[1]);
    expect(messages.some(m => /canvas/i.test(m))).toBe(true);
  });

  it('step 1: falls back to first word of message if classify fails', async () => {
    mockGetOrCreateUser.mockResolvedValue(makeUser(1));
    mockClassify.mockRejectedValue(new Error('network'));

    await webhookPost(PHONE, 'Jordan');
    await flush();

    expect(mockUpdateUser).toHaveBeenCalledWith(
      1, expect.objectContaining({ name: 'Jordan' })
    );
  });

  // ─── Step 2 — Canvas URL ───────────────────────────────────────────────

  it('step 2: accepts valid Canvas URL and advances', async () => {
    mockGetOrCreateUser.mockResolvedValue(makeUser(2));

    const res = await webhookPost(PHONE, 'canvas.vt.edu');
    expect(res.status).toBe(200);
    await flush();

    expect(mockUpdateUser).toHaveBeenCalledWith(
      1, expect.objectContaining({ canvas_base_url: 'https://canvas.vt.edu', onboarding_step: 3 })
    );
    const messages = mockSendMessage.mock.calls.map(c => c[1]);
    expect(messages.some(m => /token|integrations/i.test(m))).toBe(true);
  });

  it('step 2: rejects URL without a dot', async () => {
    mockGetOrCreateUser.mockResolvedValue(makeUser(2));

    await webhookPost(PHONE, 'notaurl');
    await flush();

    expect(mockUpdateUser).not.toHaveBeenCalled();
    const messages = mockSendMessage.mock.calls.map(c => c[1]);
    expect(messages.some(m => /look right/i.test(m))).toBe(true);
  });

  // ─── Step 3 — Canvas token ─────────────────────────────────────────────

  it('step 3: valid token saves and advances to schedule step', async () => {
    mockGetOrCreateUser.mockResolvedValue(makeUser(3));
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    await webhookPost(PHONE, 'token123abc');
    await flush();

    expect(mockUpdateUser).toHaveBeenCalledWith(
      1, expect.objectContaining({ canvas_token: 'token123abc', onboarding_step: 4 })
    );
    const messages = mockSendMessage.mock.calls.map(c => c[1]);
    expect(messages.some(m => /canvas connected/i.test(m))).toBe(true);
  });

  it('step 3: invalid token sends error without advancing', async () => {
    mockGetOrCreateUser.mockResolvedValue(makeUser(3));
    global.fetch = jest.fn().mockResolvedValue({ ok: false });

    await webhookPost(PHONE, 'badtoken');
    await flush();

    expect(mockUpdateUser).not.toHaveBeenCalled();
    const messages = mockSendMessage.mock.calls.map(c => c[1]);
    expect(messages.some(m => /try/i.test(m))).toBe(true);
  });

  // ─── Step 4 — class schedule ───────────────────────────────────────────

  it('step 4: stores schedule and asks about email', async () => {
    mockGetOrCreateUser.mockResolvedValue(makeUser(4));

    await webhookPost(PHONE, 'MWF 10-11am CS 3114');
    await flush();

    expect(mockStoreClassSchedule).toHaveBeenCalledWith(1, 'MWF 10-11am CS 3114');
    expect(mockUpdateUser).toHaveBeenCalledWith(1, { onboarding_step: 5 });
    const messages = mockSendMessage.mock.calls.map(c => c[1]);
    expect(messages.some(m => /email|class/i.test(m))).toBe(true);
  });

  // ─── Step 5 — email opt-in ─────────────────────────────────────────────

  it('step 5: yes sends OAuth links', async () => {
    mockGetOrCreateUser.mockResolvedValue(makeUser(5));

    await webhookPost(PHONE, 'yes');
    await flush();

    expect(mockUpdateUser).toHaveBeenCalledWith(1, { onboarding_step: 6 });
    const messages = mockSendMessage.mock.calls.map(c => c[1]);
    expect(messages.some(m => /outlook|microsoft|gmail/i.test(m))).toBe(true);
  });

  it('step 5: skip jumps to dorm question', async () => {
    mockGetOrCreateUser.mockResolvedValue(makeUser(5));

    await webhookPost(PHONE, 'skip');
    await flush();

    expect(mockUpdateUser).toHaveBeenCalledWith(1, { onboarding_step: 7 });
    const messages = mockSendMessage.mock.calls.map(c => c[1]);
    expect(messages.some(m => /dorm|bus/i.test(m))).toBe(true);
  });

  // ─── Step 6 — email done ───────────────────────────────────────────────

  it('step 6: done advances to dorm question', async () => {
    mockGetOrCreateUser.mockResolvedValue(makeUser(6));

    await webhookPost(PHONE, 'done');
    await flush();

    expect(mockUpdateUser).toHaveBeenCalledWith(1, { onboarding_step: 7 });
    const messages = mockSendMessage.mock.calls.map(c => c[1]);
    expect(messages.some(m => /dorm|bus/i.test(m))).toBe(true);
  });

  // ─── Step 7 — dorm / brief time preference ───────────────────────────────

  it('step 7: known dorm advances to brief time preference step', async () => {
    mockGetOrCreateUser.mockResolvedValue(makeUser(7));

    await webhookPost(PHONE, 'Ambler Johnston');
    await flush();

    expect(mockUpdateUser).toHaveBeenCalledWith(
      1, expect.objectContaining({ onboarding_step: 8 })
    );
    // Brief time preference question should be sent
    const messages = mockSendMessage.mock.calls.map(c => c[1]);
    expect(messages.some(m => /morning brief/i.test(m) || /time/i.test(m))).toBe(true);
  });

  it('step 7: skip advances to brief time preference step', async () => {
    mockGetOrCreateUser.mockResolvedValue(makeUser(7));

    await webhookPost(PHONE, 'skip');
    await flush();

    expect(mockUpdateUser).toHaveBeenCalledWith(
      1, expect.objectContaining({ onboarding_step: 8 })
    );
  });

  // ─── Already onboarded ─────────────────────────────────────────────────

  it('onboarded user goes through brain, not onboarding', async () => {
    mockGetOrCreateUser.mockResolvedValue({
      id: 1, phone_number: PHONE,
      onboarding_complete: true, onboarding_step: 8, name: 'Alex',
    });

    await webhookPost(PHONE, 'what do i have due today?');
    await flush();

    expect(mockGetResponse).toHaveBeenCalledWith(1, 'what do i have due today?');
    expect(mockSendMessage).toHaveBeenCalledWith(PHONE, 'sure thing!', 1);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });
});
