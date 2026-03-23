'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');

jest.mock('../../src/memory/store');
jest.mock('../../src/utils/claude');
jest.mock('../../src/db');

describe('feedbackCapture', () => {
  let feedbackCapture, store, claude, db;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../../src/memory/store');
    jest.mock('../../src/utils/claude');
    jest.mock('../../src/db');

    store = require('../../src/memory/store');
    claude = require('../../src/utils/claude');
    db = require('../../src/db');

    store.storeMemory.mockResolvedValue(undefined);
    claude.classify.mockResolvedValue(
      JSON.stringify({ sentiment: 'positive', confidence: 0.9 })
    );
    db.updatePreference.mockResolvedValue(undefined);

    feedbackCapture = require('../../src/learning/feedbackCapture');
  });

  // ─── captureConversationFeedback ────────────────────────────────────────────

  describe('captureConversationFeedback', () => {
    it('does nothing when no previous agent message', async () => {
      await feedbackCapture.captureConversationFeedback(1, 'hey', null);
      expect(store.storeMemory).not.toHaveBeenCalled();
    });

    it('does nothing when previousAgentMessage is undefined', async () => {
      await feedbackCapture.captureConversationFeedback(1, 'hey', undefined);
      expect(store.storeMemory).not.toHaveBeenCalled();
    });

    // CHECK 1 — response length mismatch
    it('stores length mismatch preference when long message gets one-word reply', async () => {
      const longAgent = 'x'.repeat(201);
      await feedbackCapture.captureConversationFeedback(1, 'ok', longAgent);
      expect(store.storeMemory).toHaveBeenCalledWith(
        1,
        expect.stringContaining('prefers very short responses'),
        expect.objectContaining({ importance: 7, source: 'feedback_capture' })
      );
    });

    it('does not store length mismatch when agent message is short', async () => {
      await feedbackCapture.captureConversationFeedback(1, 'ok', 'short reply');
      const lengthCalls = store.storeMemory.mock.calls.filter(c =>
        c[1].includes('prefers very short responses')
      );
      expect(lengthCalls.length).toBe(0);
    });

    it('does not store length mismatch when user reply is long', async () => {
      const longAgent = 'x'.repeat(201);
      const longUser = 'this is a longer reply that has more than four words total';
      await feedbackCapture.captureConversationFeedback(1, longUser, longAgent);
      const lengthCalls = store.storeMemory.mock.calls.filter(c =>
        c[1].includes('prefers very short responses')
      );
      expect(lengthCalls.length).toBe(0);
    });

    // CHECK 2 — explicit correction
    it('detects "actually" as correction phrase', async () => {
      await feedbackCapture.captureConversationFeedback(1, 'actually that is wrong', 'some previous message');
      expect(store.storeMemory).toHaveBeenCalledWith(
        1,
        expect.stringContaining('agent made an error'),
        expect.objectContaining({ importance: 9, source: 'feedback_capture' })
      );
    });

    it('detects "wrong" correction phrase', async () => {
      await feedbackCapture.captureConversationFeedback(1, 'wrong', 'previous message');
      expect(store.storeMemory).toHaveBeenCalledWith(
        1,
        expect.stringContaining('agent made an error'),
        expect.objectContaining({ importance: 9 })
      );
    });

    it('detects "thats not right" correction', async () => {
      await feedbackCapture.captureConversationFeedback(1, "thats not right at all", 'previous');
      expect(store.storeMemory).toHaveBeenCalledWith(
        1,
        expect.stringContaining('agent made an error'),
        expect.anything()
      );
    });

    it('stores the user message snippet in correction memory', async () => {
      await feedbackCapture.captureConversationFeedback(1, 'actually no that is not correct', 'some reply');
      const call = store.storeMemory.mock.calls.find(c => c[1].includes('agent made an error'));
      expect(call[1]).toContain('actually no that is not correct');
    });

    // CHECK 3 — positive reaction
    it('detects "omg" as positive signal', async () => {
      await feedbackCapture.captureConversationFeedback(1, 'omg yes!', 'the previous agent message');
      expect(store.storeMemory).toHaveBeenCalledWith(
        1,
        expect.stringContaining('landed really well'),
        expect.objectContaining({ importance: 7, source: 'feedback_capture' })
      );
    });

    it('detects "love that" as positive signal', async () => {
      await feedbackCapture.captureConversationFeedback(1, 'love that response', 'agent said something cool');
      const call = store.storeMemory.mock.calls.find(c => c[1].includes('landed really well'));
      expect(call).toBeTruthy();
    });

    it('stores snippet of agent message in positive reaction memory', async () => {
      const agentMsg = 'hey heads up your assignment is due tonight!';
      await feedbackCapture.captureConversationFeedback(1, 'omg yes exactly', agentMsg);
      const call = store.storeMemory.mock.calls.find(c => c[1].includes('landed really well'));
      expect(call[1]).toContain('hey heads up');
    });

    // CHECK 4 — disengagement
    it('detects "ok" as disengagement to long message', async () => {
      const longAgent = 'x'.repeat(101);
      await feedbackCapture.captureConversationFeedback(1, 'ok', longAgent);
      expect(store.storeMemory).toHaveBeenCalledWith(
        1,
        expect.stringContaining('dismissive reply'),
        expect.objectContaining({ importance: 6, source: 'feedback_capture' })
      );
    });

    it('does not flag disengagement when agent message is short', async () => {
      await feedbackCapture.captureConversationFeedback(1, 'ok', 'short');
      const calls = store.storeMemory.mock.calls.filter(c => c[1].includes('dismissive reply'));
      expect(calls.length).toBe(0);
    });

    it('does not flag disengagement for non-disengagement word', async () => {
      const longAgent = 'x'.repeat(101);
      await feedbackCapture.captureConversationFeedback(1, 'thanks a lot!', longAgent);
      const calls = store.storeMemory.mock.calls.filter(c => c[1].includes('dismissive reply'));
      expect(calls.length).toBe(0);
    });

    // CHECK 5 — question ignored
    it('detects ignored agent question', async () => {
      await feedbackCapture.captureConversationFeedback(1, 'k', 'what are you up to today?');
      expect(store.storeMemory).toHaveBeenCalledWith(
        1,
        expect.stringContaining('ignored agent question'),
        expect.objectContaining({ importance: 6, source: 'feedback_capture' })
      );
    });

    it('does not flag ignored question when user gives a real answer', async () => {
      await feedbackCapture.captureConversationFeedback(
        1,
        'not much just studying for my exam tomorrow',
        'what are you up to today?'
      );
      const calls = store.storeMemory.mock.calls.filter(c => c[1].includes('ignored agent question'));
      expect(calls.length).toBe(0);
    });

    it('does not flag ignored question when agent had no question', async () => {
      await feedbackCapture.captureConversationFeedback(1, 'k', 'sounds good see you later');
      const calls = store.storeMemory.mock.calls.filter(c => c[1].includes('ignored agent question'));
      expect(calls.length).toBe(0);
    });

    // CHECK 6 — engagement spike
    it('detects engagement spike when user writes a lot after short agent message', async () => {
      const longUser = 'x'.repeat(201);
      await feedbackCapture.captureConversationFeedback(1, longUser, 'yo');
      expect(store.storeMemory).toHaveBeenCalledWith(
        1,
        expect.stringContaining('short messages get more engagement'),
        expect.objectContaining({ importance: 8, source: 'feedback_capture' })
      );
    });

    it('does not flag engagement spike when agent message was long', async () => {
      const longUser = 'x'.repeat(201);
      const longAgent = 'x'.repeat(100);
      await feedbackCapture.captureConversationFeedback(1, longUser, longAgent);
      const calls = store.storeMemory.mock.calls.filter(c => c[1].includes('short messages get more engagement'));
      expect(calls.length).toBe(0);
    });

    // Multiple checks fire independently
    it('fires multiple checks independently on same message', async () => {
      const longAgent = 'x'.repeat(201) + '?';
      // One-word reply → CHECK 1 (length mismatch)
      // Agent asked question, short reply → CHECK 5 (ignored question)
      await feedbackCapture.captureConversationFeedback(1, 'ok', longAgent);
      const calls = store.storeMemory.mock.calls;
      const topics = calls.map(c => c[1]);
      expect(topics.some(t => t.includes('prefers very short responses'))).toBe(true);
    });

    // Never throws
    it('never throws on any input combination', async () => {
      store.storeMemory.mockRejectedValue(new Error('qdrant down'));
      await expect(
        feedbackCapture.captureConversationFeedback(1, 'omg', 'x'.repeat(250))
      ).resolves.not.toThrow();
    });

    it('never throws when storeMemory fails for all checks', async () => {
      store.storeMemory.mockRejectedValue(new Error('all fail'));
      await expect(
        feedbackCapture.captureConversationFeedback(1, 'actually wrong ok', 'x'.repeat(201) + '?')
      ).resolves.not.toThrow();
    });
  });

  // ─── captureProactiveFeedback ───────────────────────────────────────────────

  describe('captureProactiveFeedback', () => {
    it('skips update when confidence < 0.6', async () => {
      claude.classify.mockResolvedValue(
        JSON.stringify({ sentiment: 'positive', confidence: 0.5 })
      );
      await feedbackCapture.captureProactiveFeedback(1, 'canvas_alert', 'abc', 'sure');
      expect(db.updatePreference).not.toHaveBeenCalled();
    });

    it('calls updatePreference with positive=true for positive sentiment', async () => {
      claude.classify.mockResolvedValue(
        JSON.stringify({ sentiment: 'positive', confidence: 0.8 })
      );
      await feedbackCapture.captureProactiveFeedback(1, 'canvas_alert', 'abc', 'thanks!');
      expect(db.updatePreference).toHaveBeenCalledWith(1, 'canvas_alert', 'abc', true);
    });

    it('calls updatePreference with positive=false for negative sentiment', async () => {
      claude.classify.mockResolvedValue(
        JSON.stringify({ sentiment: 'negative', confidence: 0.85 })
      );
      await feedbackCapture.captureProactiveFeedback(1, 'health_nudge', 'xyz', 'stop messaging me');
      expect(db.updatePreference).toHaveBeenCalledWith(1, 'health_nudge', 'xyz', false);
    });

    it('calls updatePreference with positive=false for neutral sentiment', async () => {
      claude.classify.mockResolvedValue(
        JSON.stringify({ sentiment: 'neutral', confidence: 0.7 })
      );
      await feedbackCapture.captureProactiveFeedback(1, 'event_reminder', 'def', 'ok');
      expect(db.updatePreference).toHaveBeenCalledWith(1, 'event_reminder', 'def', false);
    });

    it('handles invalid JSON from classify gracefully', async () => {
      claude.classify.mockResolvedValue('not json');
      await expect(
        feedbackCapture.captureProactiveFeedback(1, 'canvas_alert', 'abc', 'hey')
      ).resolves.not.toThrow();
      expect(db.updatePreference).not.toHaveBeenCalled();
    });

    it('skips when classify rejects', async () => {
      claude.classify.mockRejectedValue(new Error('api down'));
      await expect(
        feedbackCapture.captureProactiveFeedback(1, 'canvas_alert', 'abc', 'hey')
      ).resolves.not.toThrow();
      expect(db.updatePreference).not.toHaveBeenCalled();
    });
  });
});
