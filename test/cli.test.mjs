import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = process.env.LAMBDADB_TEST_CLI ?? resolve('dist/cli.js');
const packageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const secret = 'test-secret-never-print';
const indexConfigs = { text: { type: 'text', analyzers: ['english'] } };
const created = { collectionName: 'demo-docs', description: '', tags: {}, defaultBranchName: 'main', snapshotRetentionInDays: 30, createdAt: 1789689600000 };
const metadata = { ...created, projectName: 'dev-project', indexConfigs, numPartitions: 1, numDocs: 3, updatedAt: created.createdAt };

async function fixture(t, handler) {
  const temp = await mkdtemp(join(tmpdir(), 'lambdadb-cli-test-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const request = { method: req.method, url: new URL(req.url, base), headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    requests.push(request);
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try { await handler(request, send, req, res, base); }
    catch (error) { send(500, { message: String(error) }); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(temp, { recursive: true, force: true }); });
  async function file(name, value) {
    const path = join(temp, name);
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  }
  async function run(args, env = {}, onSpawn = () => {}) {
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LAMBDADB_') && key !== 'XDG_CONFIG_HOME'));
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...cleanEnv, XDG_CONFIG_HOME: temp, LAMBDADB_ENDPOINT: base, LAMBDADB_PROJECT: 'dev-project', LAMBDADB_API_KEY: secret, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    onSpawn(child);
    child.stdout.on('data', c => stdout += c);
    child.stderr.on('data', c => stderr += c);
    const code = await new Promise((r, reject) => { child.on('error', reject); child.on('close', r); });
    clearTimeout(timer);
    assert.notEqual(code, null, `CLI did not terminate: ${stdout} ${stderr}`);
    assert.ok(!stdout.includes(secret) && !stderr.includes(secret), 'credential leaked');
    return { code, stdout, stderr, json: args.includes('--json') ? JSON.parse(stdout) : undefined };
  }
  return { run, file, requests, base, temp };
}

test('SIGINT and SIGTERM preserve accepted batches and classify an active write as unknown', async t => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    await t.test(signal, async t => {
      let child;
      let calls = 0;
      const f = await fixture(t, (_r, send) => {
        if (++calls === 1) send(202, { message: 'accepted' });
        else child.kill(signal);
      });
      const r = await f.run(['docs', 'import', '--collection', 'demo-docs', '--branch', 'main',
        '--batch-size', '1', '--file', resolve('examples/documents.jsonl'), '--json'], {}, spawned => { child = spawned; });
      assert.equal(r.code, 5);
      assert.equal(calls, 2);
      assert.deepEqual([r.json.data.accepted, r.json.data.unknown, r.json.data.notAttempted], [1, 1, 1]);
    });
  }
});

test('local end-to-end configure → doctor → create → import → query → fetch, plus describe and SDK pagination', async t => {
  const stored = [];
  const f = await fixture(t, async (r, send) => {
    const path = r.url.pathname;
    if (path.endsWith('/collections') && r.method === 'POST') return send(201, { collection: created });
    if (path.endsWith('/collections')) return send(200, { collections: [metadata], ...(r.url.searchParams.get('size') === '1' && !r.url.searchParams.has('pageToken') ? { nextPageToken: 'next opaque/+' } : {}) });
    if (path.endsWith('/docs/upsert')) { stored.push(...r.body.docs); return send(202, { message: 'Upsert request is accepted' }); }
    if (path.endsWith('/query')) return send(200, { took: 1, total: 1, isDocsInline: true, docs: [{ collection: 'demo-docs', score: 0.8, doc: stored[0] }] });
    if (path.endsWith('/docs/fetch')) return send(200, { took: 1, total: 1, isDocsInline: true, docs: [{ collection: 'demo-docs', doc: stored[0] }] });
    return send(200, { collection: metadata });
  });
  const config = join(f.temp, 'saved.json');
  let r = await f.run(['configure', '--config', config, '--json']);
  assert.equal(r.code, 0);
  assert.equal((await stat(config)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(config, 'utf8')).includes(secret));
  r = await f.run(['doctor', '--config', config, '--json'], { LAMBDADB_ENDPOINT: '', LAMBDADB_PROJECT: '' });
  assert.equal(r.code, 2, 'explicit empty env must not silently select stored target');
  assert.equal((await f.run(['doctor', '--json'])).code, 0);
  r = await f.run(['collections', 'create', '--collection', 'demo-docs', '--index-config', await f.file('index.json', indexConfigs), '--json']);
  assert.equal(r.code, 0); assert.equal(r.json.data.searchable, 'not_verified');
  r = await f.run(['docs', 'import', '--collection', 'demo-docs', '--branch', 'main', '--file', resolve('examples/documents.jsonl'), '--batch-size', '2', '--json']);
  assert.equal(r.code, 0); assert.equal(r.json.data.accepted, 3); assert.equal(r.json.data.batches.length, 2);
  assert.match(r.stderr, /Batch 2: accepted/); assert.equal(r.stdout.trim().split('\n').length, 1);
  r = await f.run(['query', '--collection', 'demo-docs', '--ref', 'branch:main', '--file', resolve('examples/query.json'), '--json']);
  assert.equal(r.code, 0); assert.equal(r.json.data.docs[0].doc.id, 'doc-1');
  r = await f.run(['docs', 'fetch', '--collection', 'demo-docs', '--ref', 'branch:main', '--ids', 'doc-1', 'missing', '--json']);
  assert.equal(r.code, 0); assert.deepEqual(r.json.data.missingIds, ['missing']);
  assert.equal((await f.run(['collections', 'describe', '--collection', 'demo-docs', '--json'])).code, 0);
  r = await f.run(['collections', 'list', '--all', '--size', '1', '--json']);
  assert.equal(r.code, 0); assert.equal(r.json.data.collections.length, 2);
  assert.equal(f.requests.at(-1).url.searchParams.get('pageToken'), 'next opaque/+');
  assert.ok(f.requests.every(r => r.url.pathname.startsWith('/projects/dev-project/')));
  assert.deepEqual(f.requests.filter(r => r.url.pathname.endsWith('/docs/upsert')).map(r => r.body.branch), ['main', 'main']);
});

test('query and fetch forward branch, tag and alias refs exactly; SDK follows docsUrl without API credentials', async t => {
  const doc = { collection: 'demo-docs', doc: { id: 'doc-1', text: 'x'.repeat(1024 * 1024) } };
  const f = await fixture(t, (r, send, _req, _res, base) => {
    if (r.url.pathname === '/download') return send(200, [doc]);
    send(200, { took: 1, total: 1, isDocsInline: false, docs: [], docsUrl: `${base}/download?signature=private-url` });
  });
  for (const kind of ['branch', 'tag', 'alias']) {
    for (const command of ['query', 'fetch']) {
      const args = command === 'query' ? ['query', '--file', resolve('examples/query.json')] : ['docs', 'fetch', '--ids', 'doc-1'];
      const r = await f.run([...args, '--collection', 'demo-docs', '--ref', `${kind}:version-one`, '--json'], { LAMBDADB_DEBUG: 'true' });
      assert.equal(r.code, 0); assert.equal(r.json.data.docs[0].doc.text.length, 1024 * 1024);
      assert.deepEqual(f.requests.at(-2).body.ref, { kind, name: 'version-one' });
      assert.deepEqual(r.json.target.ref, { kind, name: 'version-one' });
      assert.ok(!r.stdout.includes('private-url'));
      assert.ok(Object.values(f.requests.at(-2).headers).includes(secret), 'API call must use SDK authentication');
      assert.ok(!Object.values(f.requests.at(-1).headers).includes(secret), 'download must not use API authentication');
      assert.equal(r.stderr, '');
    }
  }
});

test('bulk SDK preserves branch, signed headers, upload body and completion; no credentials on storage', async t => {
  const f = await fixture(t, (r, send, _req, _res, base) => {
    if (r.method === 'GET') return send(200, { url: `${base}/upload`, type: 'application/json', httpMethod: 'PUT', objectKey: 'object-key', sizeLimitBytes: 200000000, headers: { 'If-None-Match': '*', 'x-test-signed': 'signed' } });
    if (r.method === 'PUT') return send(200, {});
    send(202, { message: 'Bulk request is accepted' });
  });
  const r = await f.run(['docs', 'import', '--collection', 'demo-docs', '--branch', 'dev-branch', '--mode', 'bulk', '--file', resolve('examples/documents.jsonl'), '--json']);
  assert.equal(r.code, 0); assert.equal(r.json.data.accepted, 3);
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[0].url.searchParams.get('branch'), 'dev-branch');
  assert.equal(f.requests[1].headers['if-none-match'], '*');
  assert.equal(f.requests[1].headers['x-test-signed'], 'signed');
  assert.ok(!Object.values(f.requests[1].headers).includes(secret));
  assert.deepEqual(Object.keys(f.requests[1].body), ['docs']);
  assert.deepEqual(f.requests[2].body, { objectKey: 'object-key', type: 'application/json', branch: 'dev-branch' });
});

test('partial import stops on rejection and preserves counts and line ranges', async t => {
  let calls = 0;
  const f = await fixture(t, (_r, send) => ++calls === 1 ? send(202, { message: 'accepted' }) : send(400, { message: secret }));
  const r = await f.run(['docs', 'import', '--collection', 'demo-docs', '--branch', 'main', '--batch-size', '1', '--file', resolve('examples/documents.jsonl'), '--json']);
  assert.equal(r.code, 4); assert.equal(r.json.ok, false); assert.equal(calls, 2);
  assert.deepEqual([r.json.data.accepted, r.json.data.failed, r.json.data.unknown, r.json.data.notAttempted], [1, 1, 0, 1]);
  assert.equal(r.json.data.batches[1].firstLine, 2);
  assert.equal(r.json.data.batches[1].error.httpStatus, 400);
});

test('ambiguous mutation responses are unknown, are not retried, and preserve prior acceptance', async t => {
  for (const failure of ['disconnect', 'server-error', 'malformed-success', 'timeout']) {
    await t.test(failure, async t => {
      let calls = 0;
      const f = await fixture(t, (_r, send, req) => {
        if (++calls === 1) return send(202, { message: 'accepted' });
        if (failure === 'disconnect') req.socket.destroy();
        if (failure === 'server-error') send(503, { message: 'unavailable' });
        if (failure === 'malformed-success') send(202, { bad: 'shape' });
      });
      const r = await f.run(['docs', 'import', '--collection', 'demo-docs', '--branch', 'main', '--batch-size', '1', '--file', resolve('examples/documents.jsonl'), '--timeout-ms', '600', '--json']);
      assert.equal(r.code, 5); assert.equal(calls, 2);
      assert.deepEqual([r.json.data.accepted, r.json.data.failed, r.json.data.unknown, r.json.data.notAttempted], [1, 0, 1, 1]);
    });
  }
});

test('failed bulk upload is never finalized or retried; SDK stage ambiguity is reported conservatively', async t => {
  const f = await fixture(t, (r, send, _req, _res, base) => {
    if (r.method === 'GET') return send(200, { url: `${base}/upload`, type: 'application/json', httpMethod: 'PUT', objectKey: 'key', sizeLimitBytes: 1000000, headers: { 'If-None-Match': '*' } });
    send(412, { message: secret });
  });
  const r = await f.run(['docs', 'import', '--collection', 'demo-docs', '--branch', 'main', '--mode', 'bulk', '--file', resolve('examples/documents.jsonl'), '--json']);
  assert.equal(r.code, 5); assert.equal(f.requests.length, 2); assert.equal(r.json.data.accepted, 0);
});

