// Detects dead segments on a rail line: stretches where no train has appeared
// recently enough that something is probably wrong. Pure function — no DB
// writes; persistence/cooldown gating lives in the bin script.
//
// Each branch is binned by along-track distance; a bin is "cold" when no
// train has projected into it within max(2.5× headway, 15 min) — the
// multiplier lets the threshold open up during sparse off-peak service while
// the floor keeps peak detection from getting jumpy. Loop lines
// (Brown/Orange/Pink/Purple) split into outbound/inbound branches sharing
// geometry but filtered by Train Tracker direction code, so single-direction
// outages don't get masked by trains running the other way.
//
// A candidate is admitted via any of three paths (composite gate):
//   passLong  — run length ≥ 2 mi (sparse outer-branch fallback)
//   passMulti — ≥ 2 stations completely inside the cold run
//   passSolo  — ≥ 1 station + ≥3 expected-but-missed trains + ≥3× headway
//               cold time (excludes held-train false positives)
// Returns { skipped, candidates } so the bin can distinguish "no signal"
// (don't touch existing pulse_state) from "all clear" (advance clear ticks).

const {
  buildLineBranches,
  snapToLineWithPerp,
  inLoopTrunk,
  LOOP_TRUNK_LINES,
} = require('./speedmap');
const { lineLabel } = require('./api');
const { terminalZoneFt } = require('../shared/geo');

const MAX_PERP_FT = 1500; // reject projections from off-branch trains
const DEFAULT_LOOKBACK_MS = 20 * 60 * 1000;
const DEFAULT_BIN_FT = 1320; // 0.25 mi
const DEFAULT_MIN_RUN_FT_LONG = 10560; // 2 mi — sparse outer-branch fallback
const DEFAULT_MIN_COLD_MS = 15 * 60 * 1000;
// Multipliers on scheduled headway. The headway-driven threshold scales the
// detector with service density: peak weekday (~4 min) clamps at the 15-min
// floor (3.75× headway), Sunday midday (~10 min) opens to 25 min (2.5× ⇒
// would-have-prevented the 2026-05-03 Montrose→Belmont 16-min false alarm),
// late-night sparse service (~15 min) opens to 37.5 min.
const COLD_HEADWAY_MULT = 2.5;
const COLD_HEADWAY_MULT_STRICT = 3.5;
const DEFAULT_MIN_COVERAGE_FRAC = 0.5;
const DEFAULT_MIN_SPAN_FRAC = 0.5;
// Number of expected-but-missed trains required for the 1-station passSolo
// admit path. Three trains in a row going missing isn't normal variance.
const SOLO_EXPECTED_TRAINS = 3;

// Express-overlay margins (Purple — see opts.overlay / trainOverlayInfo).
// South of the base terminal (Howard): require 1.5× the Express-headway cold
// threshold so normal sparse Express spacing doesn't post. North of it
// (Evanston shuttle): short cold runs need 1.25× the blended threshold so a
// single skipped/bunched shuttle train doesn't post.
const OVERLAY_SOUTH_MARGIN = 1.5;
const BASE_SHUTTLE_MARGIN = 1.25;
const BASE_SHUTTLE_MAX_STATIONS = 3;

// Concrete-onset recovery. A cold run is only detected once it's *already*
// been cold a while, so the last train through it frequently predates the
// detection lookback — leaving `lastSeenInRunMs` null and the published onset
// falling back to the cold-threshold floor (a lower bound, not a measurement).
// We retain ~7d of positions and already hold a 2h slice here
// (longLookbackPositions), so we can pin a concrete start by scanning it for
// the most recent train actually inside the stretch. Two guards keep the
// estimate honest:
//   - ONSET_WIDEN_CAP_MS: never back-date onset more than 2h, so a stretch
//     cold longer than our slice stays on the floor rather than guessing.
//   - ONSET_SERVICE_GAP_MS: if the line as a whole fell silent for ≥30 min
//     after the run's last train (overnight / end-of-service), the last train
//     sits on the far side of a scheduled break — clamp onset to when
//     line-wide service resumed instead of pinning it to last night's train.
const ONSET_WIDEN_CAP_MS = 2 * 60 * 60 * 1000;
const ONSET_SERVICE_GAP_MS = 30 * 60 * 1000;

// Most recent moment a train was actually inside [runLoFt, runHiFt] on this
// branch within the 2h cap, guarded against crossing a line-wide service
// break. `positions` is the 2h longLookbackPositions slice ({ts, lat, lon,
// trDr}). Returns a ts (ms), or null when the stretch has been cold longer
// than the cap (caller keeps the floored onset).
function recoverConcreteOnset({ positions, points, cumDist, trDrFilter, runLoFt, runHiFt, now }) {
  const floorTs = now - ONSET_WIDEN_CAP_MS;
  let lastInRun = -Infinity;
  const lineTs = [];
  for (const p of positions) {
    if (p.ts < floorTs) continue;
    lineTs.push(p.ts);
    if (trDrFilter && p.trDr !== trDrFilter) continue;
    const { cumDist: along, perpDist } = snapToLineWithPerp(p.lat, p.lon, points, cumDist);
    if (perpDist > MAX_PERP_FT) continue;
    if (along >= runLoFt && along <= runHiFt && p.ts > lastInRun) lastInRun = p.ts;
  }
  if (lastInRun === -Infinity) return null;
  // Overnight/service guard: a ≥30-min line-wide silence after the run's last
  // train marks a scheduled break, not the disruption. Clamp onset to the
  // first line-wide observation after the most recent such gap.
  lineTs.sort((a, b) => a - b);
  let resumedTs = null;
  for (let i = 1; i < lineTs.length; i++) {
    if (lineTs[i] - lineTs[i - 1] >= ONSET_SERVICE_GAP_MS && lineTs[i] > lastInRun) {
      resumedTs = lineTs[i];
    }
  }
  return resumedTs != null ? Math.max(lastInRun, resumedTs) : lastInRun;
}

