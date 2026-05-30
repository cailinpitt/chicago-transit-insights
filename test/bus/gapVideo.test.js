const test = require('node:test');
const assert = require('node:assert/strict');
const { gapReadout, ARRIVED_FT } = require('../../src/bus/gapVideo');

const G = 22;
const STOP = 'Foster & Marine Drive';

test('gapReadout counts down the ETA to the named stop while approaching', () => {
  // 4400 ft / 880 ft-per-min = 5 min.
  assert.equal(gapReadout(G, STOP, 4400), '~22-min gap · next bus ~5 min to Foster & Marine Drive');
});

test('gapReadout shows "reaching" within the arrival window on either side', () => {
  assert.equal(
    gapReadout(G, STOP, ARRIVED_FT - 100),
    '~22-min gap · next bus reaching Foster & Marine Drive',
  );
  // Just barely past the stop is still "reaching", not yet "left".
  assert.equal(
    gapReadout(G, STOP, -(ARRIVED_FT - 100)),
    '~22-min gap · next bus reaching Foster & Marine Drive',
  );
});

test('gapReadout says "has left" once the bus passes the stop', () => {
  assert.equal(
    gapReadout(G, STOP, -(ARRIVED_FT + 2000)),
    '~22-min gap · next bus has left Foster & Marine Drive',
  );
});

test('gapReadout falls back to unnamed phrasing when no stop name is available', () => {
  assert.equal(gapReadout(G, null, 4400), '~22-min gap · next bus ~5 min');
  assert.equal(gapReadout(G, null, 0), '~22-min gap · next bus arriving');
  assert.equal(gapReadout(G, null, -(ARRIVED_FT + 2000)), '~22-min gap · next bus has left');
});
