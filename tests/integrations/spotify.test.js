'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');

jest.mock('spotify-web-api-node');
jest.mock('../../src/db');
jest.mock('../../src/utils/cache');
jest.mock('../../src/utils/claude');

describe('spotify integration', () => {
  let spotify, db, cache, claude;
  let mockSpotifyInstance;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('spotify-web-api-node');
    jest.mock('../../src/db');
    jest.mock('../../src/utils/cache');
    jest.mock('../../src/utils/claude');

    db = require('../../src/db');
    cache = require('../../src/utils/cache');
    claude = require('../../src/utils/claude');

    cache.get.mockReturnValue(null);
    cache.set.mockReturnValue(undefined);

    const SpotifyWebApi = require('spotify-web-api-node');
    mockSpotifyInstance = {
      setRefreshToken: jest.fn(),
      setAccessToken: jest.fn(),
      refreshAccessToken: jest.fn(),
      getMyRecentlyPlayedTracks: jest.fn(),
    };
    SpotifyWebApi.mockImplementation(() => mockSpotifyInstance);

    db.getUserById.mockResolvedValue({
      id: 1,
      phone_number: '+15551234567',
      spotify_refresh_token: 'test_refresh_token',
    });

    spotify = require('../../src/integrations/spotify');
  });

  // ─── getSpotifyClient ──────────────────────────────────────────────────────

  describe('getSpotifyClient', () => {
    it('returns null when no spotify token', async () => {
      db.getUserById.mockResolvedValue({ id: 1, spotify_refresh_token: null });

      const client = await spotify.getSpotifyClient(1);

      expect(client).toBeNull();
    });

    it('refreshes token and returns client', async () => {
      mockSpotifyInstance.refreshAccessToken.mockResolvedValue({
        body: { access_token: 'new_access_token', expires_in: 3600 },
      });

      const client = await spotify.getSpotifyClient(1);

      expect(mockSpotifyInstance.setRefreshToken).toHaveBeenCalledWith('test_refresh_token');
      expect(mockSpotifyInstance.refreshAccessToken).toHaveBeenCalled();
      expect(mockSpotifyInstance.setAccessToken).toHaveBeenCalledWith('new_access_token');
      expect(client).not.toBeNull();
    });

    it('returns null when token refresh fails', async () => {
      mockSpotifyInstance.refreshAccessToken.mockRejectedValue(new Error('invalid token'));

      const client = await spotify.getSpotifyClient(1);

      expect(client).toBeNull();
    });
  });

  // ─── getRecentTracks ───────────────────────────────────────────────────────

  describe('getRecentTracks', () => {
    beforeEach(() => {
      mockSpotifyInstance.refreshAccessToken.mockResolvedValue({
        body: { access_token: 'access_token', expires_in: 3600 },
      });
    });

    it('returns empty array when no spotify token', async () => {
      db.getUserById.mockResolvedValue({ id: 1, spotify_refresh_token: null });

      const result = await spotify.getRecentTracks(1);

      expect(result).toEqual([]);
      expect(mockSpotifyInstance.getMyRecentlyPlayedTracks).not.toHaveBeenCalled();
    });

    it('returns formatted track array', async () => {
      mockSpotifyInstance.getMyRecentlyPlayedTracks.mockResolvedValue({
        body: {
          items: [
            {
              track: {
                name: 'Bohemian Rhapsody',
                artists: [{ name: 'Queen' }],
              },
              played_at: '2026-03-23T10:00:00Z',
            },
            {
              track: {
                name: 'Hotel California',
                artists: [{ name: 'Eagles' }],
              },
              played_at: '2026-03-23T09:30:00Z',
            },
          ],
        },
      });

      const result = await spotify.getRecentTracks(1);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        name: 'Bohemian Rhapsody',
        artist: 'Queen',
        playedAt: '2026-03-23T10:00:00Z',
      });
    });

    it('handles multiple artists', async () => {
      mockSpotifyInstance.getMyRecentlyPlayedTracks.mockResolvedValue({
        body: {
          items: [
            {
              track: {
                name: 'Collab Song',
                artists: [{ name: 'Artist A' }, { name: 'Artist B' }],
              },
              played_at: '2026-03-23T10:00:00Z',
            },
          ],
        },
      });

      const result = await spotify.getRecentTracks(1);

      expect(result[0].artist).toBe('Artist A, Artist B');
    });

    it('returns cached result', async () => {
      cache.get.mockReturnValue([{ name: 'Cached', artist: 'Artist', playedAt: '...' }]);

      const result = await spotify.getRecentTracks(1);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Cached');
      expect(mockSpotifyInstance.getMyRecentlyPlayedTracks).not.toHaveBeenCalled();
    });

    it('returns empty array on API error', async () => {
      mockSpotifyInstance.getMyRecentlyPlayedTracks.mockRejectedValue(new Error('API down'));

      const result = await spotify.getRecentTracks(1);

      expect(result).toEqual([]);
    });
  });

  // ─── inferMood ────────────────────────────────────────────────────────────

  describe('inferMood', () => {
    it('returns unknown mood when no tracks', async () => {
      const result = await spotify.inferMood([]);
      expect(result).toEqual({ mood: 'unknown' });
    });

    it('returns parsed mood object on success', async () => {
      claude.classify.mockResolvedValue(
        JSON.stringify({ mood: 'energized', activity: 'working out', confidence: 'high' })
      );

      const tracks = [{ name: 'Eye of the Tiger', artist: 'Survivor', playedAt: '...' }];
      const result = await spotify.inferMood(tracks);

      expect(result).toMatchObject({ mood: 'energized', activity: 'working out' });
    });

    it('returns unknown mood on bad JSON from classify', async () => {
      claude.classify.mockResolvedValue('not valid json at all');

      const tracks = [{ name: 'Song', artist: 'Artist', playedAt: '...' }];
      const result = await spotify.inferMood(tracks);

      expect(result).toEqual({ mood: 'unknown' });
    });

    it('returns unknown mood when mood field missing', async () => {
      claude.classify.mockResolvedValue(JSON.stringify({ activity: 'something' }));

      const tracks = [{ name: 'Song', artist: 'Artist', playedAt: '...' }];
      const result = await spotify.inferMood(tracks);

      expect(result).toEqual({ mood: 'unknown' });
    });

    it('returns unknown mood on classify error', async () => {
      claude.classify.mockRejectedValue(new Error('Claude down'));

      const tracks = [{ name: 'Song', artist: 'Artist', playedAt: '...' }];
      const result = await spotify.inferMood(tracks);

      expect(result).toEqual({ mood: 'unknown' });
    });
  });

  // ─── getMoodContext ────────────────────────────────────────────────────────

  describe('getMoodContext', () => {
    it('returns null when no spotify token', async () => {
      db.getUserById.mockResolvedValue({ id: 1, spotify_refresh_token: null });

      const result = await spotify.getMoodContext(1);

      expect(result).toBeNull();
    });

    it('returns mood object on success', async () => {
      mockSpotifyInstance.refreshAccessToken.mockResolvedValue({
        body: { access_token: 'token', expires_in: 3600 },
      });
      mockSpotifyInstance.getMyRecentlyPlayedTracks.mockResolvedValue({
        body: {
          items: [
            {
              track: { name: 'Stressed Out', artists: [{ name: 'twenty one pilots' }] },
              played_at: '2026-03-23T10:00:00Z',
            },
          ],
        },
      });
      claude.classify.mockResolvedValue(
        JSON.stringify({ mood: 'stressed', activity: 'studying', confidence: 'medium' })
      );

      const result = await spotify.getMoodContext(1);

      expect(result).toMatchObject({ mood: 'stressed' });
    });
  });
});
