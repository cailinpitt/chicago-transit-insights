const test = require('node:test');
const assert = require('node:assert/strict');
const Path = require('node:path');
const Fs = require('node:fs');
const Os = require('node:os');

// Lifecycle of the schedule-anchored single-train Metra cancellation columns +
// helpers in src/shared/history.js (recordCancellation / finalizeCancellation).

function freshDbPath() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-cancel-'));
  return Path.join(dir, 'history.sqlite');
}

function loadHistoryWithDb(dbPath) {
  process.env.HISTORY_DB_PATH = dbPath;
  delete require.cache[require.resolve('../../src/shared/history')];
  const history = require('../../src/shared/history');
  history.getDb();
  return {
    history,
    cleanup: () => {
      try {
        history.getDb().close();
      } catch (_e) {
        /* ignore */
      }
      delete require.cache[require.resolve('../../src/shared/history')];
      delete process.env.HISTORY_DB_PATH;
      try {
        Fs.rmSync(Path.dirname(dbPath), { recursive: true, force: true });
      } catch (_e) {
        /* ignore */
      }
    },
  };
}

// Seed a posted metra alert row at first_seen = firstSeenTs.
function seedAlert(history, alertId, firstSeenTs) {
  history.recordAlertSeen(
    {
      alertId,
      kind: 'metra',
      routes: 'UP-W',
      headline: 'UPW train #67 will not operate',
      postUri: 'at://x/y/z',
    },
    firstSeenTs,
  );
}

test('cancellation columns exist after init', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    const cols = history
      .getDb()
      .prepare('PRAGMA table_info(alert_posts)')
      .all()
      .map((c) => c.name);
    for (const c of [
      'cancel_state',
      'cancel_dep_ts',
      'cancel_arr_ts',
      'cancel_train_no',
      'cancel_origin',
    ]) {
      assert.ok(cols.includes(c), `${c} exists`);
    }
  } finally {
    cleanup();
  }
});

test('recordCancellation sets the window + initializes state to upcoming', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    const t0 = Date.UTC(2026, 5, 10, 1, 0, 0);
    seedAlert(history, 'a1', t0);
    const dep = Date.UTC(2026, 5, 11, 4, 5, 0); // future
    const arr = dep + 60 * 60 * 1000;
    history.recordCancellation({
      alertId: 'a1',
      depTs: dep,
      arrTs: arr,
      trainNo: '678',
      origin: 'Barrington',
    });
    const row = history.getAlertPost('a1');
    assert.equal(row.cancel_state, 'upcoming');
    assert.equal(row.cancel_dep_ts, dep);
    assert.equal(row.cancel_arr_ts, arr);
    assert.equal(row.cancel_train_no, '678');
    assert.equal(row.cancel_origin, 'Barrington');
    assert.equal(row.resolved_ts, null); // upcoming is not terminal
  } finally {
    cleanup();
  }
});

test('upcoming cancellation stays in the unresolved set; finalized one leaves it', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    const t0 = Date.UTC(2026, 5, 10, 1, 0, 0);
    seedAlert(history, 'a1', t0);
    const dep = Date.UTC(2026, 5, 10, 1, 40, 0);
    history.recordCancellation({
      alertId: 'a1',
      depTs: dep,
      arrTs: dep + 3600e3,
      trainNo: '67',
      origin: 'Chicago OTC',
    });
    assert.equal(history.listUnresolvedAlerts('metra').length, 1, 'upcoming is unresolved');
    history.finalizeCancellation({ alertId: 'a1', replyUri: 'at://reply/1' });
    assert.equal(
      history.listUnresolvedAlerts('metra').length,
      0,
      'finalized leaves unresolved set',
    );
  } finally {
    cleanup();
  }
});

