import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = resolve('dist/cli.js');
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
  async function run(args, env = {}) {
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LAMBDADB_') && key !== 'XDG_CONFIG_HOME'));
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...cleanEnv, XDG_CONFIG_HOME: temp, LAMBDADB_ENDPOINT: base, LAMBDADB_PROJECT: 'dev-project', LAMBDADB_API_KEY: secret, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
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
  const invalidSize = await f.file('size.json', { query: {}, size: 101 });
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
  assert.equal((await f.run(['--version'])).stdout.trim(), '0.1.0');
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
  const unusualSecret = '{"key":';
  const f = await fixture(t, (_r, send) => send(200, { took: 1, total: 1, isDocsInline: true, docs: [{ collection: 'demo-docs', doc: { id: 'doc-1', text: unusualSecret } }] }));
  const r = await f.run(['docs', 'fetch', '--collection', 'demo-docs', '--ref', 'branch:main', '--ids', 'doc-1', '--json'], { LAMBDADB_API_KEY: unusualSecret });
  assert.equal(r.code, 0); assert.equal(r.json.data.docs[0].doc.text, '[REDACTED]');
});
