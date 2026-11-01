const test = require('node:test');
const assert = require('node:assert/strict');
const { runTicks, TICK_INTERVAL_MS, TICKS_PER_RUN } = require('../scripts/observeTrains');

test('observe-trains polls twice per cron firing, 30s apart start-to-start', async () => {
  assert.equal(TICK_INTERVAL_MS, 30 * 1000);
  assert.equal(TICKS_PER_RUN, 2);
  let t = 0;
  const tickTimes = [];
  await runTicks({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    tick: async () => {
      tickTimes.push(t);
      t += 5000;
    },
  });
  assert.deepEqual(tickTimes, [0, TICK_INTERVAL_MS]);
});
