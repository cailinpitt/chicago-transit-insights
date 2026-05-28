const test = require('node:test');
const assert = require('node:assert/strict');
const { directionLabel } = require('../../src/shared/directionLabel');

test('round-trip lines: outbound keys map to their non-Loop terminus', () => {
  assert.equal(directionLabel('brown', 'branch-0-outbound'), 'toward Kimball');
  assert.equal(directionLabel('orange', 'branch-0-outbound'), 'toward Midway');
  assert.equal(directionLabel('pink', 'branch-0-outbound'), 'toward 54th/Cermak');
  assert.equal(directionLabel('purple', 'branch-0-outbound'), 'toward Linden');
});

test('round-trip lines: inbound keys map to the Loop (or Howard for purple)', () => {
  assert.equal(directionLabel('brown', 'branch-1-inbound'), 'toward the Loop');
  assert.equal(directionLabel('orange', 'branch-1-inbound'), 'toward the Loop');
  assert.equal(directionLabel('pink', 'branch-1-inbound'), 'toward the Loop');
  assert.equal(directionLabel('purple', 'branch-1-inbound'), 'toward Howard');
});

test('multi-branch lines: branch-len keys resolve to the branch terminus station', () => {
  // Real keys produced by directionKeyFor on the current trainLines.json.
  // Regenerate via scripts if trainLines geometry shifts (see directionLabel.js).
  assert.equal(directionLabel('red', 'branch-len116-41722--87624'), 'toward 95th/Dan Ryan');
  assert.equal(directionLabel('blue', 'branch-len147-41874--87817'), 'toward Forest Park');
  assert.equal(directionLabel('green', 'branch-len101-41779--87664'), 'toward Ashland/63rd');
  assert.equal(directionLabel('green', 'branch-len92-41780--87606'), 'toward Cottage Grove');
  assert.equal(directionLabel('yellow', 'branch-len26-42039--87752'), 'toward Dempster-Skokie');
  assert.equal(directionLabel('yellow', 'branch-len26-42019--87673'), 'toward Howard');
});

test('null / "all" / unrecognized direction returns null', () => {
  assert.equal(directionLabel('blue', null), null);
  assert.equal(directionLabel('blue', undefined), null);
  assert.equal(directionLabel('blue', 'all'), null);
  assert.equal(directionLabel('blue', 'branch-0'), null);
  assert.equal(directionLabel('blue', 'something-weird'), null);
});

test('null / unknown line returns null even with a valid direction key', () => {
  assert.equal(directionLabel(null, 'branch-0-outbound'), null);
  assert.equal(directionLabel('', 'branch-0-outbound'), null);
  assert.equal(directionLabel('teal', 'branch-0-outbound'), null);
  // Multi-branch key on an unknown line: no stations on that "line", so null.
  assert.equal(directionLabel('teal', 'branch-len116-41722--87624'), null);
});