test('input errors reject the complete JSONL/query before any network call', async t => {
  const f = await fixture(t, (_r, send) => send(500, {}));
  const invalidJsonl = await f.file('bad.jsonl', '{"id":"good"}\n{bad}\n');
  const invalidQuery = await f.file('bad-query.json', { query: {}, typo: true });
  const conflicting = await f.file('ref.json', { query: {}, ref: { kind: 'tag', name: 'other' } });
  const consistent = await f.file('consistent.json', { query: {}, consistentRead: true });
  const invalidSize = await f.file('size.json', { query: {}, size: 1001 });
  const cases = [
    ['docs', 'import', '--file', invalidJsonl, '--branch', 'main', '--collection', 'demo-docs'],
    ['docs', 'import', '--file', await f.file('empty.jsonl', '\n'), '--branch', 'main', '--collection', 'demo-docs'],
    ['docs', 'import', '--file', await f.file('id.jsonl', '{"id":5}\n'), '--branch', 'main', '--collection', 'demo-docs'],
    ['docs', 'import', '--file', resolve('examples/documents.jsonl'), '--branch', 'main', '--collection', 'demo-docs', '--batch-bytes', '64'],
    ...[invalidQuery, conflicting, consistent, invalidSize].map(file => ['query', '--file', file, '--collection', 'demo-docs', '--ref', 'tag:release']),
    ['docs', 'fetch', '--collection', 'demo-docs', '--ref', 'tag:release', '--consistent-read', '--ids', 'id1'],
    ['collections', 'create', '--collection', 'demo-docs', '--index-config', await f.file('empty-map.json', {})],
    ['collections', 'list', '--size', 'NaN'],
    ['query'], ['docs', 'fetch', '--collection', 'demo-docs', '--ids', 'doc-1'], ['--unknown', secret],
  ];
  for (const args of cases) {
    const r = await f.run([...args, '--json']);
    assert.equal(r.code, 2, r.stdout); assert.equal(r.json.error.code, 'INPUT_ERROR');
  }
  assert.equal(f.requests.length, 0);
});

test('no matches succeeds; auth, API, transport and invalid response fail distinctly', async t => {
  for (const status of [200, 401, 403, 404, 400, 500]) {
    await t.test(String(status), async t => {
      const f = await fixture(t, (_r, send) => send(status, status === 200 ? { took: 1, total: 0, isDocsInline: true, docs: [] } : { message: secret }));
      const r = await f.run(['query', '--collection', 'demo-docs', '--ref', 'branch:main', '--file', resolve('examples/query.json'), '--timeout-ms', '300', '--json']);
      assert.equal(r.code, status === 200 ? 0 : 3);
      if (status === 200) assert.deepEqual(r.json.data.docs, []);
      if ([401, 403].includes(status)) assert.equal(r.json.error.code, 'AUTH_ERROR');
      assert.equal(r.json.schemaVersion, 1);
    });
  }
  const f = await fixture(t, (_r, send) => send(200, { incompatible: true }));
  assert.equal((await f.run(['doctor', '--json'])).code, 3);
});

test('configuration precedence, custom auth env, secrets and SDK debug suppression', async t => {
  const f = await fixture(t, (_r, send) => send(200, { collections: [] }));
  const config = await f.file('config.json', { endpoint: f.base, project: 'saved-project', apiKeyEnv: 'CUSTOM_API_KEY' });
  let r = await f.run(['doctor', '--config', config, '--project', 'flag-project', '--json'], { CUSTOM_API_KEY: secret, LAMBDADB_PROJECT: 'env-project', LAMBDADB_DEBUG: 'true' });
  assert.equal(r.code, 0); assert.equal(r.json.target.project, 'flag-project'); assert.equal(r.stderr, '');
  r = await f.run(['doctor', '--config', config, '--json'], { CUSTOM_API_KEY: secret, LAMBDADB_PROJECT: 'env-project' });
  assert.equal(r.json.target.project, 'env-project');
  r = await f.run(['doctor', '--config', config, '--json'], { CUSTOM_API_KEY: secret, LAMBDADB_PROJECT: undefined, LAMBDADB_ENDPOINT: undefined });
  assert.equal(r.code, 0); assert.equal(r.json.target.project, 'saved-project');
  r = await f.run(['doctor', '--config', config, '--api-key-env', 'MISSING_KEY', '--json']);
  assert.equal(r.code, 2);
  r = await f.run(['doctor', '--config', await f.file('secret-config.json', { apiKey: secret }), '--json']);
  assert.equal(r.code, 2);
  r = await f.run(['doctor', '--endpoint', `https://user:${secret}@example.com`, '--json']);
  assert.equal(r.code, 2);
  r = await f.run(['doctor', '--config', join(f.temp, 'missing.json'), '--json']);
  assert.equal(r.code, 2);
});

test('create failure after dispatch is unknown; API rejection is definite', async t => {
  for (const status of [409, 503]) {
    const f = await fixture(t, (_r, send) => send(status, { message: secret }));
    const r = await f.run(['collections', 'create', '--collection', 'demo-docs', '--index-config', resolve('examples/index-config.json'), '--json']);
    assert.equal(r.code, status === 409 ? 3 : 5); assert.equal(f.requests.length, 1);
  }
});

test('read retries use SDK and normal output is readable', async t => {
  let count = 0;
  const f = await fixture(t, (_r, send) => ++count === 1 ? send(503, { message: 'temporary' }) : send(200, { collections: [] }));
  const r = await f.run(['doctor']);
  assert.equal(r.code, 0); assert.equal(count, 2); assert.match(r.stdout, /Connection verified/);
  assert.equal((await f.run(['--help'])).code, 0);
  assert.equal((await f.run(['--version'])).stdout.trim(), packageVersion);
});

test('null query size uses the public default and branch consistentRead reaches the API', async t => {
  const f = await fixture(t, (_r, send) => send(200, { took: 1, total: 0, isDocsInline: true, docs: [] }));
  const r = await f.run(['query', '--collection', 'demo-docs', '--ref', 'branch:main', '--file', await f.file('query.json', { query: {}, size: null, consistentRead: true }), '--json']);
  assert.equal(r.code, 0); assert.equal(f.requests[0].body.consistentRead, true);
  assert.equal('size' in f.requests[0].body, false);
});

test('deadline covers offloaded downloads and signed uploads as well as API requests', async t => {
  for (const operation of ['query', 'bulk']) {
    await t.test(operation, async t => {
      const f = await fixture(t, (r, send, _req, _res, base) => {
        if (r.url.pathname === '/transfer') return;
        if (operation === 'query') return send(200, { took: 1, total: 1, isDocsInline: false, docs: [], docsUrl: `${base}/transfer` });
        send(200, { url: `${base}/transfer`, type: 'application/json', httpMethod: 'PUT', objectKey: 'key', sizeLimitBytes: 1000000, headers: {} });
      });
      const args = operation === 'query'
        ? ['query', '--ref', 'branch:main', '--file', resolve('examples/query.json')]
        : ['docs', 'import', '--branch', 'main', '--mode', 'bulk', '--file', resolve('examples/documents.jsonl')];
      const started = Date.now();
      const r = await f.run([...args, '--collection', 'demo-docs', '--timeout-ms', '400', '--json']);
      assert.equal(r.code, operation === 'query' ? 3 : 5);
      assert.equal(f.requests.length, 2); assert.ok(Date.now() - started < 2000);
    });
  }
});

test('credential echoed in data is redacted without breaking JSON, even for structural characters', async t => {
  const unusualSecret = '{"key":"x"}';
  const f = await fixture(t, (_r, send) => send(200, { took: 1, total: 1, isDocsInline: true, docs: [{ collection: 'demo-docs', doc: { id: 'doc-1', text: unusualSecret } }] }));
  const r = await f.run(['docs', 'fetch', '--collection', 'demo-docs', '--ref', 'branch:main', '--ids', 'doc-1', '--json'], { LAMBDADB_API_KEY: unusualSecret });
  assert.equal(r.code, 0); assert.equal(r.json.data.docs[0].doc.text, '[REDACTED]');
});

test('credentials matching protocol tokens preserve output schema while redacting variable data', async t => {
  const key = 'accepted';
  const f = await fixture(t, (r, send) => {
    if (r.url.pathname.endsWith('/docs/upsert')) return send(202, { message: 'accepted' });
    if (r.url.pathname.endsWith('/docs/fetch')) return send(200, {
      took: 1, total: 1, isDocsInline: true,
      docs: [{ collection: 'demo-docs', doc: { id: 'doc-1', [key]: key, [`state-${key}`]: key, nested: { [key]: [key] } } }],
    });
    if (r.url.pathname.endsWith('/collections/demo-docs')) return send(200, {
      collection: { ...metadata, tags: { [key]: key }, indexConfigs: { [key]: { type: 'text', analyzers: ['english'] } } },
    });
    return send(200, { collections: [] });
  });
  const env = { LAMBDADB_API_KEY: key };
  let r = await f.run(['doctor', '--json'], env);
  assert.equal(r.code, 0);
  assert.deepEqual(Object.keys(r.json), ['schemaVersion', 'command', 'ok', 'target', 'data']);
  assert.equal(r.json.command, 'doctor');
  assert.equal(r.json.schemaVersion, 1);
  assert.deepEqual(r.json.data.checks, [
    { name: 'configuration', status: 'passed' },
    { name: 'authentication_and_project_collection_list', status: 'passed' },
  ]);
  const args = ['docs', 'import', '--collection', 'demo-docs', '--branch', 'main', '--file', resolve('examples/documents.jsonl')];
  for (const key of ['not_verified', 'accepted']) {
    r = await f.run([...args, '--json'], { LAMBDADB_API_KEY: key });
    assert.equal(r.code, 0);
    assert.equal(r.json.command, 'docs import');
    assert.equal(r.json.data.state, 'accepted');
    assert.equal(r.json.data.searchable, 'not_verified');
    assert.equal(r.json.data.batches[0].state, 'accepted');
  }
  r = await f.run(args, env);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /"accepted": 3/);
  assert.match(r.stdout, /"state": "accepted"/);
  r = await f.run(['docs', 'fetch', '--collection', 'demo-docs', '--ref', 'branch:main', '--ids', 'doc-1', '--json'], env);
  assert.equal(r.json.target.ref.kind, 'branch');
  assert.deepEqual(r.json.data.docs[0].doc, {
    id: 'doc-1', '[REDACTED]': '[REDACTED]', 'state-[REDACTED]': '[REDACTED]',
    nested: { '[REDACTED]': ['[REDACTED]'] },
  });
  r = await f.run(['collections', 'describe', '--collection', 'demo-docs', '--json'], env);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.data.collection.tags, { '[REDACTED]': '[REDACTED]' });
  assert.deepEqual(Object.keys(r.json.data.collection.indexConfigs), ['[REDACTED]']);
});

test('credential matching an error code does not rewrite error categories or import outcomes', async t => {
  let calls = 0;
  const f = await fixture(t, (_r, send) => ++calls === 1 ? send(202, { message: 'accepted' }) : send(401, { message: 'AUTH_ERROR' }));
  const env = { LAMBDADB_API_KEY: 'AUTH_ERROR' };
  const r = await f.run(['docs', 'import', '--collection', 'demo-docs', '--branch', 'main', '--batch-size', '1', '--file', resolve('examples/documents.jsonl'), '--json'], env);
  assert.equal(r.code, 4);
  assert.equal(r.json.data.state, 'partial');
  assert.equal(r.json.data.batches[1].error.code, 'AUTH_ERROR');
  const failed = await f.run(['doctor', '--json'], env);
  assert.equal(failed.code, 3);
  assert.equal(failed.json.error.code, 'AUTH_ERROR');
});

