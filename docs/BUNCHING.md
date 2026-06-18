# Bunching detection

How the bot finds clusters of buses or trains running too close together — the classic "you wait 20 minutes, then three show up at once" pattern.

## What "bunching" means

In a healthy schedule, vehicles on the same route are spread out evenly. **Bunching** is when two or more vehicles end up running within a short distance of each other, usually because the lead vehicle got delayed (heavy boarding, traffic, signals) and the one behind caught up. The riders behind the bunch suffer a long gap; the bunch itself runs nearly empty after the first vehicle.

The bot watches for clusters and posts a map showing where they are.

## The plain-English version

Every few minutes, the bot:

1. Pulls the live position of every bus or train on the routes it watches.
2. Sorts vehicles by how far they've traveled along their route.
3. Looks for groups where consecutive vehicles are closer together than a "bunching" distance threshold.
4. If a cluster is large enough and not just sitting at a terminal, posts a map.

A bus post looks like this:

> 🚌 Route 22 (Clark) Northbound — 3 buses bunched within 2,400 ft

The map shows the route line with each clustered vehicle marked along it, plus nearby intersections so a rider can recognize where they are.

## The technical version

### Buses — `src/bus/bunching.js`

Buses report a `pdist` field: feet traveled along the current pattern. That makes "are these two buses close together along the route?" a simple subtraction — no GPS math, no along-track snapping.

For each pattern (`pid`):

1. Filter to fresh observations (less than 3 minutes old).
2. Sort by `pdist`.
3. Sweep adjacent pairs. A consecutive gap of ≤ **800 ft** (~2.5 Chicago blocks) extends the current cluster.
4. Skip clusters that start within **500 ft** of the pattern start — those are layovers at the origin terminal, not bunching.
5. Rank clusters by size (more vehicles = more severe), tie-break on tighter max-gap.

The hourly bin (`bin/bus/bunching.js`) iterates ranked candidates and picks the first whose `pid` and route aren't on cooldown. Both pid- and route-level cooldowns exist because opposite-direction patterns on the same route would otherwise post within minutes of each other on the same underlying delay.

Additional terminal filtering at post time: even if `pdist` looks fine, if the cluster's nearest stop *is* the first or last named stop, it's a terminal layover and gets skipped.

### Schedule adherence — `scheduleDeviationMin` (bus only)

The `Buses:` line tags each clustered bus with its map disc number (as a keycap emoji, so the position reads as a distinct tag rather than a third number next to the vehicle id and the minutes) and, when we can compute it confidently, how late or early it is:

> Buses: #8700 (1️⃣, 12 min late), #8228 (2️⃣, 3 min early)

Every live bus self-reports the scheduled start of the trip it's running (`getvehicles` `stst` = seconds since midnight, `stsd` = service date). That plus the route identifies the exact GTFS trip — its first-stop departure equals `stst` — so we never have to *guess* which scheduled run a bus belongs to. That matters most here: in a bunch several buses sit at nearly the same place at the same time, so position alone can't tell them apart, but each bus carries its own schedule anchor.

To turn that into minutes: `scripts/fetch-gtfs.js` writes a per-trip scheduled stop curve to `data/gtfs/schedule.sqlite` (one row per stop: `route, start_sec, lat, lon, sched_sec` — too large for `index.json`). At post time `scheduleDeviationMin` (`src/shared/gtfs.js`) looks up the bus's trip by `(route, stst)`, projects the bus's lat/lon onto that trip's stop path, interpolates the scheduled time at the projection point, and reports `now − scheduled` (positive = late). lat/lon is the anchor — not `pdist` — because BusTime patterns and GTFS shapes are different coordinate systems. A bus we can't place confidently (no `stst`, no trip match, or more than ~600 ft off the path) keeps its bare number rather than showing a guessed time. Trains don't expose a per-vehicle schedule anchor, so this is bus-only.

### Trains — `src/train/bunching.js`

Trains don't report along-route distance, only lat/lon. So we have to compute "distance along the line" ourselves:

1. Build a polyline for the line from CTA's GTFS shapes (`src/train/speedmap.js#buildLinePolyline`). Loop lines (Brown/Orange/Pink/Purple) get the return leg trimmed so both directions snap to the same outbound track.
2. For each train, **perpendicular-project** its lat/lon onto that polyline to get a "track distance" — feet from the line's start. Perpendicular projection (not vertex-snap) matters because CTA train polylines are sparse — only ~80 vertices over 20 miles. Vertex-snapping would put trains hundreds of feet off.
3. Group by `(line, trDr)`, sort by track distance, sweep for clusters within **2,000 ft** (~0.38 mi).
4. Dedupe near-coincident snaps (< 200 ft apart) — almost always the same train double-reported.
5. Reject clusters in the terminal zone (a fraction of total line length).
6. **Heading gate**: every consecutive pair in the cluster must point within 60° of each other. Without it, opposite-direction trains on the elevated Loop snap to similar track distances and falsely appear bunched.

The chosen cluster is rendered as a map showing the line with each train marked at its snapped position.

### Cooldowns and posting

A successful post records the pid (or line/trDr) on cooldown so we don't keep firing on the same incident. Pattern-level *and* route-level cooldowns exist for buses; line-level cooldowns for trains. There's also a daily cap (3 bus bunches/day) so a bad day doesn't drown the feed.

Both the daily cap and the route/line-level cooldown carry a strict-dominance override: a candidate that's strictly worse than every prior post within the window (more vehicles, or same count + larger span for buses; tighter span for trains) bypasses the gate. A 3-bus pileup at 3 PM shouldn't suppress a 5-bus pileup at 3:30 PM on the same route. The pid (bus) and direction (train) cooldowns stay strict — same direction within the hour is almost always the same incident.

