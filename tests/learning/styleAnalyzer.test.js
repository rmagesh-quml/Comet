'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');

jest.mock('../../src/db');
jest.mock('../../src/utils/claude');
jest.mock('../../src/utils/cache');

describe('styleAnalyzer', () => {
  let styleAnalyzer, db, claude, cache;

  const VALID_STYLE = {
    averageLength: 'short',
    casing: 'lowercase',
    punctuation: 'minimal',
    emoji: 'sometimes',
    tone: 'casual',
    sharesPersonally: 'medium',
    prefersResponses: 'brief',
    commonPatterns: 'uses abbreviations like lol and ngl',
  };

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../../src/db');
    jest.mock('../../src/utils/claude');
    jest.mock('../../src/utils/cache');

    db = require('../../src/db');
    claude = require('../../src/utils/claude');
    cache = require('../../src/utils/cache');

    // Default: no cache hit
    cache.get.mockReturnValue(null);
    cache.set.mockReturnValue(undefined);
    cache.clear.mockReturnValue(undefined);

    // Default: 15 messages
    db.query.mockResolvedValue({
      rows: Array.from({ length: 15 }, (_, i) => ({ content: `message ${i}` })),
    });

    claude.classify.mockResolvedValue(JSON.stringify(VALID_STYLE));

    styleAnalyzer = require('../../src/learning/styleAnalyzer');
  });

  // ─── analyzeUserStyle ───────────────────────────────────────────────────────

  describe('analyzeUserStyle', () => {
    it('returns null when fewer than 10 messages', async () => {
      db.query.mockResolvedValue({ rows: Array.from({ length: 8 }, (_, i) => ({ content: `msg ${i}` })) });
      const result = await styleAnalyzer.analyzeUserStyle(1);
      expect(result).toBeNull();
      expect(claude.classify).not.toHaveBeenCalled();
    });

    it('returns cached value on second call without re-classifying', async () => {
      cache.get.mockReturnValue(VALID_STYLE);
      const result = await styleAnalyzer.analyzeUserStyle(1);
      expect(result).toEqual(VALID_STYLE);
      expect(claude.classify).not.toHaveBeenCalled();
    });

    it('uses cache key style:{userId}', async () => {
      cache.get.mockReturnValue(null);
      await styleAnalyzer.analyzeUserStyle(42);
      expect(cache.get).toHaveBeenCalledWith('style:42');
    });

    it('calls classify with formatted messages', async () => {
      await styleAnalyzer.analyzeUserStyle(1);
      expect(claude.classify).toHaveBeenCalledTimes(1);
      const [prompt] = claude.classify.mock.calls[0];
      expect(prompt).toContain('texting style');
      expect(prompt).toContain('JSON only');
    });

    it('returns null on invalid JSON from classify', async () => {
      claude.classify.mockResolvedValue('not valid json {{{');
      const result = await styleAnalyzer.analyzeUserStyle(1);
      expect(result).toBeNull();
    });

    it('caches valid result for 3 days (4320 minutes)', async () => {
      await styleAnalyzer.analyzeUserStyle(1);
      expect(cache.set).toHaveBeenCalledWith(
        'style:1',
        expect.objectContaining({ casing: 'lowercase' }),
        4320
      );
    });

    it('queries only user messages ordered by recency', async () => {
      await styleAnalyzer.analyzeUserStyle(1);
      const [sql, params] = db.query.mock.calls[0];
      expect(sql).toMatch(/role = 'user'/);
      expect(sql).toMatch(/ORDER BY created_at DESC/);
      expect(sql).toMatch(/LIMIT 50/);
      expect(params[0]).toBe(1);
    });
  });

  // ─── formatStyleContext ─────────────────────────────────────────────────────

  describe('formatStyleContext', () => {
    it('returns empty string for null input', () => {
      expect(styleAnalyzer.formatStyleContext(null)).toBe('');
    });

    it('returns empty string for undefined input', () => {
      expect(styleAnalyzer.formatStyleContext(undefined)).toBe('');
    });

    it('includes casing in output', () => {
      const result = styleAnalyzer.formatStyleContext(VALID_STYLE);
      expect(result).toContain('lowercase');
    });

    it('includes punctuation in output', () => {
      const result = styleAnalyzer.formatStyleContext(VALID_STYLE);
      expect(result).toContain('minimal');
    });

    it('includes prefersResponses in output', () => {
      const result = styleAnalyzer.formatStyleContext(VALID_STYLE);
      expect(result).toContain('brief');
    });

    it('includes commonPatterns in output', () => {
      const result = styleAnalyzer.formatStyleContext(VALID_STYLE);
      expect(result).toContain('uses abbreviations');
    });

    it('includes mirror instruction', () => {
      const result = styleAnalyzer.formatStyleContext(VALID_STYLE);
      expect(result).toContain('Mirror this naturally');
    });

    it('never throws on any input', () => {
      expect(() => styleAnalyzer.formatStyleContext({})).not.toThrow();
      expect(() => styleAnalyzer.formatStyleContext({ casing: null })).not.toThrow();
    });
  });

  // ─── getStyleContext ────────────────────────────────────────────────────────

  describe('getStyleContext', () => {
    it('returns empty string on any error', async () => {
      db.query.mockRejectedValue(new Error('db down'));
      const result = await styleAnalyzer.getStyleContext(1);
      expect(result).toBe('');
    });

    it('returns empty string when fewer than 10 messages', async () => {
      db.query.mockResolvedValue({ rows: [{ content: 'hi' }] });
      const result = await styleAnalyzer.getStyleContext(1);
      expect(result).toBe('');
    });

    it('returns formatted string on success', async () => {
      const result = await styleAnalyzer.getStyleContext(1);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain('lowercase');
    });

    it('never throws even when classify throws', async () => {
      claude.classify.mockRejectedValue(new Error('api down'));
      await expect(styleAnalyzer.getStyleContext(1)).resolves.toBe('');
    });
  });

  // ─── refreshStyleCache ──────────────────────────────────────────────────────

  describe('refreshStyleCache', () => {
    it('clears the cache key before rebuilding', async () => {
      await styleAnalyzer.refreshStyleCache(7);
      expect(cache.clear).toHaveBeenCalledWith('style:7');
    });

    it('calls analyzeUserStyle after clearing (classify is called)', async () => {
      await styleAnalyzer.refreshStyleCache(1);
      expect(claude.classify).toHaveBeenCalled();
    });

    it('returns the fresh style object', async () => {
      const result = await styleAnalyzer.refreshStyleCache(1);
      expect(result).toEqual(expect.objectContaining({ casing: 'lowercase' }));
    });
  });
});
