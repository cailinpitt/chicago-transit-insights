const test = require('node:test');
const assert = require('node:assert');
const {
  isStationOnSegment,
  stationsOnSegment,
  normalizeStationName,
} = require('../../src/shared/trainSegment');

test('normalizeStationName strips parentheticals + collapses whitespace', () => {
  assert.equal(normalizeStationName('Halsted (Orange)'), 'halsted');
  assert.equal(normalizeStationName('  UIC-Halsted  '), 'uic-halsted');
  assert.equal(normalizeStationName('Western (Blue - Forest Park Branch)'), 'western');
});

test('Wilson is between Belmont and Howard on red NB', () => {
  assert.equal(
    isStationOnSegment({
      line: 'red',
      direction: 'north',
      station: 'Wilson',
      fromStation: 'Belmont',
      toStation: 'Howard',
    }),
    true,
  );
});

test('Addison is between Belmont and Howard on red (no direction)', () => {
  assert.equal(
    isStationOnSegment({
      line: 'red',
      station: 'Addison',
      fromStation: 'Belmont',
      toStation: 'Howard',
    }),
    true,
  );
});

test('95th/Dan Ryan is NOT between Belmont and Howard on red', () => {
  assert.equal(
    isStationOnSegment({
      line: 'red',
      direction: 'north',
      station: '95th/Dan Ryan',
      fromStation: 'Belmont',
      toStation: 'Howard',
    }),
    false,
  );
});

test('round-trip line: out-of-segment station fails', () => {
  // Brown round-trips. Belmont is 25k+ ft past the Kimball→Western segment
  // (which ends at ~7300 ft); even with the per-stop buffer it's well outside.
  assert.equal(
    isStationOnSegment({
      line: 'brn',
      direction: 'out',
      station: 'Belmont',
      fromStation: 'Kimball',
      toStation: 'Western (Brown)',
    }),
    false,
  );
});

test('round-trip line: in-segment station succeeds with matching direction', () => {
  // Brown line: Western is between Kimball and Belmont in outbound direction.
  assert.equal(
    isStationOnSegment({
      line: 'brn',
      direction: 'out',
      station: 'Western (Brown)',
      fromStation: 'Kimball',
      toStation: 'Belmont',
    }),
    true,
  );
});

test('unknown station name returns false (fail closed)', () => {
  assert.equal(
    isStationOnSegment({
      line: 'red',
      station: 'Nonexistent Station',
      fromStation: 'Belmont',
      toStation: 'Howard',
    }),
    false,
  );
});

test('missing args return false', () => {
  assert.equal(isStationOnSegment({ line: 'red', station: 'Wilson' }), false);
  assert.equal(isStationOnSegment({}), false);
});

test('parenthetical line tag in name still resolves', () => {
  assert.equal(
    isStationOnSegment({
      line: 'red',
      station: 'Wilson',
      fromStation: 'Belmont (Red)',
      toStation: 'Howard',
    }),
    true,
  );
});

test('stationsOnSegment fills inner stops between the endpoints (brn)', () => {
  const stops = stationsOnSegment({
    line: 'brn',
    fromStation: 'Rockwell',
    toStation: 'Montrose',
  });
  // Endpoints included, inner Western/Damen filled, ordered from → to.
  assert.deepEqual(stops, ['Rockwell', 'Western (Brown)', 'Damen (Brown)', 'Montrose (Brown)']);
});

test('stationsOnSegment is order-independent in endpoint args', () => {
  const fwd = stationsOnSegment({ line: 'brn', fromStation: 'Rockwell', toStation: 'Montrose' });
  const rev = stationsOnSegment({ line: 'brn', fromStation: 'Montrose', toStation: 'Rockwell' });
  assert.deepEqual([...fwd].sort(), [...rev].sort());
});

test('stationsOnSegment does not bleed past the endpoints', () => {
  const stops = stationsOnSegment({ line: 'brn', fromStation: 'Rockwell', toStation: 'Montrose' });
  // Kedzie (one stop outside Rockwell) and Irving Park (one stop outside
  // Montrose) must not be pulled in.
  assert.ok(!stops.some((s) => s.startsWith('Kedzie')));
  assert.ok(!stops.some((s) => s.startsWith('Irving Park')));
});

test('stationsOnSegment picks the right branch on a multi-branch line (blue)', () => {
  const stops = stationsOnSegment({
    line: 'blue',
    fromStation: 'Clark/Lake',
    toStation: 'Damen',
  });
  // Damen (Blue) is on the O'Hare branch; the Forest Park branch must not be
  // chosen (no Forest Park-branch stops, and Damen resolves to the Blue stop).
  assert.ok(stops.includes('Clark/Lake'));
  assert.ok(stops.includes('Damen (Blue)'));
  assert.ok(!stops.some((s) => s.startsWith('Forest Park')));
});

test('stationsOnSegment fails closed on unresolved endpoint', () => {
  assert.deepEqual(
    stationsOnSegment({ line: 'brn', fromStation: 'Nowhere', toStation: 'Montrose' }),
    [],
  );
  assert.deepEqual(stationsOnSegment({ line: 'brn', fromStation: 'Rockwell' }), []);
});
