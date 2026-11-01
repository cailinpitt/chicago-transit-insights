#!/usr/bin/env node
// Dedicated bus observer — keeps coverage consistent for ghost detection AND
// bus pulse, independent of when bunching/gaps happen to poll. Polls every
// active CTA bus route so both detectors see the full system every tick.
// Cron's minimum granularity is 1 minute, so this script runs two ticks 30s
// apart per cron firing (matching observeTrains.js).
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });

const { runTicks: runTicksShared } = require('../src/shared/runTicks');

const TICK_INTERVAL_MS = 30 * 1000;
const TICKS_PER_RUN = 2;

async function defaultTick() {
  const { getVehicles } = require('../src/bus/api');
  const { allRoutes } = require('../src/bus/routes');
  if (allRoutes.length === 0) {
    console.log('No bus routes configured, nothing to observe');
    return;
  }
  const vehicles = await getVehicles(allRoutes);
  console.log(
    `observe-buses: recorded ${vehicles.length} vehicles across ${allRoutes.length} routes`,
  );
}

function runTicks({
  tick = defaultTick,
  ticksPerRun = TICKS_PER_RUN,
  intervalMs = TICK_INTERVAL_MS,
  ...rest
} = {}) {
  return runTicksShared({ tick, ticksPerRun, intervalMs, label: 'observe-buses', ...rest });
}

if (require.main === module) {
  runTicks().catch(() => process.exit(1));
}

module.exports = { runTicks, TICK_INTERVAL_MS, TICKS_PER_RUN };
