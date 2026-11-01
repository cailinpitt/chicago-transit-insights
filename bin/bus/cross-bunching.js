#!/usr/bin/env node
// Cross-route bus bunching: a cluster at one spot involving 2+ routes (e.g.
// 2 #22 + 3 #36 close together at Clark & Belmont). detect → render intersection map →
// post (bus account), with the bunching incident lifecycle keyed on the PLACE
// instead of a route. Runs just before bin/bus/bunching.js so its posted
// clusters suppress the per-route post for the same buses. Replies with a
// ~10-min timelapse of the cluster (from observation history). Supports --dry-run.
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { getVehiclesCachedOrFresh } = require('../../src/bus/api');
const { allRoutes: bunchingRoutes } = require('../../src/bus/routes');
const {
  detectCrossRouteBunches,
  groupByRoute,
  isAtTerminal,
} = require('../../src/bus/crossBunching');
const { findParkedBusVids, PARKED_WINDOW_MS } = require('../../src/bus/bunching');
const { getRecentBusObservationsByRoute } = require('../../src/shared/observations');
const { loadPattern } = require('../../src/bus/patterns');
const { haversineFt } = require('../../src/shared/geo');
const { renderCrossBunchingMap, pointsFromCluster } = require('../../src/map');
const { captureCrossBunchingVideo } = require('../../src/map/crossBunchingVideo');
const {
  buildPostText,
  buildAltText,
  buildVideoPostText,
  buildVideoAltText,
  routeLabel,
} = require('../../src/bus/crossBunchingPost');
const { loginBus, postWithImage, postWithVideo, postText } = require('../../src/bus/bluesky');
const { isOnCooldown } = require('../../src/shared/state');
const { commitAndPost } = require('../../src/shared/postDetection');
const history = require('../../src/shared/history');
const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');

const PLACE_MAX_FT = 1200;
const CROSS_BUS_DAILY_CAP = 3;
const VIDEO_WINDOW_MS = 10 * 60 * 1000; // history window for the timelapse reply

function placeKeyFor(centroid) {
  return `${centroid.lat.toFixed(3)},${centroid.lon.toFixed(3)}`;
}

// Layover gate: a parked bus sitting at its pattern terminal (start-of-run or
// end-of-run) is between trips, not stuck in traffic — and several routes lay
// over together at the same transit center (e.g. Midway, where 47/55/63 all
// terminate), which otherwise reads as a multi-route street cluster. Returns the
// subset of `vehicles` (vids) to drop before clustering. Pattern lengths come
// from the cached pattern loader; lookups are memoized per pid.
//
// Unlike MARTA, we deliberately do NOT add a "near any 'L' station" signal:
// downtown 'L' stations are 30–400 ft apart, so a proximity tag would blanket
// the Loop and suppress legitimate downtown bunching. The pattern-terminal test
// is the safe, precise signal — a Loop bus stuck in traffic is mid-pattern, not
// at a terminal, so it survives.
async function findLayoverVids(vehicles, stoppedIds) {
  const lenByPid = new Map();
  const layoverIds = new Set();
  for (const v of vehicles) {
    if (!stoppedIds.has(v.vid) || !v.pid || v.pdist == null) continue;
    if (!lenByPid.has(v.pid)) {
      let len = null;
      try {
        len = (await loadPattern(v.pid)).lengthFt;
      } catch {
        len = null;
      }
      lenByPid.set(v.pid, len);
    }
    if (isAtTerminal(parseFloat(v.pdist), lenByPid.get(v.pid))) layoverIds.add(v.vid);
  }
  return layoverIds;
}

// Name the cluster by the nearest stop across the involved routes' patterns
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