test('query and fetch preserve colliding redacted keys, existing suffixes and nested values in either input order', async t => {
  let doc;
  const f = await fixture(t, (_r, send) => send(200, {
    took: 1, total: 1, isDocsInline: true, docs: [{ collection: 'demo-docs', score: 1, doc }],
  }));
  const key = 'redact-me';
  const entries = [[key, 1], ['[REDACTED]', 2], ['[REDACTED]#1', 3], [`${key}#1`, 4]];
  const expected = { '[REDACTED]#2': 1, '[REDACTED]': 2, '[REDACTED]#1': 3, '[REDACTED]#1#1': 4 };
  for (const ordered of [entries, [...entries].reverse()]) {
    const fields = Object.fromEntries(ordered);
    doc = { id: 'doc-1', ...fields, nested: [fields] };
    for (const args of [
      ['query', '--file', resolve('examples/query.json')],
      ['docs', 'fetch', '--ids', 'doc-1'],
    ]) {
      const r = await f.run([...args, '--collection', 'demo-docs', '--ref', 'branch:main', '--json'], { LAMBDADB_API_KEY: key });
      assert.equal(r.code, 0);
      assert.equal(r.json.schemaVersion, 1);
      assert.deepEqual(r.json.data.docs[0].doc, { id: 'doc-1', ...expected, nested: [expected] });
      assert.ok(!JSON.stringify(r.json.data.docs[0].doc).includes(key));
    }
  }
  // Several distinct keys can collapse even without an unchanged base key.
  const colliding = [[`${key}[REDACTED]`, 5], [`[REDACTED]${key}`, 6], [`${key}${key}`, 7], ['[REDACTED][REDACTED]#1', 8]];
  for (const ordered of [colliding, [...colliding].reverse()]) {
    doc = { id: 'doc-1', ...Object.fromEntries(ordered) };
    const r = await f.run(['docs', 'fetch', '--collection', 'demo-docs', '--ref', 'branch:main', '--ids', 'doc-1', '--json'], { LAMBDADB_API_KEY: key });
    assert.equal(r.code, 0);
    const { id, ...fields } = r.json.data.docs[0].doc;
    assert.equal(id, 'doc-1');
    assert.deepEqual(Object.values(fields).sort(), [5, 6, 7, 8]);
    assert.equal(fields['[REDACTED][REDACTED]#1'], 8);
    assert.ok(!JSON.stringify(fields).includes(key));
  }
});

test('colliding metadata keys retain each tag and index configuration', async t => {
  const key = 'redact-me';
  const f = await fixture(t, (_r, send) => send(200, {
    collection: { ...metadata, tags: { [key]: 'first', '[REDACTED]': 'second' },
      indexConfigs: { [key]: { type: 'keyword' }, '[REDACTED]': { type: 'text', analyzers: ['english'] } } },
  }));
  const r = await f.run(['collections', 'describe', '--collection', 'demo-docs', '--json'], { LAMBDADB_API_KEY: key });
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.data.collection.tags, { '[REDACTED]#1': 'first', '[REDACTED]': 'second' });
  assert.equal(r.json.data.collection.indexConfigs['[REDACTED]#1'].type, 'keyword');
  assert.equal(r.json.data.collection.indexConfigs['[REDACTED]'].type, 'text');
});

test('a million tiny documents fail preflight within a 128 MiB heap, before any API request', async t => {
  const f = await fixture(t, (_r, send) => send(500, {}));
  const path = await f.file('many.jsonl', '{}\n'.repeat(1_000_000));
  const r = await f.run(['docs', 'import', '--collection', 'demo-docs', '--branch', 'main', '--file', path, '--json'], { NODE_OPTIONS: '--max-old-space-size=128' });
  assert.equal(r.code, 2);
  assert.equal(r.json.error.code, 'INPUT_ERROR');
  assert.match(r.json.error.message, /100000-document local limit at line 100001/);
  assert.equal(f.requests.length, 0);
});

test('many blank lines do not allocate a line array and retain the final error line number', async t => {
  const f = await fixture(t, (_r, send) => send(500, {}));
  const path = await f.file('blank-lines.jsonl', '\n'.repeat(10_000_000) + 'invalid');
  const r = await f.run(['docs', 'import', '--collection', 'demo-docs', '--branch', 'main', '--file', path, '--json'], { NODE_OPTIONS: '--max-old-space-size=128' });
  assert.equal(r.code, 2);
  assert.match(r.json.error.message, /JSONL line 10000001 must be a JSON object/);
  assert.equal(f.requests.length, 0);
});

test('facet-only, match-all and document queries preserve requests and JSON facet results', async t => {
  const facets = { category: { buckets: [{ value: 'database', count: 2 }] }, 'metadata.labels': { buckets: [] } };
  const doc = { collection: 'demo-docs', doc: { id: 'doc-1', category: ['database', 'search'] } };
  const f = await fixture(t, (r, send) => send(200, {
    took: 1, total: r.body.size === 0 ? 0 : 1, isDocsInline: true,
    docs: r.body.size === 0 ? [] : [doc], ...(r.body.facets ? { facets } : {}),
  }));
  const inputs = [
    JSON.parse(await readFile('examples/query-facets-only.json', 'utf8')),
    JSON.parse(await readFile('examples/query-with-facets.json', 'utf8')),
    {}, { size: null, facets: { category: { size: null }, 'metadata.labels': {} }, consistentRead: true },
    { size: 100, facets: Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(field => [field, { size: 100 }])) },
    { size: 1, facets: { category: { size: 1 } } },
  ];
  for (const [i, body] of inputs.entries()) {
    const r = await f.run(['query', '--collection', 'demo-docs', '--ref', 'branch:main', '--file', await f.file(`facet-${i}.json`, body), '--json']);
    assert.equal(r.code, 0, r.stderr);
    const expected = { ...body, ref: { kind: 'branch', name: 'main' }, consistentRead: body.consistentRead ?? false, includeVectors: false };
    if (expected.size === null) delete expected.size;
    assert.deepEqual(f.requests.at(-1).body, expected);
    assert.deepEqual(r.json.data.docs, body.size === 0 ? [] : [doc]);
    assert.deepEqual(r.json.data.facets, body.facets ? facets : undefined);
    assert.equal(r.stdout.trim().split('\n').length, 1);
  }
  const help = await f.run(['query', '--help']);
  assert.match(help.stdout, /omit query for match-all/);
  assert.match(help.stdout, /query-facets-only.json/);
  assert.match(help.stdout, /query-with-facets.json/);
});

test('facets survive SDK docsUrl download and redact arbitrary facet names without losing collisions', async t => {
  const facets = { category: { buckets: [{ value: 'database', count: 2 }] },
    [secret]: { buckets: [{ value: secret, count: 1 }] }, '[REDACTED]': { buckets: [] } };
  const docs = [{ collection: 'demo-docs', doc: { id: 'doc-1' } }];
  const f = await fixture(t, (r, send, _req, _res, base) => {
    if (r.url.pathname === '/download') return send(200, docs);
    send(200, { took: 1, total: 1, isDocsInline: false, docs: [], facets, docsUrl: `${base}/download?signature=private-url` });
  });
  const r = await f.run(['query', '--collection', 'demo-docs', '--ref', 'tag:release', '--file', resolve('examples/query-with-facets.json'), '--json']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.data.facets, { category: facets.category, '[REDACTED]#1': { buckets: [{ value: '[REDACTED]', count: 1 }] }, '[REDACTED]': { buckets: [] } });
  assert.deepEqual(r.json.data.docs, docs);
  assert.equal(r.json.data.isDocsInline, true);
  assert.equal('docsUrl' in r.json.data, false);
  assert.ok(!r.stdout.includes('private-url'));
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[0].body.facets, { category: {} });
  assert.ok(!Object.values(f.requests[1].headers).includes(secret));
});

test('invalid facets, sizes, queries and conflicting or inconsistent refs fail before HTTP', async t => {
  const f = await fixture(t, (_r, send) => send(500, {}));
  const bodies = [
    { size: 0 }, { size: 0, facets: {} }, { size: -1 }, { size: 1001 }, { size: 1.5 }, { size: '0', facets: { category: {} } },
    { query: null }, { query: [] }, { facets: null }, { facets: [] }, { facets: { category: null } },
    ...[0, 101, 1.5, '10'].map(size => ({ facets: { category: { size } } })),
    { facets: { category: { typo: true } } },
    { facets: Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map(field => [field, {}])) },
    { size: 0, facets: { category: {} }, consistentRead: true },
    { facets: { category: {} }, ref: { kind: 'branch', name: 'other' } },
  ];
  for (const [i, body] of bodies.entries()) {
    const r = await f.run(['query', '--collection', 'demo-docs', '--ref', 'alias:release', '--file', await f.file(`invalid-${i}.json`, body), '--json']);
    assert.equal(r.code, 2, `input ${i}`);
    assert.equal(r.json.ok, false);
  }
  assert.equal(f.requests.length, 0);
});

test('create forwards all 49 SDK analyzers unchanged and rejects unknown names before HTTP', async t => {
  const analyzers = ['standard', 'english', 'korean', 'japanese', 'chinese', 'cjk', 'arabic', 'french', 'german', 'hindi', 'indonesian', 'italian', 'portuguese', 'russian', 'spanish', 'turkish', 'armenian', 'basque', 'bengali', 'brazilian', 'bulgarian', 'catalan', 'czech', 'danish', 'dutch', 'estonian', 'finnish', 'galician', 'greek', 'hungarian', 'irish', 'latvian', 'lithuanian', 'norwegian', 'persian', 'romanian', 'serbian', 'sorani', 'swedish', 'thai', 'simple', 'whitespace', 'stop', 'keyword', 'pattern', 'fingerprint', 'nepali', 'tamil', 'telugu'];
  const f = await fixture(t, (_r, send) => send(201, { collection: created }));
  for (const config of [{ type: 'text', analyzers }, { type: 'text' }, { type: 'text', analyzers: [] }, { type: 'text', analyzers: ['chinese', 'chinese'] }]) {
    const indexConfigs = { text: config };
    const r = await f.run(['collections', 'create', '--collection', 'demo-docs', '--index-config', await f.file('analyzers.json', indexConfigs), '--json']);
    assert.equal(r.code, 0);
    assert.deepEqual(f.requests.at(-1).body.indexConfigs, indexConfigs);
  }
  for (const analyzer of ['unknown_analyzer', 'Chinese']) {
    const r = await f.run(['collections', 'create', '--collection', 'demo-docs', '--index-config', await f.file('invalid-analyzer.json', { text: { type: 'text', analyzers: [analyzer] } }), '--json']);
    assert.equal(r.code, 2);
  }
  assert.equal(f.requests.length, 4);
});

test('credentials redact facet names and values while preserving bucket schema keys', async t => {
  for (const key of ['facet-secret', 'buckets-and-count']) {
    const facets = { [key]: { buckets: [{ value: key, count: 1 }] },
      doc: { buckets: [{ value: key, count: 2 }] } };
    const f = await fixture(t, (_r, send) => send(200, { took: 1, total: 0, isDocsInline: true, docs: [], facets }));
    const r = await f.run(['query', '--collection', 'demo-docs', '--ref', 'branch:main', '--file', resolve('examples/query-facets-only.json'), '--json'], { LAMBDADB_API_KEY: key });
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.data.facets, {
      '[REDACTED]': { buckets: [{ value: '[REDACTED]', count: 1 }] },
      doc: { buckets: [{ value: '[REDACTED]', count: 2 }] },
    });
  }
});

