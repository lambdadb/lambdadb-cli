import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importDocuments, planBatches } from '../dist/import-workflow.js';

test('batch byte accounting includes UTF-8, separators and branch envelope', () => {
  const rows = ['한글', '🙂', 'abc'].map((text, i) => {
    const doc = { id: String(i), text };
    return { doc, line: i + 1, bytes: Buffer.byteLength(JSON.stringify(doc)) };
  });
  for (const bulk of [false, true]) {
    const batches = planBatches(rows, 'main', 100, 90, bulk);
    for (const batch of batches) {
      const body = { docs: batch.rows.map(r => r.doc), ...(bulk ? {} : { branch: 'main' }) };
      assert.equal(batch.bytes, Buffer.byteLength(JSON.stringify(body)));
      assert.ok(batch.bytes <= 90);
    }
    assert.deepEqual(batches.flatMap(b => b.rows), rows);
  }
});

test('a deadline between batches leaves unsent documents not attempted, not unknown', async () => {
  const controller = new AbortController();
  let calls = 0;
  const rows = [1, 2].map(line => ({ line, doc: { id: `${line}` }, bytes: 10 }));
  const result = await importDocuments({ upsert: async () => { calls++; controller.abort(); } }, planBatches(rows, 'main', 1, 100, false), 'main', false, { signal: controller.signal });
  assert.equal(calls, 1); assert.equal(result.state, 'partial');
  assert.equal(result.accepted, 1); assert.equal(result.notAttempted, 1); assert.equal(result.unknown, 0);
});
