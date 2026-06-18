#!/usr/bin/env node
// Cross-route bus bunching: a pileup at one spot involving 2+ routes (e.g.
// 2 #22 + 3 #36 stacked at Clark & Belmont). detect → render intersection map →
// post (bus account), with the bunching incident lifecycle keyed on the PLACE
// instead of a route. Runs just before bin/bus/bunching.js so its posted
// pileups suppress the per-route post for the same buses. Supports --dry-run.
// Static map only for now; timelapse video is a follow-up.
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { getVehiclesCachedOrFresh } = require('../../src/bus/api');
const { allRoutes: bunchingRoutes } = require('../../src/bus/routes');
const { detectCrossRouteBunches, groupByRoute } = require('../../src/bus/crossBunching');
const { findParkedBusVids, PARKED_WINDOW_MS } = require('../../src/bus/bunching');
const { getRecentBusObservationsByRoute } = require('../../src/shared/observations');
const { loadPattern } = require('../../src/bus/patterns');
const { haversineFt } = require('../../src/shared/geo');
const { renderCrossBunchingMap, pointsFromCluster } = require('../../src/map');
const { buildPostText, buildAltText, routeLabel } = require('../../src/bus/crossBunchingPost');
const { loginBus, postWithImage, postText } = require('../../src/bus/bluesky');
const { isOnCooldown } = require('../../src/shared/state');
const { commitAndPost } = require('../../src/shared/postDetection');
const history = require('../../src/shared/history');
const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');

const PLACE_MAX_FT = 1200;
const CROSS_BUS_DAILY_CAP = 3;

function placeKeyFor(centroid) {
  return `${centroid.lat.toFixed(3)},${centroid.lon.toFixed(3)}`;
}

// Name the pileup by the nearest stop across the involved routes' patterns
// (CTA has no global stop list; stops live on patterns). Best-effort — returns
// null when nothing is close, and the post just drops the "near X" clause.
async function placeNameForCluster(cluster) {
  const pids = [...new Set(cluster.vehicles.map((v) => v.pid).filter(Boolean))];
  let best = null;
  for (const pid of pids) {
    let pattern;
    try {
      pattern = await loadPattern(pid);
    } catch {
      continue;
    }
    for (const p of pattern.points || []) {
      if (p.type !== 'S' || !p.stopName) continue;
      const d = haversineFt(cluster.centroid, p);
      if (!best || d < best.d) best = { d, name: p.stopName };
    }
  }
  return best && best.d <= PLACE_MAX_FT ? best.name : null;
}

function recordSkip(cluster, placeKey, suppressed) {
  history.recordBunching({
    kind: 'bus-multi',
    route: placeKey,
    direction: cluster.routes.join(','),
    vehicleCount: cluster.vehicles.length,
    severityFt: cluster.spanFt,
    nearStop: null,
    posted: false,
  });
  history.recordMetaSignal({
    kind: 'bus',
    line: placeKey,
    direction: cluster.routes.join(','),
    source: 'cross-bunching',
    severity: Math.min(1, cluster.vehicles.length / 5),
    detail: { vehicles: cluster.vehicles.length, routes: cluster.routes, suppressed },
    posted: false,
  });
}

