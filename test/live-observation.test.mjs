import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeWithin } from './helpers/observation.mjs';

function clock() {
  let elapsed = 0;
  const sleeps = [];
  return {
    now: () => elapsed,
    advance: ms => { elapsed += ms; },
    sleeps,
    sleep: async ms => { sleeps.push(ms); elapsed += ms; },
  };
}

test('live observation passes only when content is verified before the deadline', async () => {
  const time = clock();
  const budgets = [];
  const result = await observeWithin({ ...time, timeoutMs: 300000, intervalMs: 2000,
    poll: async budget => {
      budgets.push(budget);
      time.advance(1000);
      return budgets.length === 2;
    },
  });
  assert.equal(result, true);
  assert.deepEqual(budgets, [300000, 297000]);
  assert.deepEqual(time.sleeps, [2000]);
});

for (const lateResult of [true, false]) {
  test(`live observation rejects a late ${lateResult ? 'successful' : 'unsuccessful'} response without another sleep`, async () => {
    const time = clock();
    const budgets = [];
    const result = await observeWithin({ ...time, timeoutMs: 300000, intervalMs: 2000,
      poll: async budget => {
        budgets.push(budget);
        // Reproduce the old harness accepting a response at 318 seconds.
        time.advance(budgets.length <= 12 || budgets.length === 15 ? 20000 : 15000);
        return budgets.length === 15 && lateResult;
      },
    });
    assert.equal(result, false);
    assert.equal(time.now(), 318000);
    assert.equal(budgets.length, 15);
    assert.equal(budgets.at(-1), 2000);
    assert.equal(time.sleeps.length, 14);
  });
}

test('live observation rejects success exactly at the deadline', async () => {
  const time = clock();
  assert.equal(await observeWithin({ ...time, timeoutMs: 300000, intervalMs: 2000,
    poll: async budget => { time.advance(budget); return true; },
  }), false);
  assert.deepEqual(time.sleeps, []);
});

test('live observation caps its final sleep and does not start another request', async () => {
  const time = clock();
  let calls = 0;
  assert.equal(await observeWithin({ ...time, timeoutMs: 300000, intervalMs: 2000,
    poll: async () => { calls++; time.advance(299500); return false; },
  }), false);
  assert.equal(calls, 1);
  assert.deepEqual(time.sleeps, [500]);
  assert.equal(time.now(), 300000);
});

test('live observation reports budget expiration when an in-flight request times out', async () => {
  const time = clock();
  assert.equal(await observeWithin({ ...time, timeoutMs: 300000, intervalMs: 2000,
    poll: async budget => { time.advance(budget); throw new Error('Request timed out'); },
  }), false);
  assert.deepEqual(time.sleeps, []);
});

test('live observation preserves failures occurring before the deadline', async () => {
  const time = clock();
  const failure = new Error('Unexpected authentication failure');
  await assert.rejects(observeWithin({ ...time, timeoutMs: 300000, intervalMs: 2000,
    poll: async () => { throw failure; },
  }), error => error === failure);
  assert.deepEqual(time.sleeps, []);
});
