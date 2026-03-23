'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');

jest.mock('../../src/db');
jest.mock('../../src/utils/cache');

describe('weather integration', () => {
  let weather, db, cache;
  let mockFetch;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../../src/db');
    jest.mock('../../src/utils/cache');

    db = require('../../src/db');
    cache = require('../../src/utils/cache');

    cache.get.mockReturnValue(null);
    cache.set.mockReturnValue(undefined);

    mockFetch = jest.fn();
    global.fetch = mockFetch;

    db.getUserById.mockResolvedValue({
      id: 1,
      campus_lat: 37.2296,
      campus_lng: -80.4139,
    });

    process.env.OPENWEATHERMAP_API_KEY = 'test_api_key';

    weather = require('../../src/integrations/weather');
  });

  it('returns null when no location set', async () => {
    db.getUserById.mockResolvedValue({ id: 1, campus_lat: null, campus_lng: null });

    const result = await weather.getTodaysForecast(1);

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null when API key missing', async () => {
    delete process.env.OPENWEATHERMAP_API_KEY;

    const result = await weather.getTodaysForecast(1);

    expect(result).toBeNull();
  });

  it('returns null on API failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 });

    const result = await weather.getTodaysForecast(1);

    expect(result).toBeNull();
  });

  it('returns null on fetch error', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await weather.getTodaysForecast(1);

    expect(result).toBeNull();
  });

  it('returns formatted forecast object', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        list: [
          {
            main: { temp: 72.3, feels_like: 70.1 },
            weather: [{ main: 'Clear', description: 'clear sky' }],
            pop: 0.1,
          },
        ],
      }),
    });

    const result = await weather.getTodaysForecast(1);

    expect(result).toMatchObject({
      temp: 72,
      feelsLike: 70,
      conditions: 'Clear',
      description: 'clear sky',
      rainProbability: 10,
      isNotable: false,
    });
  });

  it('isNotable when rainProbability > 40%', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        list: [
          {
            main: { temp: 65, feels_like: 63 },
            weather: [{ main: 'Rain', description: 'light rain' }],
            pop: 0.6,
          },
        ],
      }),
    });

    const result = await weather.getTodaysForecast(1);

    expect(result.isNotable).toBe(true);
    expect(result.rainProbability).toBe(60);
  });

  it('isNotable when temp < 30', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        list: [
          {
            main: { temp: 25, feels_like: 18 },
            weather: [{ main: 'Clear', description: 'clear sky' }],
            pop: 0,
          },
        ],
      }),
    });

    const result = await weather.getTodaysForecast(1);

    expect(result.isNotable).toBe(true);
  });

  it('isNotable when temp > 88', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        list: [
          {
            main: { temp: 95, feels_like: 102 },
            weather: [{ main: 'Clear', description: 'sunny' }],
            pop: 0,
          },
        ],
      }),
    });

    const result = await weather.getTodaysForecast(1);

    expect(result.isNotable).toBe(true);
  });

  it('isNotable when Snow conditions', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        list: [
          {
            main: { temp: 32, feels_like: 28 },
            weather: [{ main: 'Snow', description: 'light snow' }],
            pop: 0.3,
          },
        ],
      }),
    });

    const result = await weather.getTodaysForecast(1);

    expect(result.isNotable).toBe(true);
  });

  it('isNotable when Thunderstorm', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        list: [
          {
            main: { temp: 70, feels_like: 68 },
            weather: [{ main: 'Thunderstorm', description: 'thunderstorm' }],
            pop: 0.8,
          },
        ],
      }),
    });

    const result = await weather.getTodaysForecast(1);

    expect(result.isNotable).toBe(true);
  });

  it('returns cached result on second call', async () => {
    cache.get.mockReturnValue({
      temp: 70, feelsLike: 68, conditions: 'Clear',
      rainProbability: 5, description: 'clear sky', isNotable: false,
    });

    const result = await weather.getTodaysForecast(1);

    expect(result.temp).toBe(70);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('caches result for 120 minutes', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        list: [
          {
            main: { temp: 72, feels_like: 70 },
            weather: [{ main: 'Clear', description: 'clear sky' }],
            pop: 0,
          },
        ],
      }),
    });

    await weather.getTodaysForecast(1);

    expect(cache.set).toHaveBeenCalledWith(
      expect.stringContaining('weather:1'),
      expect.any(Object),
      120
    );
  });
});
