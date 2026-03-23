'use strict';

const unzipper = require('unzipper');
const csv = require('csv-parser');
const db = require('../db');

// ─── Haversine distance ───────────────────────────────────────────────────────

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in meters
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── CSV parsing ──────────────────────────────────────────────────────────────

async function parseCSVFile(zipDirectory, filename) {
  const file = zipDirectory.files.find(f => f.path === filename);
  if (!file) {
    console.warn(`GTFS zip missing ${filename}`);
    return [];
  }
  return new Promise((resolve, reject) => {
    const rows = [];
    file.stream()
      .pipe(csv())
      .on('data', row => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

// ─── GTFS static download ─────────────────────────────────────────────────────

async function downloadAndParseGTFS() {
  const url = process.env.BT_GTFS_URL;
  if (!url) {
    console.warn('BT_GTFS_URL not set, skipping GTFS download');
    return;
  }

  try {
    console.log('Downloading BT GTFS static data...');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const zipDir = await unzipper.Open.buffer(buffer);

    const [stopsRows, routesRows] = await Promise.all([
      parseCSVFile(zipDir, 'stops.txt'),
      parseCSVFile(zipDir, 'routes.txt'),
    ]);

    for (const stop of stopsRows) {
      if (!stop.stop_id) continue;
      await db.upsertBusStop(
        stop.stop_id,
        stop.stop_name || '',
        parseFloat(stop.stop_lat) || 0,
        parseFloat(stop.stop_lng) || 0
      );
    }

    for (const route of routesRows) {
      if (!route.route_id) continue;
      await db.upsertBusRoute(
        route.route_id,
        route.route_short_name || '',
        route.route_long_name || ''
      );
    }

    console.log(`GTFS import complete: ${stopsRows.length} stops, ${routesRows.length} routes`);
  } catch (err) {
    console.error('downloadAndParseGTFS error:', err.message || err);
  }
}

// ─── Nearest stops ────────────────────────────────────────────────────────────

async function getNearestStops(lat, lng, limit = 3) {
  const stops = await db.getAllBusStops();

  return stops
    .map(stop => ({
      stopId: stop.stop_id,
      stopName: stop.stop_name,
      distanceMeters: haversineMeters(
        lat, lng,
        parseFloat(stop.stop_lat),
        parseFloat(stop.stop_lng)
      ),
    }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, limit);
}

module.exports = { downloadAndParseGTFS, getNearestStops, haversineMeters };
