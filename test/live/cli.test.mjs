import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LambdaDBClient } from '@functional-systems/lambdadb';

test('explicit development-project CLI smoke with temporary collection cleanup', { timeout: 360000 }, async t => {
  // Fail instead of silently skipping a release prerequisite. Never load .env files.
  assert.equal(process.env.LAMBDADB_RUN_LIVE_TESTS, '1', 'Set LAMBDADB_RUN_LIVE_TESTS=1 only for an explicitly designated development project.');
  for (const key of ['LAMBDADB_ENDPOINT', 'LAMBDADB_PROJECT', 'LAMBDADB_API_KEY']) {
    assert.ok(process.env[key], `Missing required live-test setting: ${key}`);
  }
  assert.equal(process.env.LAMBDADB_LIVE_CONFIRM_PROJECT, process.env.LAMBDADB_PROJECT, 'LAMBDADB_LIVE_CONFIRM_PROJECT must name the designated development project.');
  const endpoint = new URL(process.env.LAMBDADB_ENDPOINT);
  assert.equal(endpoint.protocol, 'https:', 'Live tests require HTTPS.');
  assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.pathname === '/', 'Use an API origin without credentials, query, fragment or path.');
  const collection = `cli-smoke-${randomUUID()}`;
  const temp = await mkdtemp(join(tmpdir(), 'lambdadb-live-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const env = { ...process.env, LAMBDADB_API_KEY_ENV: 'LAMBDADB_API_KEY' };
  delete env.LAMBDADB_DEBUG;
  delete process.env.LAMBDADB_DEBUG;
  const cli = process.env.LAMBDADB_TEST_CLI ?? resolve('dist/cli.js');
  async function run(args) {
    return new Promise((accept, reject) => execFile(process.execPath, [cli, ...args,
      '--endpoint', endpoint.origin, '--project', process.env.LAMBDADB_PROJECT,
      '--config', join(temp, 'config.json'), '--timeout-ms', '15000', '--json',
    ], { env, timeout: 20000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      try {
        if (error && (typeof error.code !== 'number' || error.killed)) throw new Error('Live CLI process could not complete.');
        accept({ code: error?.code ?? 0, result: JSON.parse(stdout) });
      } catch { reject(new Error('Live CLI failed to produce a complete JSON result.')); }
    }));
  }
  function success(response, stage) {
    assert.equal(response.code, 0, `${stage} failed; exit=${response.code}, HTTP=${response.result.error?.httpStatus ?? 'not available'}`);
    return response.result.data;
  }
  // An explicit config prevents accidental reads of an existing user's saved target.
  await writeFile(join(temp, 'config.json'), JSON.stringify({ endpoint: endpoint.origin, project: process.env.LAMBDADB_PROJECT, apiKeyEnv: 'LAMBDADB_API_KEY' }), { mode: 0o600 });
  success(await run(['doctor']), 'doctor');
  const created = await run(['collections', 'create', '--collection', collection, '--index-config', resolve('examples/index-config.json')]);
  if (created.code === 0 || created.code === 5) {
    t.after(async () => {
      const client = new LambdaDBClient({ baseUrl: endpoint.origin, projectName: process.env.LAMBDADB_PROJECT, projectApiKey: process.env.LAMBDADB_API_KEY });
      try {
        await client.collection(collection).delete({ timeoutMs: 15000, retries: { strategy: 'none' } });
        t.diagnostic(`Cleanup accepted for temporary collection ${collection}.`);
      } catch {
        throw new Error(`Cleanup failed or is unconfirmed; inspect temporary collection ${collection}.`);
      }
    });
  }
  success(created, 'create');
  const rows = [
    { id: 'large-1', text: 'serverless smoke', payload: 'a'.repeat(3 * 1024 * 1024) },
    { id: 'large-2', text: 'serverless smoke', payload: 'b'.repeat(3 * 1024 * 1024) },
  ];
  const input = join(temp, 'documents.jsonl');
  await writeFile(input, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const imported = success(await run(['docs', 'import', '--collection', collection, '--branch', 'main', '--file', input, '--batch-size', '1']), 'upsert');
  assert.equal(imported.accepted, 2);
  assert.equal(imported.searchable, 'not_verified');
  const bulkFile = join(temp, 'bulk.jsonl');
  const bulkRow = { id: 'bulk-1', text: 'serverless smoke' };
  await writeFile(bulkFile, JSON.stringify(bulkRow) + '\n');
  const bulk = success(await run(['docs', 'import', '--collection', collection, '--branch', 'main', '--mode', 'bulk', '--file', bulkFile]), 'bulk');
  assert.equal(bulk.accepted, 1);
  const expected = [...rows, bulkRow];
  async function waitForContents(args, stage) {
    const deadline = Date.now() + 75000;
    do {
      const response = await run(args);
      if (response.code !== 0) {
        const status = response.result.error?.httpStatus;
        if (response.code !== 3 || ![404, 409, 503].includes(status)) success(response, stage);
      } else {
        const docs = response.result.data.docs.map(item => item.doc);
        if (expected.every(row => docs.some(doc => doc.id === row.id))) {
          // Avoid assertion dumps containing the large returned payloads.
          assert.ok(expected.every(row => {
            const doc = docs.find(doc => doc.id === row.id);
            return doc.text === row.text && doc.payload === row.payload;
          }), `${stage} returned different document contents.`);
          return;
        }
      }
      await delay(1000);
    } while (Date.now() < deadline);
    throw new Error(`${stage} did not return expected committed documents within the observation window.`);
  }
  await waitForContents(['query', '--collection', collection, '--ref', 'branch:main', '--file', resolve('examples/query.json')], 'query');
  await waitForContents(['docs', 'fetch', '--collection', collection, '--ref', 'branch:main', '--ids', ...expected.map(row => row.id)], 'fetch');
  t.diagnostic('Doctor, create, ordinary/bulk acceptance and committed query/fetch contents passed. This is a bounded sample, not a collection readiness guarantee.');
});
