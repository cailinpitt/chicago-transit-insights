const assert = require('node:assert/strict');
const test = require('node:test');
const { buildCsvFromPayload, CSV_COLUMNS } = require('../bin/export-csv.js');

test('export-csv emits v2 official alert and detection rows', () => {
  const start = Date.UTC(2026, 5, 11, 15, 0);
  const end = Date.UTC(2026, 5, 11, 15, 30);
  const csv = buildCsvFromPayload({
    incidents: [
      {
        id: 'abc',
        agency: 'metra',
        mode: 'commuter_rail',
        routes: ['me'],
        status: { type: 'delay' },
        official_alert: {
          id: 'metra-130',
          headline: 'Original headline',
          description: 'Train #130 delayed',
          lifecycle: {
            first_seen_ts: start,
            resolved_ts: end,
            active: false,
            duration_ms: end - start,
          },
          scope: {
            from_station: 'University Park',
            to_station: 'Millennium Station',
            stations: ['University Park', 'Millennium Station'],
            direction: 'inbound',
          },
          post_url: 'https://bsky.app/profile/example/post/abc',
        },
        detections: [
          {
            id: 42,
            source: 'delay',
            scope: { route: 'me', from_station: 'Homewood', to_station: 'Millennium Station' },
            lifecycle: {
              first_seen_ts: start + 60_000,
              resolved_ts: end,
              active: false,
              duration_ms: end - start - 60_000,
            },
            description: '~20 min late',
            post_url: 'https://example.com/obs',
          },
        ],
      },
    ],
  });

  const lines = csv.trim().split('\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  assert.equal(lines.length, 3);
  assert.match(csv, /official_alert,abc,metra,commuter_rail,me,official,delay,Original headline/);
  assert.match(csv, /detection,abc,metra,commuter_rail,me,delay,delay,,~20 min late/);
});
