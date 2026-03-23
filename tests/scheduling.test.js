'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');

jest.mock('../src/db');
jest.mock('../src/sms');
jest.mock('../src/utils/claude');
jest.mock('../src/memory/store');
jest.mock('../src/memory/extract');
jest.mock('../src/learning/patternExtractor');
jest.mock('../src/learning/styleAnalyzer');
jest.mock('../src/integrations/canvas');
jest.mock('../src/integrations/gmail');
jest.mock('../src/integrations/outlook');
jest.mock('../src/integrations/spotify');
jest.mock('../src/integrations/weather');
jest.mock('../src/integrations/schedule');
jest.mock('../src/integrations/bt_static');
jest.mock('../src/integrations/bt_bus');
jest.mock('../src/briefTime');
jest.mock('../src/proactive');

describe('scheduleUserJobs', () => {
  let scheduler, db, briefTime, mockCronJobs;

  beforeEach(() => {
    jest.resetModules();

    // Mock node-cron to capture scheduled jobs
    mockCronJobs = [];
    jest.doMock('node-cron', () => ({
      schedule: jest.fn((expr, fn, opts) => {
        const job = { expression: expr, fn, opts, stop: jest.fn() };
        mockCronJobs.push(job);
        return job;
      }),
    }));

    jest.mock('../src/db');
    jest.mock('../src/sms');
    jest.mock('../src/utils/claude');
    jest.mock('../src/memory/store');
    jest.mock('../src/memory/extract');
    jest.mock('../src/learning/patternExtractor');
    jest.mock('../src/learning/styleAnalyzer');
    jest.mock('../src/integrations/canvas');
    jest.mock('../src/integrations/gmail');
    jest.mock('../src/integrations/outlook');
    jest.mock('../src/integrations/spotify');
    jest.mock('../src/integrations/weather');
    jest.mock('../src/integrations/schedule');
    jest.mock('../src/integrations/bt_static');
    jest.mock('../src/integrations/bt_bus');
    jest.mock('../src/briefTime');
    jest.mock('../src/proactive');

    db = require('../src/db');
    briefTime = require('../src/briefTime');

    db.getAllActiveUsers.mockResolvedValue([]);
    db.wasEarlyBriefSent.mockResolvedValue(false);
    db.markEarlyBriefSent.mockResolvedValue(undefined);
    db.getLastUserMessageTime.mockResolvedValue(null);
    briefTime.getEffectiveBriefHour.mockResolvedValue(9);

    const proactive = require('../src/proactive');
    proactive.processPendingTriggers.mockResolvedValue(undefined);
    proactive.checkUpcomingEvents.mockResolvedValue(undefined);
    proactive.nightlyPlan.mockResolvedValue(undefined);
    proactive.canvasAlert.mockResolvedValue(undefined);
    proactive.healthNudge.mockResolvedValue(undefined);
    proactive.nightlyDigest.mockResolvedValue(undefined);

    const gmailMod = require('../src/integrations/gmail');
    gmailMod.renewGmailWatches.mockResolvedValue(undefined);
    gmailMod.getAllEmailContext.mockResolvedValue({ school: [], personal: [] });
    gmailMod.getGoogleCalendarEvents.mockResolvedValue([]);

    const outlookMod = require('../src/integrations/outlook');
    outlookMod.getTodaysEvents.mockResolvedValue([]);
    outlookMod.renewWebhookSubscriptions.mockResolvedValue(undefined);
    outlookMod.isEmailImportant.mockReturnValue({ important: false });

    const canvas = require('../src/integrations/canvas');
    canvas.getWeeklySnapshot.mockResolvedValue({});
    canvas.detectGradeChanges.mockResolvedValue([]);

    const schedule = require('../src/integrations/schedule');
    schedule.isInClass.mockResolvedValue(false);
    schedule.getClassSchedule.mockResolvedValue([]);

    const styleAnalyzer = require('../src/learning/styleAnalyzer');
    styleAnalyzer.refreshStyleCache.mockResolvedValue(null);

    const store = require('../src/memory/store');
    store.searchMemories.mockResolvedValue([]);
    store.deleteOldMemories.mockResolvedValue(undefined);

    const extract = require('../src/memory/extract');
    extract.nightlyExtraction.mockResolvedValue(undefined);

    const patternExtractor = require('../src/learning/patternExtractor');
    patternExtractor.extractInteractionPatterns.mockResolvedValue(undefined);

    scheduler = require('../src/scheduler');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates jobs for user and stores in userCrons', () => {
    const user = { id: 1, timezone: 'America/New_York', preferred_brief_hour: 9, preferred_brief_minute: 0 };
    scheduler.scheduleUserJobs(user);
    expect(scheduler.userCrons.has(1)).toBe(true);
    expect(scheduler.userCrons.get(1).length).toBeGreaterThan(0);
  });

  it('uses preferred_brief_hour for morning brief cron', () => {
    const user = { id: 1, timezone: 'America/New_York', preferred_brief_hour: 8, preferred_brief_minute: 0 };
    scheduler.scheduleUserJobs(user);
    const jobs = scheduler.userCrons.get(1);
    const briefJob = jobs.find(j => j.expression.includes('8'));
    expect(briefJob).toBeTruthy();
  });

  it('falls back to 9am when preferred_brief_hour is not set', () => {
    const user = { id: 1, timezone: 'America/New_York' };
    scheduler.scheduleUserJobs(user);
    const jobs = scheduler.userCrons.get(1);
    const nineAmJob = jobs.find(j => j.expression === '0 9 * * *');
    expect(nineAmJob).toBeTruthy();
  });

  it('creates early-class cron at 6:15am in user timezone', () => {
    const user = { id: 1, timezone: 'America/Chicago', preferred_brief_hour: 9 };
    scheduler.scheduleUserJobs(user);
    const jobs = scheduler.userCrons.get(1);
    const earlyJob = jobs.find(j => j.expression === '15 6 * * *');
    expect(earlyJob).toBeTruthy();
    expect(earlyJob.opts.timezone).toBe('America/Chicago');
  });

  it('uses America/New_York when no timezone set', () => {
    const user = { id: 1, preferred_brief_hour: 9 };
    scheduler.scheduleUserJobs(user);
    const jobs = scheduler.userCrons.get(1);
    for (const job of jobs) {
      expect(job.opts.timezone).toBe('America/New_York');
    }
  });

  it('stops old jobs before rescheduling', () => {
    const user = { id: 1, timezone: 'America/New_York', preferred_brief_hour: 9 };
    scheduler.scheduleUserJobs(user);
    const oldJobs = [...scheduler.userCrons.get(1)];

    // Re-schedule — old jobs should be stopped
    scheduler.scheduleUserJobs(user);
    for (const job of oldJobs) {
      expect(job.stop).toHaveBeenCalled();
    }
  });

  it('replaces old jobs with new ones in userCrons', () => {
    const user = { id: 1, timezone: 'America/New_York', preferred_brief_hour: 9 };
    scheduler.scheduleUserJobs(user);
    const firstJobs = scheduler.userCrons.get(1);

    scheduler.scheduleUserJobs(user);
    const secondJobs = scheduler.userCrons.get(1);

    expect(secondJobs).not.toBe(firstJobs);
  });

  it('creates nightly digest job at 9pm', () => {
    const user = { id: 1, timezone: 'America/New_York', preferred_brief_hour: 9 };
    scheduler.scheduleUserJobs(user);
    const jobs = scheduler.userCrons.get(1);
    const digestJob = jobs.find(j => j.expression === '0 21 * * *');
    expect(digestJob).toBeTruthy();
  });

  it('creates nightly extraction job at 2:30am', () => {
    const user = { id: 1, timezone: 'America/New_York', preferred_brief_hour: 9 };
    scheduler.scheduleUserJobs(user);
    const jobs = scheduler.userCrons.get(1);
    const extractJob = jobs.find(j => j.expression === '30 2 * * *');
    expect(extractJob).toBeTruthy();
  });
});

describe('wasEarlyBriefSent / markEarlyBriefSent', () => {
  let db;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../src/db');
    db = require('../src/db');
    db.wasEarlyBriefSent.mockResolvedValue(false);
    db.markEarlyBriefSent.mockResolvedValue(undefined);
  });

  it('returns false on first call today', async () => {
    db.wasEarlyBriefSent.mockResolvedValue(false);
    const result = await db.wasEarlyBriefSent(1, '2026-03-23');
    expect(result).toBe(false);
  });

  it('returns true after markEarlyBriefSent is called', async () => {
    await db.markEarlyBriefSent(1, '2026-03-23');
    db.wasEarlyBriefSent.mockResolvedValue(true);
    const result = await db.wasEarlyBriefSent(1, '2026-03-23');
    expect(result).toBe(true);
  });

  it('markEarlyBriefSent is called with userId and date', async () => {
    await db.markEarlyBriefSent(1, '2026-03-23');
    expect(db.markEarlyBriefSent).toHaveBeenCalledWith(1, '2026-03-23');
  });
});
