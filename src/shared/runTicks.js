// Cron's minimum granularity is 1 minute, so sub-minute observers run several
// ticks per firing. Ticks are spaced start-to-start so a slow tick doesn't push
// later ones late. A failed tick doesn't skip the rest, but the run still
// rejects so cron/healthchecks see the failure.

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTicks({
  tick,
  ticksPerRun,
  intervalMs,
  label = 'runTicks',
  sleep = defaultSleep,
  now = Date.now,
}) {
  const start = now();
  let firstError = null;
  for (let i = 0; i < ticksPerRun; i++) {
    if (i > 0) {
      const wait = start + i * intervalMs - now();
      if (wait > 0) await sleep(wait);
    }
    try {
      await tick();
    } catch (e) {
      console.error(`${label}: tick ${i + 1} failed: ${e.stack || e}`);
      firstError ??= e;
    }
  }
  if (firstError) throw firstError;
}

module.exports = { runTicks };
