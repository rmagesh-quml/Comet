'use strict';

const db = require('../db');
const cache = require('../utils/cache');

async function getTodaysForecast(userId) {
  const cacheKey = `weather:${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const user = await db.getUserById(userId);
  if (!user || user.campus_lat == null || user.campus_lng == null) return null;

  const apiKey = process.env.OPENWEATHERMAP_API_KEY;
  if (!apiKey) return null;

  try {
    const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${user.campus_lat}&lon=${user.campus_lng}&units=imperial&appid=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    const forecasts = data.list || [];
    if (forecasts.length === 0) return null;

    // Use the first forecast entry (closest to now)
    const first = forecasts[0];
    const temp = Math.round(first.main.temp);
    const feelsLike = Math.round(first.main.feels_like);
    const conditions = first.weather?.[0]?.main || 'Clear';
    const description = first.weather?.[0]?.description || '';
    const rainProbability = Math.round((first.pop || 0) * 100);

    const isNotable =
      rainProbability > 40 ||
      temp < 30 ||
      temp > 88 ||
      conditions === 'Snow' ||
      conditions === 'Thunderstorm';

    const result = { temp, feelsLike, conditions, rainProbability, description, isNotable };
    cache.set(cacheKey, result, 120);
    return result;
  } catch (err) {
    console.error(`getTodaysForecast error for user ${userId}:`, err.message || err);
    return null;
  }
}

module.exports = { getTodaysForecast };
