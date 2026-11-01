// Daily vehicle-position archive: one gzipped NDJSON file per (kind, Chicago
// service day), kept on the server and published to the public data bucket.
// The live observations table only holds a short hot window; see
// docs/POSITIONS.md.

const DAY_MS = 24 * 60 * 60 * 1000;

const START_DATE = '2026-09-28';
const HOT_WINDOW_DAYS = 14;
const KINDS = ['bus', 'train', 'metra'];

const BASE_URL = 'https://data.chicagotransitalerts.app/';

const f = (type, description, extra = {}) => ({
  type,
  ...(extra.unit && { unit: extra.unit }),
  nullable: !!extra.nullable,
  description,
  ...(extra.since && { since: extra.since }),
});

const POLL_TS = f('integer', 'Poll time', { unit: 'epoch ms' });

// Published fields per kind, in file order. `ts` is when we polled the feed;
// `vehicle_ts` is the feed's own timestamp for the position, when it has one.
const SCHEMA = {
  bus: {
    description: 'CTA Bus Tracker vehicle positions',
    fields: {
      ts: POLL_TS,
      route: f('string', 'CTA bus route (e.g. "66")'),
      pid: f('string', 'CTA pattern id (route variant + direction)', { nullable: true }),
      vehicle_id: f('string', 'Bus number'),
      destination: f('string', 'Headsign destination', { nullable: true }),
      lat: f('number', 'Latitude', { unit: 'degrees', nullable: true }),
      lon: f('number', 'Longitude', { unit: 'degrees', nullable: true }),
      pdist: f('number', 'Distance travelled along the pattern', { unit: 'feet', nullable: true }),
      heading: f('integer', 'Heading', { unit: 'degrees', nullable: true }),
      vehicle_ts: f('integer', 'Bus Tracker position timestamp', {
        unit: 'epoch ms',
        nullable: true,
      }),
      sched_start_sec: f('integer', 'Scheduled trip start, after midnight', {
        unit: 'seconds',
        nullable: true,
      }),
      sched_start_date: f('string', 'Scheduled trip service date (YYYYMMDD)', { nullable: true }),
    },
  },
  train: {
    description: 'CTA Train Tracker train positions',
    fields: {
      ts: POLL_TS,
      route: f('string', 'CTA rail line (red, blue, brn, g, org, p, pink, y)'),
      direction: f('string', 'Train Tracker direction code (1 or 5)', { nullable: true }),
      vehicle_id: f('string', 'Run number'),
      destination: f('string', 'Destination station', { nullable: true }),
      lat: f('number', 'Latitude', { unit: 'degrees', nullable: true }),
      lon: f('number', 'Longitude', { unit: 'degrees', nullable: true }),
      approx: f(
        'integer',
        '1 when the feed gave no usable lat/lon and the position was filled in from the next station',
      ),
      next_station: f('string', 'Next station name', { nullable: true }),
      heading: f('integer', 'Heading', { unit: 'degrees', nullable: true, since: '2026-11-01' }),
      vehicle_ts: f('integer', 'Train Tracker prediction-generated time (prdt)', {
        unit: 'epoch ms',
        nullable: true,
        since: '2026-11-01',
      }),
      approaching: f(
        'integer',
        '1 when Train Tracker flags the train as approaching its next station',
        { nullable: true, since: '2026-11-01' },
      ),
    },
  },
  metra: {
    description: 'Metra GTFS-realtime vehicle positions',
    fields: {
      ts: POLL_TS,
      route: f('string', 'Metra line id (e.g. "BNSF")'),
      vehicle_id: f('string', 'Train label, falling back to vehicle or trip id'),
      lat: f('number', 'Latitude', { unit: 'degrees', nullable: true }),
      lon: f('number', 'Longitude', { unit: 'degrees', nullable: true }),
      heading: f('integer', 'Bearing', { unit: 'degrees', nullable: true }),
      vehicle_ts: f('integer', 'GTFS-rt position timestamp', { unit: 'epoch ms', nullable: true }),
      trip_id: f('string', 'GTFS trip_id, joins to the Metra static schedule', { nullable: true }),
    },
  },
};

// docs/POSITIONS.md mirrors this list (a test keeps them in sync).
const BUS_LIMIT_NOTE = 'CTA Bus Tracker daily request limit hit; data unrecoverable';
const KNOWN_GAPS = [
  ['2026-10-12T18:03-05:00', '2026-10-13T00:00-05:00', ['bus'], BUS_LIMIT_NOTE],
  ['2026-10-13T14:30-05:00', '2026-10-14T00:00-05:00', ['bus'], BUS_LIMIT_NOTE],
  ['2026-10-14T13:34-05:00', '2026-10-15T00:00-05:00', ['bus'], BUS_LIMIT_NOTE],
  ['2026-10-15T13:13-05:00', '2026-10-16T00:00-05:00', ['bus'], BUS_LIMIT_NOTE],
  ['2026-10-16T13:19-05:00', '2026-10-17T00:00-05:00', ['bus'], BUS_LIMIT_NOTE],
  ['2026-10-17T15:51-05:00', '2026-10-18T00:00-05:00', ['bus'], BUS_LIMIT_NOTE],
  ['2026-10-22T15:37-05:00', '2026-10-22T15:48-05:00', KINDS, 'No polls recorded'],
  ['2026-10-30T17:40-05:00', '2026-10-30T18:07-05:00', KINDS, 'No polls recorded'],
].map(([start, end, feeds, note]) => ({ start, end, feeds, note }));