test('placeholder keys shorter than eight characters are not redacted, so ordinary words stay readable', async t => {
  const facets = { count: { buckets: [{ value: 'count', count: 1 }] } };
  const f = await fixture(t, (_r, send) => send(200, { took: 1, total: 0, isDocsInline: true, docs: [], facets }));
  for (const key of ['count', 'abcdefg']) {
    const r = await f.run(['query', '--collection', 'demo-docs', '--ref', 'branch:main', '--file', resolve('examples/query-facets-only.json'), '--json'], { LAMBDADB_API_KEY: key });
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.data.facets, facets);
    assert.ok(!r.stdout.includes('[REDACTED]'));
  }
  const human = await f.run(['query', '--collection', 'demo-docs', '--ref', 'branch:main', '--file', resolve('examples/query-facets-only.json')], { LAMBDADB_API_KEY: 'count' });
  assert.match(human.stdout, /^0 match\(es\)\.\n/);
  assert.ok(!human.stdout.includes('[REDACTED]'));
});

test('parse errors name the missing option, unknown word or close suggestion and never echo an inline value', async t => {
  const f = await fixture(t, (_r, send) => send(200, { collections: [] }));
  const cases = [
    [['docs', 'fetch', '--collection', 'demo-docs', '--ref', 'branch:main'], "Required option '--ids <id...>' not specified.", 'docs'],
    [['query', '--collection', 'demo-docs', '--ref', 'branch:main', '--file'], "Option '--file <path>' argument missing.", 'query'],
    [['collection', 'list'], "Unknown command 'collection'. Did you mean collections?", 'lambdadb'],
    [['collections', 'list', '--sizee', '3'], "Unknown option '--sizee'. Did you mean --size?", 'collections'],
    [['docs', 'import', '--collection', 'demo-docs', '--branch', 'main', '--file', 'x', '--mode', 'xyz'], "Option '--mode <mode>' argument 'xyz' is invalid. Allowed choices are upsert, bulk.", 'docs'],
    [['doctor', `--api-key=${secret}`], "Unknown option '--api-key'.", 'doctor'],
    [['doctor', `--api-key=prefix'${secret}`], "Unknown option '--api-key'.", 'doctor'],
    [['doctor', `--api-key=${secret}\n(Did you mean ${secret}?)`], "Unknown option '--api-key'.", 'doctor'],
    [['doctor', `--api-key-en=${secret}'tail-marker`], "Unknown option '--api-key-en'.", 'doctor'],
    [['doctor', '--api-key-en'], "Unknown option '--api-key-en'. Did you mean --api-key-env?", 'doctor'],
  ];
  const hint = 'Run lambdadb --help or the command-specific --help.';
  for (const [args, message, command] of cases) {
    const r = await f.run([...args, '--json']);
    assert.equal(r.code, 2, r.stdout);
    assert.equal(r.json.command, command);
    assert.equal(r.json.error.code, 'INPUT_ERROR');
    assert.ok(r.json.error.message.startsWith(message), r.json.error.message);
    assert.ok(!r.json.error.message.includes('=') && !r.json.error.message.includes('prefix') && !r.json.error.message.includes('tail-marker'), r.json.error.message);
    assert.equal(r.json.error.hint, hint);
    const human = await f.run(args);
    assert.equal(human.code, 2);
    assert.match(human.stdout, /^Command failed\.\n/);
    assert.ok(human.stderr.includes(message) && human.stderr.includes(hint), human.stderr);
  }
  assert.equal(f.requests.length, 0);
});

test('bare lambdadb prints help and a command group without a subcommand prints its help with exit 2', async t => {
  const f = await fixture(t, (_r, send) => send(200, { collections: [] }));
  const bare = await f.run([]);
  assert.equal(bare.code, 0, bare.stderr);
  assert.match(bare.stdout, /^Usage: lambdadb \[options\] \[command\]/);
  assert.match(bare.stdout, /Exit codes: 0 success/);
  assert.equal(bare.stderr, '');
  for (const group of ['collections', 'docs', 'projects']) {
    const r = await f.run([group, '--json']);
    assert.equal(r.code, 2, r.stdout);
    assert.equal(r.json.command, group);
    assert.equal(r.json.error.message, `lambdadb ${group} needs a subcommand.`);
    assert.equal(r.json.error.hint, `Run lambdadb ${group} --help to list them.`);
    assert.match(r.stderr, new RegExp(`^Usage: lambdadb ${group} \\[options\\] \\[command\\]`));
    const human = await f.run([group]);
    assert.equal(human.code, 2);
    assert.match(human.stdout, /^Command failed\.\n/);
    assert.match(human.stderr, /Usage: lambdadb/);
  }
  assert.equal(f.requests.length, 0);
});

test('messages that already state the next step carry no generic hint', async t => {
  const f = await fixture(t, (_r, send) => send(200, { collections: [] }));
  const r = await f.run(['usage', '--json']);
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.json.error.message, /^Run lambdadb login first\./);
  assert.equal(r.json.error.hint, '');
  assert.match(r.stderr, /^Run lambdadb login first\. Project-key environment setup remains available without account login\.\n$/);
  const size = await f.run(['collections', 'list', '--size', '0', '--json']);
  assert.equal(size.json.error.hint, 'Check --help and the input file or configuration.');
});

test('rerank requests preserve omission, nulls, custom criteria and independent vector k', async t => {
  const f = await fixture(t, (_r, send) => send(200, { took: 1, total: 0, isDocsInline: true, docs: [] }));
  const config = { provider: 'typesafe', model: 'jev-1.13.0', queryText: '  serverless \u{1f50e}  ', fields: ['text'] };
  const bodies = [
    JSON.parse(await readFile(resolve('examples/query-rerank.json'), 'utf8')),
    { query: { queryString: { query: 'serverless' } } },
    { query: {}, rerank: null },
    { query: { knn: { field: 'embedding', vector: [0.1, 0.2], k: 7 } }, size: 3, rerank: config },
    { query: { knn: { field: 'embedding', vector: [0.1, 0.2], k: 7 } }, size: 3,
      rerank: { ...config, candidateSize: 50, onFailure: 'returnOriginal', criteria: [' Unrelated. ', 'Answers directly.'] } },
    { query: { queryString: { query: 'serverless' } }, size: null,
      rerank: { ...config, candidateSize: null, onFailure: null, criteria: null } },
    { query: { queryString: { query: 'serverless' } }, size: 1000, rerank: { ...config, candidateSize: 1000 } },
    ...['rerank-v5.0-pro', 'rerank-v5.0-fast'].map(model => ({ query: { queryString: { query: 'serverless' } }, size: 3,
      rerank: { ...config, provider: 'cohere', model } })),
    { query: { queryString: { query: 'serverless' } }, size: 3,
      rerank: { ...config, provider: 'cohere', model: 'rerank-v5.0-fast', candidateSize: 1000, onFailure: 'returnOriginal', criteria: null } },
  ];
  for (const [i, body] of bodies.entries()) {
    const r = await f.run(['query', '--collection', 'demo-docs', '--ref', 'branch:main', '--file', await f.file(`rerank-${i}.json`, body), '--json']);
    assert.equal(r.code, 0, r.stdout);
    const expected = { consistentRead: false, includeVectors: false, ...body, ref: { kind: 'branch', name: 'main' } };
    if (expected.size === null) delete expected.size;
    assert.deepEqual(f.requests.at(-1).body, expected);
  }
});

test('invalid rerank configurations fail before HTTP', async t => {
  const f = await fixture(t, () => assert.fail('Invalid input reached HTTP'));
  const rerank = { provider: 'typesafe', model: 'jev-1.13.0', queryText: 'serverless', fields: ['text'] };
  const base = { query: { queryString: { query: 'serverless' } }, size: 10, rerank };
  const invalidConfigs = [
    { provider: 'other' }, { model: 'other' }, { queryText: undefined }, { queryText: '  ' },
    { queryText: '\u20ac'.repeat(2731) }, { fields: undefined }, { fields: [] }, { fields: ['text', 'text'] },
    { fields: Array.from({ length: 9 }, (_, i) => `field${i}`) },
    { candidateSize: 9 }, { candidateSize: 1001 }, { candidateSize: 50.5 }, { onFailure: 'ignore' },
    { criteria: ['Only one'] }, { criteria: ['same', 'same'] }, { criteria: [' ', 'good'] },
    { criteria: ['\u20ac'.repeat(683), 'good'] },
    { criteria: Array.from({ length: 5 }, (_, i) => `${i}${'x'.repeat(1700)}`) },
    { criteria: Array.from({ length: 11 }, (_, i) => `criterion ${i}`) },
    { weights: [1, 2] }, { thresholds: [0.5] }, { rubricVersion: 'v1' },
    // Provider/model pairs are exact, and Cohere rejects criteria, including an empty list.
    { provider: 'cohere' }, { model: 'rerank-v5.0-fast' }, { provider: 'cohere', model: 'rerank-v4.0' },
    ...[[], ['Unrelated.', 'Answers directly.']].map(criteria => ({ provider: 'cohere', model: 'rerank-v5.0-pro', criteria })),
  ];
  const bodies = [
    ...invalidConfigs.map(settings => ({ ...base, rerank: { ...rerank, ...settings } })),
    { ...base, query: undefined }, { ...base, query: {} },
    { ...base, query: { bool: [{ occur: 'FILTER', queryString: { query: 'serverless' } }] } },
    { ...base, sort: [] }, { ...base, size: 0, facets: { category: {} } },
    { ...base, size: 1001 }, { ...base, size: -1 },
  ];
  for (const [i, body] of bodies.entries()) {
    const r = await f.run(['query', '--collection', 'demo-docs', '--ref', 'branch:main', '--file', await f.file(`invalid-rerank-${i}.json`, body), '--json']);
    assert.equal(r.code, 2, `case ${i}: ${r.stdout}`);
    assert.equal(r.json.error.code, 'INPUT_ERROR');
  }
  assert.equal(f.requests.length, 0);
});

test('rerank output preserves final/retrieval scores, server order and metadata inline and via docsUrl', async t => {
  const applied = { status: 'applied', provider: 'typesafe', model: 'jev-1.13.0', resolvedModel: 'jev-1.13.0',
    candidateCount: 3, scoredCount: 3, took: 9, criteriaVersion: 'custom' };
  const docs = [
    { collection: 'demo-docs', score: 0.80000002, retrievalScore: 0, doc: { id: 'z' } },
    { collection: 'demo-docs', score: 0.80000002, retrievalScore: 9.123456789, doc: { id: 'a' } },
    { collection: 'demo-docs', score: 0, retrievalScore: 3.25, doc: { id: 'b' } },
  ];
  const states = [
    { docs, maxScore: 0.80000002, rerank: applied, facets: { category: { buckets: [{ value: 'search', count: 12 }] } } },
    { docs: [docs[2]], maxScore: 0, rerank: { ...applied, candidateCount: 1, scoredCount: 1, criteriaVersion: 'default-relevance-v1' } },
    { docs: [], rerank: { status: 'skipped', provider: 'typesafe', model: 'jev-1.13.0', candidateCount: 0, scoredCount: 0, took: 0, reason: 'noCandidates' } },
    { docs: [{ collection: 'demo-docs', score: 3.25, doc: { id: 'original' } }], maxScore: 3.25,
      rerank: { status: 'fallback', provider: 'typesafe', model: 'jev-1.13.0', candidateCount: 3, scoredCount: 0, took: 9, reason: 'timeout' } },
    { docs: [{ collection: 'demo-docs', score: 0, doc: { id: 'unused' } }], maxScore: 0 },
  ];
  for (const download of [false, true]) {
    for (const state of states) {
      const f = await fixture(t, (r, send, _req, _res, base) => {
        if (r.url.pathname === '/transfer') {
          assert.equal(r.headers['x-api-key'], undefined);
          return send(200, state.docs);
        }
        send(200, { took: 12, total: state.docs.length, ...state,
          ...(download ? { isDocsInline: false, docs: [], docsUrl: `${base}/transfer` } : { isDocsInline: true }) });
      });
      const body = JSON.parse(await readFile(resolve(state.rerank ? 'examples/query-rerank.json' : 'examples/query.json'), 'utf8'));
      if (state.facets) body.facets = { category: {} };
      const r = await f.run(['query', '--collection', 'demo-docs', '--ref', 'branch:main', '--file', await f.file('query.json', body), '--json']);
      assert.equal(r.code, 0, r.stdout);
      assert.deepEqual(r.json.data.docs, state.docs);
      assert.deepEqual(r.json.data.rerank, state.rerank);
      assert.equal(r.json.data.maxScore, state.maxScore);
      assert.deepEqual(r.json.data.facets, state.facets);
      assert.equal(r.json.data.total, state.docs.length);
      assert.equal(r.json.data.took, 12);
      assert.equal('docsUrl' in r.json.data, false);
    }
  }
});