### Timelapse video

Each bunching post replies with a ~10-minute timelapse of the cluster (`src/{bus,train}/bunchingVideo.js`). The capture polls vehicle positions every 15 s for 40 ticks, snaps each track to the route polyline, and renders interpolated frames between snapshots so vehicles glide instead of teleport.

CTA's tracker occasionally stops reporting a vehicle mid-clip — GPS dropouts, prediction suppression near terminals, missed polls. Without special handling these vehicles vanish abruptly from the video. For **tail drops** (vehicle present in some snapshot but missing from the final snapshot), the renderer:

1. Estimates last-known speed from the prior sample's `track` delta.
2. Dead-reckons the position forward along the polyline at that speed for up to **30 s** of clip time.
3. Fades opacity from 1.0 → 0.15 over the window.
4. Past the cap, drops the marker entirely.

The ghost marker uses a desaturated gray fill and a dashed white ring so viewers read it as "tracking lost" rather than a normal vehicle. When at least one ghost is rendered, a **"Faded = signal lost from CTA"** legend appears top-left for the duration of the clip. The shared legend builder lives in `src/map/common.js#buildGhostLegend`.

Note: this "ghost" is distinct from the ghost-bus detection in `src/{bus,train}/ghosts.js` (scheduled trips with no live vehicle reporting all hour) — it's purely a video-rendering treatment for tail-dropped GPS reports.

**Shared dropout kernel.** The handling above is the conceptual baseline; both
bus and train timelapses now route *all* dropout handling through the shared
**`src/shared/videoTracks.js`** kernel, which generalizes it to *every* gap, not
just the tail: short feed gaps (≤ 8 min) are **bridged** by interpolation (dimmed
by staleness), long interior gaps fade to a ghost on each side and draw nothing
through the unknown middle, tail drops dead-reckon along the polyline, and a drop
at a real terminal plays a turnaround glyph. The same model powers the train
videos (bunching/gap/snapshot) and the frontend's "Watch it unfold" replay — see
`docs/REPLAY.md`.

This replaced the bus side's older `fillInteriorGaps`, which bridged interior
gaps with **no cap** (a 20-min unknown was fabricated as a smooth glide); the
kernel caps bridging at 8 min and ghosts longer gaps, since past that we
genuinely don't know where the bus was. Bus specifics preserved through kernel
options: end-to-end polylines mean both endpoints are real terminals, a `vid`
that reappeared under a different `pid` is a *proven* turnaround (forced via an
explicit `turnaroundEnd`), and the U-turn glyph **parks** at the terminus rather
than fading (`turnaroundPark`).

## Cross-route / cross-line bunching

The detectors above are *per-route*: each groups by one pattern/line and measures
distance **along that route**. They can't see a pileup where vehicles from
*different* routes converge on one spot — 2 #22 + 3 #36 stacked at Clark &
Belmont, or Brown/Orange/Pink trains knotted on the shared Loop track. A #22 at
`pdist 12,000` and a #36 at `pdist 3,000` can sit at the same corner, but those
pdists are different coordinate systems, so the per-route sweep never compares
them.

Cross-route bunching is therefore a **geographic** detector, not an along-route
one. The new primitive is `src/shared/geoClusters.js#clusterByProximity`:
connected-components clustering on raw lat/lon — two vehicles are linked when
within a radius, a cluster is a maximal linked group. The surface detectors
(`src/{bus,train}/crossBunching.js`) run it over the *whole* fleet snapshot and
keep clusters that pass three gates:

1. **≥ 2 distinct routes/lines** — otherwise it's ordinary bunching the
   per-route detector already catches.
2. **≥ 3 vehicles** — a pileup, not one bus meeting another.
3. **Congestion** — ≥ 2 members must be confirmed barely-moving (buses via
   `findParkedBusVids`; trains via recent-position drift < ~350 ft). This is what
   separates a real pileup from vehicles merely crossing the same junction in
   motion.

Radius defaults: **660 ft** bus (~an intersection + its approaches), **1,500 ft**
train (station + platform approach). Clusters rank most-vehicles-first,
tie-break tightest span.

### Posting & the place key

The bins (`bin/{bus,train}/cross-bunching.js`) post to the bus / train account
with an intersection map (`src/map/crossBunching.js`): each vehicle is a
numbered disc colored by route, plus a legend. The whole incident lifecycle —
cooldown, daily cap, callouts, record — reuses `history.js` but is **keyed on the
place** (rounded centroid / nearest stop) under a new `kind` (`bus-multi` /
`train-multi`), since the incident *is* a location, not a route.

### Suppression (cross-route beats per-route)

The cross-route bin runs **1 minute before** the per-route bin (see
`cron/crontab.txt`). When it posts, it records the cluster's member vehicle/run
ids (`bunching_events.member_ids`). The per-route bins consult
`history.recentCrossBunchMemberIds()` and **skip** any candidate that shares ≥ 2
vehicles with a recently-posted pileup — the multi-route post is the better
story, so the same physical pileup is never posted twice.

Timelapse video for cross-route posts is a planned follow-up; v1 ships the
static map only.

## Why this approach

The signal is geometric, not statistical: vehicles on the same pattern, close together, in service territory. Most of the code is filtering — terminal layovers, ghost reports, opposite-direction noise — to make sure the post matches what a rider on the street would actually see.

## Files

- `src/bus/bunching.js` — bus cluster detection.
- `src/bus/bunchingPost.js` / `src/bus/bunchingVideo.js` — post and time-lapse rendering.
- `src/train/bunching.js` — train cluster detection with along-track snapping.
- `src/train/speedmap.js` — polyline building and projection helpers (shared with speedmap).
- `bin/bus/bunching.js`, `bin/train/bunching.js` — cron entry points.
