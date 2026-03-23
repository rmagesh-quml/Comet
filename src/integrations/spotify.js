'use strict';

const SpotifyWebApi = require('spotify-web-api-node');
const db = require('../db');
const cache = require('../utils/cache');
const { classify } = require('../utils/claude');

// In-memory access token cache (not persisted to DB)
const tokenCache = new Map(); // userId -> { accessToken, expiresAt }

async function getSpotifyClient(userId) {
  const user = await db.getUserById(userId);
  if (!user || !user.spotify_refresh_token) return null;

  // Return cached access token if still valid (with 60s buffer)
  const cached = tokenCache.get(userId);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    const client = new SpotifyWebApi({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    });
    client.setAccessToken(cached.accessToken);
    return client;
  }

  const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  });
  spotifyApi.setRefreshToken(user.spotify_refresh_token);

  try {
    const data = await spotifyApi.refreshAccessToken();
    const accessToken = data.body.access_token;
    const expiresIn = data.body.expires_in || 3600; // seconds

    tokenCache.set(userId, {
      accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
    });

    spotifyApi.setAccessToken(accessToken);
    return spotifyApi;
  } catch (err) {
    console.error(`Spotify token refresh error for user ${userId}:`, err.message || err);
    return null;
  }
}

async function getRecentTracks(userId, limit = 5) {
  const cacheKey = `spotify:recent:${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const client = await getSpotifyClient(userId);
  if (!client) return [];

  try {
    const data = await client.getMyRecentlyPlayedTracks({ limit });
    const tracks = (data.body.items || []).map(item => ({
      name: item.track.name,
      artist: item.track.artists.map(a => a.name).join(', '),
      playedAt: item.played_at,
    }));

    cache.set(cacheKey, tracks, 5);
    return tracks;
  } catch (err) {
    console.error(`getRecentTracks error for user ${userId}:`, err.message || err);
    return [];
  }
}

async function inferMood(tracks) {
  if (!tracks || tracks.length === 0) return { mood: 'unknown' };

  const trackList = tracks.map(t => `${t.name} by ${t.artist}`).join(', ');
  const prompt = `Based on these recently played songs: ${trackList}

Infer the listener's current mood and activity. Respond with JSON only:
{"mood": "one of: focused, relaxed, energized, stressed, happy, sad, unknown", "activity": "brief description", "confidence": "high|medium|low"}`;

  try {
    const raw = await classify(prompt, 100);
    const parsed = JSON.parse(raw.trim());
    if (!parsed.mood) return { mood: 'unknown' };
    return parsed;
  } catch {
    return { mood: 'unknown' };
  }
}

async function getMoodContext(userId) {
  const user = await db.getUserById(userId);
  if (!user || !user.spotify_refresh_token) return null;

  const tracks = await getRecentTracks(userId);
  return inferMood(tracks);
}

module.exports = { getSpotifyClient, getRecentTracks, inferMood, getMoodContext };
