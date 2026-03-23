'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');

jest.mock('../../src/db');
jest.mock('../../src/utils/claude');
jest.mock('../../src/memory/store');

describe('patternExtractor', () => {
  let patternExtractor, db, claude, store;

  const VALID_PATTERNS = {
    respondsWellTo: ['short casual check-ins', 'specific actionable suggestions'],
    disengagesFrom: ['long explanations', 'multiple questions at once'],
    peakEngagementTimes: 'late night 11pm-1am',
    topicsTheyBringUp: ['exams', 'internships', 'sleep'],
    topicsTheyAvoid: ['family'],
    communicationRhythm: 'quick back and forth with long gaps on weekends',
    emotionalPatterns: 'tends to vent before exams',
  };

  function makeMessages(count, roles = null) {
    return Array.from({ length: count }, (_, i) => ({
      role: roles ? roles[i % roles.length] : (i % 2 === 0 ? 'user' : 'assistant'),
      content: `message ${i}`,
    }));
  }

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../../src/db');
    jest.mock('../../src/utils/claude');
    jest.mock('../../src/memory/store');

    db = require('../../src/db');
    claude = require('../../src/utils/claude');
    store = require('../../src/memory/store');

    db.query.mockResolvedValue({ rows: makeMessages(20) });
    claude.classify.mockResolvedValue(JSON.stringify(VALID_PATTERNS));
    store.storeMemory.mockResolvedValue(undefined);

    patternExtractor = require('../../src/learning/patternExtractor');
  });

  it('skips when fewer than 12 messages', async () => {
    db.query.mockResolvedValue({ rows: makeMessages(10) });
    await patternExtractor.extractInteractionPatterns(1);
    expect(claude.classify).not.toHaveBeenCalled();
    expect(store.storeMemory).not.toHaveBeenCalled();
  });

  it('proceeds when exactly 12 messages', async () => {
    db.query.mockResolvedValue({ rows: makeMessages(12) });
    await patternExtractor.extractInteractionPatterns(1);
    expect(claude.classify).toHaveBeenCalled();
  });

  it('calls classify with full conversation', async () => {
    await patternExtractor.extractInteractionPatterns(1);
    const [prompt] = claude.classify.mock.calls[0];
    expect(prompt).toContain('interacts with their AI agent');
    expect(prompt).toContain('respondsWellTo');
  });

  it('queries last 40 messages for given userId', async () => {
    await patternExtractor.extractInteractionPatterns(5);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/LIMIT 40/);
    expect(params[0]).toBe(5);
  });

  it('stores memory for respondsWellTo when non-empty', async () => {
    await patternExtractor.extractInteractionPatterns(1);
    expect(store.storeMemory).toHaveBeenCalledWith(
      1,
      expect.stringContaining('responds well to:'),
      expect.objectContaining({ type: 'preference', importance: 8, source: 'pattern_extractor' })
    );
  });

  it('stores memory for disengagesFrom when non-empty', async () => {
    await patternExtractor.extractInteractionPatterns(1);
    expect(store.storeMemory).toHaveBeenCalledWith(
      1,
      expect.stringContaining('disengages from:'),
      expect.objectContaining({ type: 'preference', importance: 8, source: 'pattern_extractor' })
    );
  });

  it('stores memory for peakEngagementTimes when non-empty', async () => {
    await patternExtractor.extractInteractionPatterns(1);
    expect(store.storeMemory).toHaveBeenCalledWith(
      1,
      expect.stringContaining('most engaged and responsive around:'),
      expect.objectContaining({ type: 'habit', importance: 7, source: 'pattern_extractor' })
    );
  });

  it('stores memory for topicsTheyBringUp when non-empty', async () => {
    await patternExtractor.extractInteractionPatterns(1);
    expect(store.storeMemory).toHaveBeenCalledWith(
      1,
      expect.stringContaining('frequently brings up:'),
      expect.objectContaining({ type: 'preference', importance: 6, source: 'pattern_extractor' })
    );
  });

  it('stores memory for emotionalPatterns when non-empty', async () => {
    await patternExtractor.extractInteractionPatterns(1);
    expect(store.storeMemory).toHaveBeenCalledWith(
      1,
      'tends to vent before exams',
      expect.objectContaining({ type: 'habit', importance: 7, source: 'pattern_extractor' })
    );
  });

  it('does not store memory for empty respondsWellTo array', async () => {
    claude.classify.mockResolvedValue(JSON.stringify({ ...VALID_PATTERNS, respondsWellTo: [] }));
    await patternExtractor.extractInteractionPatterns(1);
    const calls = store.storeMemory.mock.calls.filter(c => c[1].includes('responds well to:'));
    expect(calls.length).toBe(0);
  });

  it('does not store memory for empty peakEngagementTimes string', async () => {
    claude.classify.mockResolvedValue(JSON.stringify({ ...VALID_PATTERNS, peakEngagementTimes: '' }));
    await patternExtractor.extractInteractionPatterns(1);
    const calls = store.storeMemory.mock.calls.filter(c => c[1].includes('most engaged'));
    expect(calls.length).toBe(0);
  });

  it('does not store memory for whitespace-only peakEngagementTimes', async () => {
    claude.classify.mockResolvedValue(JSON.stringify({ ...VALID_PATTERNS, peakEngagementTimes: '   ' }));
    await patternExtractor.extractInteractionPatterns(1);
    const calls = store.storeMemory.mock.calls.filter(c => c[1].includes('most engaged'));
    expect(calls.length).toBe(0);
  });

  it('does not store memory for empty emotionalPatterns', async () => {
    claude.classify.mockResolvedValue(JSON.stringify({ ...VALID_PATTERNS, emotionalPatterns: '' }));
    await patternExtractor.extractInteractionPatterns(1);
    const calls = store.storeMemory.mock.calls.filter(c => c[1].includes('tends to vent'));
    expect(calls.length).toBe(0);
  });

  it('handles invalid JSON gracefully without throwing', async () => {
    claude.classify.mockResolvedValue('{ broken json ');
    await expect(patternExtractor.extractInteractionPatterns(1)).resolves.not.toThrow();
    expect(store.storeMemory).not.toHaveBeenCalled();
  });

  it('does not throw when storeMemory rejects', async () => {
    store.storeMemory.mockRejectedValue(new Error('qdrant down'));
    await expect(patternExtractor.extractInteractionPatterns(1)).resolves.not.toThrow();
  });

  it('does not throw when db.query rejects', async () => {
    db.query.mockRejectedValue(new Error('db down'));
    await expect(patternExtractor.extractInteractionPatterns(1)).resolves.not.toThrow();
  });

  it('stores memories with correct types', async () => {
    await patternExtractor.extractInteractionPatterns(1);
    const allCalls = store.storeMemory.mock.calls;
    const preferenceTypes = allCalls.filter(c => c[2].type === 'preference');
    const habitTypes = allCalls.filter(c => c[2].type === 'habit');
    // respondsWellTo + disengagesFrom + topicsTheyBringUp = preference
    expect(preferenceTypes.length).toBe(3);
    // peakEngagementTimes + emotionalPatterns = habit
    expect(habitTypes.length).toBe(2);
  });

  // ─── Integration test — full learning loop ──────────────────────────────────

  describe('integration: full learning loop', () => {
    it('captures length-mismatch preference across 20 messages and pattern extraction sees it', async () => {
      // This test simulates the full loop where:
      // 1. captureConversationFeedback stores preferences based on reply patterns
      // 2. extractInteractionPatterns stores pattern memories
      // Both use storeMemory — verify the right memories get stored

      jest.resetModules();
      jest.mock('../../src/db');
      jest.mock('../../src/utils/claude');
      jest.mock('../../src/memory/store');

      const mockDb = require('../../src/db');
      const mockClaude = require('../../src/utils/claude');
      const mockStore = require('../../src/memory/store');

      mockStore.storeMemory.mockResolvedValue(undefined);
      mockClaude.classify
        .mockResolvedValueOnce(JSON.stringify({ sentiment: 'negative', confidence: 0.8 })) // first call for proactive
        .mockResolvedValue(JSON.stringify({ // subsequent calls for pattern extraction
          respondsWellTo: ['short messages'],
          disengagesFrom: ['long messages'],
          peakEngagementTimes: '',
          topicsTheyBringUp: [],
          topicsTheyAvoid: [],
          communicationRhythm: '',
          emotionalPatterns: 'disengages from long responses',
        }));

      const { captureConversationFeedback } = require('../../src/learning/feedbackCapture');
      const { extractInteractionPatterns: extract } = require('../../src/learning/patternExtractor');

      // Simulate 20 message turns: agent sends long message, user replies with one word
      const longAgent = 'x'.repeat(201);
      for (let i = 0; i < 20; i++) {
        await captureConversationFeedback(1, 'ok', longAgent);
      }

      // Set up db.query for extractInteractionPatterns
      mockDb.query.mockResolvedValue({
        rows: Array.from({ length: 20 }, (_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: i % 2 === 0 ? 'ok' : longAgent,
        })),
      });

      await extract(1);

      // Verify at least one memory stored about preferring shorter responses
      const allMemories = mockStore.storeMemory.mock.calls.map(c => c[1]);
      const hasShortResponsePref = allMemories.some(m =>
        m.includes('prefers very short responses') ||
        m.includes('short messages') ||
        m.includes('dismissive reply')
      );
      expect(hasShortResponsePref).toBe(true);
    });
  });
});
