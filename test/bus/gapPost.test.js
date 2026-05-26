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
  assert.ok(text.includes('No bus'));
  assert.ok(text.includes('~35 min'));
  assert.ok(text.includes('Foster & Marine Drive'));
  assert.ok(text.includes('every 9 min'));
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

test('buildGapVideoPostText anchors on the parent stop when the bus reaches the gap', () => {
  const g = { route: '147', gapMin: 39 };
  const result = { reached: true, gapMin: 39, elapsedSec: 600, startDistFt: 5000, endDistFt: 0 };
  const text = buildGapVideoPostText(g, result, stop);
  assert.ok(text.includes('~39 min gap on Route 147'));
  assert.ok(text.includes('Foster & Marine Drive'));
  assert.ok(text.includes('closed the gap'));
  assert.ok(text.includes('10 minutes later'));
  assert.ok(!text.includes('the stop'));
});

test('buildGapVideoPostText reports half-closed progress when the bus covers ~50% of the approach', () => {
  const g = { route: '26' };
  const result = {
    reached: false,
    gapMin: 39,
    elapsedSec: 600,
    startDistFt: 10_000,
    endDistFt: 5_000,
  };
  const text = buildGapVideoPostText(g, result, stop);
  assert.ok(text.includes('had covered about half the gap'));
  assert.ok(text.includes('Foster & Marine Drive'));
});

test('buildGapVideoPostText reports barely-closed when the bus has covered <25% of the approach', () => {
  const g = { route: '26' };
  const result = {
    reached: false,
    gapMin: 39,
    elapsedSec: 600,
    startDistFt: 10_000,
    endDistFt: 9_000,
  };
  const text = buildGapVideoPostText(g, result, stop);
  assert.ok(text.includes('had barely closed in'));
});

test('buildGapVideoPostText reports nearly-closed when the bus has covered >60% of the approach', () => {
  const g = { route: '26' };
  const result = {
    reached: false,
    gapMin: 39,
    elapsedSec: 600,
    startDistFt: 10_000,
    endDistFt: 2_000,
  };
  const text = buildGapVideoPostText(g, result, stop);
  assert.ok(text.includes('had nearly closed the gap'));
});

test('buildGapVideoPostText omits the stop clause when no parent stop is passed', () => {
  const g = { route: '147' };
  const result = { reached: true, gapMin: 39, elapsedSec: 600, startDistFt: 5_000, endDistFt: 0 };
  const text = buildGapVideoPostText(g, result, null);
  assert.ok(!text.includes(' near '));
  assert.ok(text.includes('~39 min gap on Route 147'));
});
