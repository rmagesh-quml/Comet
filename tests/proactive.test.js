'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');

jest.mock('../src/db');
jest.mock('../src/sms');
jest.mock('../src/utils/claude');
jest.mock('../src/integrations/schedule');
jest.mock('../src/integrations/canvas');
jest.mock('../src/integrations/outlook');
jest.mock('../src/integrations/gmail');
jest.mock('../src/integrations/spotify');
jest.mock('../src/integrations/weather');
jest.mock('../src/utils/academicCalendar');

describe('proactive', () => {
  let proactive, db, sms, claude, schedule, canvas, outlook, spotify, weather;

  beforeEach(() => {
    jest.resetModules();

    jest.mock('../src/db');
    jest.mock('../src/sms');
    jest.mock('../src/utils/claude');
    jest.mock('../src/integrations/schedule');
    jest.mock('../src/integrations/canvas');
    jest.mock('../src/integrations/outlook');
    jest.mock('../src/integrations/gmail');
    jest.mock('../src/integrations/spotify');
    jest.mock('../src/integrations/weather');
    jest.mock('../src/utils/academicCalendar');

    db       = require('../src/db');
    sms      = require('../src/sms');
    claude   = require('../src/utils/claude');
    schedule = require('../src/integrations/schedule');
    canvas   = require('../src/integrations/canvas');
    outlook  = require('../src/integrations/outlook');
    spotify  = require('../src/integrations/spotify');
    weather  = require('../src/integrations/weather');

    // Default mocks — all pass the confidence gate
    db.hasSentProactiveTriggerToday.mockResolvedValue(false);
    db.getProactiveCountToday.mockResolvedValue(0);
    db.getPreference.mockResolvedValue(null);
    db.query.mockResolvedValue({ rows: [] });
    db.logSentMessage.mockResolvedValue(undefined);
    db.getUserById.mockResolvedValue({ id: 1, phone_number: '+15405550001', name: 'Alex', health_enabled: true });
    db.getAllActiveUsers.mockResolvedValue([]);
    db.getPendingScheduledMessages.mockResolvedValue([]);
    db.expireOldScheduledMessages.mockResolvedValue(undefined);
    db.markMessageSent.mockResolvedValue(undefined);
    db.markMessageSkipped.mockResolvedValue(undefined);
    db.scheduleMessage.mockResolvedValue({ id: 99 });
    db.getLastUserMessageTime.mockResolvedValue(null);
    db.getLatestHealthReading.mockResolvedValue(null);
    db.getRecentHealthReadings.mockResolvedValue([]);

    const gmail = require('../src/integrations/gmail');
    gmail.getGoogleCalendarEvents.mockResolvedValue([]);

    canvas.getUpcomingAssignments.mockResolvedValue([]);

    const academicCalendar = require('../src/utils/academicCalendar');
    academicCalendar.isOnBreak.mockReturnValue(false);

    schedule.isInClass.mockResolvedValue(false);
    schedule.getFreeBlocksToday.mockResolvedValue([]);
    schedule.getClassSchedule.mockResolvedValue([]);

    canvas.getWeeklySnapshot.mockResolvedValue({ upcoming: [], missing: [], grades: [], announcements: [] });
    canvas.detectGradeChanges.mockResolvedValue([]);

    outlook.getTodaysEvents.mockResolvedValue([]);
    outlook.getUpcomingEvents.mockResolvedValue([]);

    spotify.getMoodContext.mockResolvedValue(null);
    weather.getTodaysForecast.mockResolvedValue(null);

    sms.sendMessage.mockResolvedValue({ success: true });
    sms.sendMultiple.mockResolvedValue([]);
    sms.sendTypingIndicator.mockResolvedValue(undefined);
    sms.sendReaction.mockResolvedValue(undefined);

    claude.generateUserMessage.mockResolvedValue('test message');
    claude.classify.mockResolvedValue('[]');

    proactive = require('../src/proactive');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ─── shouldSendProactive ───────────────────────────────────────────────────

  describe('shouldSendProactive', () => {
    it('blocks between midnight and 7am', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T03:30:00'));

      const result = await proactive.shouldSendProactive(1, 'event_reminder');

      expect(result.send).toBe(false);
      expect(result.reason).toBe('quiet_hours');
      expect(db.hasSentProactiveTriggerToday).not.toHaveBeenCalled();
    });

    it('blocks at exactly midnight (hour 0)', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T00:00:00'));

      const result = await proactive.shouldSendProactive(1, 'event_reminder');
      expect(result.send).toBe(false);
      expect(result.reason).toBe('quiet_hours');
    });

    it('allows at 8am (boundary)', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T08:00:00'));

      const result = await proactive.shouldSendProactive(1, 'event_reminder');
      expect(result.send).toBe(true);
    });

    it('blocks when user is in class', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T10:00:00'));
      schedule.isInClass.mockResolvedValue(true);

      const result = await proactive.shouldSendProactive(1, 'event_reminder');

      expect(result.send).toBe(false);
      expect(result.reason).toBe('in_class');
      expect(db.hasSentProactiveTriggerToday).not.toHaveBeenCalled();
    });

    it('blocks when already sent type today', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T10:00:00'));
      db.hasSentProactiveTriggerToday.mockResolvedValue(true);

      const result = await proactive.shouldSendProactive(1, 'canvas_alert');

      expect(result.send).toBe(false);
      expect(result.reason).toBe('already_sent_today');
      expect(db.getProactiveCountToday).not.toHaveBeenCalled();
    });

    it('blocks when total proactive count >= 8 today', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T10:00:00'));
      db.getProactiveCountToday.mockResolvedValue(8);

      const result = await proactive.shouldSendProactive(1, 'event_reminder');

      expect(result.send).toBe(false);
      expect(result.reason).toBe('daily_limit');
    });

    it('skips daily limit when skipDailyLimit is true', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T10:00:00'));
      db.getProactiveCountToday.mockResolvedValue(10);

      const result = await proactive.shouldSendProactive(1, 'email_alert', 'msg123', { skipDailyLimit: true });

      expect(result.send).toBe(true);
      expect(db.getProactiveCountToday).not.toHaveBeenCalled();
    });

    it('sends when preference data is insufficient (< 5 total)', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T10:00:00'));
      db.getPreference.mockResolvedValue({ total_count: 3, positive_count: 0 });

      const result = await proactive.shouldSendProactive(1, 'event_reminder');

      expect(result.send).toBe(true);
    });

    it('sends when no preference data at all', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T10:00:00'));
      db.getPreference.mockResolvedValue(null);

      const result = await proactive.shouldSendProactive(1, 'event_reminder');

      expect(result.send).toBe(true);
    });

    it('blocks when positive rate < 40%', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T10:00:00'));
      // 3/10 = 30% < 40%
      db.getPreference.mockResolvedValue({ total_count: 10, positive_count: 3 });

      const result = await proactive.shouldSendProactive(1, 'canvas_alert');

      expect(result.send).toBe(false);
      expect(result.reason).toBe('negative_preference');
      expect(db.logSentMessage).toHaveBeenCalledWith(
        1, expect.stringContaining('proactive:canvas_alert:'), '', 'skipped'
      );
    });

    it('sends when positive rate is exactly 40%', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T10:00:00'));
      // 4/10 = 40% — boundary, should NOT be blocked (< 0.4 is the condition)
      db.getPreference.mockResolvedValue({ total_count: 10, positive_count: 4 });

      const result = await proactive.shouldSendProactive(1, 'canvas_alert');

      expect(result.send).toBe(true);
    });

    it('sends when positive rate > 40%', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T10:00:00'));
      // 6/10 = 60%
      db.getPreference.mockResolvedValue({ total_count: 10, positive_count: 6 });

      const result = await proactive.shouldSendProactive(1, 'canvas_alert');

      expect(result.send).toBe(true);
    });

    it('logs sent decision to sent_messages when returning true', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T10:00:00'));

      await proactive.shouldSendProactive(1, 'event_reminder', 'event-abc');

      expect(db.logSentMessage).toHaveBeenCalledWith(
        1, expect.stringMatching(/^proactive:event_reminder:/), '', 'sent'
      );
    });

    it('does not log for hard block (quiet hours)', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T02:00:00'));

      await proactive.shouldSendProactive(1, 'event_reminder');

      expect(db.logSentMessage).not.toHaveBeenCalled();
    });
  });

  // ─── eventReminder ─────────────────────────────────────────────────────────

  describe('eventReminder', () => {
    const userId = 1;
    const event = {
      id: 'evt-101',
      title: 'Algorithms',
      start: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      location: 'McBryde 100',
    };

    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T10:00:00'));
    });

    it('uses event id as context key (hash appears in logSentMessage type)', async () => {
      await proactive.eventReminder(userId, event);

      // The type stored is proactive:event_reminder:<hash-of-event.id>
      // Verify hasSentProactiveTriggerToday was called with the right trigger type
      expect(db.hasSentProactiveTriggerToday).toHaveBeenCalledWith(userId, 'event_reminder');
      // And logSentMessage type starts with proactive:event_reminder:
      expect(db.logSentMessage).toHaveBeenCalledWith(
        userId,
        expect.stringMatching(/^proactive:event_reminder:/),
        '',
        'sent'
      );
    });

    it('falls back to event title when no id (still triggers as event_reminder)', async () => {
      const noIdEvent = { title: 'Algorithms', start: event.start };

      await proactive.eventReminder(userId, noIdEvent);

      expect(db.hasSentProactiveTriggerToday).toHaveBeenCalledWith(userId, 'event_reminder');
      expect(sms.sendMessage).toHaveBeenCalled();
    });

    it('calls sendTypingIndicator before sendMessage', async () => {
      const callOrder = [];
      sms.sendTypingIndicator.mockImplementation(() => {
        callOrder.push('typing');
        return Promise.resolve();
      });
      sms.sendMessage.mockImplementation(() => {
        callOrder.push('send');
        return Promise.resolve({ success: true });
      });

      await proactive.eventReminder(userId, event);

      expect(callOrder).toEqual(['typing', 'send']);
    });

    it('sends message when gate allows', async () => {
      await proactive.eventReminder(userId, event);

      expect(sms.sendMessage).toHaveBeenCalledWith('+15405550001', 'test message', userId);
    });

    it('does not send when gate blocks (user in class)', async () => {
      schedule.isInClass.mockResolvedValue(true);

      await proactive.eventReminder(userId, event);

      expect(sms.sendMessage).not.toHaveBeenCalled();
      expect(sms.sendTypingIndicator).not.toHaveBeenCalled();
    });

    it('does not send when gate blocks (quiet hours)', async () => {
      jest.setSystemTime(new Date('2024-01-15T05:00:00'));

      await proactive.eventReminder(userId, event);

      expect(sms.sendMessage).not.toHaveBeenCalled();
    });

    it('calls generateUserMessage with event details', async () => {
      await proactive.eventReminder(userId, event);

      expect(claude.generateUserMessage).toHaveBeenCalledWith(
        expect.stringContaining('Algorithms'),
        expect.any(Array),
        400, 'proactive'
      );
    });
  });

  // ─── canvasAlert ───────────────────────────────────────────────────────────

  describe('canvasAlert', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T10:00:00'));
    });

    it('does not send when no conditions met', async () => {
      canvas.getWeeklySnapshot.mockResolvedValue({
        upcoming: [{ title: 'HW1', courseName: 'CS3114', dueDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() }],
        missing: [],
        grades: [],
      });

      await proactive.canvasAlert(1);

      expect(sms.sendMessage).not.toHaveBeenCalled();
    });

    it('fires when 2+ assignments due within 24 hours', async () => {
      const soon = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
      canvas.getWeeklySnapshot.mockResolvedValue({
        upcoming: [
          { title: 'HW1', courseName: 'CS', dueDate: soon },
          { title: 'HW2', courseName: 'MATH', dueDate: soon },
        ],
        missing: [],
        grades: [],
      });

      await proactive.canvasAlert(1);

      expect(sms.sendMessage).toHaveBeenCalled();
    });

    it('fires when there are missing assignments', async () => {
      canvas.getWeeklySnapshot.mockResolvedValue({
        upcoming: [],
        missing: [{ title: 'Lab2', courseName: 'ECE' }],
        grades: [],
      });

      await proactive.canvasAlert(1);

      expect(sms.sendMessage).toHaveBeenCalled();
    });

    it('does not send when gate blocks', async () => {
      db.hasSentProactiveTriggerToday.mockResolvedValue(true);
      canvas.getWeeklySnapshot.mockResolvedValue({
        upcoming: [],
        missing: [{ title: 'Lab2', courseName: 'ECE' }],
        grades: [],
      });

      await proactive.canvasAlert(1);

      expect(sms.sendMessage).not.toHaveBeenCalled();
    });
  });

  // ─── importantEmailAlert ───────────────────────────────────────────────────

  describe('importantEmailAlert', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T10:00:00'));
    });

    const email = {
      messageId: 'msg-abc-123',
      from: 'professor@vt.edu',
      subject: 'Grade change',
      id: 'msg-abc-123',
    };

    it('sends alert when gate allows', async () => {
      await proactive.importantEmailAlert(1, email, 'Your grade was updated.');

      expect(sms.sendMessage).toHaveBeenCalledWith('+15405550001', 'test message', 1);
    });

    it('sends reaction to email messageId', async () => {
      await proactive.importantEmailAlert(1, email, 'body');

      expect(sms.sendReaction).toHaveBeenCalledWith('+15405550001', 'msg-abc-123', 'exclamation', 1);
    });

    it('does not send reaction when no messageId', async () => {
      await proactive.importantEmailAlert(1, { from: 'prof@vt.edu', subject: 'test' }, 'body');

      expect(sms.sendReaction).not.toHaveBeenCalled();
    });

    it('does not send during quiet hours even with skipDailyLimit', async () => {
      jest.setSystemTime(new Date('2024-01-15T03:00:00'));

      await proactive.importantEmailAlert(1, email, 'body');

      expect(sms.sendMessage).not.toHaveBeenCalled();
    });

    it('bypasses daily limit of 8', async () => {
      db.getProactiveCountToday.mockResolvedValue(10);

      await proactive.importantEmailAlert(1, email, 'body');

      expect(sms.sendMessage).toHaveBeenCalled();
      expect(db.getProactiveCountToday).not.toHaveBeenCalled();
    });
  });

  // ─── healthNudge ───────────────────────────────────────────────────────────

  describe('healthNudge', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T10:00:00'));
    });

    it('skips when health_enabled is false', async () => {
      db.getUserById.mockResolvedValue({ id: 1, phone_number: '+15405550001', health_enabled: false });

      await proactive.healthNudge(1);

      expect(sms.sendMessage).not.toHaveBeenCalled();
    });

    it('does not fire when readiness >= 55 even with 3+ events', async () => {
      db.getLatestHealthReading.mockResolvedValue({ readiness: 70 });
      outlook.getTodaysEvents.mockResolvedValue([{}, {}, {}]);

      await proactive.healthNudge(1);

      expect(sms.sendMessage).not.toHaveBeenCalled();
    });

    it('fires when readiness < 55 AND 3+ events today', async () => {
      db.getLatestHealthReading.mockResolvedValue({ readiness: 40 });
      outlook.getTodaysEvents.mockResolvedValue([{}, {}, {}]);

      await proactive.healthNudge(1);

      expect(sms.sendMessage).toHaveBeenCalled();
    });

    it('fires when 3 consecutive low readiness days', async () => {
      db.getLatestHealthReading.mockResolvedValue({ readiness: 60 }); // not low today
      db.getRecentHealthReadings.mockResolvedValue([
        { readiness: 40 }, { readiness: 45 }, { readiness: 50 },
      ]);

      await proactive.healthNudge(1);

      expect(sms.sendMessage).toHaveBeenCalled();
    });

    it('does not fire when only 2 consecutive low days', async () => {
      db.getRecentHealthReadings.mockResolvedValue([
        { readiness: 40 }, { readiness: 45 },
      ]);

      await proactive.healthNudge(1);

      expect(sms.sendMessage).not.toHaveBeenCalled();
    });
  });

  // ─── nightlyDigest ─────────────────────────────────────────────────────────

  describe('nightlyDigest', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T21:00:00'));
    });

    it('does not send when user texted within 4 hours', async () => {
      db.getLastUserMessageTime.mockResolvedValue(new Date(Date.now() - 2 * 60 * 60 * 1000));

      await proactive.nightlyDigest(1);

      expect(sms.sendMessage).not.toHaveBeenCalled();
    });

    it('sends when user has not texted in 4+ hours', async () => {
      db.getLastUserMessageTime.mockResolvedValue(new Date(Date.now() - 5 * 60 * 60 * 1000));

      await proactive.nightlyDigest(1);

      expect(sms.sendMessage).toHaveBeenCalled();
    });

    it('sends when user has never texted (null lastMsgTime)', async () => {
      db.getLastUserMessageTime.mockResolvedValue(null);

      await proactive.nightlyDigest(1);

      expect(sms.sendMessage).toHaveBeenCalled();
    });

    it('does not send when gate blocks', async () => {
      db.hasSentProactiveTriggerToday.mockResolvedValue(true);

      await proactive.nightlyDigest(1);

      expect(sms.sendMessage).not.toHaveBeenCalled();
    });

    it('uses sendMultiple when response has multiple paragraphs', async () => {
      db.getLastUserMessageTime.mockResolvedValue(null);
      claude.generateUserMessage.mockResolvedValue('First message.\n\nSecond message.\n\nThird message.');

      await proactive.nightlyDigest(1);

      expect(sms.sendMultiple).toHaveBeenCalledWith(
        '+15405550001',
        ['First message.', 'Second message.', 'Third message.'],
        1
      );
      expect(sms.sendMessage).not.toHaveBeenCalled();
    });
  });

  // ─── nightlyPlan ───────────────────────────────────────────────────────────

  describe('nightlyPlan', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T02:00:00'));
    });

    it('calls classify with context including tomorrow\'s data', async () => {
      outlook.getTodaysEvents.mockResolvedValue([
        { title: 'Algorithms', start: '2024-01-16T10:00:00' },
      ]);
      canvas.getWeeklySnapshot.mockResolvedValue({
        upcoming: [{ title: 'HW3', courseName: 'CS3114', dueDate: '2024-01-16T23:59:00' }],
        missing: [], grades: [],
      });

      await proactive.nightlyPlan(1);

      expect(claude.classify).toHaveBeenCalledWith(
        expect.stringContaining('Plan proactive messages'),
        500, 'classification'
      );
    });

    it('stores valid triggers in DB', async () => {
      const triggerTime = '2024-01-16T09:00:00.000Z';
      claude.classify.mockResolvedValue(JSON.stringify([
        { triggerTime, purpose: 'assignment reminder', triggerType: 'canvas_alert', contextSummary: 'HW3 due today' },
      ]));

      await proactive.nightlyPlan(1);

      expect(db.scheduleMessage).toHaveBeenCalledWith(
        1,
        expect.any(Date),
        'assignment reminder',
        expect.objectContaining({ contextSummary: 'HW3 due today' }),
        'canvas_alert'
      );
    });

    it('skips triggers with invalid triggerTime', async () => {
      claude.classify.mockResolvedValue(JSON.stringify([
        { triggerTime: 'not-a-date', purpose: 'test', triggerType: 'canvas_alert', contextSummary: '' },
      ]));

      await proactive.nightlyPlan(1);

      expect(db.scheduleMessage).not.toHaveBeenCalled();
    });

    it('skips triggers missing required fields', async () => {
      claude.classify.mockResolvedValue(JSON.stringify([
        { triggerTime: '2024-01-16T09:00:00.000Z', triggerType: 'canvas_alert' }, // missing purpose
      ]));

      await proactive.nightlyPlan(1);

      expect(db.scheduleMessage).not.toHaveBeenCalled();
    });

    it('handles empty array response gracefully', async () => {
      claude.classify.mockResolvedValue('[]');

      await proactive.nightlyPlan(1);

      expect(db.scheduleMessage).not.toHaveBeenCalled();
    });

    it('handles invalid JSON gracefully', async () => {
      claude.classify.mockResolvedValue('not json at all');

      await expect(proactive.nightlyPlan(1)).resolves.not.toThrow();
      expect(db.scheduleMessage).not.toHaveBeenCalled();
    });

    it('stores multiple triggers when classify returns multiple', async () => {
      claude.classify.mockResolvedValue(JSON.stringify([
        { triggerTime: '2024-01-16T08:00:00Z', purpose: 'morning reminder', triggerType: 'event_reminder', contextSummary: '' },
        { triggerTime: '2024-01-16T14:00:00Z', purpose: 'study nudge', triggerType: 'canvas_alert', contextSummary: '' },
      ]));

      await proactive.nightlyPlan(1);

      expect(db.scheduleMessage).toHaveBeenCalledTimes(2);
    });

    it('does not throw when user not found', async () => {
      db.getUserById.mockResolvedValue(null);

      await expect(proactive.nightlyPlan(99)).resolves.not.toThrow();
    });
  });

  // ─── processPendingTriggers ────────────────────────────────────────────────

  describe('processPendingTriggers', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T10:00:00'));
    });

    it('processes due messages and marks them sent', async () => {
      db.getPendingScheduledMessages.mockResolvedValue([{
        id: 1,
        user_id: 1,
        phone_number: '+15405550001',
        trigger_type: 'canvas_alert',
        purpose: 'assignment due soon',
        context: { contextKey: '' },
        status: 'pending',
      }]);

      await proactive.processPendingTriggers();

      expect(sms.sendMessage).toHaveBeenCalledWith('+15405550001', 'test message', 1);
      expect(db.markMessageSent).toHaveBeenCalledWith(1);
      expect(db.markMessageSkipped).not.toHaveBeenCalled();
    });

    it('skips and marks skipped when gate blocks', async () => {
      db.hasSentProactiveTriggerToday.mockResolvedValue(true);
      db.getPendingScheduledMessages.mockResolvedValue([{
        id: 2,
        user_id: 1,
        phone_number: '+15405550001',
        trigger_type: 'canvas_alert',
        purpose: 'test',
        context: {},
        status: 'pending',
      }]);

      await proactive.processPendingTriggers();

      expect(db.markMessageSkipped).toHaveBeenCalledWith(2);
      expect(sms.sendMessage).not.toHaveBeenCalled();
      expect(db.markMessageSent).not.toHaveBeenCalled();
    });

    it('skips morning_brief messages (handled by dedicated cron)', async () => {
      db.getPendingScheduledMessages.mockResolvedValue([{
        id: 3,
        user_id: 1,
        phone_number: '+15405550001',
        trigger_type: 'morning_brief',
        purpose: 'morning brief',
        context: {},
        status: 'pending',
      }]);

      await proactive.processPendingTriggers();

      expect(sms.sendMessage).not.toHaveBeenCalled();
      expect(db.markMessageSent).not.toHaveBeenCalled();
      expect(db.markMessageSkipped).not.toHaveBeenCalled();
    });

    it('handles no pending messages gracefully', async () => {
      db.getPendingScheduledMessages.mockResolvedValue([]);

      await expect(proactive.processPendingTriggers()).resolves.not.toThrow();
      expect(sms.sendMessage).not.toHaveBeenCalled();
    });

    it('processes multiple messages independently', async () => {
      db.getPendingScheduledMessages.mockResolvedValue([
        { id: 4, user_id: 1, phone_number: '+15405550001', trigger_type: 'event_reminder', purpose: 'event 1', context: {}, status: 'pending' },
        { id: 5, user_id: 1, phone_number: '+15405550001', trigger_type: 'canvas_alert', purpose: 'canvas update', context: {}, status: 'pending' },
      ]);
      // Second call to hasSentProactiveTriggerToday should also return false
      db.hasSentProactiveTriggerToday.mockResolvedValue(false);

      await proactive.processPendingTriggers();

      expect(db.markMessageSent).toHaveBeenCalledTimes(2);
    });

    it('calls expireOldScheduledMessages before processing', async () => {
      const callOrder = [];
      db.expireOldScheduledMessages.mockImplementation(() => { callOrder.push('expire'); return Promise.resolve(); });
      db.getPendingScheduledMessages.mockImplementation(() => { callOrder.push('get'); return Promise.resolve([]); });

      await proactive.processPendingTriggers();

      expect(callOrder[0]).toBe('expire');
      expect(callOrder[1]).toBe('get');
    });
  });

  // ─── checkUpcomingEvents ───────────────────────────────────────────────────

  describe('checkUpcomingEvents', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-15T09:00:00'));
    });

    it('sends reminder for event starting in 25–35 minutes', async () => {
      const eventStart = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      db.getAllActiveUsers.mockResolvedValue([
        { id: 1, phone_number: '+15405550001', name: 'Alex' },
      ]);
      outlook.getTodaysEvents.mockResolvedValue([
        { id: 'evt-1', title: 'Algorithms', start: eventStart },
      ]);

      // Clear dedup map
      proactive.sentEventReminders.clear();

      await proactive.checkUpcomingEvents();

      expect(sms.sendMessage).toHaveBeenCalled();
    });

    it('does not send reminder for event starting in 10 minutes (outside window)', async () => {
      const eventStart = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      db.getAllActiveUsers.mockResolvedValue([{ id: 1, phone_number: '+15405550001' }]);
      outlook.getTodaysEvents.mockResolvedValue([
        { id: 'evt-2', title: 'Algorithms', start: eventStart },
      ]);

      proactive.sentEventReminders.clear();

      await proactive.checkUpcomingEvents();

      expect(sms.sendMessage).not.toHaveBeenCalled();
    });

    it('deduplicates — does not send twice for same event', async () => {
      const eventStart = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      db.getAllActiveUsers.mockResolvedValue([{ id: 1, phone_number: '+15405550001', name: 'Alex' }]);
      outlook.getTodaysEvents.mockResolvedValue([
        { id: 'evt-dedup', title: 'Algorithms', start: eventStart },
      ]);

      proactive.sentEventReminders.clear();

      await proactive.checkUpcomingEvents();
      sms.sendMessage.mockClear();
      await proactive.checkUpcomingEvents();

      expect(sms.sendMessage).not.toHaveBeenCalled();
    });
  });

  // ─── hashContextKey ────────────────────────────────────────────────────────

  describe('hashContextKey', () => {
    it('returns "default" for empty string', () => {
      expect(proactive.hashContextKey('')).toBe('default');
    });

    it('returns "default" for null/undefined', () => {
      expect(proactive.hashContextKey(null)).toBe('default');
      expect(proactive.hashContextKey(undefined)).toBe('default');
    });

    it('returns consistent hash for same input', () => {
      expect(proactive.hashContextKey('event-123')).toBe(proactive.hashContextKey('event-123'));
    });

    it('returns different hashes for different inputs', () => {
      expect(proactive.hashContextKey('event-123')).not.toBe(proactive.hashContextKey('event-456'));
    });
  });
});
