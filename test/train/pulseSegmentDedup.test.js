const test = require('node:test');
const assert = require('node:assert');

const { planSegmentDedup } = require('../../bin/train/pulse');

const cand = (direction, from, to) => ({
  direction,
  fromStation: { name: from },
  toStation: { name: to },
});

test('planSegmentDedup keeps a posted duplicate instead of evicting it', () => {
  const { plan, seenDirs } = planSegmentDedup(
    [
      cand('branch-len92-41780--87606', 'Clinton (Green/Pink)', 'Adams/Wabash'),
      cand('branch-len101-41779--87664', 'Clinton (Green/Pink)', 'Adams/Wabash'),
    ],
    new Set(['branch-len92-41780--87606', 'branch-len101-41779--87664']),
  );
  assert.deepStrictEqual(
    plan.map((p) => p.action),
    ['handle', 'keep'],
  );
  assert.ok(seenDirs.has('branch-len101-41779--87664'));
});

test('planSegmentDedup still evicts an unposted duplicate', () => {
  const { plan } = planSegmentDedup(
    [
      cand('branch-len92-41780--87606', 'Clinton (Green/Pink)', 'Adams/Wabash'),
      cand('branch-len101-41779--87664', 'Clinton (Green/Pink)', 'Adams/Wabash'),
    ],
    new Set(['branch-len92-41780--87606']),
  );
  assert.deepStrictEqual(
    plan.map((p) => p.action),
    ['handle', 'evict'],
  );
});
