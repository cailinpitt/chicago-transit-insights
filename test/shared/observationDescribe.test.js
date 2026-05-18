const test = require('node:test');
const assert = require('node:assert/strict');
const {
  describeBotObservation,
  describeBotResolution,
} = require('../../src/shared/observationDescribe');

test('describeBotObservation: roundup on a train line with multiple signals', () => {
  const out = describeBotObservation({
    kind: 'train',
    line: 'blue',
    detection_source: 'roundup',
    signals: ['ghost', 'gap'],
  });
  assert.equal(
    out,
    'Blue Line service appears degraded — fewer trains than scheduled and longer-than-scheduled headways between trains.',
  );
});

test('describeBotObservation: single-signal train observation with short-code line', () => {
  const out = describeBotObservation({
    kind: 'train',
    line: 'brn',
    detection_source: 'pulse-cold',
  });
  assert.equal(out, 'Brown Line service appears degraded — a stretch of the line without trains.');
});

test('describeBotObservation: bus observation by route', () => {
  const out = describeBotObservation({
    kind: 'bus',
    line: '66',
    detection_source: 'bunching',
  });
  assert.equal(out, 'Route 66 service appears degraded — buses running bunched together.');
});

test('describeBotObservation: thin-gap on a low-frequency route', () => {
  const out = describeBotObservation({
    kind: 'bus',
    line: '124',
    detection_source: 'thin-gap',
  });
  assert.equal(
    out,
    'Route 124 service appears degraded — no buses observed within a full scheduled headway.',
  );
});

test('describeBotObservation: accepts comma-joined signals string from roundup', () => {
  const out = describeBotObservation({
    kind: 'train',
    line: 'red',
    detection_source: 'roundup',
    signals: 'ghost,gap,bunching',
  });
  assert.equal(
    out,
    'Red Line service appears degraded — fewer trains than scheduled, longer-than-scheduled headways between trains, and trains running bunched together.',
  );
});

test('describeBotObservation: null for CTA alerts', () => {
  assert.equal(describeBotObservation({ alert_id: 'x', kind: 'train', routes: ['red'] }), null);
});

test('describeBotObservation: null for merged incidents', () => {
  assert.equal(describeBotObservation({ _type: 'merged', kind: 'train', line: 'red' }), null);
});

test('describeBotObservation: null when no recognizable signal', () => {
  assert.equal(describeBotObservation({ kind: 'train', line: 'red' }), null);
});

test('describeBotResolution: thin-gap bus uses "observed again"', () => {
  const out = describeBotResolution({
    kind: 'bus',
    line: '124',
    detection_source: 'thin-gap',
  });
  assert.equal(out, 'Buses observed again on Route 124, service appears to be back to normal.');
});

test('describeBotResolution: pulse-cold train uses "observed again"', () => {
  const out = describeBotResolution({
    kind: 'train',
    line: 'brn',
    detection_source: 'pulse-cold',
  });
  assert.equal(
    out,
    'Trains observed again on the Brown Line, service appears to be back to normal.',
  );
});

test('describeBotResolution: pulse-held alone uses "moving again"', () => {
  const out = describeBotResolution({
    kind: 'train',
    line: 'red',
    detection_source: 'pulse-held',
  });
  assert.equal(out, 'Trains moving again on the Red Line, service appears to be back to normal.');
});

test('describeBotResolution: degradation roundup drops lead clause (vehicles were always visible)', () => {
  const out = describeBotResolution({
    kind: 'train',
    line: 'red',
    detection_source: 'roundup',
    signals: ['ghost', 'gap'],
  });
  assert.equal(out, 'Red Line service appears to be back to normal.');
});

test('describeBotResolution: single-signal degradation drops lead clause', () => {
  const out = describeBotResolution({
    kind: 'bus',
    line: '66',
    detection_source: 'bunching',
  });
  assert.equal(out, 'Route 66 service appears to be back to normal.');
});

test('describeBotResolution: null for alerts/merged', () => {
  assert.equal(describeBotResolution({ alert_id: 'x', kind: 'bus', line: '49' }), null);
  assert.equal(describeBotResolution({ _type: 'merged', kind: 'bus', line: '49' }), null);
});

test('describeBotResolution: null when no signals', () => {
  assert.equal(describeBotResolution({ kind: 'bus', line: '49' }), null);
});
