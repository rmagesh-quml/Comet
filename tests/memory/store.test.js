'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');

jest.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: jest.fn(),
}));
jest.mock('../../src/memory/embeddings');

describe('memory store', () => {
  let store, embeddings;
  let mockQdrantInstance;

  const FAKE_VECTOR = Array.from({ length: 1536 }, (_, i) => i / 1536);

  beforeEach(async () => {
    jest.resetModules();
    jest.mock('@qdrant/js-client-rest', () => ({
      QdrantClient: jest.fn(),
    }));
    jest.mock('../../src/memory/embeddings');

    embeddings = require('../../src/memory/embeddings');
    embeddings.getEmbedding.mockResolvedValue(FAKE_VECTOR);

    const { QdrantClient } = require('@qdrant/js-client-rest');
    mockQdrantInstance = {
      getCollections: jest.fn().mockResolvedValue({ collections: [{ name: 'memories' }] }),
      createCollection: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({ status: 'ok' }),
      search: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({}),
    };
    QdrantClient.mockImplementation(() => mockQdrantInstance);

    store = require('../../src/memory/store');
    await store.initQdrant();
  });

  // ─── initQdrant ─────────────────────────────────────────────────────────────

  describe('initQdrant', () => {
    it('creates collection when it does not exist', async () => {
      jest.resetModules();
      jest.mock('@qdrant/js-client-rest', () => ({ QdrantClient: jest.fn() }));
      jest.mock('../../src/memory/embeddings');

      const { QdrantClient } = require('@qdrant/js-client-rest');
      const freshInstance = {
        getCollections: jest.fn().mockResolvedValue({ collections: [] }),
        createCollection: jest.fn().mockResolvedValue({}),
        upsert: jest.fn(),
        search: jest.fn(),
        delete: jest.fn(),
      };
      QdrantClient.mockImplementation(() => freshInstance);

      const freshStore = require('../../src/memory/store');
      await freshStore.initQdrant();

      expect(freshInstance.createCollection).toHaveBeenCalledWith(
        'memories',
        expect.objectContaining({ vectors: { size: 1536, distance: 'Cosine' } })
      );
    });

    it('skips collection creation when it already exists', async () => {
      expect(mockQdrantInstance.createCollection).not.toHaveBeenCalled();
    });
  });

  // ─── storeMemory ─────────────────────────────────────────────────────────────

  describe('storeMemory', () => {
    it('calls getEmbedding with the text', async () => {
      await store.storeMemory(1, 'user prefers morning workouts');

      expect(embeddings.getEmbedding).toHaveBeenCalledWith('user prefers morning workouts');
    });

    it('upserts to Qdrant with userId in payload', async () => {
      await store.storeMemory(42, 'likes coffee');

      expect(mockQdrantInstance.upsert).toHaveBeenCalledWith(
        'memories',
        expect.objectContaining({
          points: expect.arrayContaining([
            expect.objectContaining({
              vector: FAKE_VECTOR,
              payload: expect.objectContaining({ userId: 42, text: 'likes coffee' }),
            }),
          ]),
        })
      );
    });

    it('includes all metadata fields in payload', async () => {
      await store.storeMemory(1, 'studying for finals', {
        type: 'academic',
        importance: 8,
        source: 'nightly_extraction',
      });

      const [, upsertArg] = mockQdrantInstance.upsert.mock.calls[0];
      const payload = upsertArg.points[0].payload;

      expect(payload).toMatchObject({
        userId: 1,
        text: 'studying for finals',
        type: 'academic',
        importance: 8,
        source: 'nightly_extraction',
      });
      expect(payload.timestamp).toBeDefined();
      expect(payload.ts).toBeDefined();
    });

    it('uses defaults when metadata is omitted', async () => {
      await store.storeMemory(1, 'some fact');

      const [, upsertArg] = mockQdrantInstance.upsert.mock.calls[0];
      const payload = upsertArg.points[0].payload;

      expect(payload.type).toBe('preference');
      expect(payload.importance).toBe(5);
      expect(payload.source).toBe('unknown');
    });

    it('generates a unique point ID per call', async () => {
      await store.storeMemory(1, 'fact one');
      await store.storeMemory(1, 'fact two');

      const id1 = mockQdrantInstance.upsert.mock.calls[0][1].points[0].id;
      const id2 = mockQdrantInstance.upsert.mock.calls[1][1].points[0].id;

      expect(id1).not.toBe(id2);
    });
  });

  // ─── searchMemories ──────────────────────────────────────────────────────────

  describe('searchMemories', () => {
    it('passes userId filter to Qdrant search', async () => {
      await store.searchMemories(7, 'morning habits');

      expect(mockQdrantInstance.search).toHaveBeenCalledWith(
        'memories',
        expect.objectContaining({
          filter: {
            must: [{ key: 'userId', match: { value: 7 } }],
          },
        })
      );
    });

    it('returns empty array when no memories exist', async () => {
      mockQdrantInstance.search.mockResolvedValue([]);

      const result = await store.searchMemories(1, 'anything');

      expect(result).toEqual([]);
    });

    it('filters results below score threshold (0.65)', async () => {
      mockQdrantInstance.search.mockResolvedValue([
        { id: 'a', score: 0.80, payload: { text: 'high score', type: 'habit', importance: 7, userId: 1 } },
        { id: 'b', score: 0.50, payload: { text: 'low score', type: 'habit', importance: 5, userId: 1 } },
        { id: 'c', score: 0.65, payload: { text: 'exact threshold', type: 'goal', importance: 6, userId: 1 } },
      ]);

      // Use score_threshold param on the Qdrant call — verify it's passed
      await store.searchMemories(1, 'test');

      expect(mockQdrantInstance.search).toHaveBeenCalledWith(
        'memories',
        expect.objectContaining({ score_threshold: 0.65 })
      );
    });

    it('returns formatted result objects', async () => {
      mockQdrantInstance.search.mockResolvedValue([
        {
          id: 'uuid1',
          score: 0.82,
          payload: { text: 'prefers late classes', type: 'preference', importance: 7, userId: 1 },
        },
      ]);

      const result = await store.searchMemories(1, 'schedule');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        text: 'prefers late classes',
        type: 'preference',
        importance: 7,
        score: 0.82,
      });
    });

    it('returns empty array on Qdrant error', async () => {
      mockQdrantInstance.search.mockRejectedValue(new Error('Qdrant down'));

      const result = await store.searchMemories(1, 'anything');

      expect(result).toEqual([]);
    });
  });

  // ─── deleteOldMemories ────────────────────────────────────────────────────────

  describe('deleteOldMemories', () => {
    it('deletes by userId, importance < 5, and ts < 90 days ago', async () => {
      await store.deleteOldMemories(3);

      expect(mockQdrantInstance.delete).toHaveBeenCalledWith(
        'memories',
        expect.objectContaining({
          filter: {
            must: expect.arrayContaining([
              { key: 'userId', match: { value: 3 } },
              { key: 'importance', range: { lt: 5 } },
              expect.objectContaining({ key: 'ts' }),
            ]),
          },
        })
      );
    });
  });
});
