import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rerankWithRetry } from './helpers/rerank.mjs';

const applied = { docs: [{ score: 0.9, retrievalScore: 2.5, doc: { id: 'a' } }],
  rerank: { status: 'applied', provider: 'cohere', model: 'rerank-v5.0-fast', scoredCount: 1, criteriaVersion: 'cohere-relevance-v1' } };
const fallback = reason => ({ docs: [{ score: 2.5, doc: { id: 'a' } }],
  rerank: { status: 'fallback', provider: 'cohere', model: 'rerank-v5.0-fast', candidateCount: 1, scoredCount: 0,
    ...(reason === undefined ? {} : { reason }) } });

function harness(responses) {
  const calls = { queries: 0, sleeps: [], logs: [] };
  return { calls, options: { size: 3, label: 'Cohere rerank-v5.0-fast',
    query: async () => {
      const response = responses[calls.queries++];
      if (response instanceof Error) throw response;
      return response;
    },
    log: message => calls.logs.push(message), sleep: async ms => { calls.sleeps.push(ms); } } };
}

test('applied Cohere reranking returns on the first attempt without retry', async () => {
  const { calls, options } = harness([applied]);
  assert.equal(await rerankWithRetry(options), applied);
  assert.deepEqual(calls, { queries: 1, sleeps: [], logs: [] });
});

test('transient Cohere fallbacks retry with bounded backoff until applied', async () => {
  const { calls, options } = harness([fallback('timeout'), fallback('rateLimit'), applied]);
  assert.equal(await rerankWithRetry(options), applied);
  assert.equal(calls.queries, 3);
  assert.deepEqual(calls.sleeps, [5000, 10000]);
  assert.deepEqual(calls.logs, [
    '[live] Cohere rerank-v5.0-fast fell back with reason timeout; retrying (2/3)',
    '[live] Cohere rerank-v5.0-fast fell back with reason rateLimit; retrying (3/3)',
  ]);
});

test('a third transient Cohere fallback fails instead of passing', async () => {
  const { calls, options } = harness([fallback('timeout'), fallback('unavailable'), fallback('timeout'), applied]);
  await assert.rejects(rerankWithRetry(options), /Cohere rerank-v5\.0-fast fell back with reason timeout on attempt 3\/3/);
  assert.equal(calls.queries, 3);
  assert.deepEqual(calls.sleeps, [5000, 10000]);
});

for (const reason of ['credentials', 'invalidResponse', 'unknownReason', undefined]) {
  test(`a Cohere fallback with reason ${reason ?? '(missing)'} fails without retry`, async () => {
    const { calls, options } = harness([fallback(reason), applied]);
    await assert.rejects(rerankWithRetry(options), new RegExp(`fell back with reason ${reason} on attempt 1/3`));
    assert.deepEqual(calls, { queries: 1, sleeps: [], logs: [] });
  });
}

for (const [name, change, message] of [
  ['scores', data => { data.rerank.scoredCount = 1; }, /must not report scores/],
  ['criteriaVersion', data => { data.rerank.criteriaVersion = 'cohere-relevance-v1'; }, /must omit criteriaVersion/],
  ['retrievalScore', data => { data.docs[0].retrievalScore = 2.5; }, /must omit retrievalScore/],
  ['more than size documents', data => { data.docs = Array.from({ length: 4 }, (_, i) => ({ score: 1, doc: { id: `${i}` } })); }, /at most 3 documents/],
]) {
  test(`a transient Cohere fallback reporting ${name} fails the documented shape`, async () => {
    const data = fallback('timeout');
    change(data);
    const { calls, options } = harness([data, applied]);
    await assert.rejects(rerankWithRetry(options), message);
    assert.deepEqual(calls, { queries: 1, sleeps: [], logs: [] });
  });
}

test('errors and other statuses pass through after one call', async () => {
  const skipped = { docs: [], rerank: { status: 'skipped', scoredCount: 0, reason: 'noCandidates' } };
  const passed = harness([skipped]);
  assert.equal(await rerankWithRetry(passed.options), skipped);
  assert.equal(passed.calls.queries, 1);
  const failed = harness([new Error('rerank cohere failed; exit=3, HTTP=408'), applied]);
  await assert.rejects(rerankWithRetry(failed.options), /HTTP=408/);
  assert.deepEqual(failed.calls, { queries: 1, sleeps: [], logs: [] });
});