// Metra vehicle_ts was stored in epoch seconds until 2026-11-01. Any value
// below this is seconds (as ms it would be 1973).
const MAX_SECONDS_TS = 1e11;

function metraVehicleTsMs(v) {
  return Number.isFinite(v) && v < MAX_SECONDS_TS ? v * 1000 : v;
}

function toRecord(row) {
  const out = {};
  for (const field of Object.keys(SCHEMA[row.kind].fields)) {
    out[field] = field === 'pid' ? row.direction : row[field];
  }
  if (row.kind === 'metra' && 'vehicle_ts' in out)
    out.vehicle_ts = metraVehicleTsMs(out.vehicle_ts);
  return out;
}

function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function chicagoDate(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

// Chicago midnight for a YYYY-MM-DD date, as epoch ms. DST flips at 2am, so
// midnight is always unambiguous; probe both offsets and keep the one that
// lands on 00:00 local.
function chicagoMidnight(date) {
  const [y, m, d] = date.split('-').map(Number);
  for (const offsetHours of [5, 6]) {
    const candidate = Date.UTC(y, m - 1, d, offsetHours);
    const hour = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(candidate));
    if (chicagoDate(candidate) === date && hour === '00') return candidate;
  }
  throw new Error(`No Chicago midnight for ${date}`);
}

function dayBounds(date) {
  return { start: chicagoMidnight(date), end: chicagoMidnight(addDays(date, 1)) };
}

// Every finished day from START_DATE through yesterday (Chicago time).
function completedDays(now = Date.now(), startDate = START_DATE) {
  const today = chicagoDate(now);
  const days = [];
  for (let d = startDate; d < today; d = addDays(d, 1)) days.push(d);
  return days;
}

function filePath(kind, date) {
  return `${kind}/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.ndjson.gz`;
}

// Rows older than the hot window may be deleted, but never past the first day
// that hasn't been archived and uploaded yet.
function rolloffCutoff(manifest, now = Date.now(), startDate = START_DATE) {
  const today = chicagoDate(now);
  let cutoff = chicagoMidnight(addDays(today, -HOT_WINDOW_DAYS));
  for (const date of completedDays(now, startDate)) {
    const { start } = dayBounds(date);
    if (start >= cutoff) break;
    if (!manifest[date]?.uploaded) {
      cutoff = start;
      break;
    }
  }
  return cutoff;
}

function weekday(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  });
}

// Accepts both the current index and the pre-2026-11 one ({ schema, days }
// oldest first); either way only `date` and `files` are carried over.
function indexDays(previous) {
  const out = {};
  for (const day of previous?.days || []) {
    if (day?.date && day.files) out[day.date] = day.files;
  }
  return out;
}

// Days come from the manifest, plus any listed in the previous index that the
// manifest lacks, so a rebuild never drops a published day.
function buildIndex(manifest, generatedAt = Date.now(), previous = null) {
  const byDate = indexDays(previous);
  for (const [date, entry] of Object.entries(manifest)) {
    if (entry.uploaded) byDate[date] = entry.files;
  }
  const dates = Object.keys(byDate).sort().reverse();
  const days = dates.map((date) => {
    const files = byDate[date];
    const rows = {};
    for (const kind of Object.keys(files)) rows[kind] = files[kind].rows;
    return { date, weekday: weekday(date), rows, files };
  });
  return {
    title: 'CTA vehicle positions archive',
    generated_at: new Date(generatedAt).toISOString(),
    timezone: 'America/Chicago',
    days_are: 'Local calendar days in `timezone`, midnight to midnight',
    format: 'gzipped NDJSON, one JSON object per line, ordered by ts',
    base_url: BASE_URL,
    coverage: { first: dates.at(-1) ?? null, latest: dates[0] ?? null, days: dates.length },
    feeds: SCHEMA,
    known_gaps: KNOWN_GAPS,
    days,
  };
}

module.exports = {
  DAY_MS,
  START_DATE,
  HOT_WINDOW_DAYS,
  KINDS,
  SCHEMA,
  BASE_URL,
  KNOWN_GAPS,
  MAX_SECONDS_TS,
  metraVehicleTsMs,
  toRecord,
  addDays,
  chicagoDate,
  chicagoMidnight,
  dayBounds,
  completedDays,
  filePath,
  rolloffCutoff,
  indexDays,
  buildIndex,
};
