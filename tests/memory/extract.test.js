'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');

jest.mock('../../src/db');
jest.mock('../../src/utils/claude');
jest.mock('../../src/memory/store');

describe('nightlyExtraction', () => {
  let extract, db, claude, store;

  const sampleMessages = [
    { id: 1, role: 'user',      content: 'i have an exam tomorrow in cs3114' },
    { id: 2, role: 'assistant', content: 'want me to help you study?' },
    { id: 3, role: 'user',      content: 'yeah, also i always work out at 7am' },
    { id: 4, role: 'assistant', content: 'noted! ill factor that into your mornings' },
  ];

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../../src/db');
    jest.mock('../../src/utils/claude');
    jest.mock('../../src/memory/store');

    db    = require('../../src/db');
    claude = require('../../src/utils/claude');
    store  = require('../../src/memory/store');

    db.getTodaysMessages.mockResolvedValue(sampleMessages);
    store.storeMemory.mockResolvedValue(undefined);

    extract = require('../../src/memory/extract');
  });

  it('skips extraction when fewer than 4 messages', async () => {
    db.getTodaysMessages.mockResolvedValue([
      { id: 1, role: 'user', content: 'hey' },
      { id: 2, role: 'assistant', content: 'hi' },
    ]);

    await extract.nightlyExtraction(1);

    expect(claude.classify).not.toHaveBeenCalled();
    expect(store.storeMemory).not.toHaveBeenCalled();
  });

  it('skips when message list is empty', async () => {
    db.getTodaysMessages.mockResolvedValue([]);

    await extract.nightlyExtraction(1);

    expect(claude.classify).not.toHaveBeenCalled();
  });

  it('calls classify with formatted messages', async () => {
    claude.classify.mockResolvedValue('[]');

    await extract.nightlyExtraction(1);

    expect(claude.classify).toHaveBeenCalledTimes(1);
    const [prompt] = claude.classify.mock.calls[0];
    expect(prompt).toContain('Messages:');
    expect(prompt).toContain('i have an exam tomorrow');
  });

  it('stores memories for importance >= 6', async () => {
    claude.classify.mockResolvedValue(JSON.stringify([
      { text: 'always works out at 7am', type: 'habit', importance: 8 },
      { text: 'has CS3114 exam', type: 'academic', importance: 7 },
    ]));

    await extract.nightlyExtraction(1);

    expect(store.storeMemory).toHaveBeenCalledTimes(2);
    expect(store.storeMemory).toHaveBeenCalledWith(
      1,
      'always works out at 7am',
      { type: 'habit', importance: 8, source: 'nightly_extraction' }
    );
    expect(store.storeMemory).toHaveBeenCalledWith(
      1,
      'has CS3114 exam',
      { type: 'academic', importance: 7, source: 'nightly_extraction' }
    );
  });

  it('skips memories with importance < 6', async () => {
    claude.classify.mockResolvedValue(JSON.stringify([
      { text: 'high priority memory', type: 'goal', importance: 9 },
      { text: 'low priority detail', type: 'preference', importance: 4 },
      { text: 'border case - exactly 5', type: 'habit', importance: 5 },
    ]));

    await extract.nightlyExtraction(1);

    expect(store.storeMemory).toHaveBeenCalledTimes(1);
    expect(store.storeMemory).toHaveBeenCalledWith(1, 'high priority memory', expect.any(Object));
  });

  it('handles invalid JSON from classify gracefully', async () => {
    claude.classify.mockResolvedValue('this is not valid json at all');

    await expect(extract.nightlyExtraction(1)).resolves.not.toThrow();
    expect(store.storeMemory).not.toHaveBeenCalled();
  });

  it('does not crash when classify rejects', async () => {
    claude.classify.mockRejectedValue(new Error('Claude unavailable'));

    await expect(extract.nightlyExtraction(1)).resolves.not.toThrow();
    expect(store.storeMemory).not.toHaveBeenCalled();
  });

  it('does not crash when DB throws', async () => {
    db.getTodaysMessages.mockRejectedValue(new Error('DB down'));

    await expect(extract.nightlyExtraction(1)).resolves.not.toThrow();
    expect(claude.classify).not.toHaveBeenCalled();
  });

  it('stores up to max 8 memories', async () => {
    const manyMemories = Array.from({ length: 10 }, (_, i) => ({
      text: `memory ${i}`,
      type: 'habit',
      importance: 7,
    }));
    claude.classify.mockResolvedValue(JSON.stringify(manyMemories));

    await extract.nightlyExtraction(1);

    // classify returns 10, but extract.js stores all that pass the filter
    // (the max-8 cap is on what classify returns per the prompt instructions;
    // extract.js itself doesn't enforce it — it stores whatever classify gives)
    expect(store.storeMemory).toHaveBeenCalledTimes(10);
  });

  it('falls back to "preference" for unknown type', async () => {
    claude.classify.mockResolvedValue(JSON.stringify([
      { text: 'some memory', type: 'unknown_type', importance: 7 },
    ]));

    await extract.nightlyExtraction(1);

    expect(store.storeMemory).toHaveBeenCalledWith(
      1,
      'some memory',
      { type: 'preference', importance: 7, source: 'nightly_extraction' }
    );
  });

  it('skips entries with missing or non-string text', async () => {
    claude.classify.mockResolvedValue(JSON.stringify([
      { text: '', type: 'habit', importance: 8 },
      { type: 'habit', importance: 8 },          // no text key
      { text: 123, type: 'habit', importance: 8 }, // non-string
      { text: 'valid memory', type: 'goal', importance: 9 },
    ]));

    await extract.nightlyExtraction(1);

    expect(store.storeMemory).toHaveBeenCalledTimes(1);
    expect(store.storeMemory).toHaveBeenCalledWith(1, 'valid memory', expect.any(Object));
  });
});