// Feed-coverage guard. When the upstream Train Tracker feed / observe-trains
// ingestion stalls, the whole fleet stops reporting at once — and when it
// recovers it often replays stale positions for a few minutes. Both make
// cold-segment and synthetic full-line detection unreliable: absence of an
// observation no longer means absence of a train. detectFeedGap inspects the
// GLOBAL snapshot timestamps (every line) over the recent window and reports
// the largest stretch with no snapshot — counting the leading edge (window
// start → first snapshot) and trailing edge (last snapshot → now) as well as
// internal gaps. The leading edge matters because a gap that has scrolled to
// the start of the window still poisons a detector whose lookback reaches into
// it (the "recovery shadow" — FPs kept firing ~20 min after the feed came
// back on 2026-05-28). Red/Blue run 24h so the global feed has a snapshot
// every ~1–2 min around the clock; a ≥5 min gap is an outage, not sparse
// service. The 30 min window keeps the guard active through the recovery
// shadow without suppressing normal pulses.
const FEED_GAP_LOOKBACK_MS = 30 * 60 * 1000;
const FEED_GAP_MS = 5 * 60 * 1000;

function detectFeedGap({
  positions,
  now,
  lookbackMs = FEED_GAP_LOOKBACK_MS,
  maxGapMs = FEED_GAP_MS,
}) {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const since = nowMs - lookbackMs;
  const tsList = [
    ...new Set(positions.map((p) => p.ts).filter((t) => t >= since && t <= nowMs)),
  ].sort((a, b) => a - b);
  // No global snapshots at all in the window = total outage.
  if (tsList.length === 0) return { gap: true, maxGapMs: lookbackMs };
  let maxGap = Math.max(tsList[0] - since, nowMs - tsList[tsList.length - 1]);
  for (let i = 1; i < tsList.length; i++) {
    const g = tsList[i] - tsList[i - 1];
    if (g > maxGap) maxGap = g;
  }
  return { gap: maxGap >= maxGapMs, maxGapMs: maxGap };
}