test('returnOriginal does not mask API validation, authorization, quota or admission errors', async t => {
  for (const status of [400, 403, 429, 503]) {
    const f = await fixture(t, (_r, send) => send(status, { message: 'Request failed' }));
    const body = JSON.parse(await readFile(resolve('examples/query-rerank.json'), 'utf8'));
    body.rerank.onFailure = 'returnOriginal';
    const r = await f.run(['query', '--collection', 'demo-docs', '--ref', 'branch:main', '--file', await f.file('query.json', body), '--timeout-ms', '300', '--json']);
    assert.equal(r.code, 3);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.data, undefined);
  }
});

test('colliding credentials preserve fixed rerank tokens while redacting arbitrary strings in JSON and human output', async t => {
  const cases = [
    ['status', 'applied'], ['status', 'skipped'], ['status', 'fallback'],
    ['provider', 'typesafe'], ['model', 'jev-1.13.0'],
    ['provider', 'cohere'], ['model', 'rerank-v5.0-pro'], ['model', 'rerank-v5.0-fast'],
    ['criteriaVersion', 'custom'], ['criteriaVersion', 'default-relevance-v1'], ['criteriaVersion', 'cohere-relevance-v1'],
    ...['noCandidates', 'timeout', 'rateLimit', 'unavailable', 'invalidResponse', 'credentials'].map(reason => ['reason', reason]),
    ['provider', 'a'],
  ];
  for (const [field, key] of cases) {
    const status = field === 'status' ? key : field === 'reason' ? (key === 'noCandidates' ? 'skipped' : 'fallback') : 'applied';
    const rerank = { status, provider: field === 'provider' ? key : 'typesafe', model: field === 'model' ? key : 'jev-1.13.0', resolvedModel: `server-${key}`,
      candidateCount: status === 'skipped' ? 0 : 1, scoredCount: status === 'applied' ? 1 : 0, took: 0,
      ...(status === 'applied' ? { criteriaVersion: field === 'criteriaVersion' ? key : 'custom' } : {}),
      ...(field === 'reason' ? { reason: key } : status === 'skipped' ? { reason: 'noCandidates' } : status === 'fallback' ? { reason: 'timeout' } : {}),
    };
    const docs = status === 'skipped' ? [] : [{ collection: 'demo-docs', score: 0, ...(status === 'applied' ? { retrievalScore: 0 } : {}),
      doc: { text: key, rerank: { status: key, provider: key, reason: key } } }];
    const f = await fixture(t, (r, send, _req, _res, base) => r.url.pathname === '/transfer'
      ? send(200, docs)
      : send(200, { took: 0, total: docs.length, isDocsInline: false, docs: [], docsUrl: `${base}/transfer`, rerank }));
    for (const json of [true, false]) {
      const r = await f.run(['query', '--collection', 'demo-docs', '--ref', 'branch:main', '--file', resolve('examples/query-rerank.json'), ...(json ? ['--json'] : [])], { LAMBDADB_API_KEY: key });
      assert.equal(r.code, 0);
      const data = json ? r.json.data : JSON.parse(r.stdout.split('\n').slice(2).join('\n'));
      // Shorter placeholders are not credentials and stay readable.
      const redacted = key.length >= 8 ? '[REDACTED]' : key;
      assert.deepEqual(data.rerank, { ...rerank, resolvedModel: `server-${redacted}` });
      if (docs.length) {
        const doc = data.docs[0].doc;
        assert.ok(Object.values(doc).includes(redacted));
        const nested = Object.values(doc).find(value => value && typeof value === 'object');
        assert.deepEqual(Object.values(nested), [redacted, redacted, redacted]);
        assert.equal(data.docs[0].score, 0);
      }
    }
  }
});

test('unknown rerank provider, model and reason remain subject to credential redaction', async t => {
  const key = 'private-token';
  const rerank = { status: 'fallback', provider: `provider-${key}`, model: `model-${key}`, reason: `reason-${key}`,
    resolvedModel: key, candidateCount: 1, scoredCount: 0, took: 0 };
  const f = await fixture(t, (_r, send) => send(200, { took: 0, total: 1, isDocsInline: true,
    docs: [{ collection: 'demo-docs', score: 2, doc: { text: key } }], rerank }));
  const r = await f.run(['query', '--collection', 'demo-docs', '--ref', 'branch:main', '--file', resolve('examples/query-rerank.json'), '--json'], { LAMBDADB_API_KEY: key });
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.data.rerank, { ...rerank, provider: 'provider-[REDACTED]', model: 'model-[REDACTED]',
    reason: 'reason-[REDACTED]', resolvedModel: '[REDACTED]' });
  assert.equal(r.json.data.docs[0].doc.text, '[REDACTED]');
  assert.ok(!r.stdout.includes(key) && !r.stderr.includes(key));
});

const bayesianSignals = [
  { queryString: { query: 'text:serverless' } },
  { knn: { field: 'vector', queryVector: [1, 0], k: 30 } },
];
const bayesianRerank = { provider: 'typesafe', model: 'jev-1.13.0', queryText: 'serverless search', fields: ['text'] };

test('Bayesian JSON mapping preserves budgets, nulls, defaults, Boolean signals and refs', async t => {
  const f = await fixture(t, (_req, send) => send(200, { took: 1, total: 0, isDocsInline: true, docs: [] }));
  const query = { bayesian: bayesianSignals };
  const bodies = [
    JSON.parse(await readFile('examples/query-bayesian.json', 'utf8')),
    JSON.parse(await readFile('examples/query-bayesian-rerank.json', 'utf8')),
    { query, size: 1, candidateSize: 1 }, { query, size: 100, candidateSize: 100 },
    { query, size: 3, candidateSize: 101 }, { query, size: 3, candidateSize: 1000 }, { query, size: 1000, candidateSize: 1000 },
    { query, candidateSize: 30 }, { query, size: null, candidateSize: 30, rerank: null },
    { query, size: 3, rerank: bayesianRerank },
    { query, size: 3, rerank: { ...bayesianRerank, candidateSize: 30 } },
    { query, size: null, rerank: { ...bayesianRerank, candidateSize: null } },
    { query: { bayesian: [{ bool: [{ occur: 'MUST', ...bayesianSignals[0] }] }, bayesianSignals[1]] }, size: 2, candidateSize: 30 },
  ];
  for (const [i, body] of bodies.entries()) {
    const ref = { kind: ['branch', 'tag', 'alias'][i % 3], name: 'selected' };
    const r = await f.run(['query', '--collection', 'demo-docs', '--ref', `${ref.kind}:${ref.name}`,
      '--file', await f.file('bayesian.json', { ...body, ref }), '--json']);
    assert.equal(r.code, 0, r.stderr);
    const expected = { ...body, ref, consistentRead: false, includeVectors: false };
    if (expected.size === null) delete expected.size;
    assert.deepEqual(f.requests.at(-1).body, expected);
  }
  const help = await f.run(['query', '--help']);
  assert.match(help.stdout, /exactly two unboosted subqueries/);
  assert.match(help.stdout, /query-bayesian-rerank.json/);
});

test('Bayesian semantic rejections stay server API errors; free-form DSL is never rewritten', async t => {
  const f = await fixture(t, (_req, send) => send(400, { message: 'Invalid query' }));
  const query = { bayesian: bayesianSignals };
  const bodies = [
    { query }, { query, size: 2, candidateSize: 1 }, { query, candidateSize: 0 }, { query, candidateSize: 1001 },
    { query, size: 0, facets: { category: {} }, candidateSize: 30 },
    { query, candidateSize: 30, rerank: bayesianRerank },
    ...[[], [bayesianSignals[0]], [...bayesianSignals, bayesianSignals[0]]].map(bayesian => ({ query: { bayesian }, candidateSize: 30 })),
    { query: { bayesian: [{ ...bayesianSignals[0], boost: 1 }, bayesianSignals[1]] }, candidateSize: 30 },
    { query: { bayesian: [{ bool: [{ occur: 'MUST', bool: [{ occur: 'SHOULD', ...bayesianSignals[0], boost: 1 }] }] }, bayesianSignals[1]] }, candidateSize: 30 },
    ...['bayesian', 'rrf', 'mm', 'l2'].map(method => ({ query: { bayesian: [{ [method]: bayesianSignals }, bayesianSignals[1]] }, candidateSize: 30 })),
    { query: bayesianSignals[0], candidateSize: 30 },
    { query: { futureQuery: { arbitrary: ['preserve', 1] } } },
  ];
  for (const body of bodies) {
    const r = await f.run(['query', '--collection', 'demo-docs', '--ref', 'branch:main', '--file', await f.file('rejected.json', body), '--json']);
    assert.equal(r.code, 3);
    assert.equal(r.json.error.code, 'API_ERROR');
    assert.equal(r.json.error.httpStatus, 400);
    assert.deepEqual(f.requests.at(-1).body, { ...body, ref: { kind: 'branch', name: 'main' }, consistentRead: false, includeVectors: false });
  }
  assert.equal(f.requests.length, bodies.length);
});

test('Bayesian local type, ref and file errors retain input precedence and make no requests', async t => {
  const f = await fixture(t, (_req, send) => send(500, {}));
  const query = { bayesian: bayesianSignals };
  for (const body of [
    { query, candidateSize: '30' }, { query, candidateSize: 1.5 }, { query, candidateSize: null },
    { query, size: 1001, candidateSize: 1000 }, { query, size: 2, rerank: { ...bayesianRerank, candidateSize: 1 } },
    { query, size: 0, candidateSize: 30 }, { query, consistentRead: true, candidateSize: 30 },
    { query, ref: { kind: 'branch', name: 'main' }, candidateSize: 30 },
    { query, ref: { kind: 'tag', name: 'release', extra: true }, candidateSize: 30 },
    '{invalid', [],
  ]) {
    const r = await f.run(['query', '--collection', 'demo-docs', '--ref', 'tag:release', '--file', await f.file('bad.json', body), '--json'],
      { LAMBDADB_ENDPOINT: 'invalid-origin' });
    assert.equal(r.code, 2);
    assert.equal(r.json.error.code, 'INPUT_ERROR');
    assert.doesNotMatch(r.json.error.message, /endpoint/i);
  }
  assert.equal(f.requests.length, 0);
});

