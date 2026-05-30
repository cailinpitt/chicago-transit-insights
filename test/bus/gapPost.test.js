const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPostText, buildAltText, buildGapVideoPostText } = require('../../src/bus/gapPost');

const pattern = { direction: 'Southbound' };
const stop = { stopName: 'Foster & Marine Drive' };
const gap = { route: '147', gapMin: 35, expectedMin: 9 };

test('buildPostText includes gap duration, stop, and scheduled headway', () => {
  const text = buildPostText(gap, pattern, stop);
  assert.ok(text.includes('🕳️'));
  assert.ok(text.includes('Route 147'));
  assert.ok(text.includes('Southbound'));
  assert.ok(text.includes('No buses'));
  assert.ok(text.includes('a ~35 min gap'));
  assert.ok(text.includes('Foster & Marine Drive'));
  assert.ok(text.includes('every 9 min'));
});

test('buildPostText names the stretch between flanking stops', () => {
  const g = {
    ...gap,
    flankBefore: { stopName: 'Bryn Mawr' },
    flankAfter: { stopName: 'Wilson' },
  };
  const text = buildPostText(g, pattern, stop);
  assert.ok(text.includes('No buses between Bryn Mawr and Wilson'));
  assert.ok(text.includes('a ~35 min gap'));
  // Does not fall back to the single-stop phrasing when flanks are present.
  assert.ok(!text.includes('near Foster & Marine Drive'));
});

test('buildPostText falls back to "near <stop>" when no flanks are available', () => {
  const text = buildPostText(gap, pattern, stop);
  assert.ok(text.includes('No buses near Foster & Marine Drive'));
});

test('buildPostText spells out rider roles with Last seen / Next up', () => {
  const g = { ...gap, leading: { vid: '1934' }, trailing: { vid: '8021' } };
  const text = buildPostText(g, pattern, stop);
  assert.ok(text.includes('Last seen: #1934'));
  assert.ok(text.includes('Next up: #8021'));
  assert.ok(!text.includes('Buses:'));
});

test('buildPostText marks the modeled gap as approximate with a tilde', () => {
  assert.ok(buildPostText(gap, pattern, stop).includes('~35 min'));
});

test('buildAltText describes the gap for screen readers', () => {
  const alt = buildAltText(gap, pattern, stop);
  assert.ok(alt.includes('Route 147'));
  assert.ok(alt.includes('southbound'));
  assert.ok(alt.includes('35 min gap'));
  assert.ok(alt.includes('Foster & Marine Drive'));
});

test('buildAltText names the stretch between flanking stops', () => {
  const g = {
    ...gap,
    flankBefore: { stopName: 'Bryn Mawr' },
    flankAfter: { stopName: 'Wilson' },
  };
  const alt = buildAltText(g, pattern, stop);
  assert.ok(alt.includes('with no buses between Bryn Mawr and Wilson'));
});

test('buildGapVideoPostText names the mid-gap stop when the bus reaches it', () => {
  const g = { route: '147' };
  const result = {
    reached: true,
    gapMin: 39,
    elapsedSec: 600,
    startDistFt: 5000,
    endDistFt: 0,
    stopName: 'Foster & Marine Drive',
  };
  const text = buildGapVideoPostText(g, result);
  assert.ok(text.includes('~39 min Route 147'));
  assert.ok(text.includes('reached Foster & Marine Drive — the middle of the gap'));
  assert.ok(text.includes('10 minutes later'));
});

test('buildGapVideoPostText reports the concrete remaining distance in miles', () => {
  const g = { route: '26' };
  const result = {
    reached: false,
    gapMin: 39,
    elapsedSec: 600,
    startDistFt: 10_000,
    endDistFt: 5_000,
    stopName: 'Foster & Marine Drive',
  };
  const text = buildGapVideoPostText(g, result);
  assert.ok(text.includes('closed to within ~0.95 mi of Foster & Marine Drive'));
  assert.ok(text.includes('the middle of the gap'));
});

test('buildGapVideoPostText reports remaining distance in feet under a quarter mile', () => {
  const g = { route: '26' };
  const result = {
    reached: false,
    gapMin: 39,
    elapsedSec: 600,
    startDistFt: 10_000,
    endDistFt: 640,
    stopName: 'Foster & Marine Drive',
  };
  const text = buildGapVideoPostText(g, result);
  assert.ok(text.includes('closed to within ~640 ft of Foster & Marine Drive'));
});

test('buildGapVideoPostText ties in the Next up vehicle id when present', () => {
  const g = { route: '147', trailing: { vid: '8021' } };
  const result = {
    reached: true,
    gapMin: 39,
    elapsedSec: 600,
    startDistFt: 5_000,
    endDistFt: 0,
    stopName: 'Foster & Marine Drive',
  };
  assert.ok(buildGapVideoPostText(g, result).includes('next bus (#8021) reached'));
});

test('buildGapVideoPostText falls back to "the middle of the gap" with no stop name', () => {
  const g = { route: '147' };
  const result = { reached: true, gapMin: 39, elapsedSec: 600, startDistFt: 5_000, endDistFt: 0 };
  const text = buildGapVideoPostText(g, result);
  assert.ok(text.includes('reached the middle of the gap'));
  assert.ok(text.includes('~39 min Route 147'));
});
