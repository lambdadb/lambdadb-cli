import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// Every live rerank request that sends onFailure "returnOriginal" goes through here.
// Provider timeouts, rate limits and outages are transient under shared load and
// arrive as a fallback naming the reason. Retry only those, a bounded number of
// times. Credential, invalid-response and any other fallback fails at once, and a
// fallback never counts as applied reranking.
const transientReasons = new Set(['timeout', 'rateLimit', 'unavailable']);
export const rerankAttempts = 3;

export async function rerankWithRetry({ query, size, label, log = console.info, sleep = delay }) {
  for (let attempt = 1; ; attempt++) {
    const data = await query();
    if (data?.rerank?.status !== 'fallback') return data;
    const { reason } = data.rerank;
    // Documented fallback shape: retrieval order without rerank scores or criteria.
    assert.equal(data.rerank.scoredCount, 0, `${label} fallback must not report scores`);
    assert.equal(data.rerank.criteriaVersion, undefined, `${label} fallback must omit criteriaVersion`);
    assert.ok(data.docs.length <= size, `${label} fallback must return at most ${size} documents`);
    assert.ok(data.docs.every(hit => hit.retrievalScore === undefined), `${label} fallback must omit retrievalScore`);
    assert.ok(transientReasons.has(reason) && attempt < rerankAttempts,
      `${label} fell back with reason ${reason} on attempt ${attempt}/${rerankAttempts}`);
    log(`[live] ${label} fell back with reason ${reason}; retrying (${attempt + 1}/${rerankAttempts})`);
    await sleep(attempt * 5000);
  }
}