test('ordinary text, KNN, RRF, Min-Max and L2 preserve boosts and omit Bayesian budgets', async t => {
  const f = await fixture(t, (_req, send) => send(200, { took: 1, total: 0, isDocsInline: true, docs: [] }));
  const signals = bayesianSignals.map(signal => ({ ...signal, boost: 0.5 }));
  for (const query of [...signals, ...['rrf', 'mm', 'l2'].map(method => ({ [method]: signals }))]) {
    const r = await f.run(['query', '--collection', 'demo-docs', '--ref', 'branch:main', '--file', await f.file('ordinary.json', { query }), '--json']);
    assert.equal(r.code, 0);
    assert.deepEqual(f.requests.at(-1).body, { query, ref: { kind: 'branch', name: 'main' }, consistentRead: false, includeVectors: false });
  }
});

test('native and legacy embedding create/update mapping preserves explicit values without inferred defaults', async t => {
  const embedding = { provider: 'openai', model: 'text-embedding-3-small', sourceField: 'text' };
  const f = await fixture(t, (req, send) => send(req.method === 'POST' ? 201 : 200,
    { collection: req.method === 'POST' ? created : { ...metadata, indexConfigs: req.body.indexConfigs } }));
  const configs = [
    JSON.parse(await readFile('examples/index-config-native.json', 'utf8')),
    ...[undefined, true].flatMap(flag => [embedding, { ...embedding, dimensions: 256, similarity: 'cosine' }].map(value => ({
      text: { type: 'text' }, vector: { type: 'vector', embedding: value, ...(flag ? { managedEmbedding: flag } : {}) },
    }))),
    { vector: { type: 'vector', dimensions: 64, similarity: 'cosine', managedEmbedding: false } },
    { vector: { type: 'vector', dimensions: 4096, similarity: 'euclidean' } },
    // Ordered sources and Cohere; provider/model/dimension combinations stay server validations.
    { vector: { type: 'vector', embedding: { provider: 'openai', model: 'text-embedding-3-small', sources: [{ field: 'article.body', type: 'text' }] } } },
    { vector: { type: 'vector', embedding: { provider: 'cohere', model: 'embed-v5.0-pro', dimensions: 1024, similarity: 'euclidean',
      sources: [{ field: 'product.description', type: 'text' }, { field: 'product.images', type: 'image' }] } } },
    { vector: { type: 'vector', embedding: { provider: 'cohere', model: 'embed-v5.0-fast', sourceField: 'text', sources: null } } },
    { vector: { type: 'vector', embedding: { provider: 'openai', model: 'text-embedding-3-small', sourceField: null,
      sources: [{ field: 'text', type: 'text' }] } } },
    { vector: { type: 'vector', embedding: { provider: 'cohere', model: 'embed-v5.0-fast',
      sources: Array.from({ length: 16 }, (_, i) => ({ field: `part${i}`, type: i % 2 ? 'image' : 'text' })) } } },
  ];
  for (const command of ['create', 'update']) {
    for (const config of configs) {
      const r = await f.run(['collections', command, '--collection', 'demo-docs', '--index-config', await f.file('native.json', config), '--json']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.json.data.state, command === 'create' ? 'created' : 'updated');
      assert.equal(r.json.data.searchable, 'not_verified');
      assert.equal(f.requests.at(-1).method, command === 'create' ? 'POST' : 'PATCH');
      assert.deepEqual(f.requests.at(-1).body.indexConfigs, config);
      if (command === 'update') {
        assert.deepEqual(f.requests.at(-1).body, { indexConfigs: config });
        assert.equal(f.requests.at(-1).url.pathname, '/projects/dev-project/collections/demo-docs');
        // The SDK normalizes response nulls to omission; requests keep explicit nulls.
        assert.deepEqual(r.json.data.collection.indexConfigs, JSON.parse(JSON.stringify(config, (_key, value) => value ?? undefined)));
      }
    }
    const help = await f.run(['collections', command, '--help']);
    assert.match(help.stdout, /index-config-native.json/);
  }
});

test('contradictory or incomplete embedding configurations reject consistently for create/update before config resolution', async t => {
  const f = await fixture(t, (_req, send) => send(500, {}));
  const embedding = { provider: 'openai', model: 'text-embedding-3-small', sourceField: 'text' };
  const vectors = [
    { type: 'vector', embedding, managedEmbedding: false },
    { type: 'vector', embedding, dimensions: 1536 }, { type: 'vector', embedding, similarity: 'cosine' },
    { type: 'vector', embedding, managedEmbedding: true, dimensions: 1536 },
    { type: 'vector', managedEmbedding: true }, { type: 'vector' },
    ...Object.keys(embedding).map(key => ({ type: 'vector', embedding: Object.fromEntries(Object.entries(embedding).filter(([k]) => k !== key)) })),
    // Exactly one non-null sourceField or 1–16 strict sources.
    { type: 'vector', embedding: { ...embedding, sources: [{ field: 'text', type: 'text' }] } },
    { type: 'vector', embedding: { ...embedding, sourceField: null } },
    { type: 'vector', embedding: { ...embedding, sourceField: null, sources: null } },
    ...[[], Array.from({ length: 17 }, (_, i) => ({ field: `part${i}`, type: 'text' })), [{ field: 'text', type: 'audio' }],
      [{ field: 'text' }], [{ field: 'text', type: 'text', weight: 1 }]].map(sources => ({ type: 'vector', embedding: { ...embedding, sourceField: undefined, sources } })),
    { type: 'vector', embedding: { ...embedding, provider: 'voyage' } },
    // Dimensions are integers from 64 to 4096; dot product and max inner product are removed.
    ...[63, 4097, 64.5].flatMap(dimensions => [{ type: 'vector', dimensions }, { type: 'vector', embedding: { ...embedding, dimensions } }]),
    ...['dot_product', 'max_inner_product'].flatMap(similarity => [
      { type: 'vector', dimensions: 256, similarity }, { type: 'vector', embedding: { ...embedding, similarity } }]),
  ];
  for (const command of ['create', 'update']) {
    for (const config of [{}, ...vectors.map(vector => ({ vector }))]) {
      const r = await f.run(['collections', command, '--collection', 'demo-docs', '--index-config', await f.file('bad-native.json', config), '--json'],
        { LAMBDADB_ENDPOINT: 'invalid-origin' });
      assert.equal(r.code, 2);
      assert.equal(r.json.error.code, 'INPUT_ERROR');
      assert.match(r.json.error.message, /Invalid index configuration/);
    }
  }
  assert.equal(f.requests.length, 0);
});

test('collection update preserves definite rejection versus uncertain write outcomes without retries', async t => {
  for (const [status, body, code, error] of [
    [400, {}, 3, 'API_ERROR'], [403, {}, 3, 'AUTH_ERROR'], [404, {}, 3, 'API_ERROR'],
    [408, {}, 5, 'API_ERROR'], [503, {}, 5, 'API_ERROR'], [200, {}, 5, 'INVALID_RESPONSE'],
  ]) {
    const f = await fixture(t, (_req, send) => send(status, body));
    const r = await f.run(['collections', 'update', '--collection', 'demo-docs', '--index-config', resolve('examples/index-config-native.json'), '--json']);
    assert.equal(r.code, code);
    assert.equal(r.json.error.code, error);
    assert.equal(r.json.data?.state, code === 5 ? 'unknown' : undefined);
    assert.equal(f.requests.length, 1);
  }
});

test('Bayesian rerank retains complete documents and metadata in inline/downloaded JSON and human output', async t => {
  const docs = [{ collection: 'demo-docs', score: 0.9, retrievalScore: 0.72,
    doc: { id: 'one', text: 'serverless', vector: [1, 0], nested: { arbitrary: ['kept'] } } }];
  const rerank = { status: 'applied', provider: 'typesafe', model: 'jev-1.13.0', candidateCount: 2, scoredCount: 2, took: 3 };
  for (const offload of [false, true]) {
    const f = await fixture(t, (req, send, _request, _response, base) => req.url.pathname === '/transfer'
      ? send(200, docs) : send(200, { took: 5, total: 1, maxScore: 0.9, rerank, isDocsInline: !offload,
        docs: offload ? [] : docs, ...(offload ? { docsUrl: `${base}/transfer?signature=private` } : {}) }));
    for (const json of [false, true]) {
      const r = await f.run(['query', '--collection', 'demo-docs', '--ref', 'branch:main', '--file', resolve('examples/query-bayesian-rerank.json'), ...(json ? ['--json'] : [])]);
      assert.equal(r.code, 0);
      const data = json ? r.json.data : JSON.parse(r.stdout.split('\n').slice(2).join('\n'));
      assert.deepEqual(data.docs, docs);
      assert.deepEqual(data.rerank, rerank);
      assert.equal(data.docsUrl, undefined);
      assert.ok(!r.stdout.includes('signature=private'));
    }
    for (const request of f.requests.filter(req => req.url.pathname === '/transfer')) assert.equal(request.headers['x-api-key'], undefined);
  }
});

test('describe output keeps the server-managed id field, and update sends it back unchanged', async t => {
  const indexConfigs = { id: { type: 'keyword' }, text: { type: 'text', analyzers: ['english'] },
    vector: { type: 'vector', managedEmbedding: true, embedding: { provider: 'cohere', model: 'embed-v5.0-fast',
      sources: [{ field: 'text', type: 'text' }], dimensions: 2048, similarity: 'cosine' } } };
  const f = await fixture(t, (req, send) => send(200, { collection: { ...metadata, indexConfigs: req.body?.indexConfigs ?? indexConfigs } }));
  const described = await f.run(['collections', 'describe', '--collection', 'demo-docs', '--json']);
  assert.equal(described.code, 0, described.stderr);
  assert.deepEqual(described.json.data.collection.indexConfigs, indexConfigs);
  for (const config of [described.json.data.collection.indexConfigs, { id: { type: 'keyword' } }]) {
    const updated = await f.run(['collections', 'update', '--collection', 'demo-docs', '--index-config', await f.file('round-trip.json', config), '--json']);
    assert.equal(updated.code, 0, updated.stderr);
    assert.deepEqual(f.requests.at(-1).body, { indexConfigs: config });
  }
  const help = await f.run(['collections', 'update', '--help']);
  assert.match(help.stdout, /server-managed id keyword field/);
});

test('describe and list reject removed similarity values and out-of-range dimensions as invalid responses', async t => {
  for (const vector of [
    { type: 'vector', dimensions: 256, similarity: 'dot_product' },
    { type: 'vector', dimensions: 256, similarity: 'max_inner_product' },
    { type: 'vector', dimensions: 32, similarity: 'cosine' },
  ]) {
    const collection = { ...metadata, indexConfigs: { vector } };
    const f = await fixture(t, (req, send) => send(200, req.url.pathname.endsWith('/collections') ? { collections: [collection] } : { collection }));
    for (const args of [['collections', 'describe', '--collection', 'demo-docs'], ['collections', 'list']]) {
      const r = await f.run([...args, '--json']);
      assert.equal(r.code, 3, r.stdout);
      assert.equal(r.json.error.code, 'INVALID_RESPONSE');
    }
  }
});

