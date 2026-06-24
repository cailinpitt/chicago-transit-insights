const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');

function loadHistoryWithDb() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-accessibility-'));
  const dbPath = Path.join(dir, 'history.sqlite');
  process.env.HISTORY_DB_PATH = dbPath;
  delete require.cache[require.resolve('../../src/shared/history')];
  delete require.cache[require.resolve('../../bin/export-accessibility')];
  const history = require('../../src/shared/history');
  history.getDb();
  return {
    history,
    exportAccessibility: require('../../bin/export-accessibility'),
    cleanup: () => {
      try {
        history.getDb().close();
      } catch {
        // best effort
      }
      delete require.cache[require.resolve('../../src/shared/history')];
      delete require.cache[require.resolve('../../bin/export-accessibility')];
      delete process.env.HISTORY_DB_PATH;
      Fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const {
  isCtaAccessibilityAlert,
  isMetraAccessibilityAlert,
  toCtaOutageRows,
  toMetraOutageRows,
} = require('../../src/shared/accessibility');

test('CTA accessibility gate captures elevator-status alerts that the timeline rejects', () => {
  const alert = {
    id: '114905',
    headline: 'Elevator at Belmont Temporarily Out-of-Service',
    shortDescription: 'Elevator to Red/Brown/Purple Line platform at Belmont is out of service.',
    fullDescription: null,
    impact: 'Elevator Status',
    major: true,
    severityScore: 1,
    busRoutes: [],
    trainLines: ['red', 'brn', 'p'],
  };
  assert.equal(isCtaAccessibilityAlert(alert), true);
  const [row] = toCtaOutageRows([alert], 5000);
  assert.equal(row.sourceId, 'cta-114905');
  assert.equal(row.agency, 'cta');
  assert.equal(row.stationName, 'Belmont');
  assert.equal(row.stationSlug, 'belmont-red-brown-purple');
  assert.deepEqual(row.lines, ['brn', 'p', 'red']);
  assert.equal(row.unitType, 'elevator');
  assert.equal(row.unitLabel, 'to Red/Brown/Purple Line platform');
});

test('Metra accessibility gate captures ADA notices that the timeline rejects', () => {
  const alert = {
    id: 'metra-alert-1',
    header: 'Elevator outage at Chicago Union Station',
    description: 'Elevator near the Great Hall at Chicago Union Station is out of service.',
    effect: 'UNKNOWN_EFFECT',
    informedEntities: [{ routeId: 'BNSF' }],
  };
  assert.equal(isMetraAccessibilityAlert(alert), true);
  const [row] = toMetraOutageRows([alert], 5000);
  assert.equal(row.sourceId, 'metra-metra-alert-1');
  assert.equal(row.agency, 'metra');
  assert.equal(row.stationName, 'Chicago Union Station');
  assert.equal(row.stationSlug, 'chicago-union-station');
  assert.ok(row.lines.includes('bnsf'));
  assert.equal(row.unitType, 'elevator');
  assert.equal(row.unitLabel, 'near the Great Hall');
});

test('accessibility storage reconciles and export emits public shape', () => {
  const { history, exportAccessibility, cleanup } = loadHistoryWithDb();
  try {
    history.upsertAccessibilityOutages(
      [
        {
          sourceId: 'cta-1',
          agency: 'cta',
          stationName: 'Belmont',
          stationSlug: 'belmont',
          lines: ['red', 'brn', 'p'],
          unitType: 'elevator',
          unitLabel: 'to platform',
          headline: 'Elevator out',
          description: 'Elevator to platform at Belmont is out.',
          sourceUrl: 'https://transitchicago.com/',
          firstSeenTs: 1000,
        },
      ],
      1000,
    );
    for (let i = 0; i < history.ACCESSIBILITY_CLEAR_TICKS - 1; i += 1) {
      history.reconcileAccessibilityOutages(new Set(), 2000 + i);
    }
    assert.equal(history.getAccessibilityOutages(0)[0].active, true);
    history.reconcileAccessibilityOutages(new Set(), 3000);
    let stored = history.getAccessibilityOutages(0)[0];
    assert.equal(stored.active, false);
    assert.equal(stored.restoredTs, 2000);

    history.upsertAccessibilityOutages(
      [{ ...stored, sourceId: 'cta-1', firstSeenTs: stored.firstSeenTs }],
      4000,
    );
    stored = history.getAccessibilityOutages(0)[0];
    assert.equal(stored.active, true);
    assert.equal(stored.restoredTs, null);

    const payload = exportAccessibility.buildAccessibilityPayload({ now: 5000 });
    assert.equal(payload.schema_version, 1);
    assert.equal(payload.window_days, 180);
    assert.equal(payload.outages.length, 1);
    assert.equal(payload.outages[0].id, 'cta-1');
    assert.equal(payload.outages[0].station.slug, 'belmont');
    assert.equal(payload.outages[0].lifecycle.active, true);
  } finally {
    cleanup();
  }
});