async function main() {
  setup();
  const routes = bunchingRoutes;
  const { vehicles, now } = await getVehiclesCachedOrFresh(routes);
  console.log(`Got ${vehicles.length} vehicles across ${routes.length} routes`);
  const nowMs = now instanceof Date ? now.getTime() : now;

  // Congestion gate input: confirmed-parked buses (barely moved over the window).
  const recentByRoute = getRecentBusObservationsByRoute(routes, nowMs - PARKED_WINDOW_MS);
  const stoppedIds = new Set();
  for (const rows of recentByRoute.values()) {
    for (const vid of findParkedBusVids(rows)) stoppedIds.add(vid);
  }

  const clusters = detectCrossRouteBunches(vehicles, { now: nowMs, stoppedIds });
  if (!argv['dry-run']) {
    const closed = history.reconcileBunchingEvents
      ? history.reconcileBunchingEvents({
          kind: 'bus-multi',
          current: clusters.map((c) => ({
            route: placeKeyFor(c.centroid),
            direction: c.routes.join(','),
          })),
          now: nowMs,
        })
      : [];
    if (closed.length > 0) console.log(`Resolved ${closed.length} open cross-route bus pileup(s)`);
  }
  if (clusters.length === 0) {
    console.log('No cross-route bus bunching detected');
    return;
  }
  console.log(`Found ${clusters.length} candidate cross-route pileup(s)`);

  let chosen = null;
  let placeKey = null;
  let cooldownOverridden = false;
  for (const cluster of clusters) {
    const pk = placeKeyFor(cluster.centroid);
    console.log(
      `  ${cluster.vehicles.length} buses / ${cluster.routeCount} routes (${cluster.routes.join(', ')}) @ ${pk}`,
    );
    if (!argv['dry-run']) {
      const cdKey = `xbunch:bus:${pk}`;
      const cd = isOnCooldown(cdKey);
      const cooldownAllows = history.bunchingCooldownAllows({
        kind: 'bus-multi',
        route: pk,
        candidate: { vehicleCount: cluster.vehicles.length, severityFt: cluster.spanFt },
      });
      if (cd && !cooldownAllows) {
        console.log('  skip: on cooldown');
        recordSkip(cluster, pk, 'cooldown');
        continue;
      }
      if (cd && cooldownAllows) cooldownOverridden = true;
      const capAllows = history.bunchingCapAllows({
        kind: 'bus-multi',
        route: pk,
        candidate: { vehicleCount: cluster.vehicles.length, severityFt: cluster.spanFt },
        cap: CROSS_BUS_DAILY_CAP,
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

  const placeName = await placeNameForCluster(chosen);
  const callouts = history.bunchingCallouts({
    kind: 'bus-multi',
    route: placeKey,
    routeLabel: placeName ? `pileup near ${placeName}` : 'multi-route pileup',
    vehicleCount: chosen.vehicles.length,
    severityFt: chosen.spanFt,
  });

  const { byRoute, labels } = groupByRoute(chosen);
  const ctx = { placeName };
  const text = buildPostText(chosen, ctx, callouts);
  const alt = buildAltText(chosen, ctx);

  let image;
  try {
    const { points, legend } = pointsFromCluster(chosen.vehicles, {
      idOf: (v) => v.vid,
      groupKeyOf: (v) => v.route,
      labels,
      groupOrder: byRoute.map((g) => g.route),
      legendLabelOf: (r) => routeLabel(r),
    });
    image = await renderCrossBunchingMap({
      points,
      legend,
      title: `${chosen.vehicles.length} buses · ${chosen.routeCount} routes`,
    });
  } catch (e) {
    console.warn(`Map render failed (${e.message}); will post text-only`);
    image = null;
  }

  if (argv['dry-run']) {
    const out = image
      ? writeDryRunAsset(
          image,
          `cross-bus-${placeKey.replace(/[^a-z0-9]+/gi, '-')}-${Date.now()}.jpg`,
        )
      : '(render failed — text only)';
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${out}`);
    return;
  }

  const baseEvent = {
    kind: 'bus-multi',
    route: placeKey,
    direction: chosen.routes.join(','),
    vehicleCount: chosen.vehicles.length,
    severityFt: chosen.spanFt,
    nearStop: placeName,
    memberIds: chosen.vehicles.map((v) => v.vid),
  };
  await commitAndPost({
    cooldownKeys: [`xbunch:bus:${placeKey}`],
    forceClearCooldown: cooldownOverridden,
    recordSkip: () => history.recordBunching({ ...baseEvent, posted: false }),
    agentLogin: loginBus,
    image,
    text,
    alt,
    recordPosted: (primary) => {
      history.recordBunching({ ...baseEvent, posted: true, postUri: primary.uri });
      history.recordMetaSignal({
        kind: 'bus',
        line: placeKey,
        direction: chosen.routes.join(','),
        source: 'cross-bunching',
        severity: Math.min(1, chosen.vehicles.length / 5),
        detail: { vehicles: chosen.vehicles.length, routes: chosen.routes, nearStop: placeName },
        posted: true,
      });
    },
    postWithImage,
    postText,
  });
}

runBin(main);