test('fetch forwards up to 1000 IDs and rejects more before HTTP', async t => {
  const f = await fixture(t, (_r, send) => send(200, { took: 1, total: 0, isDocsInline: true, docs: [] }));
  const ids = Array.from({ length: 1000 }, (_, i) => `doc-${i}`);
  const r = await f.run(['docs', 'fetch', '--collection', 'demo-docs', '--ref', 'branch:main', '--ids', ...ids, '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(f.requests.at(-1).body.ids, ids);
  assert.deepEqual(r.json.data.missingIds, ids);
  const rejected = await f.run(['docs', 'fetch', '--collection', 'demo-docs', '--ref', 'branch:main', '--ids', ...ids, 'doc-1000', '--json']);
  assert.equal(rejected.code, 2);
  assert.equal(rejected.json.error.message, 'Fetch requires 1–1000 nonempty IDs.');
  assert.equal(f.requests.length, 1);
  assert.match((await f.run(['docs', 'fetch', '--help'])).stdout, /up to 1000 IDs/);
});

const snapshot = { snapshotId: 'snap-1', snapshotCommittedAt: 1789689600000 };
const branchDetails = { name: 'candidate', parentBranch: { branchId: 'b-main', name: 'main' }, headSnapshot: snapshot, parentSnapshot: snapshot, createdAt: 1789689600000 };
const tagDetails = { ...snapshot, name: 'release-one', createdAt: 1789689600000 };
const aliasDetails = { aliasId: 'a-1', aliasName: 'production', targetKind: 'TAG', targetName: 'release-one', targetId: 't-1', aliasRevision: 2, dangling: false, createdAt: 1789689600000 };

test('branch, tag and alias commands forward kind:NAME refs, as-of cutoffs and names to the versioning API', async t => {
  const f = await fixture(t, (r, send) => {
    const path = r.url.pathname.replace('/projects/dev-project/collections/demo-docs', '');
    if (r.method === 'DELETE') return send(200, { message: 'deleted' });
    if (path === '/branches') return send(r.method === 'POST' ? 201 : 200, r.method === 'POST' ? { branch: branchDetails } : { branches: [branchDetails] });
    if (path === '/tags') return send(r.method === 'POST' ? 201 : 200, r.method === 'POST' ? { tag: tagDetails } : { tags: [tagDetails] });
    if (path === '/aliases') return send(r.method === 'POST' ? 201 : 200, r.method === 'POST' ? { alias: aliasDetails } : { aliases: [aliasDetails] });
    if (path === '/aliases/production' && r.method === 'PATCH') return send(200, { alias: aliasDetails });
    return send(404, { message: 'unexpected route' });
  });
  const base = ['--collection', 'demo-docs', '--json'];
  const asOf = Date.parse('2026-10-01T00:00:00Z');
  const cases = [
    [['branches', 'list'], 'GET', '/branches', undefined, {}, undefined, 'branches'],
    [['branches', 'create', '--branch', 'candidate'], 'POST', '/branches', { branchName: 'candidate' }, { branch: 'candidate' }, 'created', 'branch'],
    [['branches', 'create', '--branch', 'candidate', '--source', 'branch:main', '--as-of', '2026-10-01T00:00:00Z'], 'POST', '/branches',
      { branchName: 'candidate', source: { kind: 'branch', name: 'main', asOf } }, { branch: 'candidate' }, 'created', 'branch'],
    [['branches', 'create', '--branch', 'candidate', '--as-of', String(asOf)], 'POST', '/branches',
      { branchName: 'candidate', source: { kind: 'branch', name: 'main', asOf } }, { branch: 'candidate' }, 'created', 'branch'],
    [['branches', 'create', '--branch', 'candidate', '--as-of', '2026-10-01'], 'POST', '/branches',
      { branchName: 'candidate', source: { kind: 'branch', name: 'main', asOf } }, { branch: 'candidate' }, 'created', 'branch'],
    [['branches', 'create', '--branch', 'candidate', '--as-of', '2026-10-01T09:30:15.250+09:30'], 'POST', '/branches',
      { branchName: 'candidate', source: { kind: 'branch', name: 'main', asOf: asOf + 15_250 } }, { branch: 'candidate' }, 'created', 'branch'],
    [['branches', 'delete', '--branch', 'candidate'], 'DELETE', '/branches/candidate', undefined, { branch: 'candidate' }, 'deleted', 'message'],
    [['tags', 'list'], 'GET', '/tags', undefined, {}, undefined, 'tags'],
    [['tags', 'create', '--tag', 'release-one'], 'POST', '/tags', { tagName: 'release-one' }, { tag: 'release-one' }, 'created', 'tag'],
    [['tags', 'create', '--tag', 'release-one', '--source', 'tag:release-zero'], 'POST', '/tags',
      { tagName: 'release-one', source: { kind: 'tag', name: 'release-zero' } }, { tag: 'release-one' }, 'created', 'tag'],
    [['tags', 'create', '--tag', 'release-one', '--source', 'branch:candidate', '--as-of', String(asOf)], 'POST', '/tags',
      { tagName: 'release-one', source: { kind: 'branch', name: 'candidate', asOf } }, { tag: 'release-one' }, 'created', 'tag'],
    [['tags', 'delete', '--tag', 'release-one'], 'DELETE', '/tags/release-one', undefined, { tag: 'release-one' }, 'deleted', 'message'],
    [['aliases', 'list'], 'GET', '/aliases', undefined, {}, undefined, 'aliases'],
    [['aliases', 'create', '--alias', 'production', '--target', 'tag:release-one'], 'POST', '/aliases',
      { aliasName: 'production', target: { kind: 'tag', name: 'release-one' } }, { alias: 'production' }, 'created', 'alias'],
    [['aliases', 'retarget', '--alias', 'production', '--target', 'branch:main'], 'PATCH', '/aliases/production',
      { target: { kind: 'branch', name: 'main' } }, { alias: 'production' }, 'retargeted', 'alias'],
    [['aliases', 'delete', '--alias', 'production'], 'DELETE', '/aliases/production', undefined, { alias: 'production' }, 'deleted', 'message'],
  ];
  for (const [args, method, path, body, targetRef, state, key] of cases) {
    const r = await f.run([...args, ...base]);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stdout}`);
    const request = f.requests.at(-1);
    assert.equal(request.method, method, args.join(' '));
    assert.equal(request.url.pathname, `/projects/dev-project/collections/demo-docs${path}`);
    assert.deepEqual(request.body, body);
    assert.equal(request.headers['x-api-key'], secret);
    assert.equal(r.json.command, `${args[0]} ${args[1]}`);
    assert.deepEqual(r.json.target, { endpoint: f.base, project: 'dev-project', collection: 'demo-docs', ...targetRef });
    assert.equal(r.json.data.state, state);
    assert.ok(key in r.json.data, `${args.join(' ')} lacks ${key}`);
    assert.equal(r.stdout.trim().split('\n').length, 1);
  }
  // The SDK converts creation times to Date, which the envelope prints as ISO 8601.
  assert.deepEqual((await f.run(['aliases', 'list', ...base])).json.data.aliases[0], { ...aliasDetails, createdAt: new Date(aliasDetails.createdAt).toISOString() });
  const human = await f.run(['branches', 'list', '--collection', 'demo-docs']);
  assert.equal(human.code, 0); assert.match(human.stdout, /1 branch\(es\)/);
});

test('invalid ref sources, targets, names and as-of values fail before any versioning request', async t => {
  const f = await fixture(t, (_r, send) => send(500, { message: 'must not be called' }));
  const base = ['--collection', 'demo-docs', '--json'];
  for (const [args, message] of [
    [['branches', 'create', '--branch', 'candidate', '--source', 'tag:release-one'], 'Source must be branch:NAME; tags and aliases cannot be branch sources.'],
    [['branches', 'create', '--branch', 'candidate', '--source', 'alias:production'], 'Source must be branch:NAME; tags and aliases cannot be branch sources.'],
    [['branches', 'create', '--branch', 'candidate', '--source', 'main'], 'Ref must be branch:NAME, tag:NAME or alias:NAME.'],
    // Impossible calendar values must not be normalized into a different snapshot cutoff.
    ...['2026-13-01', '2026-02-30T00:00:00Z', '2026-10-01T24:00:00Z', '2026-10-01T00:60:00Z', '2026-10-01 00:00:00', '2026-10-01T00:00:00',
      '2026-10-01T00:00:00+15:00', '2026-10-01T00:00:00+00:99', '2026-10-01T00:00:00+0900', '2026-10-01T00:00:00+9:00', '0', '-1', '1e12', 'yesterday'].map(asOf =>
      [['branches', 'create', '--branch', 'candidate', '--as-of', asOf], '--as-of must be Unix epoch milliseconds or an ISO 8601 time.']),
    [['branches', 'create', '--branch', 'no'], 'Branch name must contain 3–52 letters, digits, underscores or hyphens.'],
    [['branches', 'delete', '--branch', 'bad name'], 'Branch name must contain 3–52 letters, digits, underscores or hyphens.'],
    [['tags', 'create', '--tag', 'release-one', '--source', 'alias:production'], 'Source must be branch:NAME or tag:NAME; aliases cannot be tag sources.'],
    [['tags', 'create', '--tag', 'release-one', '--source', 'tag:release-zero', '--as-of', '1789689600000'], '--as-of requires a branch source.'],
    [['tags', 'delete', '--tag', 'x'], 'Tag name must contain 3–52 letters, digits, underscores or hyphens.'],
    [['aliases', 'create', '--alias', 'production', '--target', 'alias:other'], 'Alias target must be branch:NAME or tag:NAME.'],
    [['aliases', 'retarget', '--alias', 'production', '--target', 'release-one'], 'Ref must be branch:NAME, tag:NAME or alias:NAME.'],
    [['aliases', 'delete', '--alias', 'a/b'], 'Alias name must contain 3–52 letters, digits, underscores or hyphens.'],
  ]) {
    const r = await f.run([...args, ...base]);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}`);
    assert.equal(r.json.error.code, 'INPUT_ERROR');
    assert.equal(r.json.error.message, message, args.join(' '));
  }
  const missing = await f.run(['aliases', 'create', '--alias', 'production', ...base]);
  assert.equal(missing.code, 2); assert.match(missing.json.error.message, /--target/);
  assert.equal(f.requests.length, 0);
});

test('ref mutations keep definite rejections distinct from uncertain outcomes and never retry', async t => {
  // 'ok' answers with the real success status (201 for creation) and an empty body the SDK cannot validate.
  for (const [status, code, error] of [[400, 3, 'API_ERROR'], [404, 3, 'API_ERROR'], [409, 3, 'API_ERROR'], [401, 3, 'AUTH_ERROR'], [503, 5, 'API_ERROR'], ['ok', 5, 'INVALID_RESPONSE']]) {
    const f = await fixture(t, (r, send) => send(status === 'ok' ? (r.method === 'POST' ? 201 : 200) : status, {}));
    for (const args of [
      ['branches', 'create', '--branch', 'candidate'], ['branches', 'delete', '--branch', 'main'],
      ['tags', 'create', '--tag', 'release-one'], ['tags', 'delete', '--tag', 'release-one'],
      ['aliases', 'create', '--alias', 'production', '--target', 'branch:main'], ['aliases', 'retarget', '--alias', 'production', '--target', 'branch:main'],
      ['aliases', 'delete', '--alias', 'production'],
    ]) {
      const before = f.requests.length;
      const r = await f.run([...args, '--collection', 'demo-docs', '--json']);
      assert.equal(r.code, code, `${status} ${args.join(' ')}: ${r.stdout}`);
      assert.equal(r.json.error.code, error);
      assert.equal(r.json.data?.state, code === 5 ? 'unknown' : undefined);
      assert.equal(f.requests.length, before + 1, 'mutations are never retried');
      if (status === 409) assert.match(r.json.error.hint, /alias still references/);
    }
  }
  const f = await fixture(t, (_r, send) => send(503, {}));
  const read = await f.run(['tags', 'list', '--collection', 'demo-docs', '--json']);
  assert.equal(read.code, 3); assert.equal(read.json.data, undefined);
  assert.ok(f.requests.length > 1, 'reads keep SDK retries');
});