// Route-line overlays for the map: for each route group, draw the pattern the
// cluster is actually sitting on. We pick the clustered bus of that route nearest
// the centroid and load its pattern (buses in a bunch share a pid, so any of
// them resolves the same line through the corner). groupIndex matches the disc
// color so each line ties to its vehicles + legend. Best-effort — a route whose
// pattern won't load is just left without a line.
async function buildRoutePaths(cluster, groupOrder) {
  const paths = [];
  for (let groupIndex = 0; groupIndex < groupOrder.length; groupIndex++) {
    const route = groupOrder[groupIndex];
    const members = cluster.vehicles.filter((v) => v.route === route && v.pid);
    if (members.length === 0) continue;
    const rep = members.reduce((a, b) =>
      haversineFt(b, cluster.centroid) < haversineFt(a, cluster.centroid) ? b : a,
    );
    let pattern;
    try {
      pattern = await loadPattern(rep.pid);
    } catch {
      continue;
    }
    const points = (pattern.points || [])
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .map((p) => ({ lat: p.lat, lon: p.lon }));
    if (points.length >= 2) paths.push({ points, groupIndex });
  }
  return paths;
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

  const layoverIds = await findLayoverVids(vehicles, stoppedIds);
  if (layoverIds.size > 0)
    console.log(`Excluding ${layoverIds.size} layover bus(es) at terminals/bays`);

  const clusters = detectCrossRouteBunches(vehicles, { now: nowMs, stoppedIds, layoverIds });
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
    if (closed.length > 0) console.log(`Resolved ${closed.length} open cross-route bus cluster(s)`);
  }
  if (clusters.length === 0) {
    console.log('No cross-route bus bunching detected');
    return;
  }
  console.log(`Found ${clusters.length} candidate cross-route cluster(s)`);

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
    routeLabel: placeName ? `cluster near ${placeName}` : 'multi-route cluster',
    calloutNoun: '',
    vehicleCount: chosen.vehicles.length,
    severityFt: chosen.spanFt,
  });

  const { byRoute, labels } = groupByRoute(chosen);
  const ctx = { placeName };
  const text = buildPostText(chosen, ctx, callouts);
  const alt = buildAltText(chosen, ctx);

  const { points, legend } = pointsFromCluster(chosen.vehicles, {
    idOf: (v) => v.vid,
    groupKeyOf: (v) => v.route,
    labels,
    groupOrder: byRoute.map((g) => g.route),
    legendLabelOf: (r) => routeLabel(r),
  });
  const mapTitle = `${chosen.vehicles.length} buses · ${chosen.routeCount} routes`;
  const routePaths = await buildRoutePaths(
    chosen,
    byRoute.map((g) => g.route),
  );

  let image;
  try {
    image = await renderCrossBunchingMap({
      points,
      legend,
      title: mapTitle,
      markerKind: 'bus',
      routePaths,
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
  const posted = await commitAndPost({
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

  // Timelapse reply is non-fatal — the primary post already went out. Built from
  // observation history (the observe-buses loop records positions every 30s).
  if (posted?.primary?.uri) {
    try {
      const groupOrder = byRoute.map((g) => g.route);
      const groupIndexByRoute = new Map(groupOrder.map((r, i) => [r, i]));
      const routeByVid = new Map(chosen.vehicles.map((v) => [String(v.vid), v.route]));
      const memberSet = new Set(chosen.vehicles.map((v) => String(v.vid)));
      const recent = getRecentBusObservationsByRoute(routes, Date.now() - VIDEO_WINDOW_MS);
      const videoRows = [...recent.values()]
        .flat()
        .filter(
          (o) => memberSet.has(String(o.vid)) && Number.isFinite(o.lat) && Number.isFinite(o.lon),
        )
        .map((o) => ({
          id: String(o.vid),
          lat: o.lat,
          lon: o.lon,
          ts: o.ts,
          label: String(labels.get(o.vid) ?? '?'),
          groupIndex: groupIndexByRoute.get(routeByVid.get(String(o.vid))) ?? 0,
        }));
      const video = await captureCrossBunchingVideo(videoRows, {
        legend,
        title: mapTitle,
        markerKind: 'bus',
        routePaths,
      });
      if (!video) {
        console.log('Timelapse history produced <2 frames, skipping reply');
        return;
      }
      const replyRef = {
        root: { uri: posted.primary.uri, cid: posted.primary.cid },
        parent: { uri: posted.primary.uri, cid: posted.primary.cid },
      };
      const reply = await postWithVideo(
        posted.agent,
        buildVideoPostText(video, chosen),
        video.buffer,
        buildVideoAltText(chosen, ctx),
        replyRef,
      );
      console.log(`Timelapse reply: ${reply.url}`);
    } catch (e) {
      console.warn(`Timelapse reply failed: ${e.message}`);
    }
  }
}

runBin(main);
