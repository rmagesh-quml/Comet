'use strict';

const { transit_realtime } = require('gtfs-realtime-bindings');
const db = require('../db');
const { haversineMeters } = require('./bt_static');

// ─── VT building → nearest BT stop ID ────────────────────────────────────────
// Stop IDs are matched against the BT GTFS data loaded by bt_static.downloadAndParseGTFS().
// Verify/update these after your first GTFS import by checking bus_stops in the DB.

const VT_BUILDING_STOPS = {
  'mcbryde':        'CPAT',
  'torgersen':      'COLG',
  'surge':          'COLG',
  'newman':         'LIBR',
  'squires':        'SQRS',
  'war memorial':   'BICK',
  'whittemore':     'ENGR',
  'randolph':       'CPAT',
  'burruss':        'CPAT',
  'price':          'COLG',
  'lavery':         'ENGR',
  'goodwin':        'ENGR',
  'durham':         'ENGR',
  'hahn':           'COLG',
  'performing arts':'THEA',
  'perform':        'THEA',
};

function findBuildingStop(locationStr) {
  if (!locationStr) return null;
  const loc = locationStr.toLowerCase();
  for (const [keyword, stopId] of Object.entries(VT_BUILDING_STOPS)) {
    if (loc.includes(keyword)) return stopId;
  }
  return null;
}

// ─── Protobuf int64 → JS number ───────────────────────────────────────────────

function longToNumber(val) {
  if (val == null) return null;
  if (typeof val === 'number') return val;
  if (typeof val.toNumber === 'function') return val.toNumber();
  if (typeof val.low === 'number') return val.low + val.high * 4294967296;
  return Number(val);
}

// ─── Real-time feed ───────────────────────────────────────────────────────────

async function fetchAndStoreRealtimeData() {
  const url = process.env.BT_REALTIME_TRIP_UPDATES_URL;
  if (!url) return;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const feed = transit_realtime.FeedMessage.decode(buffer);

    // Build routeId → shortName lookup
    const routes = await db.getAllBusRoutes();
    const routeMap = new Map(routes.map(r => [r.route_id, r.route_short_name]));

    for (const entity of feed.entity || []) {
      const tu = entity.tripUpdate;
      if (!tu) continue;

      const tripId = tu.trip?.tripId || entity.id;
      const routeId = tu.trip?.routeId;
      const routeShortName = (routeId && routeMap.get(routeId)) || routeId || '';

      for (const stu of tu.stopTimeUpdate || []) {
        const stopId = stu.stopId;
        if (!stopId) continue;

        const rawTime = stu.arrival?.time ?? stu.departure?.time;
        const arrivalTimestamp = longToNumber(rawTime);
        if (!arrivalTimestamp) continue;

        const arrivalDate = new Date(arrivalTimestamp * 1000);
        const delaySeconds = longToNumber(stu.arrival?.delay ?? stu.departure?.delay) || 0;

        await db.upsertBusPrediction(tripId, stopId, routeShortName, arrivalDate, delaySeconds);
      }
    }
  } catch (err) {
    // Fail silently — BT feeds go down sometimes
    console.error('fetchAndStoreRealtimeData error:', err.message || err);
  }
}

// ─── Next buses at a stop ─────────────────────────────────────────────────────

async function getNextBuses(stopId, limit = 5) {
  const arrivals = await db.getNextBusArrivals(stopId);
  const now = Date.now();
  const twoMinsAgo = now - 2 * 60 * 1000;
  const sixtyMinsOut = now + 60 * 60 * 1000;

  return arrivals
    .filter(row => {
      const arrMs = new Date(row.arrival_time).getTime();
      const updMs = new Date(row.updated_at).getTime();
      return arrMs > now && arrMs <= sixtyMinsOut && updMs >= twoMinsAgo;
    })
    .slice(0, limit)
    .map(row => ({
      routeName: row.route_short_name,
      etaMinutes: Math.round((new Date(row.arrival_time).getTime() - now) / 60000),
      arrivalTime: row.arrival_time,
      delaySeconds: row.delay_seconds,
    }));
}

// ─── Should-leave alert ───────────────────────────────────────────────────────

async function shouldLeaveAlert(userId, event) {
  const user = await db.getUserById(userId);
  if (!user || !user.nearest_bus_stop_id) return null;
  if (user.campus_lat == null || user.campus_lng == null) return null;

  // Match event location to a known VT building stop
  const destinationStopId = findBuildingStop(event.location);
  if (!destinationStopId) return null;

  // Look up user's home stop coordinates for walk-time calculation
  const homeStop = await db.getBusStopById(user.nearest_bus_stop_id);
  if (!homeStop) return null;

  const distanceMeters = haversineMeters(
    parseFloat(user.campus_lat),
    parseFloat(user.campus_lng),
    parseFloat(homeStop.stop_lat),
    parseFloat(homeStop.stop_lng)
  );
  const walkTimeMins = distanceMeters / 80; // 80 m/min walking speed

  const buses = await getNextBuses(user.nearest_bus_stop_id);
  if (buses.length === 0) return null;

  const now = Date.now();
  const eventStart = new Date(event.start).getTime();
  const minsUntilEvent = (eventStart - now) / 60000;

  // Only alert if class starts within 35 minutes
  if (minsUntilEvent > 35) return null;

  // Best bus: ETA must give enough time to walk to stop + 2-min boarding buffer
  const bestBus = buses.find(b => b.etaMinutes > walkTimeMins + 2);
  if (!bestBus) return null;

  const leaveInMinutes = Math.round(bestBus.etaMinutes - walkTimeMins - 2);
  if (leaveInMinutes > 8) return null;

  const eventName = event.title || event.name || 'class';
  const leavePhrase = leaveInMinutes <= 0
    ? 'leave now'
    : `leave in ${leaveInMinutes} min${leaveInMinutes === 1 ? '' : 's'}`;

  return {
    shouldAlert: true,
    leaveInMinutes,
    busRoute: bestBus.routeName,
    message: `${leavePhrase} to catch ${bestBus.routeName} — gets you to ${eventName} with time to spare`,
  };
}

module.exports = {
  fetchAndStoreRealtimeData,
  getNextBuses,
  shouldLeaveAlert,
  findBuildingStop,
  longToNumber,
};
