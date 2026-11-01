const test = require('node:test');
const assert = require('node:assert');

const { chicagoWallTime } = require('../../src/shared/chicagoTime');
const { parseBusTime } = require('../../src/bus/api');

test('chicagoWallTime handles CDT and CST', () => {
  assert.strictEqual(
    chicagoWallTime(2026, 10, 31, 23, 1, 8).toISOString(),
    '2026-11-01T04:01:08.000Z',
  );
  assert.strictEqual(
    chicagoWallTime(2026, 11, 2, 9, 0, 0).toISOString(),
    '2026-11-02T15:00:00.000Z',
  );
});

test('chicagoWallTime handles midnight', () => {
  assert.strictEqual(
    chicagoWallTime(2026, 10, 30, 0, 0, 5).toISOString(),
    '2026-10-30T05:00:05.000Z',
  );
});

test('parseBusTime still parses Bus Tracker timestamps', () => {
  assert.strictEqual(parseBusTime('20260415 15:52:13').toISOString(), '2026-04-15T20:52:13.000Z');
});
