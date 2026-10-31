import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Analyzer } from '@functional-systems/lambdadb/models';
import { observeWithin } from '../helpers/observation.mjs';
import { rerankWithRetry } from '../helpers/rerank.mjs';

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
  // One hook removes temporary collections through the CLI, which still needs the temp config,
  // and only then the temp directory. Every removal is verified by HTTP 404 before the hook fails.
  const temporaryCollections = [];
  t.after(async () => {
    const unconfirmed = [];
    for (const name of temporaryCollections) {
      // A killed or incomplete CLI process must not stop the remaining removals.
      try {
        const deleted = await run(['collections', 'delete', '--collection', name]);
        const gone = deleted.code === 0 || (deleted.code === 3 && deleted.result.error?.httpStatus === 404)
          ? await run(['collections', 'describe', '--collection', name]) : deleted;
        if (gone.code === 3 && gone.result.error?.httpStatus === 404) t.diagnostic(`Cleanup verified by HTTP 404 for temporary collection ${name}.`);
        else unconfirmed.push(name);
      } catch { unconfirmed.push(name); }
    }
    await rm(temp, { recursive: true, force: true });
    if (unconfirmed.length) throw new Error(`Cleanup failed or is unconfirmed; inspect temporary collection(s) ${unconfirmed.join(', ')}.`);
  });
  const removeAfterwards = name => temporaryCollections.push(name);
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
  const created = await run(['collections', 'create', '--collection', collection, '--index-config', indexFile,
    '--description', 'CLI live smoke', '--tag', 'suite=cli-smoke', '--snapshot-retention-days', '7']);
  if (created.code === 0 || created.code === 5) removeAfterwards(collection);
  const createdCollection = success(created, 'create').collection;
  assert.deepEqual([createdCollection.description, createdCollection.tags, createdCollection.snapshotRetentionInDays], ['CLI live smoke', { suite: 'cli-smoke' }, 7]);
  progress(`Created temporary collection ${collection} with description, metadata tag and 7-day retention.`);
  const described = success(await run(['collections', 'describe', '--collection', collection]), 'describe analyzers');
  assert.deepEqual([described.collection.description, described.collection.tags, described.collection.snapshotRetentionInDays], ['CLI live smoke', { suite: 'cli-smoke' }, 7]);
  const settings = success(await run(['collections', 'update', '--collection', collection, '--description', '', '--tag', 'suite=cli-smoke', '--tag', 'stage=updated', '--snapshot-retention-days', '3']), 'update settings');
  assert.deepEqual([settings.collection.description, settings.collection.tags, settings.collection.snapshotRetentionInDays], ['', { suite: 'cli-smoke', stage: 'updated' }, 3]);
  assert.deepEqual(success(await run(['collections', 'update', '--collection', collection, '--clear-tags']), 'clear tags').collection.tags, {});
  progress('Collection settings update verified: description cleared, tags replaced then cleared, retention lowered.');
  assert.ok(Object.entries(indexConfigs).every(([field, config]) => isDeepStrictEqual(described.collection?.indexConfigs?.[field], config)),
    'Collection metadata must preserve every requested analyzer preset.');
  assert.deepEqual(described.collection.indexConfigs.id, { type: 'keyword' }, 'Described metadata must include the server-managed id field.');
  const roundTripFile = join(temp, 'index-config-described.json');
  await writeFile(roundTripFile, JSON.stringify(described.collection.indexConfigs));
  assert.equal(success(await run(['collections', 'update', '--collection', collection, '--index-config', roundTripFile]), 'id round trip').state, 'updated');
  progress('All 49 fixed analyzer presets accepted and metadata verified; described metadata with the server-managed id was sent back unchanged. Language-specific search quality is not measured.');
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
  // Both limits were 100 before the 1000-count read contract.
  const largeQueryFile = join(temp, 'query-size-1000.json');
  await writeFile(largeQueryFile, JSON.stringify({ size: 1000, fields: { include: ['id'] } }));
  assert.equal(success(await run(['query', '--collection', collection, '--ref', 'branch:main', '--file', largeQueryFile]), 'query size 1000').docs.length, expected.length);
  const missing = Array.from({ length: 1000 - expected.length }, (_, i) => `missing-${i}`);
  const fetched = success(await run(['docs', 'fetch', '--collection', collection, '--ref', 'branch:main', '--ids', ...expected.map(row => row.id), ...missing]), 'fetch 1000 IDs');
  assert.deepEqual(fetched.docs.map(hit => hit.doc.id).sort(), expected.map(row => row.id).sort());
  assert.deepEqual(fetched.missingIds, missing);
  progress('Query size 1000 and fetch of 1000 IDs accepted.');
  for (const [file, expectedDocs] of [['query-facets-only.json', 0], ['query-with-facets.json', 3]]) {
    const data = success(await run(['query', '--collection', collection, '--ref', 'branch:main', '--file', resolve('examples', file)]), file);
    assert.equal(data.docs.length, expectedDocs);
    assert.deepEqual(data.facets?.category?.buckets, [
      { value: 'database', count: 2 }, { value: 'developer-tools', count: 1 },
    ]);
    progress(`${file}: document count and exact facet buckets verified.`);
  }
  const idsOnly = join(temp, 'list-ids.json');
  await writeFile(idsOnly, JSON.stringify({ fields: { include: ['id'] } }));
  const firstPage = success(await run(['docs', 'list', '--collection', collection, '--ref', 'branch:main', '--size', '2', '--file', idsOnly]), 'list page 1');
  assert.equal(firstPage.docs.length, 2);
  assert.ok(firstPage.nextPageToken, 'A two-document page of three documents must carry a page token.');
  assert.ok(firstPage.docs.every(hit => Object.keys(hit.doc).join() === 'id'), 'fields.include must limit returned fields.');
  const secondPage = success(await run(['docs', 'list', '--collection', collection, '--ref', 'branch:main', '--size', '2', '--file', idsOnly, '--page-token', firstPage.nextPageToken]), 'list page 2');
  assert.deepEqual([...firstPage.docs, ...secondPage.docs].map(hit => hit.doc.id).sort(), expected.map(row => row.id).sort());
  assert.deepEqual(success(await run(['docs', 'list', '--collection', collection, '--ref', 'branch:main', '--size', '1', '--all', '--file', idsOnly]), 'list all').docs.map(hit => hit.doc.id).sort(), expected.map(row => row.id).sort());
  const filterFile = join(temp, 'list-filter.json');
  await writeFile(filterFile, JSON.stringify({ filter: { queryString: { query: 'category:database' } }, fields: { include: ['id', 'category'] } }));
  const filtered = success(await run(['docs', 'list', '--collection', collection, '--ref', 'branch:main', '--file', filterFile]), 'list filter');
  assert.deepEqual(filtered.docs.map(hit => hit.doc.id).sort(), ['large-1', 'large-2']);
  assert.equal(success(await run(['docs', 'list', '--collection', collection, '--ref', 'branch:main', '--size', '1']), 'list GET route').docs.length, 1);
  progress('Document listing verified: paging with a token, --all, extended filter/fields selectors and the plain route.');

  const branch = success(await run(['branches', 'create', '--collection', collection, '--branch', 'smoke-branch']), 'branch create');
  assert.equal(branch.state, 'created');
  assert.equal(branch.branch.parentBranch?.name, 'main');
  assert.ok(branch.branch.headSnapshot?.snapshotId, 'A branch from committed main must have a head snapshot.');
  assert.deepEqual(success(await run(['branches', 'list', '--collection', collection]), 'branch list').branches.map(item => item.name).sort(), ['main', 'smoke-branch']);
  const tag = success(await run(['tags', 'create', '--collection', collection, '--tag', 'smoke-tag', '--source', 'branch:main']), 'tag create');
  // The SDK converts snapshot and creation times to Date, printed as ISO 8601.
  assert.ok(tag.tag.snapshotId && Number.isFinite(Date.parse(tag.tag.snapshotCommittedAt)));
  assert.deepEqual(success(await run(['tags', 'list', '--collection', collection]), 'tag list').tags.map(item => item.name), ['smoke-tag']);
  const alias = success(await run(['aliases', 'create', '--collection', collection, '--alias', 'smoke-alias', '--target', 'tag:smoke-tag']), 'alias create');
  assert.deepEqual([alias.alias.targetKind, alias.alias.targetName], ['TAG', 'smoke-tag']);
  for (const ref of ['tag:smoke-tag', 'alias:smoke-alias', 'branch:smoke-branch']) {
    const pinned = success(await run(['docs', 'fetch', '--collection', collection, '--ref', ref, '--ids', ...expected.map(row => row.id)]), `fetch at ${ref}`);
    assert.deepEqual(pinned.docs.map(hit => hit.doc.id).sort(), expected.map(row => row.id).sort(), `${ref} must expose the committed documents.`);
  }
  const branchDoc = join(temp, 'branch-doc.jsonl');
  await writeFile(branchDoc, JSON.stringify({ id: 'branch-only', text: 'branch only', category: 'database' }) + '\n');
  assert.equal(success(await run(['docs', 'import', '--collection', collection, '--branch', 'smoke-branch', '--file', branchDoc]), 'branch import').accepted, 1);
  assert.deepEqual(success(await run(['docs', 'fetch', '--collection', collection, '--ref', 'branch:smoke-branch', '--ids', 'branch-only', '--consistent-read']), 'branch consistent fetch').missingIds, []);
  assert.deepEqual(success(await run(['docs', 'fetch', '--collection', collection, '--ref', 'branch:main', '--ids', 'branch-only', '--consistent-read']), 'main isolation').missingIds, ['branch-only']);
  const retargeted = success(await run(['aliases', 'retarget', '--collection', collection, '--alias', 'smoke-alias', '--target', 'branch:smoke-branch']), 'alias retarget');
  assert.deepEqual([retargeted.alias.targetKind, retargeted.alias.targetName, retargeted.alias.aliasRevision > alias.alias.aliasRevision], ['BRANCH', 'smoke-branch', true]);
  const referenced = await run(['branches', 'delete', '--collection', collection, '--branch', 'smoke-branch']);
  assert.deepEqual([referenced.code, referenced.result.error?.httpStatus], [3, 409], 'Deleting an alias-referenced branch must be refused.');
  assert.equal(success(await run(['aliases', 'delete', '--collection', collection, '--alias', 'smoke-alias']), 'alias delete').state, 'deleted');
  assert.equal(success(await run(['tags', 'delete', '--collection', collection, '--tag', 'smoke-tag']), 'tag delete').state, 'deleted');
  assert.equal(success(await run(['branches', 'delete', '--collection', collection, '--branch', 'smoke-branch']), 'branch delete').state, 'deleted');
  const protectedMain = await run(['branches', 'delete', '--collection', collection, '--branch', 'main']);
  assert.deepEqual([protectedMain.code, protectedMain.result.error?.httpStatus], [3, 400], 'Deleting main must be refused.');
  assert.deepEqual(success(await run(['branches', 'list', '--collection', collection]), 'branch list after cleanup').branches.map(item => item.name), ['main']);
  progress('Refs verified: branch from main, tag pinned, alias created and retargeted, reads at tag/alias/branch, branch isolation under consistent reads, 409 for a referenced branch, 400 for main, and deletions.');

  const baseline = JSON.parse(await readFile(resolve('examples/query.json'), 'utf8'));
  for (const variant of ['default', 'null', 'custom', 'cohere']) {
    const rerank = variant === 'null' ? null : {
      provider: 'typesafe', model: 'jev-1.13.0', queryText: 'How does serverless search work?', fields: ['text'], onFailure: 'returnOriginal',
      ...(variant === 'cohere' ? { provider: 'cohere', model: 'rerank-v5.0-fast' } : {}),
      ...(variant === 'custom' ? { candidateSize: 50, onFailure: 'error', criteria: [
        'Does not address serverless search.', 'Explains serverless search directly.',
      ] } : {}),
    };
    const file = join(temp, `query-rerank-${variant}.json`);
    await writeFile(file, JSON.stringify({ ...baseline, rerank }));
    const query = async () => success(await run(['query', '--collection', collection, '--ref', 'branch:main', '--file', file], 60000), `rerank ${variant}`);
    // The custom variant sets onFailure itself and stays one-shot to keep that contract coverage.
    const data = rerank?.onFailure === 'returnOriginal'
      ? await rerankWithRetry({ query, size: baseline.size, label: `${rerank.provider} ${rerank.model}` }) : await query();
    assert.equal(data.docs.length, 3);
    assert.ok(expected.every(row => data.docs.some(hit => hit.doc.id === row.id)));
    if (variant === 'null') {
      assert.equal(data.rerank, undefined);
      assert.ok(data.docs.every(hit => hit.retrievalScore === undefined));
    } else {
      assert.equal(data.rerank?.status, 'applied');
      assert.equal(data.rerank?.provider, rerank.provider);
      assert.equal(data.rerank?.model, rerank.model);
      assert.equal(data.rerank?.criteriaVersion, { default: 'default-relevance-v1', custom: 'custom', cohere: 'cohere-relevance-v1' }[variant]);
      assert.equal(data.rerank?.candidateCount, 3);
      assert.equal(data.rerank?.scoredCount, 3);
      assert.ok(data.docs.every(hit => Number.isFinite(hit.score) && hit.score >= 0 && hit.score <= 1 && Number.isFinite(hit.retrievalScore)));
      assert.ok(data.docs.every((hit, i) => i === 0 || data.docs[i - 1].score >= hit.score));
      assert.equal(data.maxScore, data.docs[0].score);
    }
    progress(`Native reranking ${variant}: document envelopes and status metadata verified.`);
  }
  async function waitForFetch(args, check, stage) {
    assert.ok(await observeWithin({ timeoutMs: 120000, intervalMs: 2000, poll: async remainingMs => check(success(await run(args, remainingMs), stage)) }),
      `${stage} did not reach the expected state within 120 seconds.`);
    progress(`${stage} verified.`);
  }
  const patchFile = join(temp, 'updates.jsonl');
  await writeFile(patchFile, JSON.stringify({ id: 'bulk-1', note: 'updated by docs update' }) + '\n');
  const patched = success(await run(['docs', 'update', '--collection', collection, '--branch', 'main', '--file', patchFile]), 'docs update');
  assert.deepEqual([patched.state, patched.accepted, patched.searchable], ['accepted', 1, 'not_verified']);
  await waitForFetch(['docs', 'fetch', '--collection', collection, '--ref', 'branch:main', '--ids', 'bulk-1', '--consistent-read'],
    data => data.docs[0]?.doc.note === 'updated by docs update' && data.docs[0].doc.category === bulkRow.category && data.docs[0].doc.text === bulkRow.text, 'merged update');
  assert.equal(success(await run(['docs', 'delete', '--collection', collection, '--branch', 'main', '--ids', 'bulk-1']), 'delete by id').state, 'accepted');
  await waitForFetch(['docs', 'fetch', '--collection', collection, '--ref', 'branch:main', '--ids', 'bulk-1', '--consistent-read'],
    data => isDeepStrictEqual(data.missingIds, ['bulk-1']), 'delete by id');
  const deleteFilter = join(temp, 'delete-filter.json');
  await writeFile(deleteFilter, JSON.stringify({ filter: { queryString: { query: 'category:database' } } }));
  assert.equal(success(await run(['docs', 'delete', '--collection', collection, '--branch', 'main', '--file', deleteFilter]), 'delete by filter').state, 'accepted');
  await waitForFetch(['docs', 'fetch', '--collection', collection, '--ref', 'branch:main', '--ids', 'large-1', 'large-2', '--consistent-read'],
    data => isDeepStrictEqual(data.missingIds, ['large-1', 'large-2']), 'delete by filter');
  for (const variant of ['openai', 'openai-legacy', 'cohere-sources']) {
    const legacy = variant === 'openai-legacy';
    const nativeCollection = `cli-native-${randomUUID()}`;
    const embedding = variant === 'cohere-sources'
      ? { provider: 'cohere', model: 'embed-v5.0-fast', sources: [{ field: 'text', type: 'text' }], dimensions: 256, similarity: 'cosine' }
      : { provider: 'openai', model: 'text-embedding-3-small', sourceField: 'text', dimensions: 256, similarity: 'cosine' };
    const nativeConfigs = { text: { type: 'text' }, vector: { type: 'vector', embedding, ...(legacy ? { managedEmbedding: true } : {}) } };
    const configFile = join(temp, `native-${variant}.json`);
    await writeFile(configFile, JSON.stringify(nativeConfigs));
    const nativeCreated = await run(['collections', 'create', '--collection', nativeCollection, '--index-config', configFile]);
    if (nativeCreated.code === 0 || nativeCreated.code === 5) removeAfterwards(nativeCollection);
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
    const nativeDocs = join(temp, `native-docs-${variant}.jsonl`);
    await writeFile(nativeDocs, nativeRows.map(row => JSON.stringify(row)).join('\n') + '\n');
    assert.equal(success(await run(['docs', 'import', '--collection', nativeCollection, '--branch', 'main', '--file', nativeDocs]), 'native import').accepted, 3);
    const queryFile = join(temp, `native-query-${variant}.json`);
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
    assert.ok(baseline.docs.every(hit => Number.isFinite(hit.score)));
    const prefix = success(await nativeQuery({ ...body, size: 1 }), 'fixed candidate budget');
    // Separate provider embedding calls need not return bit-identical retrieval scores.
    assert.deepEqual(prefix.docs.map(hit => hit.doc), baseline.docs.slice(0, 1).map(hit => hit.doc));
    assert.ok(prefix.docs.every(hit => Number.isFinite(hit.score)));
    const queryInputs = { knn: { field: 'vector', queryInputs: [{ type: 'text', value: 'How does serverless search work?' }], k: 30 } };
    for (const query of [signals[0], signals[1], queryInputs, ...['rrf', 'mm', 'l2'].map(method => ({ [method]: signals }))]) {
      assert.ok(success(await nativeQuery({ query, size: 3, consistentRead: true }), 'ordinary retrieval').docs.length > 0);
    }
    for (const explicitBudget of [false, true]) {
      const reranked = await rerankWithRetry({ size: 2, label: 'typesafe jev-1.13.0 Bayesian', query: async () =>
        success(await nativeQuery({ query: body.query, size: 2, consistentRead: true, rerank: {
          provider: 'typesafe', model: 'jev-1.13.0', queryText: 'How does serverless search work?', fields: ['text'],
          onFailure: 'returnOriginal', ...(explicitBudget ? { candidateSize: 30 } : {}),
        } }), 'Bayesian rerank') });
      assert.equal(reranked.rerank?.status, 'applied');
      assert.equal(reranked.rerank.candidateCount, 3);
      assert.equal(reranked.rerank.scoredCount, 3);
      assert.equal(reranked.docs.length, 2);
      assert.ok(reranked.docs.every(hit => Number.isFinite(hit.score) && hit.score >= 0 && hit.score <= 1
        && Number.isFinite(hit.retrievalScore) && baseline.docs.some(original => isDeepStrictEqual(original.doc, hit.doc))));
    }
    const nullRerank = success(await nativeQuery({ ...body, rerank: null }), 'null rerank');
    assert.deepEqual(nullRerank.docs.map(hit => hit.doc), baseline.docs.map(hit => hit.doc));
    assert.ok(nullRerank.docs.every(hit => Number.isFinite(hit.score) && hit.retrievalScore === undefined));
    assert.equal(nullRerank.rerank, undefined);
    // Reject above both the original 100-candidate limit and the newer 1000-candidate limit.
    const invalid = [
      { ...body, candidateSize: undefined }, { ...body, candidateSize: 0 },
      { ...body, candidateSize: 2 }, { ...body, candidateSize: 1001 },
      { ...body, rerank: { provider: 'typesafe', model: 'jev-1.13.0', queryText: 'serverless', fields: ['text'] } },
      ...[[], [signals[0]], [...signals, signals[0]]].map(bayesian => ({ ...body, query: { bayesian } })),
      { ...body, query: { bayesian: [{ ...signals[0], boost: 1 }, signals[1]] } },
      { ...body, query: { bayesian: [{ bool: [{ occur: 'MUST', ...signals[0], boost: 1 }] }, signals[1]] } },
      ...['bayesian', 'rrf', 'mm', 'l2'].map(method => ({ ...body, query: { bayesian: [{ [method]: signals }, signals[1]] } })),
      { ...body, query: signals[0] },
    ];
    for (const [index, request] of invalid.entries()) {
      const rejected = await nativeQuery(request);
      assert.equal(rejected.code, 3, `Native embedding ${variant} invalid Bayesian case ${index}: exit=${rejected.code}, HTTP=${rejected.result.error?.httpStatus ?? 'not available'}`);
      assert.equal(rejected.result.error?.code, 'API_ERROR');
      assert.equal(rejected.result.error?.httpStatus, 400);
    }
    progress(`Native embedding ${variant}: create/update, actual embeddings, ordinary and queryInputs retrieval, Bayesian budgets, default/explicit rerank and ${invalid.length} HTTP 400 rejections passed.`);
  }
  t.diagnostic('Doctor, collection settings, all 49 analyzer preset metadata, id round trip, ordinary/bulk acceptance, committed query/fetch including the 1000 limits, facets, document listing, branch/tag/alias lifecycle, partial update and deletes under consistent reads, native reranking default/null/custom/Cohere, OpenAI/legacy/Cohere native embeddings and CLI collection deletion passed. This is a bounded development sample, not a production readiness or search-quality guarantee.');
});
