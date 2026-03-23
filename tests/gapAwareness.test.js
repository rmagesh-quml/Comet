'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');

jest.mock('../src/db');
jest.mock('../src/sms');
jest.mock('../src/utils/claude');
jest.mock('../src/memory/store');
jest.mock('../src/learning/styleAnalyzer');
jest.mock('../src/learning/feedbackCapture');
jest.mock('../src/deletion');

describe('getGapContext', () => {
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
    claude.generateUserMessage.mockResolvedValue('hey!');
    claude.classify.mockResolvedValue('a summary');
    store.searchMemories.mockResolvedValue([]);
    styleAnalyzer.getStyleContext.mockResolvedValue('');
    feedbackCapture.captureConversationFeedback.mockResolvedValue(undefined);
    feedbackCapture.captureProactiveFeedback.mockResolvedValue(undefined);
    deletion.isDeletionRequest.mockReturnValue(false);
    deletion.requestDeletion.mockResolvedValue(undefined);

    brain = require('../src/brain');
  });

  it('returns null when no prior messages', async () => {
    db.getLastUserMessageTime.mockResolvedValue(null);
    const result = await brain.getGapContext(1);
    expect(result).toBeNull();
  });

  it('returns null when last message was recent (< 12h ago)', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600000);
    db.getLastUserMessageTime.mockResolvedValue(twoHoursAgo);
    const result = await brain.getGapContext(1);
    expect(result).toBeNull();
  });

  it('returns yesterday string for 15h gap', async () => {
    const fifteenHoursAgo = new Date(Date.now() - 15 * 3600000);
    db.getLastUserMessageTime.mockResolvedValue(fifteenHoursAgo);
    const result = await brain.getGapContext(1);
    expect(result).toContain('yesterday');
  });

  it('returns days string for 2 day gap', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600000);
    db.getLastUserMessageTime.mockResolvedValue(twoDaysAgo);
    const result = await brain.getGapContext(1);
    expect(result).toContain('2 days');
  });

  it('returns notable absence string for 4 day gap', async () => {
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 3600000);
    db.getLastUserMessageTime.mockResolvedValue(fourDaysAgo);
    const result = await brain.getGapContext(1);
    expect(result).toContain('notable absence');
  });

  it('returns null at exactly 12h boundary (11h59m ago)', async () => {
    const justUnder12h = new Date(Date.now() - (12 * 3600000 - 60000));
    db.getLastUserMessageTime.mockResolvedValue(justUnder12h);
    const result = await brain.getGapContext(1);
    expect(result).toBeNull();
  });

  it('returns yesterday string at exactly 12h boundary (12h01m ago)', async () => {
    const justOver12h = new Date(Date.now() - (12 * 3600000 + 60000));
    db.getLastUserMessageTime.mockResolvedValue(justOver12h);
    const result = await brain.getGapContext(1);
    expect(result).toContain('yesterday');
  });

  it('returns null on db error', async () => {
    db.getLastUserMessageTime.mockRejectedValue(new Error('db down'));
    const result = await brain.getGapContext(1);
    expect(result).toBeNull();
  });
});
