'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');

jest.mock('../src/db');
jest.mock('../src/sms');
jest.mock('../src/utils/claude');
jest.mock('../src/integrations/schedule');
jest.mock('../src/memory/store');
jest.mock('../src/integrations/bt_static');
jest.mock('../src/briefTime');

describe('onboarding', () => {
  let onboarding, db, sms, claude, schedule, store, btStatic;

  // Factory: user at a given step with sensible defaults for that step
  function makeUser(step, overrides = {}) {
    return {
      id: 1,
      phone_number: '+15551234567',
      onboarding_step: step,
      onboarding_complete: false,
      name: step >= 2 ? 'Alex' : null,
      canvas_base_url: step >= 3 ? 'https://canvas.vt.edu' : null,
      canvas_token: null,
      campus_lat: null,
      campus_lng: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../src/db');
    jest.mock('../src/sms');
    jest.mock('../src/utils/claude');
    jest.mock('../src/integrations/schedule');
    jest.mock('../src/memory/store');
    jest.mock('../src/integrations/bt_static');

    db       = require('../src/db');
    sms      = require('../src/sms');
    claude   = require('../src/utils/claude');
    schedule = require('../src/integrations/schedule');
    store    = require('../src/memory/store');
    btStatic = require('../src/integrations/bt_static');

    const briefTime = require('../src/briefTime');
    briefTime.parseBriefTime.mockReturnValue(null);

    // Set OAuth env vars so URL builders don't throw
    process.env.MICROSOFT_CLIENT_ID     = 'test-ms-client-id';
    process.env.MICROSOFT_CLIENT_SECRET = 'test-ms-secret';
    process.env.MICROSOFT_REDIRECT_URI  = 'http://localhost:3000/auth/microsoft';
    process.env.GOOGLE_CLIENT_ID        = 'test-google-client-id';
    process.env.GOOGLE_CLIENT_SECRET    = 'test-google-secret';
    process.env.GOOGLE_REDIRECT_URI     = 'http://localhost:3000/auth/google';

    db.updateUser.mockResolvedValue(undefined);
    db.scheduleMessage.mockResolvedValue({ id: 1 });
    db.updateBriefPreference.mockResolvedValue(undefined);
    db.getBriefHour.mockResolvedValue({ hour: 9, minute: 0 });
    db.getUserById.mockResolvedValue({ id: 1, name: 'Alex' });
    sms.sendMessage.mockResolvedValue(undefined);
    claude.classify.mockResolvedValue(JSON.stringify({ name: 'Alex' }));
    schedule.storeClassSchedule.mockResolvedValue([]);
    store.storeMemory.mockResolvedValue(undefined);
    btStatic.getNearestStops.mockResolvedValue([{ stopId: 'STOP1', stopName: 'Test Stop', distanceMeters: 150 }]);

    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    onboarding = require('../src/onboarding');
  });

  // ─── Step 0 — First contact ──────────────────────────────────────────────────

  describe('step 0 — first contact', () => {
    it('sends three welcome messages for any message', async () => {
      await onboarding.handleOnboardingMessage(makeUser(0), 'hello');

      expect(sms.sendMessage).toHaveBeenCalledTimes(3);
    });

    it('first message contains agent name', async () => {
      process.env.AGENT_NAME = 'Comet';
      await onboarding.handleOnboardingMessage(makeUser(0), 'hi');

      expect(sms.sendMessage).toHaveBeenNthCalledWith(
        1, '+15551234567', expect.stringContaining('Comet'), 1
      );
    });

    it('last message asks for name', async () => {
      await onboarding.handleOnboardingMessage(makeUser(0), 'hey');

      const lastCall = sms.sendMessage.mock.calls.at(-1);
      expect(lastCall[1]).toMatch(/name/i);
    });

    it('advances to step 1', async () => {
      await onboarding.handleOnboardingMessage(makeUser(0), 'anything');

      expect(db.updateUser).toHaveBeenCalledWith(1, { onboarding_step: 1 });
    });
  });

  // ─── Step 1 — Name ───────────────────────────────────────────────────────────

  describe('step 1 — name', () => {
    it('calls classify to extract name', async () => {
      await onboarding.handleOnboardingMessage(makeUser(1), 'my name is Alex');

      expect(claude.classify).toHaveBeenCalledWith(
        expect.stringContaining('my name is Alex'),
        50
      );
    });

    it('saves extracted name to DB', async () => {
      claude.classify.mockResolvedValue(JSON.stringify({ name: 'Jordan' }));

      await onboarding.handleOnboardingMessage(makeUser(1), 'jordan');

      expect(db.updateUser).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ name: 'Jordan' })
      );
    });

    it('advances to step 2', async () => {
      await onboarding.handleOnboardingMessage(makeUser(1), 'Alex');

      expect(db.updateUser).toHaveBeenCalledWith(
        1, expect.objectContaining({ onboarding_step: 2 })
      );
    });

    it('greets user by name in response', async () => {
      claude.classify.mockResolvedValue(JSON.stringify({ name: 'Sam' }));

      await onboarding.handleOnboardingMessage(makeUser(1), 'Sam');

      const calls = sms.sendMessage.mock.calls.map(c => c[1]);
      expect(calls.some(m => m.includes('Sam'))).toBe(true);
    });

    it('falls back to first word of message if classify fails', async () => {
      claude.classify.mockRejectedValue(new Error('Claude down'));

      await onboarding.handleOnboardingMessage(makeUser(1), 'Taylor swift');

      expect(db.updateUser).toHaveBeenCalledWith(
        1, expect.objectContaining({ name: 'Taylor' })
      );
    });

    it('falls back to first word if classify returns malformed JSON', async () => {
      claude.classify.mockResolvedValue('not json');

      await onboarding.handleOnboardingMessage(makeUser(1), 'Riley');

      expect(db.updateUser).toHaveBeenCalledWith(
        1, expect.objectContaining({ name: 'Riley' })
      );
    });
  });

  // ─── Step 2 — Canvas URL ─────────────────────────────────────────────────────

  describe('step 2 — canvas URL', () => {
    it('saves canvas_base_url and advances to step 3', async () => {
      await onboarding.handleOnboardingMessage(makeUser(2), 'canvas.vt.edu');

      expect(db.updateUser).toHaveBeenCalledWith(
        1, expect.objectContaining({ canvas_base_url: 'https://canvas.vt.edu', onboarding_step: 3 })
      );
    });

    it('strips https:// prefix before saving', async () => {
      await onboarding.handleOnboardingMessage(makeUser(2), 'https://canvas.vt.edu');

      expect(db.updateUser).toHaveBeenCalledWith(
        1, expect.objectContaining({ canvas_base_url: 'https://canvas.vt.edu' })
      );
    });

    it('rejects message without a dot — does not advance', async () => {
      await onboarding.handleOnboardingMessage(makeUser(2), 'canvas vt edu');

      expect(db.updateUser).not.toHaveBeenCalledWith(
        1, expect.objectContaining({ onboarding_step: 3 })
      );
    });

    it('sends error message for invalid URL', async () => {
      await onboarding.handleOnboardingMessage(makeUser(2), 'notaurl');

      expect(sms.sendMessage).toHaveBeenCalledWith(
        '+15551234567', expect.stringMatching(/doesn't look right/i), 1
      );
    });

    it('sends instructions including the URL', async () => {
      await onboarding.handleOnboardingMessage(makeUser(2), 'canvas.vt.edu');

      const messages = sms.sendMessage.mock.calls.map(c => c[1]).join(' ');
      expect(messages).toContain('canvas.vt.edu');
    });
  });

  // ─── Step 3 — Canvas token ───────────────────────────────────────────────────

  describe('step 3 — canvas token', () => {
    it('validates token against Canvas API', async () => {
      await onboarding.handleOnboardingMessage(makeUser(3), 'mytoken123');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://canvas.vt.edu/api/v1/users/self',
        expect.objectContaining({
          headers: { Authorization: 'Bearer mytoken123' },
        })
      );
    });

    it('saves token and advances to step 4 on success', async () => {
      global.fetch.mockResolvedValue({ ok: true });

      await onboarding.handleOnboardingMessage(makeUser(3), 'validtoken');

      expect(db.updateUser).toHaveBeenCalledWith(
        1, expect.objectContaining({ canvas_token: 'validtoken', onboarding_step: 4 })
      );
    });

    it('sends confirmation message on success', async () => {
      await onboarding.handleOnboardingMessage(makeUser(3), 'validtoken');

      const messages = sms.sendMessage.mock.calls.map(c => c[1]);
      expect(messages.some(m => m.includes('Canvas connected'))).toBe(true);
    });

    it('stays on step 3 and sends retry message when Canvas API fails', async () => {
      global.fetch.mockResolvedValue({ ok: false, status: 401 });

      await onboarding.handleOnboardingMessage(makeUser(3), 'badtoken');

      expect(db.updateUser).not.toHaveBeenCalledWith(
        1, expect.objectContaining({ onboarding_step: 4 })
      );
      expect(sms.sendMessage).toHaveBeenCalledWith(
        '+15551234567', expect.stringMatching(/didn't work|try copying/i), 1
      );
    });

    it('stays on step 3 when fetch throws', async () => {
      global.fetch.mockRejectedValue(new Error('Network error'));

      await onboarding.handleOnboardingMessage(makeUser(3), 'badtoken');

      expect(db.updateUser).not.toHaveBeenCalledWith(
        1, expect.objectContaining({ onboarding_step: 4 })
      );
    });

    it('trims whitespace from token before validation', async () => {
      await onboarding.handleOnboardingMessage(makeUser(3), '  tokenwithtabs  ');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: { Authorization: 'Bearer tokenwithtabs' },
        })
      );
    });
  });

  // ─── Step 4 — Class schedule ─────────────────────────────────────────────────

  describe('step 4 — class schedule', () => {
    it('calls storeClassSchedule with userId and raw message', async () => {
      await onboarding.handleOnboardingMessage(
        makeUser(4), 'MWF 9-10am CS3114 in McBryde'
      );

      expect(schedule.storeClassSchedule).toHaveBeenCalledWith(
        1, 'MWF 9-10am CS3114 in McBryde'
      );
    });

    it('advances to step 5', async () => {
      await onboarding.handleOnboardingMessage(makeUser(4), 'MWF 9am CS class');

      expect(db.updateUser).toHaveBeenCalledWith(
        1, expect.objectContaining({ onboarding_step: 5 })
      );
    });

    it('sends "never text you during class" confirmation', async () => {
      await onboarding.handleOnboardingMessage(makeUser(4), 'MWF 9am class');

      const messages = sms.sendMessage.mock.calls.map(c => c[1]).join(' ');
      expect(messages).toMatch(/during class/i);
    });
  });

  // ─── Step 5 — Email choice ────────────────────────────────────────────────────

  describe('step 5 — email choice', () => {
    it('sends both OAuth URLs when user says yes', async () => {
      await onboarding.handleOnboardingMessage(makeUser(5), 'yes');

      const messages = sms.sendMessage.mock.calls.map(c => c[1]);
      expect(messages.some(m => m.includes('microsoftonline.com'))).toBe(true);
      expect(messages.some(m => m.includes('accounts.google.com'))).toBe(true);
    });

    it('advances to step 6 when yes', async () => {
      await onboarding.handleOnboardingMessage(makeUser(5), 'yeah');

      expect(db.updateUser).toHaveBeenCalledWith(
        1, expect.objectContaining({ onboarding_step: 6 })
      );
    });

    it('accepts variations: y, sure, yeah', async () => {
      for (const word of ['y', 'sure', 'yeah']) {
        sms.sendMessage.mockClear();
        db.updateUser.mockClear();

        await onboarding.handleOnboardingMessage(makeUser(5), word);

        const messages = sms.sendMessage.mock.calls.map(c => c[1]);
        expect(messages.some(m => m.includes('microsoftonline.com'))).toBe(true);
      }
    });

    it('jumps to step 7 (not 6) when user skips', async () => {
      await onboarding.handleOnboardingMessage(makeUser(5), 'skip');

      expect(db.updateUser).toHaveBeenCalledWith(
        1, expect.objectContaining({ onboarding_step: 7 })
      );
      expect(db.updateUser).not.toHaveBeenCalledWith(
        1, expect.objectContaining({ onboarding_step: 6 })
      );
    });

    it('asks about dorm when skipping email', async () => {
      await onboarding.handleOnboardingMessage(makeUser(5), 'no');

      expect(sms.sendMessage).toHaveBeenCalledWith(
        '+15551234567', expect.stringMatching(/dorm|apartment/i), 1
      );
    });

    it('OAuth URLs contain userId in state param', async () => {
      await onboarding.handleOnboardingMessage(makeUser(5, { id: 42 }), 'yes');

      const messages = sms.sendMessage.mock.calls.map(c => c[1]);
      const microsoftMsg = messages.find(m => m.includes('microsoftonline.com'));
      const googleMsg    = messages.find(m => m.includes('accounts.google.com'));

      expect(microsoftMsg).toContain('state=42');
      expect(googleMsg).toContain('state=42');
    });
  });

  // ─── Step 6 — OAuth confirmation ─────────────────────────────────────────────

  describe('step 6 — OAuth confirmation', () => {
    it('sends "email connected" on done', async () => {
      await onboarding.handleOnboardingMessage(makeUser(6), 'done');

      expect(sms.sendMessage).toHaveBeenCalledWith(
        '+15551234567', expect.stringContaining('email connected'), 1
      );
    });

    it('advances to step 7 regardless of response', async () => {
      for (const reply of ['done', 'skip', 'both']) {
        db.updateUser.mockClear();
        await onboarding.handleOnboardingMessage(makeUser(6), reply);

        expect(db.updateUser).toHaveBeenCalledWith(
          1, expect.objectContaining({ onboarding_step: 7 })
        );
      }
    });

    it('asks about dorm in all cases', async () => {
      await onboarding.handleOnboardingMessage(makeUser(6), 'skip');

      expect(sms.sendMessage).toHaveBeenCalledWith(
        '+15551234567', expect.stringMatching(/dorm|apartment/i), 1
      );
    });
  });

  // ─── Step 7 — Dorm / location ─────────────────────────────────────────────────

  describe('step 7 — dorm/location', () => {
    it('saves coordinates for known dorm', async () => {
      await onboarding.handleOnboardingMessage(makeUser(7), 'Slusher Tower');

      expect(db.updateUser).toHaveBeenCalledWith(
        1, expect.objectContaining({ campus_lat: expect.any(Number), campus_lng: expect.any(Number) })
      );
    });

    it('saves nearest bus stop ID', async () => {
      await onboarding.handleOnboardingMessage(makeUser(7), 'Harper Hall');

      expect(db.updateUser).toHaveBeenCalledWith(
        1, expect.objectContaining({ nearest_bus_stop_id: 'STOP1' })
      );
    });

    it('stores location as memory', async () => {
      await onboarding.handleOnboardingMessage(makeUser(7), 'Peddrew-Yates');

      expect(store.storeMemory).toHaveBeenCalledWith(
        1, expect.stringContaining('Peddrew-Yates'), expect.any(Object)
      );
    });

    it('skips coordinates when user says skip', async () => {
      await onboarding.handleOnboardingMessage(makeUser(7), 'skip');

      expect(db.updateUser).not.toHaveBeenCalledWith(
        1, expect.objectContaining({ campus_lat: expect.any(Number) })
      );
    });

    it('uses Drillfield default for unrecognized location', async () => {
      await onboarding.handleOnboardingMessage(makeUser(7), '123 Main St, Blacksburg');

      expect(db.updateUser).toHaveBeenCalledWith(
        1, expect.objectContaining({ campus_lat: 37.2284, campus_lng: -80.4234 })
      );
    });

    it('proceeds to brief time preference step even when skip', async () => {
      await onboarding.handleOnboardingMessage(makeUser(7), 'skip');

      expect(db.updateUser).toHaveBeenCalledWith(
        1, expect.objectContaining({ onboarding_step: 8 })
      );
    });

    it('silently continues when getNearestStops throws', async () => {
      btStatic.getNearestStops.mockRejectedValue(new Error('No stops'));

      await expect(
        onboarding.handleOnboardingMessage(makeUser(7), 'Slusher')
      ).resolves.not.toThrow();
    });
  });

  // ─── Step 8 — Brief time preference ─────────────────────────────────────────

  describe('step 8 — brief time preference', () => {
    it('sends brief time preference question', async () => {
      await onboarding.handleOnboardingMessage(makeUser(8), '9am');

      // Step 8 processes time preference and calls completeOnboarding
      expect(db.updateUser).toHaveBeenCalledWith(
        1, expect.objectContaining({ onboarding_complete: true })
      );
    });

    it('calls updateBriefPreference when valid time given', async () => {
      const briefTime = require('../src/briefTime');
      briefTime.parseBriefTime.mockReturnValue({ hour: 8, minute: 0 });

      await onboarding.handleOnboardingMessage(makeUser(8), '8am');

      expect(db.updateBriefPreference).toHaveBeenCalledWith(1, 8, 0);
    });

    it('does not call updateBriefPreference for skip', async () => {
      const briefTime = require('../src/briefTime');
      briefTime.parseBriefTime.mockReturnValue(null);

      await onboarding.handleOnboardingMessage(makeUser(8), 'skip');

      expect(db.updateBriefPreference).not.toHaveBeenCalled();
    });

    it('completes onboarding regardless of input', async () => {
      await onboarding.handleOnboardingMessage(makeUser(8), 'whatever');

      expect(db.updateUser).toHaveBeenCalledWith(
        1, expect.objectContaining({ onboarding_complete: true })
      );
    });
  });

  // ─── Step 9 — Already onboarded ─────────────────────────────────────────────
  // Step 9 is set after completeOnboarding runs (from step 8). If someone texts
  // again after onboarding, step 9 just sends a friendly "already set" message.

  describe('step 9 — already onboarded', () => {
    it('sends a single "already set" message', async () => {
      await onboarding.handleOnboardingMessage(makeUser(9), 'anything');

      expect(sms.sendMessage).toHaveBeenCalledTimes(1);
      const msg = sms.sendMessage.mock.calls[0][1];
      expect(msg).toMatch(/already all set/i);
    });

    it('does not call updateUser or scheduleMessage', async () => {
      await onboarding.handleOnboardingMessage(makeUser(9), 'anything');

      expect(db.updateUser).not.toHaveBeenCalled();
      expect(db.scheduleMessage).not.toHaveBeenCalled();
    });
  });

  // ─── Concurrent onboarding ────────────────────────────────────────────────────

  describe('concurrent onboarding', () => {
    it('two users at step 3 simultaneously each get correct response', async () => {
      const user1 = makeUser(3, { id: 1, phone_number: '+11111111111' });
      const user2 = makeUser(3, { id: 2, phone_number: '+12222222222' });

      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true })  // user1 token valid
        .mockResolvedValueOnce({ ok: true }); // user2 token valid

      await Promise.all([
        onboarding.handleOnboardingMessage(user1, 'token_user1'),
        onboarding.handleOnboardingMessage(user2, 'token_user2'),
      ]);

      const updateCalls = db.updateUser.mock.calls;

      const user1Token = updateCalls.find(([id, fields]) => id === 1 && fields.canvas_token);
      const user2Token = updateCalls.find(([id, fields]) => id === 2 && fields.canvas_token);

      expect(user1Token).toBeDefined();
      expect(user1Token[1].canvas_token).toBe('token_user1');
      expect(user2Token).toBeDefined();
      expect(user2Token[1].canvas_token).toBe('token_user2');
    });

    it('DB state stays isolated — each user only updates their own rows', async () => {
      const user1 = makeUser(1, { id: 10, phone_number: '+1' });
      const user2 = makeUser(1, { id: 20, phone_number: '+2' });

      claude.classify
        .mockResolvedValueOnce(JSON.stringify({ name: 'Alice' }))
        .mockResolvedValueOnce(JSON.stringify({ name: 'Bob' }));

      await Promise.all([
        onboarding.handleOnboardingMessage(user1, 'alice'),
        onboarding.handleOnboardingMessage(user2, 'bob'),
      ]);

      const updateCalls = db.updateUser.mock.calls;
      const user1Calls = updateCalls.filter(([id]) => id === 10);
      const user2Calls = updateCalls.filter(([id]) => id === 20);

      // Neither user touched the other's rows
      expect(user1Calls.every(([id]) => id === 10)).toBe(true);
      expect(user2Calls.every(([id]) => id === 20)).toBe(true);

      // Each user got their own name saved
      expect(user1Calls.some(([, fields]) => fields.name === 'Alice')).toBe(true);
      expect(user2Calls.some(([, fields]) => fields.name === 'Bob')).toBe(true);
    });

    it('step 3 failure for one user does not affect the other', async () => {
      const user1 = makeUser(3, { id: 1, phone_number: '+11111111111' });
      const user2 = makeUser(3, { id: 2, phone_number: '+12222222222' });

      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: false }) // user1 fails
        .mockResolvedValueOnce({ ok: true }); // user2 succeeds

      await Promise.all([
        onboarding.handleOnboardingMessage(user1, 'bad_token'),
        onboarding.handleOnboardingMessage(user2, 'good_token'),
      ]);

      const updateCalls = db.updateUser.mock.calls;

      // user1 should NOT advance to step 4
      expect(updateCalls.some(([id, f]) => id === 1 && f.onboarding_step === 4)).toBe(false);
      // user2 SHOULD advance to step 4
      expect(updateCalls.some(([id, f]) => id === 2 && f.onboarding_step === 4)).toBe(true);
    });
  });

  // ─── extractCanvasUrl helper ─────────────────────────────────────────────────

  describe('extractCanvasUrl', () => {
    it('handles plain domain', () => {
      expect(onboarding.extractCanvasUrl('canvas.vt.edu')).toBe('https://canvas.vt.edu');
    });

    it('strips https:// prefix', () => {
      expect(onboarding.extractCanvasUrl('https://canvas.vt.edu')).toBe('https://canvas.vt.edu');
    });

    it('strips paths', () => {
      expect(onboarding.extractCanvasUrl('canvas.vt.edu/courses/123')).toBe('https://canvas.vt.edu');
    });

    it('returns null for string without dot', () => {
      expect(onboarding.extractCanvasUrl('canvasvtedu')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(onboarding.extractCanvasUrl('')).toBeNull();
    });
  });

  // ─── matchDorm helper ────────────────────────────────────────────────────────

  describe('matchDorm', () => {
    it('matches Slusher Tower', () => {
      const coords = onboarding.matchDorm('Slusher Tower');
      expect(coords).not.toBeNull();
      expect(coords.lat).toBeCloseTo(37.2222, 3);
    });

    it('is case-insensitive', () => {
      expect(onboarding.matchDorm('HARPER HALL')).not.toBeNull();
    });

    it('returns null for unrecognized location', () => {
      expect(onboarding.matchDorm('My friend\'s couch')).toBeNull();
    });

    it('matches off-campus / apartment', () => {
      const coords = onboarding.matchDorm('apartment downtown');
      expect(coords).not.toBeNull();
      expect(coords.lat).toBeCloseTo(37.2284, 3);
    });
  });
});
