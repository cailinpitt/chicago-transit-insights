// Regression for the train pulse feed-coverage guard (detectFeedGap). On
// 2026-05-28 the upstream Train Tracker feed / observe-trains ingestion stalled
// 21:11→21:43 CDT, then replayed stale positions on recovery. That produced a
// cluster of pulse false positives: a Purple full-line blackout (456), Red/Blue
// "all" segment posts during the outage (442/443), and Red/Brown/Blue segment
// posts in the ~20-min recovery shadow (462/463/464/465). The guard inspects
// the GLOBAL snapshot timestamps over a 30-min window and skips the tick when
// there's a ≥5 min hole — which must be true at every one of those post times
// and false during healthy pre-outage operation.
const test = require('node:test');
const assert = require('node:assert');
const Fs = require('node:fs');
const Path = require('node:path');

const { detectFeedGap } = require('../../src/train/pulse');

const fixture = JSON.parse(
  Fs.readFileSync(Path.join(__dirname, 'fixtures', 'train-feed-outage-2026-05-28.json'), 'utf8'),
);
const positions = fixture.snapshotTimestamps.map((ts) => ({ ts }));

test('feed-gap guard fires at every FP post time during the 2026-05-28 outage', () => {
  for (const [label, now] of Object.entries(fixture.fpPostTimes)) {
    const { gap, maxGapMs } = detectFeedGap({ positions, now });
    assert.equal(gap, true, `expected feed gap at ${label} (now=${now})`);
    assert.ok(maxGapMs >= 5 * 60 * 1000, `gap at ${label} should be ≥5 min, got ${maxGapMs}ms`);
  }
});

test('feed-gap guard stays quiet during healthy pre-outage operation', () => {
  const { gap } = detectFeedGap({ positions, now: fixture.controlTs });
  assert.equal(gap, false);
});

test('feed-gap guard treats a window with no snapshots as a gap', () => {
  const { gap } = detectFeedGap({ positions: [], now: fixture.controlTs });
  assert.equal(gap, true);
});

test('feed-gap guard ignores sub-threshold jitter between snapshots', () => {
  const now = 1_700_000_000_000;
  // Snapshots every 2 min for 30 min — normal cadence, no gap ≥ 5 min.
  const steady = [];
  for (let t = now - 30 * 60_000; t <= now; t += 2 * 60_000) steady.push({ ts: t });
  assert.equal(detectFeedGap({ positions: steady, now }).gap, false);
});
