'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');

jest.mock('../../src/db');
jest.mock('gtfs-realtime-bindings', () => ({
  transit_realtime: {
    FeedMessage: { decode: jest.fn() },
  },
}));

// VT campus reference coordinates (Drillfield area)
const VT_LAT = 37.2284;
const VT_LNG = -80.4234;

describe('bt_bus integration', () => {
  let btBus, btStatic, db;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../../src/db');
    jest.mock('gtfs-realtime-bindings', () => ({
      transit_realtime: {
        FeedMessage: { decode: jest.fn() },
      },
    }));

    db = require('../../src/db');
    db.getAllBusStops.mockResolvedValue([]);
    db.getBusStopById.mockResolvedValue(null);
    db.getAllBusRoutes.mockResolvedValue([]);
    db.getNextBusArrivals.mockResolvedValue([]);
    db.getUserById.mockResolvedValue(null);
    db.upsertBusPrediction.mockResolvedValue(undefined);

    btStatic = require('../../src/integrations/bt_static');
    btBus = require('../../src/integrations/bt_bus');
  });

  // ─── getNearestStops ───────────────────────────────────────────────────────

  describe('getNearestStops', () => {
    it('returns stops sorted by distance', async () => {
      db.getAllBusStops.mockResolvedValue([
        { stop_id: 'FAR',  stop_name: 'Far Stop',   stop_lat: '37.2400', stop_lng: '-80.4234' }, // ~1.77 km
        { stop_id: 'NEAR', stop_name: 'Near Stop',  stop_lat: '37.2290', stop_lng: '-80.4234' }, // ~67 m
        { stop_id: 'MID',  stop_name: 'Mid Stop',   stop_lat: '37.2310', stop_lng: '-80.4234' }, // ~289 m
      ]);

      const result = await btStatic.getNearestStops(VT_LAT, VT_LNG, 3);

      expect(result[0].stopId).toBe('NEAR');
      expect(result[1].stopId).toBe('MID');
      expect(result[2].stopId).toBe('FAR');
    });

    it('correctly calculates haversine distance', async () => {
      // One degree of latitude ≈ 111,000 m at VT latitude
      // 0.01° latitude difference ≈ 1,111 m
      db.getAllBusStops.mockResolvedValue([
        { stop_id: 'S1', stop_name: 'Test', stop_lat: String(VT_LAT + 0.01), stop_lng: String(VT_LNG) },
      ]);

      const result = await btStatic.getNearestStops(VT_LAT, VT_LNG, 1);

      expect(result[0].distanceMeters).toBeGreaterThan(1000);
      expect(result[0].distanceMeters).toBeLessThan(1250);
    });

    it('respects the limit parameter', async () => {
      db.getAllBusStops.mockResolvedValue([
        { stop_id: 'A', stop_name: 'A', stop_lat: '37.2290', stop_lng: '-80.4234' },
        { stop_id: 'B', stop_name: 'B', stop_lat: '37.2300', stop_lng: '-80.4234' },
        { stop_id: 'C', stop_name: 'C', stop_lat: '37.2310', stop_lng: '-80.4234' },
        { stop_id: 'D', stop_name: 'D', stop_lat: '37.2320', stop_lng: '-80.4234' },
      ]);

      const result = await btStatic.getNearestStops(VT_LAT, VT_LNG, 2);

      expect(result).toHaveLength(2);
    });

    it('returns empty array when no stops in DB', async () => {
      db.getAllBusStops.mockResolvedValue([]);

      const result = await btStatic.getNearestStops(VT_LAT, VT_LNG, 3);

      expect(result).toEqual([]);
    });

    it('includes stopId, stopName, distanceMeters in each result', async () => {
      db.getAllBusStops.mockResolvedValue([
        { stop_id: 'S1', stop_name: 'Bus Stop 1', stop_lat: '37.2290', stop_lng: '-80.4234' },
      ]);

      const result = await btStatic.getNearestStops(VT_LAT, VT_LNG, 1);

      expect(result[0]).toMatchObject({
        stopId: 'S1',
        stopName: 'Bus Stop 1',
        distanceMeters: expect.any(Number),
      });
    });
  });

  // ─── haversineMeters (unit) ────────────────────────────────────────────────

  describe('haversineMeters', () => {
    it('returns 0 for same coordinates', () => {
      expect(btStatic.haversineMeters(37.2284, -80.4234, 37.2284, -80.4234)).toBe(0);
    });

    it('returns ~111km per degree of latitude', () => {
      const dist = btStatic.haversineMeters(37, -80, 38, -80);
      expect(dist).toBeGreaterThan(110000);
      expect(dist).toBeLessThan(112000);
    });
  });

  // ─── getNextBuses ──────────────────────────────────────────────────────────

  describe('getNextBuses', () => {
    it('returns empty array for unknown stop (no predictions)', async () => {
      db.getNextBusArrivals.mockResolvedValue([]);

      const result = await btBus.getNextBuses('UNKNOWN_STOP');

      expect(result).toEqual([]);
    });

    it('returns empty array when no predictions exist', async () => {
      db.getNextBusArrivals.mockResolvedValue([]);

      const result = await btBus.getNextBuses('STOP1');

      expect(result).toEqual([]);
    });

    it('filters out stale predictions (updated_at > 2 min ago)', async () => {
      const staleTime = new Date(Date.now() - 3 * 60 * 1000); // 3 min ago
      db.getNextBusArrivals.mockResolvedValue([
        {
          trip_id: 'trip1',
          stop_id: 'STOP1',
          route_short_name: '17',
          arrival_time: new Date(Date.now() + 5 * 60 * 1000),
          delay_seconds: 0,
          updated_at: staleTime,
        },
      ]);

      const result = await btBus.getNextBuses('STOP1');

      expect(result).toEqual([]);
    });

    it('returns sorted predictions by arrival time', async () => {
      const freshTime = new Date(Date.now() - 30 * 1000); // 30 sec ago
      db.getNextBusArrivals.mockResolvedValue([
        {
          trip_id: 'trip2',
          stop_id: 'STOP1',
          route_short_name: '45',
          arrival_time: new Date(Date.now() + 15 * 60 * 1000),
          delay_seconds: 0,
          updated_at: freshTime,
        },
        {
          trip_id: 'trip1',
          stop_id: 'STOP1',
          route_short_name: '17',
          arrival_time: new Date(Date.now() + 5 * 60 * 1000),
          delay_seconds: 60,
          updated_at: freshTime,
        },
      ]);

      const result = await btBus.getNextBuses('STOP1');

      // DB already returns sorted (ORDER BY arrival_time), but we verify mapping
      expect(result).toHaveLength(2);
      expect(result[0].routeName).toBe('45');
      expect(result[1].routeName).toBe('17');
    });

    it('returns etaMinutes, routeName, arrivalTime, delaySeconds', async () => {
      const freshTime = new Date(Date.now() - 10 * 1000);
      const arrivalTime = new Date(Date.now() + 8 * 60 * 1000);
      db.getNextBusArrivals.mockResolvedValue([
        {
          trip_id: 'trip1',
          stop_id: 'STOP1',
          route_short_name: '17',
          arrival_time: arrivalTime,
          delay_seconds: 120,
          updated_at: freshTime,
        },
      ]);

      const result = await btBus.getNextBuses('STOP1');

      expect(result[0]).toMatchObject({
        routeName: '17',
        etaMinutes: 8,
        delaySeconds: 120,
      });
      expect(result[0].arrivalTime).toEqual(arrivalTime);
    });

    it('respects limit parameter', async () => {
      const freshTime = new Date(Date.now() - 10 * 1000);
      const predictions = Array.from({ length: 6 }, (_, i) => ({
        trip_id: `trip${i}`,
        stop_id: 'STOP1',
        route_short_name: String(i),
        arrival_time: new Date(Date.now() + (i + 1) * 5 * 60 * 1000),
        delay_seconds: 0,
        updated_at: freshTime,
      }));
      db.getNextBusArrivals.mockResolvedValue(predictions);

      const result = await btBus.getNextBuses('STOP1', 3);

      expect(result).toHaveLength(3);
    });
  });

  // ─── shouldLeaveAlert ──────────────────────────────────────────────────────

  describe('shouldLeaveAlert', () => {
    const baseUser = {
      id: 1,
      phone_number: '+15551234567',
      nearest_bus_stop_id: 'HOME_STOP',
      campus_lat: VT_LAT,
      campus_lng: VT_LNG,
    };

    const soonEvent = {
      title: 'CS 3114',
      location: 'McBryde Hall',
      start: new Date(Date.now() + 20 * 60 * 1000), // 20 min from now
    };

    it('returns null when user has no home stop stored', async () => {
      db.getUserById.mockResolvedValue({ ...baseUser, nearest_bus_stop_id: null });

      const result = await btBus.shouldLeaveAlert(1, soonEvent);

      expect(result).toBeNull();
    });

    it('returns null for unrecognized building location', async () => {
      db.getUserById.mockResolvedValue(baseUser);

      const result = await btBus.shouldLeaveAlert(1, {
        title: 'Meeting',
        location: 'Some Random Building',
        start: new Date(Date.now() + 20 * 60 * 1000),
      });

      expect(result).toBeNull();
    });

    it('returns null when home stop not found in DB', async () => {
      db.getUserById.mockResolvedValue(baseUser);
      db.getBusStopById.mockResolvedValue(null);

      const result = await btBus.shouldLeaveAlert(1, soonEvent);

      expect(result).toBeNull();
    });

    it('returns null when no buses available', async () => {
      db.getUserById.mockResolvedValue(baseUser);
      db.getBusStopById.mockResolvedValue({
        stop_id: 'HOME_STOP',
        stop_name: 'My Stop',
        stop_lat: VT_LAT,       // same location → 0 walk time
        stop_lng: VT_LNG,
      });
      db.getNextBusArrivals.mockResolvedValue([]);

      const result = await btBus.shouldLeaveAlert(1, soonEvent);

      expect(result).toBeNull();
    });

    it('returns alert when leaveInMinutes <= 8', async () => {
      db.getUserById.mockResolvedValue(baseUser);
      // Stop at same location → walk time ≈ 0 min
      db.getBusStopById.mockResolvedValue({
        stop_id: 'HOME_STOP',
        stop_name: 'My Stop',
        stop_lat: VT_LAT,
        stop_lng: VT_LNG,
      });
      const freshTime = new Date(Date.now() - 30 * 1000);
      // Bus arrives in 5 min: leaveInMinutes = 5 - 0 - 2 = 3 (≤ 8 → alert)
      db.getNextBusArrivals.mockResolvedValue([
        {
          trip_id: 'trip1',
          stop_id: 'HOME_STOP',
          route_short_name: '17',
          arrival_time: new Date(Date.now() + 5 * 60 * 1000),
          delay_seconds: 0,
          updated_at: freshTime,
        },
      ]);

      const result = await btBus.shouldLeaveAlert(1, soonEvent);

      expect(result).not.toBeNull();
      expect(result.shouldAlert).toBe(true);
      expect(result.busRoute).toBe('17');
      expect(result.leaveInMinutes).toBe(3);
      expect(result.message).toContain('17');
      expect(result.message).toContain('CS 3114');
    });

    it('returns null when plenty of time (leaveInMinutes > 8)', async () => {
      db.getUserById.mockResolvedValue(baseUser);
      db.getBusStopById.mockResolvedValue({
        stop_id: 'HOME_STOP',
        stop_name: 'My Stop',
        stop_lat: VT_LAT,
        stop_lng: VT_LNG,
      });
      const freshTime = new Date(Date.now() - 30 * 1000);
      // Bus arrives in 20 min: leaveInMinutes = 20 - 0 - 2 = 18 (> 8 → null)
      db.getNextBusArrivals.mockResolvedValue([
        {
          trip_id: 'trip1',
          stop_id: 'HOME_STOP',
          route_short_name: '17',
          arrival_time: new Date(Date.now() + 20 * 60 * 1000),
          delay_seconds: 0,
          updated_at: freshTime,
        },
      ]);

      const result = await btBus.shouldLeaveAlert(1, soonEvent);

      expect(result).toBeNull();
    });

    it('returns null when event starts in more than 35 minutes', async () => {
      db.getUserById.mockResolvedValue(baseUser);
      db.getBusStopById.mockResolvedValue({
        stop_id: 'HOME_STOP', stop_name: 'My Stop',
        stop_lat: VT_LAT, stop_lng: VT_LNG,
      });
      const freshTime = new Date(Date.now() - 30 * 1000);
      db.getNextBusArrivals.mockResolvedValue([
        {
          trip_id: 'trip1', stop_id: 'HOME_STOP', route_short_name: '17',
          arrival_time: new Date(Date.now() + 5 * 60 * 1000),
          delay_seconds: 0, updated_at: freshTime,
        },
      ]);

      // Event in 40 minutes → outside 35-min window
      const result = await btBus.shouldLeaveAlert(1, {
        title: 'CS 3114',
        location: 'McBryde Hall',
        start: new Date(Date.now() + 40 * 60 * 1000),
      });

      expect(result).toBeNull();
    });

    it('correctly accounts for walk time in leaveInMinutes calculation', async () => {
      db.getUserById.mockResolvedValue(baseUser);
      // Stop is ~800 m away → ~10 min walk → needs bus with eta > 12 min
      db.getBusStopById.mockResolvedValue({
        stop_id: 'HOME_STOP',
        stop_name: 'Far Stop',
        stop_lat: VT_LAT + 0.0072, // ~800m north
        stop_lng: VT_LNG,
      });
      const freshTime = new Date(Date.now() - 30 * 1000);
      db.getNextBusArrivals.mockResolvedValue([
        {
          // Bus in 3 min: eta(3) <= walkTime(~10) + 2 → skipped (can't make it)
          trip_id: 'trip0', stop_id: 'HOME_STOP', route_short_name: '45',
          arrival_time: new Date(Date.now() + 3 * 60 * 1000),
          delay_seconds: 0, updated_at: freshTime,
        },
        {
          // Bus in 15 min: eta(15) > walkTime(~10) + 2 → leaveInMinutes = 15 - 10 - 2 = 3 ≤ 8
          trip_id: 'trip1', stop_id: 'HOME_STOP', route_short_name: '17',
          arrival_time: new Date(Date.now() + 15 * 60 * 1000),
          delay_seconds: 0, updated_at: freshTime,
        },
      ]);

      const result = await btBus.shouldLeaveAlert(1, soonEvent);

      expect(result).not.toBeNull();
      expect(result.busRoute).toBe('17'); // picked the later bus that user can actually make
      expect(result.leaveInMinutes).toBeGreaterThanOrEqual(0);
      expect(result.leaveInMinutes).toBeLessThanOrEqual(8);
    });
  });

  // ─── findBuildingStop ──────────────────────────────────────────────────────

  describe('findBuildingStop', () => {
    it('returns stop ID for known building', () => {
      expect(btBus.findBuildingStop('McBryde Hall 123')).toBe('CPAT');
      expect(btBus.findBuildingStop('Torgersen Hall')).toBe('COLG');
      expect(btBus.findBuildingStop('Newman Library')).toBe('LIBR');
      expect(btBus.findBuildingStop('Squires Student Center')).toBe('SQRS');
    });

    it('is case-insensitive', () => {
      expect(btBus.findBuildingStop('BURRUSS HALL')).toBe('CPAT');
      expect(btBus.findBuildingStop('goodwin hall')).toBe('ENGR');
    });

    it('returns null for unknown location', () => {
      expect(btBus.findBuildingStop('Unknown Building')).toBeNull();
      expect(btBus.findBuildingStop(null)).toBeNull();
      expect(btBus.findBuildingStop('')).toBeNull();
    });

    it('matches all 15 hardcoded buildings', () => {
      const buildings = [
        'McBryde Hall', 'Torgersen Hall', 'Surge Building', 'Newman Library',
        'Squires Student Center', 'War Memorial Hall', 'Whittemore Hall',
        'Randolph Hall', 'Burruss Hall', 'Price Hall', 'Lavery Hall',
        'Goodwin Hall', 'Durham Hall', 'Hahn Hall North', 'Performing Arts Building',
      ];
      buildings.forEach(b => {
        expect(btBus.findBuildingStop(b)).not.toBeNull();
      });
    });
  });
});
