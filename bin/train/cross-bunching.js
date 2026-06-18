#!/usr/bin/env node
// Cross-line train bunching: a pileup at one spot involving 2+ lines (e.g. the
// shared Loop track — Brown/Orange/Pink/Purple stacked at Tower 18). detect →
// render station map → post (train account), keyed on the PLACE. Runs just
// before bin/train/bunching.js so its posted pileups suppress the per-line post
// for the same trains. Supports --dry-run. Static map only for now.
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { getAllTrainPositions } = require('../../src/train/api');
const { detectCrossLineBunches, groupByLine } = require('../../src/train/crossBunching');
const { getRecentTrainPositions } = require('../../src/shared/observations');
const { haversineFt } = require('../../src/shared/geo');
const stations = require('../../src/train/data/trainStations.json');
const { renderCrossBunchingMap, pointsFromCluster } = require('../../src/map');
const { buildPostText, buildAltText, lineLabel } = require('../../src/train/crossBunchingPost');
const { loginTrain, postWithImage, postText } = require('../../src/train/bluesky');
const { isOnCooldown } = require('../../src/shared/state');
const { commitAndPost } = require('../../src/shared/postDetection');
const history = require('../../src/shared/history');
const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');

const WINDOW_MS = 5 * 60 * 1000;
const STOPPED_DRIFT_FT = 350; // a train that moved < this across the window is stuck
const PLACE_MAX_FT = 2200; // a station farther than this isn't a fair label
const CROSS_TRAIN_DAILY_CAP = 2;

// Trains that barely moved across the recent window — the congestion gate.
function stoppedRunsFrom(rows) {
  const byRn = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    if (!byRn.has(r.rn)) byRn.set(r.rn, []);
    byRn.get(r.rn).push(r);
  }
  const stopped = new Set();
  for (const [rn, pts] of byRn) {
    if (pts.length < 2) continue;
    let drift = 0;
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        const d = haversineFt(pts[a], pts[b]);
        if (d > drift) drift = d;
      }
    }
    if (drift <= STOPPED_DRIFT_FT) stopped.add(rn);
  }
  return stopped;
}

function nearestStation(centroid) {
  let best = null;
  for (const s of stations) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const d = haversineFt(centroid, s);
    if (!best || d < best.d) best = { d, name: s.name };
  }
  return best && best.d <= PLACE_MAX_FT ? best.name : null;
}

function placeKeyFor(centroid) {
  return `${centroid.lat.toFixed(3)},${centroid.lon.toFixed(3)}`;
}

function recordSkip(cluster, placeKey, suppressed) {
  history.recordBunching({
    kind: 'train-multi',
    route: placeKey,
    direction: cluster.lines.join(','),
    vehicleCount: cluster.trains.length,
    severityFt: cluster.spanFt,
    nearStop: null,
    posted: false,
  });
  history.recordMetaSignal({
    kind: 'train',
    line: placeKey,
    direction: cluster.lines.join(','),
    source: 'cross-bunching',
    severity: Math.min(1, cluster.trains.length / 5),
    detail: { trains: cluster.trains.length, lines: cluster.lines, suppressed },
    posted: false,
  });
}

async function main() {
  setup();
  console.log('Fetching train positions...');
  const trains = await getAllTrainPositions();
  console.log(`Got ${trains.length} trains`);

  const stoppedRns = stoppedRunsFrom(getRecentTrainPositions(Date.now() - WINDOW_MS));
  const clusters = detectCrossLineBunches(trains, { stoppedRns });
  if (clusters.length === 0) {
    console.log('No cross-line train bunching detected');
    return;
  }
  console.log(`Found ${clusters.length} candidate cross-line pileup(s)`);

  let chosen = null;
  let placeKey = null;
  let cooldownOverridden = false;
  for (const cluster of clusters) {
    const pk = placeKeyFor(cluster.centroid);
    console.log(
      `  ${cluster.trains.length} trains / ${cluster.lineCount} lines (${cluster.lines.join(', ')}) @ ${pk}`,
    );
    if (!argv['dry-run']) {
      const cdKey = `xbunch:train:${pk}`;
      const cd = isOnCooldown(cdKey);
      const cooldownAllows = history.bunchingCooldownAllows({
        kind: 'train-multi',
        route: pk,
        candidate: { vehicleCount: cluster.trains.length, severityFt: cluster.spanFt },
      });
      if (cd && !cooldownAllows) {
        console.log('  skip: on cooldown');
        recordSkip(cluster, pk, 'cooldown');
        continue;
      }
      if (cd && cooldownAllows) cooldownOverridden = true;
      const capAllows = history.bunchingCapAllows({
        kind: 'train-multi',
        route: pk,
        candidate: { vehicleCount: cluster.trains.length, severityFt: cluster.spanFt },
        cap: CROSS_TRAIN_DAILY_CAP,
      });
      if (!capAllows) {
        console.log('  skip: at daily cap and not more severe');
        recordSkip(cluster, pk, 'cap');
        continue;
      }
    }
    chosen = cluster;
    placeKey = pk;
    break;
  }

  if (!chosen) {
    console.log('All candidates filtered (cooldown/cap), nothing to post');
    return;
  }

  const placeName = nearestStation(chosen.centroid);
  const callouts = history.bunchingCallouts({
    kind: 'train-multi',
    route: placeKey,
    routeLabel: placeName ? `pileup at ${placeName}` : 'multi-line pileup',
    vehicleCount: chosen.trains.length,
    severityFt: chosen.spanFt,
  });

  const { byLine, labels } = groupByLine(chosen);
  const ctx = { placeName };
  const text = buildPostText(chosen, ctx, callouts);
  const alt = buildAltText(chosen, ctx);

  let image;
  try {
    const { points, legend } = pointsFromCluster(chosen.trains, {
      idOf: (t) => t.rn,
      groupKeyOf: (t) => t.line,
      labels,
      groupOrder: byLine.map((g) => g.line),
      legendLabelOf: (l) => lineLabel(l),
    });
    image = await renderCrossBunchingMap({
      points,
      legend,
      title: `${chosen.trains.length} trains · ${chosen.lineCount} lines`,
    });
  } catch (e) {
    console.warn(`Map render failed (${e.message}); will post text-only`);
    image = null;
  }

  if (argv['dry-run']) {
    const out = image
      ? writeDryRunAsset(
          image,
          `cross-train-${placeKey.replace(/[^a-z0-9]+/gi, '-')}-${Date.now()}.jpg`,
        )
      : '(render failed - text only)';
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${out}`);
    return;
  }

  const baseEvent = {
    kind: 'train-multi',
    route: placeKey,
    direction: chosen.lines.join(','),
    vehicleCount: chosen.trains.length,
    severityFt: chosen.spanFt,
    nearStop: placeName,
    memberIds: chosen.trains.map((t) => t.rn),
  };
  await commitAndPost({
    cooldownKeys: [`xbunch:train:${placeKey}`],
    forceClearCooldown: cooldownOverridden,
    recordSkip: () => history.recordBunching({ ...baseEvent, posted: false }),
    agentLogin: loginTrain,
    image,
    text,
    alt,
    recordPosted: (primary) => {
      history.recordBunching({ ...baseEvent, posted: true, postUri: primary.uri });
      history.recordMetaSignal({
        kind: 'train',
        line: placeKey,
        direction: chosen.lines.join(','),
        source: 'cross-bunching',
        severity: Math.min(1, chosen.trains.length / 5),
        detail: { trains: chosen.trains.length, lines: chosen.lines, nearStop: placeName },
        posted: true,
      });
    },
    postWithImage,
    postText,
  });
}

runBin(main);
