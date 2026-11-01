const axios = require('axios');
const GtfsRt = require('gtfs-realtime-bindings');
const { withRetry } = require('../shared/retry');
const { recordMetraObservations, recordMetraTripUpdates } = require('../shared/observations');

// Metra GTFS-realtime feeds. Protocol Buffers (GTFS-rt v2.0), refreshed ~30s,
// authenticated with an `api_token` query param. The old JSON API at
// gtfsapi.metrarail.com was retired 2025-11-01 — this is the current host.
const BASE = 'https://gtfspublic.metrarr.com/gtfs/public';

const { transit_realtime } = GtfsRt;
const FeedMessage = transit_realtime.FeedMessage;

// protobufjs decodes 64-bit fields as Long objects; everything downstream wants
// plain numbers (epoch seconds). Null-safe.
function longToNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v.toNumber === 'function') return v.toNumber();
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function secondsToMs(sec) {
  return sec == null ? null : sec * 1000;
}

// Reverse an enum-values object ({SCHEDULED:0,…}) into name lookups so we store
// readable strings ('CANCELED') instead of opaque ints. Built once.
function reverseEnum(enumObj) {
  const out = {};
  for (const [name, val] of Object.entries(enumObj)) out[val] = name;
  return out;
}
const TRIP_REL = reverseEnum(transit_realtime.TripDescriptor.ScheduleRelationship);
const STOP_REL = reverseEnum(transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship);
const ALERT_CAUSE = reverseEnum(transit_realtime.Alert.Cause);
const ALERT_EFFECT = reverseEnum(transit_realtime.Alert.Effect);

const relName = (map, v) => (v == null ? null : (map[v] ?? String(v)));

// First-translation text from a GTFS-rt TranslatedString (Metra publishes 'en').
function translatedText(ts) {
  const t = ts?.translation?.[0];
  return t?.text ?? null;
}

async function fetchFeed(path) {
  if (!process.env.METRA_API_KEY) throw new Error('METRA_API_KEY is not set');
  const { data } = await withRetry(
    () =>
      axios.get(`${BASE}/${path}`, {
        params: { api_token: process.env.METRA_API_KEY },
        responseType: 'arraybuffer',
        timeout: 15000,
      }),
    { label: `Metra ${path}` },
  );
  return FeedMessage.decode(new Uint8Array(data));
}

// --- Normalizers (pure; one per feed entity type) ---

function parsePosition(entity) {
  const v = entity.vehicle;
  if (!v) return null;
  const trip = v.trip || {};
  const pos = v.position || {};
  return {
    tripId: trip.tripId ?? null,
    routeId: trip.routeId ?? null,
    startTime: trip.startTime ?? null,
    startDate: trip.startDate ?? null,
    scheduleRelationship: relName(TRIP_REL, trip.scheduleRelationship),
    label: v.vehicle?.label ?? null,
    vehicleId: v.vehicle?.id ?? null,
    lat: Number.isFinite(pos.latitude) ? pos.latitude : null,
    lon: Number.isFinite(pos.longitude) ? pos.longitude : null,
    bearing: Number.isFinite(pos.bearing) ? pos.bearing : null,
    // Epoch ms, like Bus Tracker; the feed sends seconds.
    ts: secondsToMs(longToNum(v.timestamp)),
  };
}

function parseTripUpdate(entity) {
  const tu = entity.tripUpdate;
  if (!tu) return null;
  const trip = tu.trip || {};
  return {
    tripId: trip.tripId ?? null,
    routeId: trip.routeId ?? null,
    startTime: trip.startTime ?? null,
    startDate: trip.startDate ?? null,
    scheduleRelationship: relName(TRIP_REL, trip.scheduleRelationship),
    label: tu.vehicle?.label ?? null,
    vehicleId: tu.vehicle?.id ?? null,
    timestamp: longToNum(tu.timestamp),
    stopUpdates: (tu.stopTimeUpdate || []).map((s) => ({
      stopSequence: Number.isFinite(s.stopSequence) ? s.stopSequence : null,
      stopId: s.stopId ?? null,
      scheduleRelationship: relName(STOP_REL, s.scheduleRelationship),
      arrivalTime: longToNum(s.arrival?.time),
      departureTime: longToNum(s.departure?.time),
      // Either side may carry the delay; arrival wins when both present.
      delay: s.arrival?.delay ?? s.departure?.delay ?? null,
    })),
  };
}

function parseAlert(entity) {
  const a = entity.alert;
  if (!a) return null;
  return {
    id: entity.id ?? null,
    informedEntities: (a.informedEntity || []).map((e) => ({
      agencyId: e.agencyId ?? null,
      routeId: e.routeId ?? null,
      stopId: e.stopId ?? null,
      tripId: e.trip?.tripId ?? null,
    })),
    cause: relName(ALERT_CAUSE, a.cause),
    effect: relName(ALERT_EFFECT, a.effect),
    url: translatedText(a.url),
    header: translatedText(a.headerText),
    description: translatedText(a.descriptionText),
    activePeriod: (a.activePeriod || []).map((p) => ({
      start: longToNum(p.start),
      end: longToNum(p.end),
    })),
  };
}

// --- Public fetchers (mirror src/train/api.js: record to the DB by default;
// pass {record:false} for diagnostic fetches that shouldn't write). ---

async function getMetraPositions({ record = true } = {}) {
  const feed = await fetchFeed('positions');
  const positions = (feed.entity || []).map(parsePosition).filter(Boolean);
  if (record) recordMetraObservations(positions);
  return positions;
}

async function getMetraTripUpdates({ record = true } = {}) {
  const feed = await fetchFeed('tripupdates');
  const updates = (feed.entity || []).map(parseTripUpdate).filter(Boolean);
  if (record) recordMetraTripUpdates(updates);
  return updates;
}

async function getMetraAlerts() {
  const feed = await fetchFeed('alerts');
  return (feed.entity || []).map(parseAlert).filter(Boolean);
}

module.exports = {
  BASE,
  getMetraPositions,
  getMetraTripUpdates,
  getMetraAlerts,
  // Exposed for unit tests so feeds can be decoded from a fixture buffer without
  // hitting the network.
  parsePosition,
  parseTripUpdate,
  parseAlert,
};
