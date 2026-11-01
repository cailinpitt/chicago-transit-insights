const test = require('node:test');
const assert = require('node:assert/strict');
const { runTicks } = require('../../src/shared/runTicks');

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

test('runTicks fires ticksPerRun times, intervalMs apart', async () => {
  const clock = fakeClock();
  const tickTimes = [];
  await runTicks({
    ticksPerRun: 2,
    intervalMs: 30000,
    now: clock.now,
    tick: async () => {
      tickTimes.push(clock.now());
    },
    sleep: async (ms) => clock.advance(ms),
  });
  assert.deepEqual(tickTimes, [0, 30000]);
});

test('runTicks spaces ticks start-to-start, subtracting tick duration', async () => {
  const clock = fakeClock();
  const sleeps = [];
  const tickTimes = [];
  await runTicks({
    now: clock.now,
    tick: async () => {
      tickTimes.push(clock.now());
      clock.advance(8000);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
    },
    ticksPerRun: 3,
    intervalMs: 30000,
  });
  assert.deepEqual(sleeps, [22000, 22000]);
  assert.deepEqual(tickTimes, [0, 30000, 60000]);
});

test('runTicks skips the sleep when a tick overruns the interval', async () => {
  const clock = fakeClock();
  const sleeps = [];
  await runTicks({
    now: clock.now,
    ticksPerRun: 2,
    intervalMs: 30000,
    tick: async () => clock.advance(35000),
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.deepEqual(sleeps, []);
});

test('runTicks runs remaining ticks after a failure, then rejects', async () => {
  let calls = 0;
  const origError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      runTicks({
        ticksPerRun: 2,
        intervalMs: 30000,
        tick: async () => {
          calls++;
          if (calls === 1) throw new Error('simulated transient API failure');
        },
        sleep: async () => {},
      }),
      /simulated transient API failure/,
    );
  } finally {
    console.error = origError;
  }
  assert.equal(calls, 2);
});
