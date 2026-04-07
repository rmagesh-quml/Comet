'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');

// ─── Mock mem0ai MemoryClient ─────────────────────────────────────────────────

let mockClientInstance;

jest.mock('mem0ai', () => {
  const MockMemoryClient = jest.fn().mockImplementation(() => mockClientInstance);
  return { MemoryClient: MockMemoryClient };
});

describe('memory store', () => {
  let store;

  beforeEach(async () => {
    jest.resetModules();

    // Fresh mock instance for every test
    mockClientInstance = {
      getAll:    jest.fn().mockResolvedValue([]),
      add:       jest.fn().mockResolvedValue({ results: [] }),
      search:    jest.fn().mockResolvedValue([]),
      deleteAll: jest.fn().mockResolvedValue({}),
    };

    jest.mock('mem0ai', () => {
      const MockMemoryClient = jest.fn().mockImplementation(() => mockClientInstance);
      return { MemoryClient: MockMemoryClient };
    });

    store = require('../../src/memory/store');
    await store.initQdrant();
  });

  // ─── initQdrant ─────────────────────────────────────────────────────────────

  describe('initQdrant', () => {
    it('performs a connectivity check via getAll', () => {
      expect(mockClientInstance.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: '__healthcheck__' })
      );
    });

    it('does not throw when Mem0 is unreachable', async () => {
      jest.resetModules();
      mockClientInstance = {
        getAll:    jest.fn().mockRejectedValue(new Error('network error')),
        add:       jest.fn(),
        search:    jest.fn(),
        deleteAll: jest.fn(),
      };
      jest.mock('mem0ai', () => ({
        MemoryClient: jest.fn().mockImplementation(() => mockClientInstance),
      }));

      const freshStore = require('../../src/memory/store');
      await expect(freshStore.initQdrant()).resolves.toBeUndefined();
    });
  });

  // ─── storeMemory ─────────────────────────────────────────────────────────────

  describe('storeMemory', () => {
    it('calls client.add with a messages array and user_id', async () => {
      await store.storeMemory(1, 'user prefers morning workouts');

      expect(mockClientInstance.add).toHaveBeenCalledWith(
        [{ role: 'user', content: 'user prefers morning workouts' }],
        expect.objectContaining({ user_id: '1' })
      );
    });

    it('coerces numeric userId to string', async () => {
      await store.storeMemory(42, 'likes coffee');

      const [, options] = mockClientInstance.add.mock.calls[0];
      expect(options.user_id).toBe('42');
    });

    it('passes metadata through to client.add options', async () => {
      await store.storeMemory(1, 'studying for finals', {
        type: 'academic',
        importance: 8,
        source: 'nightly_extraction',
      });

      const [, options] = mockClientInstance.add.mock.calls[0];
      expect(options.metadata).toMatchObject({
        type: 'academic',
        importance: 8,
        source: 'nightly_extraction',
      });
    });

    it('does not throw when client.add rejects', async () => {
      mockClientInstance.add.mockRejectedValue(new Error('Mem0 error'));

      await expect(store.storeMemory(1, 'something')).resolves.toBeUndefined();
    });
  });

  // ─── searchMemories ──────────────────────────────────────────────────────────

  describe('searchMemories', () => {
    it('calls client.search with query, user_id, and limit', async () => {
      await store.searchMemories(7, 'morning habits');

      expect(mockClientInstance.search).toHaveBeenCalledWith(
        'morning habits',
        expect.objectContaining({ user_id: '7', limit: 5 })
      );
    });

    it('passes custom limit through', async () => {
      await store.searchMemories(1, 'anything', 10);

      const [, opts] = mockClientInstance.search.mock.calls[0];
      expect(opts.limit).toBe(10);
    });

    it('returns empty array when no memories exist', async () => {
      mockClientInstance.search.mockResolvedValue([]);

      const result = await store.searchMemories(1, 'anything');
      expect(result).toEqual([]);
    });

    it('normalises v1 array response into result objects', async () => {
      mockClientInstance.search.mockResolvedValue([
        {
          id: 'uuid1',
          memory: 'prefers late classes',
          score: 0.82,
          metadata: { type: 'preference', importance: 7 },
        },
      ]);

      const result = await store.searchMemories(1, 'schedule');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        text:       'prefers late classes',
        type:       'preference',
        importance: 7,
        score:      0.82,
      });
    });

    it('normalises v2 wrapped response { results: [] }', async () => {
      mockClientInstance.search.mockResolvedValue({
        results: [
          {
            id: 'uuid2',
            memory: 'wakes up at 7am',
            score: 0.91,
            metadata: { type: 'habit', importance: 8 },
          },
        ],
      });

      const result = await store.searchMemories(1, 'morning');

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('wakes up at 7am');
    });

    it('uses fallback defaults when metadata is absent', async () => {
      mockClientInstance.search.mockResolvedValue([
        { id: 'x', memory: 'some fact', score: 0.75 },
      ]);

      const [result] = await store.searchMemories(1, 'fact');

      expect(result.type).toBe('preference');
      expect(result.importance).toBe(5);
      expect(result.score).toBe(0.75);
    });

    it('returns empty array when client.search rejects', async () => {
      mockClientInstance.search.mockRejectedValue(new Error('Mem0 down'));

      const result = await store.searchMemories(1, 'anything');
      expect(result).toEqual([]);
    });
  });

  // ─── deleteOldMemories ────────────────────────────────────────────────────────

  describe('deleteOldMemories', () => {
    it('is a no-op (Mem0 manages its own lifecycle)', async () => {
      await expect(store.deleteOldMemories(3)).resolves.toBeUndefined();
      expect(mockClientInstance.deleteAll).not.toHaveBeenCalled();
    });
  });

  // ─── deleteUserMemories ───────────────────────────────────────────────────────

  describe('deleteUserMemories', () => {
    it('calls client.deleteAll with the user_id', async () => {
      await store.deleteUserMemories(99);

      expect(mockClientInstance.deleteAll).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: '99' })
      );
    });

    it('does not throw when client.deleteAll rejects', async () => {
      mockClientInstance.deleteAll.mockRejectedValue(new Error('Mem0 error'));

      await expect(store.deleteUserMemories(1)).resolves.toBeUndefined();
    });
  });
});
