#!/usr/bin/env node
// Densifies train-observations capture by polling Train Tracker every 30s.
// Cron's minimum granularity is 1 minute, so this script runs two ticks 30s
// apart per cron firing. recordTrainObservations is invoked by
// getAllTrainPositions; this script's only job is to call it on its own
// cadence so detection cron jobs aren't the only writers to the observations
// table.

require('../src/shared/env');

const { setup, runBin } = require('../src/shared/runBin');
const { getAllTrainPositions } = require('../src/train/api');
const { runTicks: runTicksShared } = require('../src/shared/runTicks');

const TICK_INTERVAL_MS = 30 * 1000;
const TICKS_PER_RUN = 2;

async function defaultTick() {
  try {
    const trains = await getAllTrainPositions();
    console.log(`observe-trains: recorded ${trains.length} trains`);
  } catch (e) {
    console.warn(`observe-trains: getAllTrainPositions failed: ${e.message}`);
  }
}

function runTicks({
  tick = defaultTick,
  ticksPerRun = TICKS_PER_RUN,
  intervalMs = TICK_INTERVAL_MS,
  ...rest
} = {}) {
  return runTicksShared({ tick, ticksPerRun, intervalMs, label: 'observe-trains', ...rest });
}

async function main() {
  setup();
  await runTicks();
}

if (require.main === module) {
  runBin(main);
}

module.exports = { runTicks, TICK_INTERVAL_MS, TICKS_PER_RUN };
