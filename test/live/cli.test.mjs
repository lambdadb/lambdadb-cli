import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LambdaDBClient } from '@functional-systems/lambdadb';
import { Analyzer } from '@functional-systems/lambdadb/models';
import { observeWithin } from '../helpers/observation.mjs';

test('explicit development-project CLI smoke with temporary collection cleanup', { timeout: 900000 }, async t => {
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
  const startedAt = Date.now();
  const progress = message => console.info(`[live +${Math.round((Date.now() - startedAt) / 1000)}s] ${message}`);
  const temp = await mkdtemp(join(tmpdir(), 'lambdadb-live-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const env = { ...process.env, LAMBDADB_API_KEY_ENV: 'LAMBDADB_API_KEY' };
  delete env.LAMBDADB_DEBUG;
  delete process.env.LAMBDADB_DEBUG;
  const cli = process.env.LAMBDADB_TEST_CLI ?? resolve('dist/cli.js');
  async function run(args, remainingMs = 20000) {
    return new Promise((accept, reject) => execFile(process.execPath, [cli, ...args,
      '--endpoint', endpoint.origin, '--project', process.env.LAMBDADB_PROJECT,
      '--config', join(temp, 'config.json'), '--timeout-ms', String(Math.min(15000, remainingMs)), '--json',
    ], { env, timeout: Math.min(20000, remainingMs), maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
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
  progress('Doctor passed.');
  const indexFile = join(temp, 'index-config.json');
  const indexConfigs = {
    text: { type: 'text', analyzers: ['english', 'chinese'] }, category: { type: 'keyword' },
    ...Object.fromEntries(Object.values(Analyzer).map(analyzer => [`preset_${analyzer}`, { type: 'text', analyzers: [analyzer] }])),
  };
  assert.equal(Object.values(Analyzer).length, 49);
  await writeFile(indexFile, JSON.stringify(indexConfigs));
  const created = await run(['collections', 'create', '--collection', collection, '--index-config', indexFile]);
  if (created.code === 0 || created.code === 5) {
    t.after(async () => {
      const client = new LambdaDBClient({ baseUrl: endpoint.origin, projectName: process.env.LAMBDADB_PROJECT, projectApiKey: process.env.LAMBDADB_API_KEY });
      try {
        await client.collection(collection).delete({ timeoutMs: 15000, retries: { strategy: 'none' } });
        await assert.rejects(client.collection(collection).get({ timeoutMs: 15000, retries: { strategy: 'none' } }),
          error => error.statusCode === 404);
        t.diagnostic(`Cleanup verified by HTTP 404 for temporary collection ${collection}.`);
      } catch {
        throw new Error(`Cleanup failed or is unconfirmed; inspect temporary collection ${collection}.`);
      }
    });
  }
  success(created, 'create');
  progress(`Created temporary collection ${collection}.`);
  const described = success(await run(['collections', 'describe', '--collection', collection]), 'describe analyzers');
  assert.ok(Object.entries(indexConfigs).every(([field, config]) => isDeepStrictEqual(described.collection?.indexConfigs?.[field], config)),
    'Collection metadata must preserve every requested analyzer preset.');
  progress('All 49 fixed analyzer presets accepted and metadata verified; language-specific search quality is not measured.');
  const rows = [
    { id: 'large-1', text: 'serverless smoke', category: 'database', payload: 'a'.repeat(3 * 1024 * 1024) },
    { id: 'large-2', text: 'serverless smoke', category: 'database', payload: 'b'.repeat(3 * 1024 * 1024) },
  ];
  const input = join(temp, 'documents.jsonl');
  await writeFile(input, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const imported = success(await run(['docs', 'import', '--collection', collection, '--branch', 'main', '--file', input, '--batch-size', '1']), 'upsert');
  assert.equal(imported.accepted, 2);
  assert.equal(imported.searchable, 'not_verified');
  const bulkFile = join(temp, 'bulk.jsonl');
  const bulkRow = { id: 'bulk-1', text: 'serverless smoke', category: 'developer-tools' };
  await writeFile(bulkFile, JSON.stringify(bulkRow) + '\n');
  const bulk = success(await run(['docs', 'import', '--collection', collection, '--branch', 'main', '--mode', 'bulk', '--file', bulkFile]), 'bulk');
  assert.equal(bulk.accepted, 1);
  progress('Ordinary writes (2) and bulk write (1) accepted; search visibility is not yet verified.');
  const expected = [...rows, bulkRow];
  async function waitForContents(args, stage) {
    let nextProgressAt = 0;
    let lastObservation = 'no completed response';
    const observed = await observeWithin({ timeoutMs: 300000, intervalMs: 2000, poll: async remainingMs => {
      const response = await run(args, remainingMs);
      if (response.code !== 0) {
        const status = response.result.error?.httpStatus;
        lastObservation = `exit=${response.code}, HTTP=${status ?? 'not available'}`;
        if (response.code !== 3 || ![404, 409, 503].includes(status)) success(response, stage);
      } else {
        const docs = response.result.data.docs.map(item => item.doc);
        lastObservation = `matched=${expected.filter(row => docs.some(doc => doc.id === row.id)).length}/${expected.length}`;
        if (expected.every(row => docs.some(doc => doc.id === row.id))) {
          // Avoid assertion dumps containing the large returned payloads.
          assert.ok(expected.every(row => {
            const doc = docs.find(doc => doc.id === row.id);
            return doc.text === row.text && doc.payload === row.payload;
          }), `${stage} returned different document contents.`);
          return true;
        }
      }
      if (Date.now() >= nextProgressAt) {
        progress(`${stage}: waiting for committed documents (${lastObservation}).`);
        nextProgressAt = Date.now() + 15000;
      }
      return false;
    } });
    if (!observed) throw new Error(`${stage} did not return expected committed documents within 300 seconds (${lastObservation}).`);
    progress(`${stage}: all expected document contents verified.`);
  }
  await waitForContents(['query', '--collection', collection, '--ref', 'branch:main', '--file', resolve('examples/query.json')], 'query');
  await waitForContents(['docs', 'fetch', '--collection', collection, '--ref', 'branch:main', '--ids', ...expected.map(row => row.id)], 'fetch');
  for (const [file, expectedDocs] of [['query-facets-only.json', 0], ['query-with-facets.json', 3]]) {
    const data = success(await run(['query', '--collection', collection, '--ref', 'branch:main', '--file', resolve('examples', file)]), file);
    assert.equal(data.docs.length, expectedDocs);
    assert.deepEqual(data.facets?.category?.buckets, [
      { value: 'database', count: 2 }, { value: 'developer-tools', count: 1 },
    ]);
    progress(`${file}: document count and exact facet buckets verified.`);
  }
  const baseline = JSON.parse(await readFile(resolve('examples/query.json'), 'utf8'));
  for (const variant of ['default', 'null', 'custom']) {
    const rerank = variant === 'null' ? null : {
      provider: 'typesafe', model: 'jev-1.13.0', queryText: 'How does serverless search work?', fields: ['text'],
      ...(variant === 'custom' ? { candidateSize: 50, onFailure: 'error', criteria: [
        'Does not address serverless search.', 'Explains serverless search directly.',
      ] } : {}),
    };
    const file = join(temp, `query-rerank-${variant}.json`);
    await writeFile(file, JSON.stringify({ ...baseline, rerank }));
    const data = success(await run(['query', '--collection', collection, '--ref', 'branch:main', '--file', file], 60000), `rerank ${variant}`);
    assert.equal(data.docs.length, 3);
    assert.ok(expected.every(row => data.docs.some(hit => hit.doc.id === row.id)));
    if (variant === 'null') {
      assert.equal(data.rerank, undefined);
      assert.ok(data.docs.every(hit => hit.retrievalScore === undefined));
    } else {
      assert.equal(data.rerank?.status, 'applied');
      assert.equal(data.rerank?.provider, 'typesafe');
      assert.equal(data.rerank?.model, 'jev-1.13.0');
      assert.equal(data.rerank?.criteriaVersion, variant === 'custom' ? 'custom' : 'default-relevance-v1');
      assert.equal(data.rerank?.candidateCount, 3);
      assert.equal(data.rerank?.scoredCount, 3);
      assert.ok(data.docs.every(hit => Number.isFinite(hit.score) && hit.score >= 0 && hit.score <= 1 && Number.isFinite(hit.retrievalScore)));
      assert.ok(data.docs.every((hit, i) => i === 0 || data.docs[i - 1].score >= hit.score));
      assert.equal(data.maxScore, data.docs[0].score);
    }
    progress(`Managed reranking ${variant}: document envelopes and status metadata verified.`);
  }
  for (const legacy of [false, true]) {
    const nativeCollection = `cli-native-${randomUUID()}`;
    const embedding = { provider: 'openai', model: 'text-embedding-3-small', sourceField: 'text', dimensions: 256, similarity: 'cosine' };
    const nativeConfigs = { text: { type: 'text' }, vector: { type: 'vector', embedding, ...(legacy ? { managedEmbedding: true } : {}) } };
    const configFile = join(temp, `native-${legacy}.json`);
    await writeFile(configFile, JSON.stringify(nativeConfigs));
    const nativeCreated = await run(['collections', 'create', '--collection', nativeCollection, '--index-config', configFile]);
    if (nativeCreated.code === 0 || nativeCreated.code === 5) {
      t.after(async () => {
        const client = new LambdaDBClient({ baseUrl: endpoint.origin, projectName: process.env.LAMBDADB_PROJECT, projectApiKey: process.env.LAMBDADB_API_KEY });
        try {
          await client.collection(nativeCollection).delete({ timeoutMs: 15000, retries: { strategy: 'none' } });
          await assert.rejects(client.collection(nativeCollection).get({ timeoutMs: 15000, retries: { strategy: 'none' } }), error => error.statusCode === 404);
          t.diagnostic(`Cleanup verified by HTTP 404 for temporary collection ${nativeCollection}.`);
        } catch { throw new Error(`Cleanup failed or is unconfirmed; inspect temporary collection ${nativeCollection}.`); }
      });
    }
    success(nativeCreated, 'native create');
    const updated = success(await run(['collections', 'update', '--collection', nativeCollection, '--index-config', configFile]), 'native update');
    assert.equal(updated.state, 'updated');
    const nativeMetadata = success(await run(['collections', 'describe', '--collection', nativeCollection]), 'native describe').collection.indexConfigs.vector;
    assert.equal(nativeMetadata.managedEmbedding, true);
    assert.deepEqual(nativeMetadata.embedding, embedding);
    const nativeRows = [
      { id: 'one', text: 'Serverless search retrieves documents.' },
      { id: 'two', text: 'Serverless databases manage search infrastructure.' },
      { id: 'three', text: 'A recipe for vegetable soup.' },
    ];
    const nativeDocs = join(temp, `native-docs-${legacy}.jsonl`);
    await writeFile(nativeDocs, nativeRows.map(row => JSON.stringify(row)).join('\n') + '\n');
    assert.equal(success(await run(['docs', 'import', '--collection', nativeCollection, '--branch', 'main', '--file', nativeDocs]), 'native import').accepted, 3);
    const queryFile = join(temp, `native-query-${legacy}.json`);
    async function nativeQuery(body, remainingMs) {
      await writeFile(queryFile, JSON.stringify(body));
      return run(['query', '--collection', nativeCollection, '--ref', 'branch:main', '--file', queryFile], remainingMs);
    }
    const signals = [
      { queryString: { query: 'text:serverless' } },
      { knn: { field: 'vector', queryText: 'How does serverless search work?', k: 30 } },
    ];
    const body = { query: { bayesian: signals }, size: 3, candidateSize: 30, consistentRead: true };
    assert.ok(await observeWithin({ timeoutMs: 120000, intervalMs: 2000, poll: async remainingMs => {
      const response = await nativeQuery(body, remainingMs);
      if (response.code === 3 && [404, 409, 503].includes(response.result.error?.httpStatus)) return false;
      return success(response, 'native Bayesian visibility').docs.length === 3;
    } }), 'Native documents did not become visible within 120 seconds.');
    const baseline = success(await nativeQuery(body), 'native Bayesian');
    assert.ok(nativeRows.every(row => baseline.docs.some(hit => isDeepStrictEqual(hit.doc, row))));
    const prefix = success(await nativeQuery({ ...body, size: 1 }), 'fixed candidate budget');
    assert.deepEqual(prefix.docs, baseline.docs.slice(0, 1));
    for (const query of [signals[0], signals[1], ...['rrf', 'mm', 'l2'].map(method => ({ [method]: signals }))]) {
      assert.ok(success(await nativeQuery({ query, size: 3, consistentRead: true }), 'ordinary retrieval').docs.length > 0);
    }
    for (const explicitBudget of [false, true]) {
      const reranked = success(await nativeQuery({ query: body.query, size: 2, consistentRead: true, rerank: {
        provider: 'typesafe', model: 'jev-1.13.0', queryText: 'How does serverless search work?', fields: ['text'],
        ...(explicitBudget ? { candidateSize: 30 } : {}),
      } }), 'Bayesian rerank');
      assert.equal(reranked.rerank?.status, 'applied');
      assert.equal(reranked.rerank.candidateCount, 3);
      assert.equal(reranked.rerank.scoredCount, 3);
      assert.equal(reranked.docs.length, 2);
      assert.ok(reranked.docs.every(hit => Number.isFinite(hit.score) && hit.score >= 0 && hit.score <= 1
        && hit.retrievalScore === baseline.docs.find(original => original.doc.id === hit.doc.id)?.score));
    }
    const nullRerank = success(await nativeQuery({ ...body, rerank: null }), 'null rerank');
    assert.deepEqual(nullRerank.docs, baseline.docs);
    assert.equal(nullRerank.rerank, undefined);
    const invalid = [
      { ...body, candidateSize: undefined }, { ...body, candidateSize: 0 },
      { ...body, candidateSize: 2 }, { ...body, candidateSize: 101 },
      { ...body, rerank: { provider: 'typesafe', model: 'jev-1.13.0', queryText: 'serverless', fields: ['text'] } },
      ...[[], [signals[0]], [...signals, signals[0]]].map(bayesian => ({ ...body, query: { bayesian } })),
      { ...body, query: { bayesian: [{ ...signals[0], boost: 1 }, signals[1]] } },
      { ...body, query: { bayesian: [{ bool: [{ occur: 'MUST', ...signals[0], boost: 1 }] }, signals[1]] } },
      ...['bayesian', 'rrf', 'mm', 'l2'].map(method => ({ ...body, query: { bayesian: [{ [method]: signals }, signals[1]] } })),
      { ...body, query: signals[0] },
    ];
    for (const request of invalid) {
      const rejected = await nativeQuery(request);
      assert.equal(rejected.code, 3);
      assert.equal(rejected.result.error?.code, 'API_ERROR');
      assert.equal(rejected.result.error?.httpStatus, 400);
    }
    progress(`Native/legacy=${legacy}: create/update, actual embeddings, ordinary retrieval, Bayesian budgets, default/explicit rerank and ${invalid.length} HTTP 400 rejections passed.`);
  }
  t.diagnostic('Doctor, all 49 analyzer preset metadata, ordinary/bulk acceptance, committed query/fetch, facets and managed reranking default/null/custom passed. This is a bounded development sample, not a production readiness or search-quality guarantee.');
});