test('finalizeCancellation flips the label, dates resolved_ts to departure, stores the reply', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    const t0 = Date.UTC(2026, 5, 10, 1, 0, 0);
    seedAlert(history, 'a1', t0);
    const dep = Date.UTC(2026, 5, 10, 1, 40, 0); // after first_seen
    history.recordCancellation({
      alertId: 'a1',
      depTs: dep,
      arrTs: dep + 3600e3,
      trainNo: '67',
      origin: 'Chicago OTC',
    });
    history.finalizeCancellation({ alertId: 'a1', replyUri: 'at://reply/1' });
    const row = history.getAlertPost('a1');
    assert.equal(row.cancel_state, 'cancelled');
    assert.equal(row.resolved_ts, dep, 'resolved_ts = scheduled departure');
    assert.equal(row.resolved_reply_uri, 'at://reply/1');
  } finally {
    cleanup();
  }
});

test('an annulment announced after departure dates resolved_ts to first_seen, never negative', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    const firstSeen = Date.UTC(2026, 5, 10, 1, 49, 0); // 8:49pm CDT — after the 8:40 departure
    seedAlert(history, 'a1', firstSeen);
    const dep = Date.UTC(2026, 5, 10, 1, 40, 0); // 8:40pm — before we saw the alert
    history.recordCancellation({
      alertId: 'a1',
      depTs: dep,
      arrTs: dep + 3600e3,
      trainNo: '67',
      origin: 'Chicago OTC',
    });
    history.finalizeCancellation({ alertId: 'a1', replyUri: null });
    const row = history.getAlertPost('a1');
    assert.equal(
      row.resolved_ts,
      firstSeen,
      'resolved_ts clamps to first_seen when dep precedes it',
    );
    assert.ok(row.resolved_ts >= row.first_seen_ts, 'never a negative duration');
  } finally {
    cleanup();
  }
});

test('finalizeCancellation is idempotent — resolved_ts and reply are not clobbered', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    const t0 = Date.UTC(2026, 5, 10, 1, 0, 0);
    seedAlert(history, 'a1', t0);
    const dep = Date.UTC(2026, 5, 10, 1, 40, 0);
    history.recordCancellation({
      alertId: 'a1',
      depTs: dep,
      arrTs: dep + 3600e3,
      trainNo: '67',
      origin: 'Chicago OTC',
    });
    history.finalizeCancellation({ alertId: 'a1', replyUri: 'at://reply/1' });
    history.finalizeCancellation({ alertId: 'a1', replyUri: 'at://reply/2' });
    const row = history.getAlertPost('a1');
    assert.equal(row.resolved_ts, dep);
    assert.equal(row.resolved_reply_uri, 'at://reply/1', 'first reply wins');
  } finally {
    cleanup();
  }
});

test('recordCancellation never downgrades a finalized cancellation back to upcoming', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    const t0 = Date.UTC(2026, 5, 10, 1, 0, 0);
    seedAlert(history, 'a1', t0);
    const dep = Date.UTC(2026, 5, 10, 1, 40, 0);
    history.recordCancellation({
      alertId: 'a1',
      depTs: dep,
      arrTs: dep + 3600e3,
      trainNo: '67',
      origin: 'Chicago OTC',
    });
    history.finalizeCancellation({ alertId: 'a1', replyUri: 'at://reply/1' });
    // A later tick re-records (e.g. alert still on the wire) — must stay cancelled.
    history.recordCancellation({
      alertId: 'a1',
      depTs: dep,
      arrTs: dep + 3600e3,
      trainNo: '67',
      origin: 'Chicago OTC',
    });
    assert.equal(history.getAlertPost('a1').cancel_state, 'cancelled');
  } finally {
    cleanup();
  }
});

test('cancel_state is null for ordinary (non-cancellation) alerts', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    history.recordAlertSeen({
      alertId: 'b1',
      kind: 'metra',
      routes: 'UP-N',
      headline: 'Signal problems',
      postUri: 'at://x/y/z',
    });
    assert.equal(history.getAlertPost('b1').cancel_state, null);
  } finally {
    cleanup();
  }
});
