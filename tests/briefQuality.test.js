'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');

// ─── buildMorningBriefPrompt ──────────────────────────────────────────────────

describe('buildMorningBriefPrompt', () => {
  let buildMorningBriefPrompt;

  beforeEach(() => {
    jest.resetModules();
    // Mock all scheduler dependencies so the module loads in isolation
    jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));
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

    ({ buildMorningBriefPrompt } = require('../src/scheduler'));
  });

  function makeContext(overrides = {}) {
    return {
      user: { name: 'Alice', timezone: 'America/New_York' },
      canvas: {},
      emails: { school: [], personal: [] },
      googleCal: [],
      outlookCal: [],
      weather: null,
      health: null,
      memories: [],
      mood: null,
      schedule: [],
      dayOfWeek: 'Monday',
      briefStats: null,
      ...overrides,
    };
  }

  it('includes class names when classes are scheduled today', () => {
    const ctx = makeContext({
      dayOfWeek: 'Monday',
      schedule: [
        { name: 'CS 3114', days: ['M', 'W', 'F'], startTime: '10:00' },
        { name: 'MATH 2114', days: ['T', 'Th'], startTime: '09:00' },
      ],
    });
    const prompt = buildMorningBriefPrompt(ctx);
    expect(prompt).toContain('CS 3114');
    expect(prompt).not.toContain('MATH 2114'); // not on Monday
  });

  it('includes assignment due soon within 48h', () => {
    const soonDue = new Date(Date.now() + 20 * 3600000).toISOString();
    const ctx = makeContext({
      canvas: {
        upcoming: [{ title: 'Homework 5', courseName: 'CS 3114', dueDate: soonDue }],
        missing: [],
      },
    });
    const prompt = buildMorningBriefPrompt(ctx);
    expect(prompt).toContain('Homework 5');
  });

  it('excludes assignment due more than 48h away', () => {
    const farDue = new Date(Date.now() + 72 * 3600000).toISOString();
    const ctx = makeContext({
      canvas: {
        upcoming: [{ title: 'Final Project', courseName: 'CS 3114', dueDate: farDue }],
        missing: [],
      },
    });
    const prompt = buildMorningBriefPrompt(ctx);
    expect(prompt).not.toContain('Final Project');
  });

  it('includes notable weather when isNotable is true', () => {
    const ctx = makeContext({
      weather: { isNotable: true, description: 'thunderstorms', temp: 58, rainProbability: 80 },
    });
    const prompt = buildMorningBriefPrompt(ctx);
    expect(prompt).toContain('thunderstorms');
    expect(prompt).toContain('80% rain');
  });

  it('omits weather section when isNotable is false', () => {
    const ctx = makeContext({
      weather: { isNotable: false, description: 'clear', temp: 72, rainProbability: 5 },
    });
    const prompt = buildMorningBriefPrompt(ctx);
    expect(prompt).not.toContain('Weather:');
  });

  it('adds low-engagement hint when rate < 0.3 and totalSent >= 5', () => {
    const ctx = makeContext({
      briefStats: { totalSent: 10, engagementRate: 0.2, avgReplyLength: 20 },
    });
    const prompt = buildMorningBriefPrompt(ctx);
    expect(prompt).toContain('very short');
  });

  it('adds high-engagement hint when rate > 0.7 and totalSent >= 5', () => {
    const ctx = makeContext({
      briefStats: { totalSent: 8, engagementRate: 0.85, avgReplyLength: 40 },
    });
    const prompt = buildMorningBriefPrompt(ctx);
    expect(prompt).toContain('engages a lot');
  });

  it('does not add engagement hints when totalSent < 5', () => {
    const ctx = makeContext({
      briefStats: { totalSent: 3, engagementRate: 0.1, avgReplyLength: 5 },
    });
    const prompt = buildMorningBriefPrompt(ctx);
    expect(prompt).not.toContain('very short');
    expect(prompt).not.toContain('engages a lot');
  });

  it('adds brief reply hint when avgReplyLength < 10', () => {
    const ctx = makeContext({
      briefStats: { totalSent: 6, engagementRate: 0.5, avgReplyLength: 7 },
    });
    const prompt = buildMorningBriefPrompt(ctx);
    expect(prompt).toContain('casual and short');
  });

  it('includes user name in opening line', () => {
    const ctx = makeContext({ user: { name: 'Jordan', timezone: 'America/Chicago' } });
    const prompt = buildMorningBriefPrompt(ctx);
    expect(prompt).toContain('Jordan');
  });
});

// ─── getResponse calls updateMorningBriefEngagement with message length ───────

describe('morning brief engagement — getResponse integration', () => {
  let brain, db;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../src/db');
    jest.mock('../src/sms');
    jest.mock('../src/utils/claude');
    jest.mock('../src/memory/store');
    jest.mock('../src/learning/styleAnalyzer');
    jest.mock('../src/learning/feedbackCapture');
    jest.mock('../src/deletion');

    db = require('../src/db');
    const sms = require('../src/sms');
    const claude = require('../src/utils/claude');
    const store = require('../src/memory/store');
    const styleAnalyzer = require('../src/learning/styleAnalyzer');
    const feedbackCapture = require('../src/learning/feedbackCapture');
    const deletion = require('../src/deletion');

    db.getUserById.mockResolvedValue({ id: 1, name: 'Alice', phone_number: '+15551234567' });
    db.getRecentMessages.mockResolvedValue([]);
    db.saveMessage.mockResolvedValue({ id: 99 });
    db.getMessageCount.mockResolvedValue(5);
    db.deleteMessages.mockResolvedValue(undefined);
    db.query.mockResolvedValue({ rows: [] });
    db.getMostRecentProactiveSent.mockResolvedValue(null);
    db.updateMorningBriefEngagement.mockResolvedValue(undefined);
    db.getLastUserMessageTime.mockResolvedValue(null);

    sms.sendTypingIndicator.mockResolvedValue(undefined);
    claude.generateUserMessage.mockResolvedValue('good morning!');
    claude.classify.mockResolvedValue('summary');
    store.searchMemories.mockResolvedValue([]);
    styleAnalyzer.getStyleContext.mockResolvedValue('');
    feedbackCapture.captureConversationFeedback.mockResolvedValue(undefined);
    feedbackCapture.captureProactiveFeedback.mockResolvedValue(undefined);
    deletion.isDeletionRequest.mockReturnValue(false);
    deletion.requestDeletion.mockResolvedValue(undefined);

    brain = require('../src/brain');
  });

  it('calls updateMorningBriefEngagement with userId and message length (not raw string)', async () => {
    const msg = 'hey good morning';
    await brain.getResponse(1, msg);
    await new Promise(resolve => setImmediate(resolve));
    expect(db.updateMorningBriefEngagement).toHaveBeenCalledWith(1, msg.length);
  });
});
