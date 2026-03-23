'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');

jest.mock('../src/db');
jest.mock('../src/sms');
jest.mock('../src/utils/claude');
jest.mock('../src/memory/store');
jest.mock('../src/learning/styleAnalyzer');
jest.mock('../src/learning/feedbackCapture');
jest.mock('../src/deletion');

describe('brain', () => {
  let brain;
  let db;
  let sms;
  let claude;

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
    sms = require('../src/sms');
    claude = require('../src/utils/claude');

    const store = require('../src/memory/store');
    store.searchMemories.mockResolvedValue([]);

    const styleAnalyzer = require('../src/learning/styleAnalyzer');
    styleAnalyzer.getStyleContext.mockResolvedValue('');

    const feedbackCapture = require('../src/learning/feedbackCapture');
    feedbackCapture.captureConversationFeedback.mockResolvedValue(undefined);
    feedbackCapture.captureProactiveFeedback.mockResolvedValue(undefined);

    const deletion = require('../src/deletion');
    deletion.isDeletionRequest.mockReturnValue(false);
    deletion.requestDeletion.mockResolvedValue(undefined);

    // Default DB mocks
    db.getUserById.mockResolvedValue({
      id: 1,
      phone_number: '+15551234567',
      name: 'Alice',
    });
    db.getRecentMessages.mockResolvedValue([]);
    db.saveMessage.mockResolvedValue({ id: 99 });
    db.getMessageCount.mockResolvedValue(5);
    db.deleteMessages.mockResolvedValue(undefined);
    db.query.mockResolvedValue({ rows: [] });
    db.getMostRecentProactiveSent.mockResolvedValue(null);
    db.updateMorningBriefEngagement.mockResolvedValue(undefined);
    db.getLastUserMessageTime.mockResolvedValue(null);

    // Default Claude mock
    claude.generateUserMessage.mockResolvedValue('hey what is up');
    claude.classify.mockResolvedValue('a brief summary');

    // Default SMS mock
    sms.sendTypingIndicator.mockResolvedValue(undefined);

    brain = require('../src/brain');
  });

  it('getResponse returns a string', async () => {
    const result = await brain.getResponse(1, 'hello');
    expect(typeof result).toBe('string');
  });

  it('getResponse calls sendTypingIndicator first (before generateUserMessage)', async () => {
    const callOrder = [];
    sms.sendTypingIndicator.mockImplementation(() => {
      callOrder.push('typing');
      return Promise.resolve();
    });
    claude.generateUserMessage.mockImplementation(() => {
      callOrder.push('generate');
      return Promise.resolve('response text');
    });

    await brain.getResponse(1, 'hello');
    expect(callOrder[0]).toBe('typing');
  });

  it('getResponse saves both user and assistant messages to DB', async () => {
    await brain.getResponse(1, 'test message');
    expect(db.saveMessage).toHaveBeenCalledWith(1, 'user', 'test message');
    expect(db.saveMessage).toHaveBeenCalledWith(1, 'assistant', expect.any(String));
  });

  it('getResponse detects [ACTION: ...] tag and calls proposeAction', async () => {
    claude.generateUserMessage.mockResolvedValue(
      'sure thing [ACTION: reminder | {"time":"8am"} | set your alarm] see you tomorrow'
    );
    const result = await brain.getResponse(1, 'remind me');
    // Action tag should be extracted — result should not contain the raw tag
    expect(result).not.toContain('[ACTION:');
  });

  it('getResponse strips action tag from returned text', async () => {
    claude.generateUserMessage.mockResolvedValue(
      'ok got it [ACTION: note | {"text":"hello"} | saving note] done'
    );
    const result = await brain.getResponse(1, 'save note');
    expect(result).not.toMatch(/\[ACTION:/);
    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('compactHistory triggers when message count > 20', async () => {
    db.getMessageCount.mockResolvedValue(25);
    db.getRecentMessages.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => ({
        id: i + 1,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message ${i}`,
      }))
    );

    await brain.getResponse(1, 'hello');
    expect(claude.classify).toHaveBeenCalled();
    expect(db.deleteMessages).toHaveBeenCalled();
  });

  it('compactHistory creates a summary row with is_summary=true', async () => {
    db.getMessageCount.mockResolvedValue(25);
    db.getRecentMessages.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => ({
        id: i + 1,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message ${i}`,
      }))
    );
    claude.classify.mockResolvedValue('these users talked about classes');

    await brain.getResponse(1, 'hello');

    // Find the saveMessage call with is_summary=true
    const summaryCalls = db.saveMessage.mock.calls.filter(call => call[3] === true);
    expect(summaryCalls.length).toBeGreaterThan(0);
    expect(summaryCalls[0][1]).toBe('system');
  });
});
