const test = require('node:test');
const assert = require('node:assert');
const Path = require('node:path');
const Fs = require('node:fs');
const Os = require('node:os');

function loadHistoryWithDb() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-unposted-clear-'));
  process.env.HISTORY_DB_PATH = Path.join(dir, 'history.sqlite');
  delete require.cache[require.resolve('../../src/shared/history')];
  const history = require('../../src/shared/history');
  history.getDb();
  return {
    history,
    cleanup: () => {
      history.getDb().close();
      delete require.cache[require.resolve('../../src/shared/history')];
      delete process.env.HISTORY_DB_PATH;
      Fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const PULSE = {
  kind: 'train',
  line: 'g',
  direction: 'branch-len101-41779--87664',
  fromStation: 'Clinton (Green/Pink)',
  toStation: 'Indiana',
  source: 'observed',
  posted: true,
  postUri: 'at://did:plc:x/app.bsky.feed.post/pulse1',
};

function openPulses(history) {
  return history.findUnresolvedDisruptions(
    { kind: 'train', source: 'observed', sinceMs: 10 * 86400000 },
    3000,
  );
}

test('recordUnpostedPulseClear closes the matching pulse', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    history.recordDisruption(PULSE, 1000);
    assert.strictEqual(openPulses(history).length, 1);
    assert.strictEqual(
      history.recordUnpostedPulseClear({ kind: 'train', pulseUri: PULSE.postUri }, 2000),
      true,
    );
    assert.strictEqual(openPulses(history).length, 0);
    const clear = history
      .getDb()
      .prepare("SELECT * FROM disruption_events WHERE source = 'observed-clear'")
      .get();
    assert.strictEqual(clear.ts, 2000);
    assert.strictEqual(clear.posted, 0);
    assert.strictEqual(clear.direction, PULSE.direction);
    assert.strictEqual(clear.to_station, 'Indiana');
  } finally {
    cleanup();
  }
});

test('recordUnpostedPulseClear is a no-op once a clear exists', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    history.recordDisruption(PULSE, 1000);
    history.recordDisruption({ ...PULSE, source: 'observed-clear', postUri: 'at://clear' }, 1500);
    assert.strictEqual(
      history.recordUnpostedPulseClear({ kind: 'train', pulseUri: PULSE.postUri }, 2000),
      false,
    );
    const n = history
      .getDb()
      .prepare("SELECT COUNT(*) AS n FROM disruption_events WHERE source = 'observed-clear'")
      .get().n;
    assert.strictEqual(n, 1);
  } finally {
    cleanup();
  }
});

test('recordUnpostedPulseClear never backdates before the pulse', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    history.recordDisruption(PULSE, 1000);
    history.recordUnpostedPulseClear({ kind: 'train', pulseUri: PULSE.postUri }, 500);
    const clear = history
      .getDb()
      .prepare("SELECT ts FROM disruption_events WHERE source = 'observed-clear'")
      .get();
    assert.strictEqual(clear.ts, 1000);
  } finally {
    cleanup();
  }
});
