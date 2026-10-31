// Daily vehicle-position archive: one gzipped NDJSON file per (kind, Chicago
// service day), kept on the server and published to the public data bucket.
// The live observations table only holds a short hot window; see
// docs/POSITIONS.md.

const DAY_MS = 24 * 60 * 60 * 1000;

const START_DATE = '2026-09-28';
const HOT_WINDOW_DAYS = 14;
const KINDS = ['bus', 'train', 'metra'];

// Published field lists per kind. `ts` is when we polled the feed (epoch ms);
// `vehicle_ts` is the feed's own timestamp for the position, when it has one.
const SCHEMA = {
  bus: {
    ts: 'Poll time, epoch ms',
    route: 'CTA bus route (e.g. "66")',
    pid: 'CTA pattern id (route variant + direction)',
    vehicle_id: 'Bus number',
    destination: 'Headsign destination',
    lat: 'Latitude',
    lon: 'Longitude',
    pdist: 'Feet travelled along the pattern',
    heading: 'Heading in degrees',
    vehicle_ts: 'Bus Tracker position timestamp, epoch ms',
    sched_start_sec: 'Scheduled trip start, seconds after midnight',
    sched_start_date: 'Scheduled trip service date (YYYYMMDD)',
  },
  train: {
    ts: 'Poll time, epoch ms',
    route: 'CTA rail line (red, blue, brn, g, org, p, pink, y)',
    direction: 'Train Tracker direction code (1 or 5)',
    vehicle_id: 'Run number',
    destination: 'Destination station',
    lat: 'Latitude',
    lon: 'Longitude',
    approx:
      '1 when the feed gave no usable lat/lon and the position was filled in from the next station',
    next_station: 'Next station name',
  },
  metra: {
    ts: 'Poll time, epoch ms',
    route: 'Metra line id (e.g. "BNSF")',
    vehicle_id: 'Train label, falling back to vehicle or trip id',
    lat: 'Latitude',
    lon: 'Longitude',
    heading: 'Bearing in degrees',
    vehicle_ts: 'GTFS-rt position timestamp, epoch ms',
    trip_id: 'GTFS trip_id, joins to the Metra static schedule',
  },
};

function toRecord(row) {
  const out = {};
  for (const field of Object.keys(SCHEMA[row.kind])) {
    out[field] = field === 'pid' ? row.direction : row[field];
  }
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

function buildIndex(manifest, generatedAt = Date.now()) {
  const days = Object.keys(manifest)
    .filter((date) => manifest[date].uploaded)
    .sort()
    .map((date) => ({ date, files: manifest[date].files }));
  return {
    generated_at: new Date(generatedAt).toISOString(),
    timezone: 'America/Chicago',
    format: 'gzipped NDJSON, one JSON object per line, ordered by ts',
    schema: SCHEMA,
    days,
  };
}

module.exports = {
  DAY_MS,
  START_DATE,
  HOT_WINDOW_DAYS,
  KINDS,
  SCHEMA,
  toRecord,
  addDays,
  chicagoDate,
  chicagoMidnight,
  dayBounds,
  completedDays,
  filePath,
  rolloffCutoff,
  buildIndex,
};
