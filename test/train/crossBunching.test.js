const test = require('node:test');
const assert = require('node:assert/strict');
const { detectCrossLineBunches, groupByLine } = require('../../src/train/crossBunching');

const FT_PER_MILLIDEG_LAT = 365;
const dLatForFt = (ft) => ft / FT_PER_MILLIDEG_LAT / 1000;
const at = (rn, line, ft) => ({ rn, line, lat: 41.88 + dLatForFt(ft), lon: -87.63 });

test('detects a multi-line pileup on the Loop (Brn + Org + Pink)', () => {
  const ts = [at('801', 'Brn', 0), at('802', 'Org', 300), at('803', 'Pink', 600)];
  const [bunch] = detectCrossLineBunches(ts);
  assert.equal(bunch.trains.length, 3);
  assert.deepEqual(bunch.lines, ['Brn', 'Org', 'Pink']);
  assert.equal(bunch.lineCount, 3);
});

test('ignores a single-line cluster (regular per-line bunching catches it)', () => {
  const ts = [at('801', 'Brn', 0), at('802', 'Brn', 300), at('803', 'Brn', 600)];
  assert.equal(detectCrossLineBunches(ts).length, 0);
});

test('ignores a multi-line cluster below the train minimum', () => {
  const ts = [at('801', 'Brn', 0), at('802', 'Org', 300)];
  assert.equal(detectCrossLineBunches(ts).length, 0);
});

test('congestion gate: drops a cluster with too few stopped trains', () => {
  const ts = [at('801', 'Brn', 0), at('802', 'Org', 300), at('803', 'Pink', 600)];
  const stoppedRns = new Set(['801']);
  assert.equal(detectCrossLineBunches(ts, { stoppedRns }).length, 0);
});

test('congestion gate: keeps a cluster with enough stopped trains', () => {
  const ts = [at('801', 'Brn', 0), at('802', 'Org', 300), at('803', 'Pink', 600)];
  const stoppedRns = new Set(['801', '802']);
  assert.equal(detectCrossLineBunches(ts, { stoppedRns }).length, 1);
});

test('groupByLine numbers trains across lines, biggest group first', () => {
  const ts = [at('801', 'Brn', 0), at('900', 'Org', 300), at('901', 'Org', 600)];
  const [bunch] = detectCrossLineBunches(ts);
  const { byLine, labels } = groupByLine(bunch);
  assert.equal(byLine[0].line, 'Org');
  assert.equal(byLine[1].line, 'Brn');
  assert.equal(labels.size, 3);
});
