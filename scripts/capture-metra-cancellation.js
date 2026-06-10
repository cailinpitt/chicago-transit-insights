#!/usr/bin/env node
// Diagnostic: pull the live Metra feeds and look for CANCELED trips, to confirm
// the real wire encoding of trip.schedule_relationship=CANCELED (the Phase 0
// open item — the decode path is unit-proven with a synthetic entity, but we
// hadn't yet seen a real one on the wire). Read-only: no DB writes, no posting.
//
// When it finds cancellations it writes a fixture under test/metra/fixtures/
// containing the raw decoded entities (so a regression test can replay them
// through parseTripUpdate and assert 'CANCELED' against actual wire data).
//
// Usage: node scripts/capture-metra-cancellation.js [--write]

require('../src/shared/env');

const Fs = require('node:fs');
const Path = require('node:path');
const axios = require('axios');
const GtfsRt = require('gtfs-realtime-bindings');
const { parseTripUpdate, parseAlert, BASE } = require('../src/metra/api');
const { withRetry } = require('../src/shared/retry');

const { transit_realtime } = GtfsRt;
const FeedMessage = transit_realtime.FeedMessage;
const CANCELED = transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED; // enum int

async function fetchRaw(path) {
  const { data } = await withRetry(
    () =>
      axios.get(`${BASE}/${path}`, {
        params: { api_token: process.env.METRA_API_KEY },
        responseType: 'arraybuffer',
        timeout: 15000,
      }),
    { label: `Metra ${path}`, retries: 5 },
  );
  return { buf: Buffer.from(data), feed: FeedMessage.decode(new Uint8Array(data)) };
}

async function main() {
  if (!process.env.METRA_API_KEY) throw new Error('METRA_API_KEY not set');
  const write = process.argv.includes('--write');

  const tu = await fetchRaw('tripupdates');
  const pos = await fetchRaw('positions');
  const al = await fetchRaw('alerts');

  const tuEntities = tu.feed.entity || [];
  const posEntities = pos.feed.entity || [];

  // Trip-level CANCELED in tripUpdates — the authoritative cancellation signal.
  const canceledTU = tuEntities.filter(
    (e) => e.tripUpdate?.trip?.scheduleRelationship === CANCELED,
  );
  const canceledPos = posEntities.filter((e) => e.vehicle?.trip?.scheduleRelationship === CANCELED);

  console.log(
    `Feeds: ${tuEntities.length} tripUpdates, ${posEntities.length} positions, ${(al.feed.entity || []).length} alerts`,
  );
  console.log(
    `CANCELED (enum=${CANCELED}): ${canceledTU.length} in tripUpdates, ${canceledPos.length} in positions`,
  );

  for (const e of canceledTU.slice(0, 12)) {
    const n = parseTripUpdate(e);
    const stopRels = [...new Set((n.stopUpdates || []).map((s) => s.scheduleRelationship))];
    console.log(
      `  [TU] ${n.routeId} ${n.tripId} rel=${n.scheduleRelationship} stops=${n.stopUpdates.length} stopRels=${stopRels.join(',') || '—'}`,
    );
  }

  // Cancellation-shaped alerts (for cross-checking the inferred-vs-alert path).
  const cancelAlerts = (al.feed.entity || [])
    .map(parseAlert)
    .filter((a) => /cancel|annul/i.test(`${a.header} ${a.description}`));
  if (cancelAlerts.length) {
    console.log(`Cancellation-wording alerts: ${cancelAlerts.length}`);
    for (const a of cancelAlerts.slice(0, 6)) {
      console.log(
        `  [ALERT] effect=${a.effect} routes=${a.informedEntities.map((e) => e.routeId).join(',')} :: ${a.header}`,
      );
    }
  }

  if (canceledTU.length === 0 && canceledPos.length === 0) {
    console.log('\nNo CANCELED trips on the wire right now — re-run during the disruption.');
    return;
  }

  if (!write) {
    console.log('\n(Found cancellations — re-run with --write to save the fixture.)');
    return;
  }

  // Save the authoritative wire bytes: a trimmed FeedMessage (original header +
  // only the CANCELED entities), protobuf-encoded and base64'd. A regression test
  // decodes this with FeedMessage.decode and replays through parseTripUpdate —
  // exercising the FULL real decode path (the integer enum 3 → 'CANCELED'),
  // immune to JSON enum-name conversion. A decoded preview (enums as ints, so it
  // mirrors the wire) rides alongside for human readability.
  const dir = Path.join(__dirname, '..', 'test', 'metra', 'fixtures');
  Fs.mkdirSync(dir, { recursive: true });
  const trim = (feed, entities) =>
    Buffer.from(
      FeedMessage.encode(FeedMessage.create({ header: feed.header, entity: entities })).finish(),
    ).toString('base64');
  const FeedEntity = transit_realtime.FeedEntity;
  const preview = (entities) =>
    entities.map((e) => FeedEntity.toObject(e, { enums: Number, longs: String, defaults: false }));
  const out = {
    capturedAt: new Date().toISOString(),
    note: 'Live Metra CANCELED trips captured during a real disruption. tripUpdatesB64/positionsB64 are base64 protobuf FeedMessages — decode with GtfsRealtimeBindings FeedMessage.decode, then parseTripUpdate/parsePosition. canceledEnumValue is the wire int for schedule_relationship=CANCELED.',
    canceledEnumValue: CANCELED,
    tripUpdatesB64: trim(tu.feed, canceledTU),
    positionsB64: canceledPos.length ? trim(pos.feed, canceledPos) : null,
    preview: { tripUpdates: preview(canceledTU), positions: preview(canceledPos) },
  };
  const file = Path.join(dir, 'canceled-tripupdates.json');
  Fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    `\nWrote ${canceledTU.length} tripUpdate + ${canceledPos.length} position fixtures → ${Path.relative(process.cwd(), file)}`,
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