function detectDeadSegments({ line, trainLines, stations, headwayMin, now, opts = {} }) {
  const lookbackMs = opts.lookbackMs || DEFAULT_LOOKBACK_MS;
  const binFt = opts.binFt || DEFAULT_BIN_FT;
  const minRunFtLong = opts.minRunFt || DEFAULT_MIN_RUN_FT_LONG;
  const minCoverageFrac =
    opts.minCoverageFrac != null ? opts.minCoverageFrac : DEFAULT_MIN_COVERAGE_FRAC;
  const minSpanFrac = opts.minSpanFrac != null ? opts.minSpanFrac : DEFAULT_MIN_SPAN_FRAC;
  const coldThresholdMs = Math.max(
    DEFAULT_MIN_COLD_MS,
    headwayMin != null ? COLD_HEADWAY_MULT * headwayMin * 60 * 1000 : DEFAULT_MIN_COLD_MS,
  );
  const coldThresholdMsStrict = Math.max(
    DEFAULT_MIN_COLD_MS,
    headwayMin != null ? COLD_HEADWAY_MULT_STRICT * headwayMin * 60 * 1000 : DEFAULT_MIN_COLD_MS,
  );

  const branches = buildLineBranches(trainLines, line);
  if (branches.length === 0) return { skipped: 'no-branches', candidates: [] };

  const recent = opts.recentPositions || [];
  const sinceTs = now - lookbackMs;
  const fresh = recent.filter((p) => p.ts >= sinceTs);

  if (fresh.length === 0) return { skipped: 'noobs', candidates: [] };
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const p of fresh) {
    if (p.ts < minTs) minTs = p.ts;
    if (p.ts > maxTs) maxTs = p.ts;
  }
  if (maxTs - minTs < lookbackMs * minSpanFrac) {
    return { skipped: 'sparse-span', candidates: [] };
  }

  const candidates = [];
  let allBranchesSparse = true;
  for (let branchIdx = 0; branchIdx < branches.length; branchIdx++) {
    const branch = branches[branchIdx];
    const { points, cumDist, totalFt, trDrFilter, directionHint } = branch;
    if (points.length < 2 || !totalFt) continue;

    // Round-trip lines split into outbound/inbound branches sharing geometry
    // — filter observations by Train Tracker direction code so each branch
    // sees only its half of the traffic. Exception: bins on the Loop trunk
    // (Lake/Wabash/Van Buren/Wells) accept either direction, because
    // TrainTracker flips trDr at the Loop apex mid-circuit and a Brown
    // inbound train tagged "outbound" while still on the south Loop would
    // otherwise leave inbound bins falsely cold.
    const branchObs = fresh;

    const numBins = Math.max(2, Math.ceil(totalFt / binFt));
    const binLengthFt = totalFt / numBins;
    const loopTrunkBin = new Array(numBins).fill(false);
    const useLoopTrunkOverride = trDrFilter && LOOP_TRUNK_LINES.has(line);
    if (useLoopTrunkOverride) {
      for (let i = 0; i < points.length; i++) {
        const pt = points[i];
        const lat = pt.lat != null ? pt.lat : pt[0];
        const lon = pt.lon != null ? pt.lon : pt[1];
        if (!inLoopTrunk(lat, lon)) continue;
        const idx = Math.min(numBins - 1, Math.max(0, Math.floor(cumDist[i] / binLengthFt)));
        loopTrunkBin[idx] = true;
      }
    }
    const lastSeenPerBin = new Array(numBins).fill(-Infinity);
    const binIdxOfPos = [];
    // Per-train trajectories, used downstream to detect trains that crossed
    // the cold run between snapshots — at ~3-5 min observer cadence, trains
    // moving at typical speeds traverse a 0.25mi bin in <60s and frequently
    // skip over a 1mi run between adjacent obs without ever being recorded
    // inside it. Without this check, fast traversals look identical to true
    // outages.
    const trajByRun = new Map();
    // Track unique runs seen anywhere on the branch + which of those touched
    // a bin inside the cold run, so trainsOutsideRun counts trains, not raw
    // observation rows (with ~15s observation cadence, each train contributes
    // ~80 rows in a 20 min lookback — counting rows produced absurd numbers
    // like "171 trains active elsewhere on the line" for a 5-train line).
    const runsOnBranch = new Set();
    const binIdxOfRun = [];

    for (const p of branchObs) {
      const { cumDist: along, perpDist } = snapToLineWithPerp(p.lat, p.lon, points, cumDist);
      if (perpDist > MAX_PERP_FT) continue;
      const idx = Math.min(numBins - 1, Math.max(0, Math.floor(along / (totalFt / numBins))));
      if (trDrFilter && p.trDr !== trDrFilter && !(useLoopTrunkOverride && loopTrunkBin[idx])) {
        continue;
      }
      if (p.ts > lastSeenPerBin[idx]) lastSeenPerBin[idx] = p.ts;
      binIdxOfPos.push(idx);
      if (p.rn) {
        runsOnBranch.add(p.rn);
        binIdxOfRun.push({ rn: p.rn, idx });
        let traj = trajByRun.get(p.rn);
        if (!traj) {
          traj = [];
          trajByRun.set(p.rn, traj);
        }
        traj.push({ ts: p.ts, along });
      }
    }

    const zoneFt = terminalZoneFt(totalFt);
    const zoneBins = Math.ceil(zoneFt / (totalFt / numBins));
    if (numBins - 2 * zoneBins < 4) {
      console.warn(
        `[pulse] line=${lineLabel(line)} branch=${branchIdx} eligible scan range only ${numBins - 2 * zoneBins} bins — short branch may misfire`,
      );
    }

    // Active-service-range clip. Per branch, project recent-window obs onto
    // the polyline and take the [min, max] along-track span. Bins outside
    // that span aren't part of current service and are skipped.
    //
    // For round-trip lines with a trDrFilter, scope to obs matching the
    // candidate's direction (Bug 16, 2026-05-15 Howard→Armitage FP). The
    // earlier all-direction approach assumed both directions go quiet
    // together at end-of-service, but during the ~30-min PM Express
    // wind-down on Purple, NB returns (trDr=1, dest Linden) keep traversing
    // the Loop trunk for ~30 min after the last SB Express has cleared.
    // That propped the SB corridor open and let Howard→Armitage cold runs
    // post. Per-direction range tightens as soon as the SB pattern stops.
    //
    // Pinned ranges (from prior pulse_state) expand the active range so a
    // long sustained outage doesn't self-mask once the active range shrinks
    // past the formerly-active stretch.
    const activeRangeWindowMs =
      opts.activeRangeWindowMs != null
        ? opts.activeRangeWindowMs
        : Math.max(20 * 60 * 1000, headwayMin != null ? headwayMin * 1.5 * 60 * 1000 : 0);
    const activeRangeSinceTs = now - activeRangeWindowMs;
    let activeLo = Infinity;
    let activeHi = -Infinity;
    for (const p of fresh) {
      if (p.ts < activeRangeSinceTs) continue;
      if (trDrFilter && p.trDr !== trDrFilter) continue;
      const { cumDist: along, perpDist } = snapToLineWithPerp(p.lat, p.lon, points, cumDist);
      if (perpDist > MAX_PERP_FT) continue;
      if (along < activeLo) activeLo = along;
      if (along > activeHi) activeHi = along;
    }
    const branchDirectionKey = directionKeyFor(branches, branchIdx, directionHint);
    if (opts.pinnedRanges) {
      const pin =
        opts.pinnedRanges instanceof Map
          ? opts.pinnedRanges.get(branchDirectionKey)
          : opts.pinnedRanges[branchDirectionKey];
      if (pin && Number.isFinite(pin.lo) && Number.isFinite(pin.hi)) {
        if (pin.lo < activeLo) activeLo = pin.lo;
        if (pin.hi > activeHi) activeHi = pin.hi;
      }
    }
    let corridorLo = 0;
    let corridorHi = numBins;
    if (Number.isFinite(activeLo) && Number.isFinite(activeHi) && activeHi > activeLo) {
      corridorLo = Math.max(0, Math.floor(activeLo / binLengthFt));
      corridorHi = Math.min(numBins, Math.ceil(activeHi / binLengthFt));
    }

    // Express-overlay schedule clip (Purple). South of the base shuttle
    // terminal (Howard) the line is served only by the peak Express overlay;
    // gate that stretch on schedule truth rather than observed trains, because
    // a lone deadhead/return-leg train otherwise props the observed corridor
    // open and the whole Loop trunk reads cold (the recurring "local vs
    // express" FP). `overlayCapFt` = base terminal along this branch; "south"
    // = beyond it toward the Loop (higher cumDist). When this direction's
    // Express peak isn't live now, clip the corridor at the base terminal so
    // no south-of-base bin can become a cold run. Stays inert for every line
    // but Purple (trainOverlayInfo returns null) and for non-direction-split
    // branches. Used again below to pick the right cold threshold.
    let overlayCapFt = null;
    let overlaySouthLive = true;
    if (opts.overlay && opts.overlay.baseLat != null && directionHint) {
      const snap = snapToLineWithPerp(opts.overlay.baseLat, opts.overlay.baseLon, points, cumDist);
      if (snap.perpDist <= MAX_PERP_FT) {
        overlayCapFt = snap.cumDist;
        overlaySouthLive =
          directionHint === 'outbound'
            ? !!opts.overlay.southLiveOutbound
            : !!opts.overlay.southLiveInbound;
        if (!overlaySouthLive) {
          corridorHi = Math.min(corridorHi, Math.floor(overlayCapFt / binLengthFt));
        }
      }
    }

    let coveredBins = 0;
    let corridorBinCount = 0;
    for (let i = 0; i < numBins; i++) {
      if (i < corridorLo || i >= corridorHi) continue;
      corridorBinCount++;
      if (lastSeenPerBin[i] > -Infinity) coveredBins++;
    }
    if (corridorBinCount > 0 && coveredBins / corridorBinCount < minCoverageFrac) continue;
    allBranchesSparse = false;

    const coldBefore = now - coldThresholdMs;
    const cold = lastSeenPerBin.map((ts) => ts < coldBefore);

    let bestStart = -1;
    let bestEnd = -1;
    let curStart = -1;
    const scanStart = Math.max(zoneBins, corridorLo);
    const scanEnd = Math.min(numBins - zoneBins, corridorHi);
    for (let i = scanStart; i < scanEnd; i++) {
      if (cold[i]) {
        if (curStart < 0) curStart = i;
        const curEnd = i;
        if (bestEnd - bestStart < curEnd - curStart) {
          bestStart = curStart;
          bestEnd = curEnd;
        }
      } else {
        curStart = -1;
      }
    }
    if (bestStart < 0) continue;

    const runLoFt = bestStart * binLengthFt;
    const runHiFt = (bestEnd + 1) * binLengthFt;
    const runLengthFt = runHiFt - runLoFt;

    const stationsOnBranch = stationsAlongBranch(stations, line, points, cumDist);
    // Bug 19: clip from/to to stations strictly inside the cold run rather
    // than reaching out to the nearest station, which used to push the named
    // endpoints past the terminal-zone clip.
    const stationsInRun = stationsOnBranch.filter(
      (s) => s.trackDist >= runLoFt && s.trackDist <= runHiFt,
    );
    if (stationsInRun.length < 1) continue;
    const fromStation = stationsInRun[0];
    const toStation = stationsInRun[stationsInRun.length - 1];
    // A run that only resolves to one station (or two with the same name)
    // doesn't yield a renderable suspended-segment polyline downstream and
    // can't be described as "X to Y" in a post. Skip rather than emit a
    // degenerate "Halsted → Halsted" candidate.
    if (fromStation.station.name === toStation.station.name) continue;

    // Turnaround-tail veto: on round-trip lines (Brown/Orange/Pink/Purple)
    // each branch is filtered by trDr, but Train Tracker flips trDr at the
    // terminal as trains turn around. The geometric terminal-zone clip
    // (terminalZoneFt = 1500 ft) misses cases where the run sits just
    // outside the zone but still names the branch's first/last station as
    // `to`. Reject those.
    if (trDrFilter && stationsOnBranch.length >= 2) {
      const branchHead = stationsOnBranch[0].station.name;
      const branchTail = stationsOnBranch[stationsOnBranch.length - 1].station.name;
      if (
        fromStation.station.name === branchHead ||
        toStation.station.name === branchHead ||
        fromStation.station.name === branchTail ||
        toStation.station.name === branchTail
      ) {
        continue;
      }
    }

    // Trailing-edge veto: on a direction-filtered branch, a cold run that
    // has no dir-matched obs `downstream` of it (toward where trains exit
    // the run) in the active-range window is not an outage — it's the
    // trailing edge of where service is currently flowing. Two cases this
    // catches that nothing else does:
    //   (1) Mid-polyline turnarounds: Purple's polyline encodes the full
    //       Linden→Loop run but most off-peak service is the Linden↔Howard
    //       shuttle. On the outbound branch (trDr=1, toward Linden), trains
    //       finishing their NB run near Linden flip to trDr=5 as they turn
    //       around, leaving Central/Noyes/Davis with no recent trDr=1 obs
    //       downstream (toward Linden) — the 2026-05-12 Central→Noyes FP.
    //   (2) End-of-service for an express overlay: PM Express ends ~6:55 PM,
    //       so by ~7:30 PM there are no trDr=1 obs in the Loop trunk
    //       downstream of any Loop-trunk cold run. The active-range clip
    //       above usually catches this first, but the trailing-edge veto is
    //       a robust backstop when the active range is still wide due to a
    //       single late straggler.
    // Downstream depends on flow direction: outbound flows decreasing
    // cumDist (exits at runLoFt), inbound flows increasing cumDist (exits
    // at runHiFt). The veto skips lines with no directionHint (Blue/Green-
    // style bidirectional branches) because there's no single downstream.
    if (trDrFilter && directionHint && Number.isFinite(activeRangeSinceTs)) {
      const flowIncreasing = directionHint !== 'outbound';
      let foundDownstream = false;
      for (const p of fresh) {
        if (p.ts < activeRangeSinceTs) continue;
        if (p.trDr !== trDrFilter) continue;
        const { cumDist: along, perpDist } = snapToLineWithPerp(p.lat, p.lon, points, cumDist);
        if (perpDist > MAX_PERP_FT) continue;
        if (flowIncreasing ? along > runHiFt : along < runLoFt) {
          foundDownstream = true;
          break;
        }
      }
      if (!foundDownstream) continue;
    }

    // Service-pattern-terminus veto. The trailing-edge veto above only fires
    // when no flow exists past the run; the 2026-05-14 Howard→Belmont FP
    // showed that's not enough. There, a single late-Express deadhead lingered
    // past Belmont (foundDownstream=true) while the only fresh upstream traffic
    // was the Linden↔Howard shuttle terminating at Howard — the cold-run entry.
    // Two disjoint service patterns, with the cold run being the structural gap
    // between them, not an outage.
    //
    // Veto when: in the active-range window, every *moving* trDr-matched run
    // with obs strictly upstream of the cold run carries a destination string
    // equal to the cold-run entry station (fromStation) — meaning that pattern
    // is *designed* to stop at the entry — AND at least one trDr-matched run
    // exists strictly past the run (the structural-gap signature) AND no run
    // has obs both upstream and at-or-past the run (no traversal in the
    // window). A real held-train outage doesn't qualify: piled-up trains
    // approaching the entry carry their normal destination (e.g. "95th/Dan
    // Ryan"), not the entry station's name.
    //
    // Stationary upstream runs (parked/idling at a yard, often mislabeled
    // with the next assignment's destination) are excluded — they aren't
    // service. The 2026-05-15 Howard→Armitage FP slipped past the original
    // form of this veto because a single parked train at Linden carried
    // dest=Loop, breaking the all-terminate-at-entry predicate.
    const STATIONARY_FT = 1000; // <~1 station-spacing of along movement = parked
    if (trDrFilter && directionHint && Number.isFinite(activeRangeSinceTs)) {
      const flowIncreasing = directionHint !== 'outbound';
      const runStats = new Map();
      for (const p of fresh) {
        if (p.ts < activeRangeSinceTs) continue;
        if (p.trDr !== trDrFilter) continue;
        const { cumDist: along, perpDist } = snapToLineWithPerp(p.lat, p.lon, points, cumDist);
        if (perpDist > MAX_PERP_FT) continue;
        let bucket;
        if (flowIncreasing) {
          bucket = along < runLoFt ? 'before' : along > runHiFt ? 'after' : 'in';
        } else {
          bucket = along > runHiFt ? 'before' : along < runLoFt ? 'after' : 'in';
        }
        const r = runStats.get(p.rn) || {
          before: false,
          in: false,
          after: false,
          destinations: new Set(),
          alongMin: Infinity,
          alongMax: -Infinity,
        };
        r[bucket] = true;
        if (p.destination) r.destinations.add(p.destination);
        if (along < r.alongMin) r.alongMin = along;
        if (along > r.alongMax) r.alongMax = along;
        runStats.set(p.rn, r);
      }
      const strictBefore = [];
      let strictAfter = 0;
      let traversed = 0;
      for (const r of runStats.values()) {
        const moved = r.alongMax - r.alongMin >= STATIONARY_FT;
        if (r.before && (r.in || r.after)) traversed++;
        else if (r.before) {
          if (moved) strictBefore.push(r);
        } else if (r.after && !r.in) strictAfter++;
      }
      const fromName = fromStation.station.name;
      const allTerminateAtEntry =
        strictBefore.length >= 1 &&
        strictBefore.every(
          (r) => r.destinations.size > 0 && [...r.destinations].every((d) => d === fromName),
        );
      if (traversed === 0 && strictAfter >= 1 && allTerminateAtEntry) {
        continue;
      }
    }

    // Terminal-adjacency veto: cold runs sitting at the corridor's terminal-
    // most station with `coldMs` barely clearing the threshold are usually a
    // single missed turnaround on a sparse line, not a real outage. Require a
    // 1.2× margin over threshold for terminal-adjacent runs unless the run is
    // long (passLong-ish) or a dispatch-continuity check will catch it.
    let terminalAdjacent = false;
    if (stationsOnBranch.length >= 2) {
      const corridorLoFt = corridorLo * binLengthFt;
      const corridorHiFt = corridorHi * binLengthFt;
      const corridorTerminalDistFt = 2640; // 0.5 mi
      const inCorridor = stationsOnBranch.filter(
        (s) => s.trackDist >= corridorLoFt && s.trackDist <= corridorHiFt,
      );
      if (inCorridor.length >= 2) {
        const corridorWest = inCorridor[0];
        const corridorEast = inCorridor[inCorridor.length - 1];
        const fromIsTerminalAdjacent =
          Math.abs(fromStation.trackDist - corridorWest.trackDist) <= corridorTerminalDistFt ||
          Math.abs(fromStation.trackDist - corridorEast.trackDist) <= corridorTerminalDistFt;
        const toIsTerminalAdjacent =
          Math.abs(toStation.trackDist - corridorWest.trackDist) <= corridorTerminalDistFt ||
          Math.abs(toStation.trackDist - corridorEast.trackDist) <= corridorTerminalDistFt;
        terminalAdjacent = fromIsTerminalAdjacent || toIsTerminalAdjacent;
      }
    }

    // Ramp-up veto: the day's first direction-matching train may simply not
    // have reached this stretch yet. Brown 06:10 FPs are the canonical case —
    // outbound service started at 05:34, but vehicle 401 was still climbing
    // toward Western and hadn't entered Francisco↔Irving Park. The 20 min
    // lookback can't tell that apart from a real outage; a 2 h lookback can.
    //
    // Direction matters: loop-line pruned polylines start at the outer
    // terminal (cumDist=0) and end at the Loop (cumDist=max). Inbound trains
    // flow with increasing cumDist (Kimball→Loop); outbound trains flow with
    // decreasing cumDist (Loop→Kimball). The "near edge" of the cold run —
    // the side trains enter from — is therefore runLoFt for inbound and
    // runHiFt for outbound. The original implementation only checked the
    // inbound case, which is why Brown 06:10 outbound kept firing despite
    // vehicle 401 being miles short of the run.
    if (opts.longLookbackPositions && opts.longLookbackPositions.length > 0 && trDrFilter) {
      let maxAlongDirMatch = -Infinity;
      let minAlongDirMatch = Infinity;
      for (const p of opts.longLookbackPositions) {
        if (p.trDr !== trDrFilter) continue;
        const { cumDist: along, perpDist } = snapToLineWithPerp(p.lat, p.lon, points, cumDist);
        if (perpDist > MAX_PERP_FT) continue;
        if (along > maxAlongDirMatch) maxAlongDirMatch = along;
        if (along < minAlongDirMatch) minAlongDirMatch = along;
      }
      const flowIncreasing = directionHint !== 'outbound';
      const reachedNearEdge = flowIncreasing
        ? maxAlongDirMatch >= runLoFt
        : minAlongDirMatch <= runHiFt;
      if (!reachedNearEdge) {
        const edgeLabel = flowIncreasing ? 'runLoFt' : 'runHiFt';
        const edgeFt = flowIncreasing ? runLoFt : runHiFt;
        const reachFt = flowIncreasing ? maxAlongDirMatch : minAlongDirMatch;
        const reachStr = Number.isFinite(reachFt) ? `${(reachFt / 5280).toFixed(1)}mi` : 'none';
        console.log(
          `[${lineLabel(line)}/${directionKeyFor(branches, branchIdx, directionHint)}] ramp-up suppressed: no direction-${trDrFilter} obs reached ${edgeLabel}=${(edgeFt / 5280).toFixed(1)}mi in past 2h (front=${reachStr})`,
        );
        continue;
      }
    }

    // Aliasing veto: did any train's consecutive observations bracket the
    // cold run? If so, the train physically crossed it between snapshots —
    // not a true outage, just a fast traversal.
    let crossed = false;
    for (const traj of trajByRun.values()) {
      if (traj.length < 2) continue;
      traj.sort((a, b) => a.ts - b.ts);
      for (let i = 1; i < traj.length; i++) {
        const a = traj[i - 1].along;
        const b = traj[i].along;
        if ((a < runLoFt && b > runHiFt) || (a > runHiFt && b < runLoFt)) {
          crossed = true;
          break;
        }
      }
      if (crossed) break;
    }
    if (crossed) continue;

    let lastSeenInRun = -Infinity;
    for (let i = bestStart; i <= bestEnd; i++) {
      if (lastSeenPerBin[i] > lastSeenInRun) lastSeenInRun = lastSeenPerBin[i];
    }
    const runsInRun = new Set();
    for (const { rn, idx } of binIdxOfRun) {
      if (idx >= bestStart && idx <= bestEnd) runsInRun.add(rn);
    }
    let trainsOutsideRun = 0;
    for (const rn of runsOnBranch) if (!runsInRun.has(rn)) trainsOutsideRun++;

    const lastSeenInRunMs = lastSeenInRun > -Infinity ? lastSeenInRun : null;
    // `coldMs` / the admit gate below deliberately stay on the narrow-window
    // value (floored to lookbackMs) so detection sensitivity is unchanged.
    const coldMs = lastSeenInRunMs ? now - lastSeenInRunMs : lookbackMs;
    // `onsetTs` is the reported start. Concrete when we saw a train in the run
    // within the lookback; otherwise recovered from the wider 2h slice so the
    // published onset reflects the real gap start rather than the floor.
    let onsetTs = lastSeenInRunMs;
    if (
      lastSeenInRunMs == null &&
      opts.longLookbackPositions &&
      opts.longLookbackPositions.length
    ) {
      onsetTs = recoverConcreteOnset({
        positions: opts.longLookbackPositions,
        points,
        cumDist,
        trDrFilter,
        runLoFt,
        runHiFt,
        now,
      });
    }
    const expectedTrains = headwayMin ? Math.floor(coldMs / 60_000 / headwayMin) : null;
    const coldStations = stationsInRun.length;
    const coldStationNames = stationsInRun.map((s) => s.station.name);

    // Direction-of-travel destination for the trDr-matched feed, derived
    // empirically from per-run net displacement. Lets the title say "trains
    // to Howard not seen" on a Sunday Purple shuttle (where inbound trains
    // terminate at Howard) instead of the static "trains to the Loop" —
    // which is only correct on weekday peak when Express service runs
    // through. Earlier heuristic compared along-extremes to the branch
    // midpoint, which silently picked the wrong end whenever trDr-matched
    // trains traversed (or nearly traversed) the full corridor — both
    // extremes were equidistant from the midpoint and the tiebreak defaulted
    // to the high-cumDist station, producing reversed direction text on
    // Pink/Purple branch-0-outbound posts.
    let directionDestinationName = null;
    if (trDrFilter && stationsOnBranch.length >= 2) {
      const runFirst = new Map();
      const runLast = new Map();
      for (const p of branchObs) {
        if (p.trDr !== trDrFilter) continue;
        if (p.rn == null) continue;
        const { cumDist: along, perpDist } = snapToLineWithPerp(p.lat, p.lon, points, cumDist);
        if (perpDist > MAX_PERP_FT) continue;
        const f = runFirst.get(p.rn);
        if (!f || p.ts < f.ts) runFirst.set(p.rn, { ts: p.ts, along });
        const l = runLast.get(p.rn);
        if (!l || p.ts > l.ts) runLast.set(p.rn, { ts: p.ts, along });
      }
      let netDisplacement = 0;
      for (const [rn, first] of runFirst) {
        const last = runLast.get(rn);
        if (!last || last.ts === first.ts) continue;
        netDisplacement += last.along - first.along;
      }
      if (netDisplacement !== 0) {
        const towardHi = netDisplacement > 0;
        const corridorLoFt = corridorLo * (totalFt / numBins);
        const corridorHiFt = corridorHi * (totalFt / numBins);
        const inCorridor = stationsOnBranch.filter(
          (s) => s.trackDist >= corridorLoFt && s.trackDist <= corridorHiFt,
        );
        if (inCorridor.length > 0) {
          const dest = towardHi ? inCorridor[inCorridor.length - 1] : inCorridor[0];
          // If the picked terminus station sits inside the Loop trunk on a
          // Loop-circling line (Brown/Orange/Pink/Purple), leave the empirical
          // name unset so terminusFor() falls back to the "the Loop" string.
          // Naming a specific Loop station ("Harold Washington Library",
          // "Quincy") misleads readers — these lines circle through the Loop
          // rather than terminating at any one stop on it.
          const stLat = dest.station.lat;
          const stLon = dest.station.lon;
          const inTrunk =
            LOOP_TRUNK_LINES.has(line) &&
            stLat != null &&
            stLon != null &&
            inLoopTrunk(stLat, stLon);
          if (!inTrunk) directionDestinationName = dest.station.name;
        }
      }
    }

    // Express-overlay thresholds (Purple). A cold run that reaches south of the
    // base shuttle terminal (Howard) during a live Express peak is held to the
    // *Express* headway, not the blended line headway: Express runs sparser and
    // faster than the all-day shuttle, so normal Express spacing otherwise nicks
    // the 15-min floor (the during-rush "local vs express" FPs). Requires a
    // margin over that threshold and bypasses passLong, so a long-but-normal
    // Express gap can't auto-admit. Conversely a short cold run entirely north
    // of Howard is the frequent Evanston shuttle — one skipped/bunched train,
    // not an outage — so it needs extra margin too unless it's a long run.
    if (overlayCapFt != null) {
      const reachesSouth = runHiFt > overlayCapFt;
      if (reachesSouth && opts.overlay.expressHeadwayMin) {
        const expressThresholdMs = Math.max(
          DEFAULT_MIN_COLD_MS,
          COLD_HEADWAY_MULT * opts.overlay.expressHeadwayMin * 60 * 1000,
        );
        if (coldMs < OVERLAY_SOUTH_MARGIN * expressThresholdMs) continue;
      } else if (
        !reachesSouth &&
        coldStations <= BASE_SHUTTLE_MAX_STATIONS &&
        runLengthFt < minRunFtLong &&
        coldMs < BASE_SHUTTLE_MARGIN * coldThresholdMs
      ) {
        continue;
      }
    }

    // Composite admit gate: any one of the three paths is sufficient. Minor
    // veto already happened upstream via cold-threshold + terminal exclusion.
    // Every path also requires coldMs >= coldThresholdMs — without this gate,
    // passLong/passMulti would admit a 2-mi cold run at coldMs == headway
    // (1× scheduled), which is well within natural bunching variance and
    // produced FPs on sparse-service lines (Sunday Green @ 20-min headway,
    // Pulaski→Kedzie went cold for ~20 min and tripped the alert despite
    // service running normally).
    const passLong = runLengthFt >= minRunFtLong && coldMs >= coldThresholdMs;
    const passMulti = coldStations >= 2 && coldMs >= coldThresholdMs;
    const passSolo =
      coldStations >= 1 &&
      expectedTrains != null &&
      expectedTrains >= SOLO_EXPECTED_TRAINS &&
      coldMs >= coldThresholdMsStrict;
    if (!(passLong || passMulti || passSolo)) continue;

    // Terminal-adjacency margin: terminal-adjacent runs need 1.2× threshold
    // unless they're already long (passLong covers genuine sustained outages
    // at the line's edges).
    if (terminalAdjacent && !passLong && coldMs < 1.2 * coldThresholdMs) {
      continue;
    }

    // Dispatch-continuity veto: if GTFS says a scheduled trip start should
    // have happened in the lookback window AND coldMs is within 1.5× threshold
    // AND it's not a long sustained outage, treat as a between-dispatch gap.
    if (
      opts.expectedDispatchesInWindow != null &&
      opts.expectedDispatchesInWindow >= 1 &&
      !passLong &&
      coldMs < 1.5 * coldThresholdMs
    ) {
      continue;
    }

    // Inferred-held reclassification: the strict held detector requires ≥2
    // trains visibly stationary together for ≥10 min, but the dominant real-
    // world held failure is "trains held in place, then GPS goes silent" —
    // exactly what trips the cold detector. Recover that case by checking
    // whether any train's trajectory ENDS inside this cold run with low
    // displacement over its tail. If so, relabel the candidate as `held` so
    // the pipeline records `observed-held` and the post says trains are
    // stuck rather than missing.
    const INFERRED_TAIL_MS = 10 * 60 * 1000;
    const INFERRED_STATIONARY_FT = 500;
    const INFERRED_MIN_TAIL_SPAN_MS = 5 * 60 * 1000;
    let inferredHeld = null;
    for (const [rn, traj] of trajByRun) {
      if (traj.length < 2) continue;
      const sorted = [...traj].sort((a, b) => a.ts - b.ts);
      const last = sorted[sorted.length - 1];
      if (last.along < runLoFt || last.along > runHiFt) continue;
      const tail = sorted.filter((p) => last.ts - p.ts <= INFERRED_TAIL_MS);
      if (tail.length < 2) continue;
      let minA = Infinity;
      let maxA = -Infinity;
      for (const p of tail) {
        if (p.along < minA) minA = p.along;
        if (p.along > maxA) maxA = p.along;
      }
      const tailSpanMs = last.ts - tail[0].ts;
      if (maxA - minA <= INFERRED_STATIONARY_FT && tailSpanMs >= INFERRED_MIN_TAIL_SPAN_MS) {
        if (
          !inferredHeld ||
          tailSpanMs > inferredHeld.lastStationaryMs ||
          (tailSpanMs === inferredHeld.lastStationaryMs && last.ts > inferredHeld.lastSeenTs)
        ) {
          inferredHeld = { rn, lastStationaryMs: tailSpanMs, lastSeenTs: last.ts };
        }
      }
    }

    const candidate = {
      line,
      direction: directionKeyFor(branches, branchIdx, directionHint),
      directionHint: directionHint || null,
      runLoFt,
      runHiFt,
      runLengthFt,
      fromStation: fromStation.station,
      toStation: toStation.station,
      coldBins: bestEnd - bestStart + 1,
      totalBins: numBins,
      observedTrainsInWindow: runsOnBranch.size,
      lastSeenInRunMs,
      onsetTs,
      coldThresholdMs,
      lookbackMs,
      trainsOutsideRun,
      coldStations,
      coldStationNames,
      expectedTrains,
      headwayMin: headwayMin != null ? headwayMin : null,
      directionDestinationName,
    };
    if (inferredHeld) {
      candidate.kind = 'held';
      candidate.heldEvidence = {
        inferredFromCold: true,
        trainCount: 1,
        stationaryMs: inferredHeld.lastStationaryMs,
        cohesionFt: 0,
        trainRns: [inferredHeld.rn],
        lastSeenTs: inferredHeld.lastSeenTs,
      };
    }
    candidates.push(candidate);
  }

  if (allBranchesSparse && candidates.length === 0 && branches.length > 0) {
    return { skipped: 'sparse-coverage', candidates: [] };
  }
  candidates.sort((a, b) => {
    // Prefer candidates with more cold stations, breaking ties by length.
    if (b.coldStations !== a.coldStations) return b.coldStations - a.coldStations;
    return b.runLengthFt - a.runLengthFt;
  });
  return { skipped: null, candidates };
}

