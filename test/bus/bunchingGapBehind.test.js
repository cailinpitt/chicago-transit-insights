const test = require('node:test');
const assert = require('node:assert');
const { computeGapBehind } = require('../../src/bus/bunching');

const bunchVehicles = [
  { vid: 'lead', pdist: 12000 },
  { vid: 'back', pdist: 11000 }, // trailing edge of the bunch
];

test('computeGapBehind: nearest follower on same pid, distance + minutes', () => {
  const vehicles = [
    ...bunchVehicles.map((v) => ({ ...v, pid: 'P1' })),
    { vid: 'f-near', pid: 'P1', pdist: 8000 }, // 3000 ft behind the bunch
    { vid: 'f-far', pid: 'P1', pdist: 4000 },
    { vid: 'other-pid', pid: 'P2', pdist: 10500 }, // ignored: wrong pid
  ];
  // lengthFt 30000, tripMinutes 60 -> pace 1 min / 500 ft. 3000 ft -> 6 min.
  const gap = computeGapBehind({
    vehicles,
    pid: 'P1',
    bunchVehicles,
    lengthFt: 30000,
    tripMinutes: 60,
  });
  assert.equal(gap.followerVid, 'f-near');
  assert.equal(gap.distFt, 3000);
  assert.equal(gap.minutes, 6);
});

test('computeGapBehind: returns null when nothing follows the bunch', () => {
  const vehicles = [
    ...bunchVehicles.map((v) => ({ ...v, pid: 'P1' })),
    { vid: 'ahead', pid: 'P1', pdist: 15000 }, // ahead, not behind
  ];
  const gap = computeGapBehind({
    vehicles,
    pid: 'P1',
    bunchVehicles,
    lengthFt: 30000,
    tripMinutes: 60,
  });
  assert.equal(gap, null);
});

test('computeGapBehind: minutes null when no scheduled pace', () => {
  const vehicles = [
    ...bunchVehicles.map((v) => ({ ...v, pid: 'P1' })),
    { vid: 'f', pid: 'P1', pdist: 9000 },
  ];
  const gap = computeGapBehind({
    vehicles,
    pid: 'P1',
    bunchVehicles,
    lengthFt: 30000,
    tripMinutes: null,
  });
  assert.equal(gap.distFt, 2000);
  assert.equal(gap.minutes, null);
});