test('docs list forwards refs, paging and vectors on the GET route and selectors on the extended route; --all follows tokens', async t => {
  const page = (docs, next) => ({ total: docs.length, isDocsInline: true, docs: docs.map(doc => ({ collection: 'demo-docs', doc })), ...(next ? { nextPageToken: next } : {}) });
  const f = await fixture(t, (r, send, _req, _res, base) => {
    if (r.url.pathname === '/download') return send(200, [{ collection: 'demo-docs', doc: { id: 'doc-9' } }]);
    if (r.method === 'POST') return send(200, { total: 0, isDocsInline: false, docs: [], docsUrl: `${base}/download?signature=private-url` });
    const token = r.url.searchParams.get('pageToken');
    return send(200, token === 'second' ? page([{ id: 'doc-3' }]) : page([{ id: 'doc-1' }, { id: 'doc-2' }], 'second'));
  });
  const base = ['--collection', 'demo-docs', '--json'];
  let r = await f.run(['docs', 'list', '--ref', 'alias:production', ...base]);
  assert.equal(r.code, 0, r.stdout);
  let request = f.requests.at(-1);
  assert.equal(request.method, 'GET');
  assert.equal(request.url.pathname, '/projects/dev-project/collections/demo-docs/docs');
  assert.deepEqual(Object.fromEntries(request.url.searchParams), { size: '20', includeVectors: 'false', refKind: 'alias', refName: 'production' });
  assert.deepEqual(r.json.target.ref, { kind: 'alias', name: 'production' });
  assert.deepEqual(r.json.data.docs.map(item => item.doc.id), ['doc-1', 'doc-2']);
  assert.equal(r.json.data.nextPageToken, 'second');
  const human = await f.run(['docs', 'list', '--ref', 'alias:production', '--collection', 'demo-docs']);
  assert.equal(human.code, 0); assert.match(human.stdout, /2 document\(s\); more pages available/);

  r = await f.run(['docs', 'list', '--ref', 'tag:release-one', '--size', '1', '--page-token', 'second', '--include-vectors', ...base]);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(Object.fromEntries(f.requests.at(-1).url.searchParams), { size: '1', pageToken: 'second', includeVectors: 'true', refKind: 'tag', refName: 'release-one' });
  assert.deepEqual(r.json.data.docs.map(item => item.doc.id), ['doc-3']);

  const before = f.requests.length;
  r = await f.run(['docs', 'list', '--ref', 'branch:main', '--all', ...base]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(f.requests.length, before + 2);
  assert.deepEqual(r.json.data, { docs: [{ collection: 'demo-docs', doc: { id: 'doc-1' } }, { collection: 'demo-docs', doc: { id: 'doc-2' } }, { collection: 'demo-docs', doc: { id: 'doc-3' } }] });

  r = await f.run(['docs', 'list', '--ref', 'branch:main', '--size', '5', '--file', resolve('examples/list-filter.json'), ...base]);
  assert.equal(r.code, 0, r.stdout);
  request = f.requests.at(-2);
  assert.equal(request.method, 'POST');
  assert.equal(request.url.pathname, '/projects/dev-project/collections/demo-docs/docs/list');
  assert.deepEqual(request.body, { size: 5, includeVectors: false, ref: { kind: 'branch', name: 'main' }, filter: { queryString: { query: 'category:database' } }, fields: { include: ['id', 'text', 'category'] } });
  assert.equal(request.headers['x-api-key'], secret);
  assert.ok(!Object.values(f.requests.at(-1).headers).includes(secret), 'download must not use API authentication');
  assert.deepEqual(r.json.data.docs, [{ collection: 'demo-docs', doc: { id: 'doc-9' } }]);
  assert.ok(!r.stdout.includes('private-url'));
  assert.equal(r.json.data.isDocsInline, true);
});

test('docs update merges JSONL rows in sequential batches with the branch and stops on the first rejection', async t => {
  // A batch whose first row is doc-2 stands in for a batch with a missing id.
  const f = await fixture(t, (r, send) => r.body.docs[0].id === 'doc-2' ? send(400, { message: 'missing id' }) : send(202, { message: 'accepted' }));
  const base = ['--collection', 'demo-docs', '--branch', 'edits', '--json'];
  let r = await f.run(['docs', 'update', '--file', resolve('examples/updates.jsonl'), ...base]);
  assert.equal(r.code, 0, r.stdout);
  const request = f.requests.at(-1);
  assert.equal(request.method, 'POST');
  assert.equal(request.url.pathname, '/projects/dev-project/collections/demo-docs/docs/update');
  assert.deepEqual(request.body, { docs: [{ id: 'doc-1', category: 'database', metadata: { reviewed: true } }, { id: 'doc-2', category: 'developer-tools' }], branch: 'edits' });
  assert.deepEqual(r.json.target, { endpoint: f.base, project: 'dev-project', collection: 'demo-docs', branch: 'edits' });
  assert.deepEqual([r.json.data.state, r.json.data.accepted, r.json.data.total, r.json.data.searchable], ['accepted', 2, 2, 'not_verified']);
  assert.match(r.stderr, /Batch 1: accepted, 2 document\(s\), lines 1–2/);

  r = await f.run(['docs', 'update', '--file', resolve('examples/updates.jsonl'), '--batch-size', '1', ...base]);
  assert.equal(r.code, 4, r.stdout);
  assert.deepEqual([r.json.data.accepted, r.json.data.failed, r.json.data.notAttempted], [1, 1, 0]);
  assert.equal(r.json.data.batches[1].error.httpStatus, 400);
  assert.match(r.stderr, /missing id is rejected as a whole/);

  const before = f.requests.length;
  for (const [content, message] of [
    ['{"id":"doc-1","title":"x"}\n{"title":"no id"}\n', 'JSONL line 2 has no id; updates address existing documents by a nonempty string id.'],
    ['{"id":"","title":"x"}\n', 'JSONL line 1 has an invalid id; use a nonempty string or omit it.'],
  ]) {
    r = await f.run(['docs', 'update', '--file', await f.file('patch.jsonl', content), ...base]);
    assert.equal(r.code, 2, r.stdout);
    assert.equal(r.json.error.message, message);
  }
  r = await f.run(['docs', 'update', '--file', resolve('examples/updates.jsonl'), '--batch-bytes', '4000001', ...base]);
  assert.equal(r.code, 2); assert.match(r.json.error.message, /Batch bytes must be an integer from 64 to 4000000/);
  assert.equal(f.requests.length, before);
});

test('docs delete requires exactly one selector, forwards ids or filter with the branch, and reports acceptance only', async t => {
  const f = await fixture(t, (_r, send) => send(202, { message: 'Delete request is accepted' }));
  const base = ['--collection', 'demo-docs', '--branch', 'main', '--json'];
  let r = await f.run(['docs', 'delete', '--ids', 'doc-1', 'doc-2', ...base]);
  assert.equal(r.code, 0, r.stdout);
  let request = f.requests.at(-1);
  assert.equal(request.method, 'POST');
  assert.equal(request.url.pathname, '/projects/dev-project/collections/demo-docs/docs/delete');
  assert.deepEqual(request.body, { ids: ['doc-1', 'doc-2'], branch: 'main' });
  assert.deepEqual(r.json.target, { endpoint: f.base, project: 'dev-project', collection: 'demo-docs', branch: 'main' });
  assert.deepEqual(r.json.data, { message: 'Delete request is accepted', state: 'accepted', searchable: 'not_verified' });

  r = await f.run(['docs', 'delete', '--file', resolve('examples/delete-filter.json'), ...base]);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(f.requests.at(-1).body, { filter: { queryString: { query: 'category:developer-tools' } }, branch: 'main' });

  const partitioned = await f.file('delete-ids.json', { ids: ['doc-3'], partitionFilter: { field: 'tenant', in: ['acme'] }, branch: 'main' });
  r = await f.run(['docs', 'delete', '--file', partitioned, ...base]);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(f.requests.at(-1).body, { ids: ['doc-3'], partitionFilter: { field: 'tenant', in: ['acme'] }, branch: 'main' });

  const before = f.requests.length;
  const selectors = 'Delete requires exactly one selector: --ids, or a --file with ids or filter and an optional partitionFilter.';
  for (const [args, message] of [
    [['docs', 'delete'], selectors],
    [['docs', 'delete', '--ids', 'doc-1', '--file', resolve('examples/delete-filter.json')], selectors],
    [['docs', 'delete', '--file', await f.file('both.json', { ids: ['doc-1'], filter: { queryString: { query: '*:*' } } })], selectors],
    [['docs', 'delete', '--file', await f.file('partition-only.json', { partitionFilter: { field: 'tenant', in: ['acme'] } })], selectors],
    [['docs', 'delete', '--file', await f.file('other-branch.json', { ids: ['doc-1'], branch: 'other' })], 'File branch conflicts with --branch. Use the same explicit branch in both.'],
    [['docs', 'delete', '--file', await f.file('unknown.json', { ids: ['doc-1'], size: 1 })], 'Delete file accepts ids or filter, partitionFilter and branch. Unknown: size.'],
    [['docs', 'delete', '--file', await f.file('empty-ids.json', { ids: [] })], 'Invalid delete request. ids must be a nonempty string array and filter must use the query DSL (queryString or bool).'],
    [['docs', 'delete', '--file', await f.file('blank-id.json', { ids: ['doc-1', ''] })], 'Invalid delete request. ids must be a nonempty string array and filter must use the query DSL (queryString or bool).'],
    [['docs', 'delete', '--file', await f.file('bad-filter.json', { filter: 'category:x' })], 'Invalid delete request. ids must be a nonempty string array and filter must use the query DSL (queryString or bool).'],
    [['docs', 'delete', '--ids', ''], 'Delete IDs must be nonempty strings.'],
  ]) {
    r = await f.run([...args, ...base]);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}`);
    assert.equal(r.json.error.message, message, args.join(' '));
  }
  for (const [args, message] of [
    [['docs', 'list', '--ref', 'branch:main', '--file', await f.file('list-size.json', { filter: {}, size: 5 })], /accepts only filter, partitionFilter and fields/],
    [['docs', 'list', '--ref', 'branch:main', '--file', await f.file('list-bad.json', { fields: 'id' })], /Invalid list request/],
    [['docs', 'list', '--ref', 'branch:main', '--size', '101'], /Page size must be an integer from 1 to 100/],
    [['docs', 'list', '--ref', 'main'], /Ref must be branch:NAME, tag:NAME or alias:NAME/],
  ]) {
    r = await f.run([...args, '--collection', 'demo-docs', '--json']);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}`);
    assert.match(r.json.error.message, message);
  }
  assert.equal(f.requests.length, before);

  // 202 is the real acceptance status; an empty body there is an unverifiable success.
  for (const [status, code, error] of [[400, 3, 'API_ERROR'], [404, 3, 'API_ERROR'], [503, 5, 'API_ERROR'], [202, 5, 'INVALID_RESPONSE']]) {
    const g = await fixture(t, (_r, send) => send(status, {}));
    r = await g.run(['docs', 'delete', '--ids', 'doc-1', ...base]);
    assert.equal(r.code, code, `${status}: ${r.stdout}`);
    assert.equal(r.json.error.code, error);
    assert.equal(r.json.data?.state, code === 5 ? 'unknown' : undefined);
    assert.equal(g.requests.length, 1, 'deletes are never retried');
  }
});