// Direction key used as the (line, direction) PK in pulse_state. Stable
// across reorderings of trainLines.json: derives from directionHint
// (outbound/inbound) for round-trip splits, or from a length+terminal
// signature for multi-branch bidirectional lines (Blue, Green).
function directionKeyFor(branches, branchIdx, directionHint) {
  if (branches.length === 1) return 'all';
  if (directionHint) return `branch-${branchIdx}-${directionHint}`;
  const branch = branches[branchIdx];
  if (!branch?.points?.length) return `branch-${branchIdx}`;
  const lastPt = branch.points[branch.points.length - 1];
  const lat = Array.isArray(lastPt) ? lastPt[0] : lastPt.lat;
  const lon = Array.isArray(lastPt) ? lastPt[1] : lastPt.lon;
  const latStr = String(Math.round(lat * 1000));
  const lonStr = String(Math.round(lon * 1000));
  const lenK = Math.round(branch.totalFt / 1000);
  return `branch-len${lenK}-${latStr}-${lonStr}`;
}

function stationsAlongBranch(stations, line, points, cumDist) {
  const out = [];
  for (const s of stations || []) {
    if (!s.lines?.includes(line)) continue;
    const { cumDist: along, perpDist } = snapToLineWithPerp(s.lat, s.lon, points, cumDist);
    if (perpDist > MAX_PERP_FT) continue;
    out.push({ station: s, trackDist: along });
  }
  out.sort((a, b) => a.trackDist - b.trackDist);
  return out;
}

function nearestStationAtOrBefore(stationsOnBranch, ft) {
  let best = null;
  for (const s of stationsOnBranch) {
    if (s.trackDist <= ft) best = s;
    else break;
  }
  return best;
}

function nearestStationAtOrAfter(stationsOnBranch, ft) {
  for (const s of stationsOnBranch) {
    if (s.trackDist >= ft) return s;
  }
  return null;
}

module.exports = {
  detectDeadSegments,
  detectFeedGap,
  recoverConcreteOnset,
  ONSET_WIDEN_CAP_MS,
  FEED_GAP_LOOKBACK_MS,
  FEED_GAP_MS,
  stationsAlongBranch,
  nearestStationAtOrBefore,
  nearestStationAtOrAfter,
  directionKeyFor,
  DEFAULT_LOOKBACK_MS,
  DEFAULT_BIN_FT,
  DEFAULT_MIN_RUN_FT_LONG,
  DEFAULT_MIN_COVERAGE_FRAC,
  DEFAULT_MIN_SPAN_FRAC,
  SOLO_EXPECTED_TRAINS,
  MAX_PERP_FT,
};
