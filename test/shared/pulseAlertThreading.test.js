const test = require('node:test');
const assert = require('node:assert/strict');
const Path = require('node:path');
const Fs = require('node:fs');
const Os = require('node:os');

function loadHistoryWithDb() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-pulsethread-'));
  const dbPath = Path.join(dir, 'history.sqlite');
  process.env.HISTORY_DB_PATH = dbPath;
  delete require.cache[require.resolve('../../src/shared/history')];
  const history = require('../../src/shared/history');
  history.getDb();
  return {
    history,
    cleanup: () => {
      try {
        history.getDb().close();
      } catch (_) {
        /* ignore */
      }
      delete require.cache[require.resolve('../../src/shared/history')];
      delete process.env.HISTORY_DB_PATH;
      try {
        Fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {
        /* ignore */
      }
    },
  };
}

test('getRecentPulsePost returns the most recent posted observed pulse', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const t0 = 1_700_000_000_000;
    history.recordDisruption(
      {
        kind: 'train',
        line: 'red',
        direction: 'N',
        fromStation: 'Belmont',
        toStation: 'Howard',
        source: 'observed',
        posted: true,
        postUri: 'at://x/y/old',
      },
      t0,
    );
    history.recordDisruption(
      {
        kind: 'train',
        line: 'red',
        direction: 'N',
        fromStation: 'Belmont',
        toStation: 'Howard',
        source: 'observed',
        posted: true,
        postUri: 'at://x/y/new',
      },
      t0 + 60_000,
    );
    const found = history.getRecentPulsePost({ kind: 'train', line: 'red' }, t0 + 120_000);
    assert.equal(found.post_uri, 'at://x/y/new');
    assert.equal(found.from_station, 'Belmont');
  } finally {
    cleanup();
  }
});

test('getRecentPulsePost filters out non-posted, non-observed, and out-of-window rows', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const t0 = 1_700_000_000_000;
    history.recordDisruption(
      {
        kind: 'train',
        line: 'red',
        direction: 'N',
        fromStation: 'A',
        toStation: 'B',
        source: 'observed',
        posted: false,
        postUri: null,
      },
      t0,
    );
    history.recordDisruption(
      {
        kind: 'train',
        line: 'red',
        direction: 'N',
        fromStation: 'A',
        toStation: 'B',
        source: 'cta-alert',
        posted: true,
        postUri: 'at://x/y/cta',
      },
      t0 + 1000,
    );
    history.recordDisruption(
      {
        kind: 'train',
        line: 'red',
        direction: 'N',
        fromStation: 'A',
        toStation: 'B',
        source: 'observed',
        posted: true,
        postUri: 'at://x/y/old',
      },
      t0,
    );
    // Lookup window starts 1 minute before "now" — older row falls outside.
    const found = history.getRecentPulsePost(
      { kind: 'train', line: 'red', withinMs: 60_000 },
      t0 + 120_000,
    );
    assert.equal(found, null);
  } finally {
    cleanup();
  }
});

test('getRecentPulsePost respects direction filter when provided', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const t0 = 1_700_000_000_000;
    history.recordDisruption(
      {
        kind: 'train',
        line: 'red',
        direction: 'N',
        fromStation: 'A',
        toStation: 'B',
        source: 'observed',
        posted: true,
        postUri: 'at://x/y/north',
      },
      t0,
    );
    history.recordDisruption(
      {
        kind: 'train',
        line: 'red',
        direction: 'S',
        fromStation: 'C',
        toStation: 'D',
        source: 'observed',
        posted: true,
        postUri: 'at://x/y/south',
      },
      t0 + 10,
    );
    const north = history.getRecentPulsePost(
      { kind: 'train', line: 'red', direction: 'N' },
      t0 + 1000,
    );
    assert.equal(north.post_uri, 'at://x/y/north');
    const south = history.getRecentPulsePost(
      { kind: 'train', line: 'red', direction: 'S' },
      t0 + 1000,
    );
    assert.equal(south.post_uri, 'at://x/y/south');
  } finally {
    cleanup();
  }
});

test('hasUnresolvedCtaAlert matches comma-bracketed route codes without false positives', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    history.recordAlertSeen({
      alertId: 'a1',
      kind: 'train',
      routes: 'Red,P',
      headline: 'h',
      postUri: 'at://x/y/a1',
    });
    assert.equal(history.hasUnresolvedCtaAlert({ kind: 'train', ctaRouteCode: 'Red' }), true);
    assert.equal(history.hasUnresolvedCtaAlert({ kind: 'train', ctaRouteCode: 'P' }), true);
    // 'Re' must not match 'Red' via substring — comma boundary protects it.
    assert.equal(history.hasUnresolvedCtaAlert({ kind: 'train', ctaRouteCode: 'Re' }), false);
    // Resolved alerts no longer count as open.
    history.recordAlertResolved({ alertId: 'a1', replyUri: 'at://reply' });
    assert.equal(history.hasUnresolvedCtaAlert({ kind: 'train', ctaRouteCode: 'Red' }), false);
  } finally {
    cleanup();
  }
});

test('hasUnresolvedCtaAlert ignores rows that have not been posted yet', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    history.recordAlertSeen({
      alertId: 'a1',
      kind: 'train',
      routes: 'Red',
      headline: 'h',
      postUri: null,
    });
    assert.equal(history.hasUnresolvedCtaAlert({ kind: 'train', ctaRouteCode: 'Red' }), false);
  } finally {
    cleanup();
  }
});

test('openSilenceLines powers cross-detector suppression and releases on a shared clear', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const t0 = 1_700_000_000_000;
    const sinceMs = 7 * 24 * 60 * 60 * 1000;
    // An open thin-gap on #62 and an open pulse on #119.
    history.recordDisruption(
      {
        kind: 'bus',
        line: '62',
        source: 'observed-thin',
        posted: true,
        postUri: 'at://x/y/thin62',
      },
      t0,
    );
    history.recordDisruption(
      { kind: 'bus', line: '119', source: 'observed', posted: true, postUri: 'at://x/y/pulse119' },
      t0,
    );

    // Each detector sees only the OTHER's open silence under its own source key.
    const openThin = history.openSilenceLines(
      { kind: 'bus', source: 'observed-thin', sinceMs },
      t0 + 1000,
    );
    const openPulse = history.openSilenceLines(
      { kind: 'bus', source: 'observed', sinceMs },
      t0 + 1000,
    );
    assert.ok(openThin.has('62'), 'open thin-gap on 62 surfaces');
    assert.ok(!openThin.has('119'), 'a pulse firing is not an open thin-gap');
    assert.ok(openPulse.has('119'), 'open pulse on 119 surfaces');
    assert.ok(!openPulse.has('62'), 'a thin-gap firing is not an open pulse');

    // A line-keyed observed-clear releases the suppression.
    history.recordDisruption(
      {
        kind: 'bus',
        line: '62',
        source: 'observed-clear',
        posted: true,
        postUri: 'at://x/y/clr62',
      },
      t0 + 60_000,
    );
    const afterClear = history.openSilenceLines(
      { kind: 'bus', source: 'observed-thin', sinceMs },
      t0 + 120_000,
    );
    assert.ok(!afterClear.has('62'), 'cleared thin-gap no longer suppresses');
  } finally {
    cleanup();
  }
});
