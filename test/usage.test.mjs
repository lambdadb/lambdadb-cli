import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const bin = process.env.LAMBDADB_TEST_CLI ?? resolve('dist/cli.js');
const org = '11111111-1111-4111-8111-111111111111';
const project = '22222222-2222-4222-8222-222222222222';
const member = '33333333-3333-4333-8333-333333333333';
const credential = '44444444-4444-4444-8444-444444444444';
const secret = 'synthetic-usage-account-secret';
const organization = { id: org, name: 'Team', role: 'owner', plan: 'Free', max_projects: 1, projects_count: 1 };
const quota = { period: 'MONTH', window_start_at: 1790812800000, updated_at: '2026-10-27T09:00:00Z', read: { used: 25, limit: 100 }, write: { used: 0, limit: 0 }, storage: { limit: 200 }, inference: {} };
const free = { organization, projects: [{ id: project, organization_id: org, name: 'demo', quota_enabled: true, quota }], retrieved_at: '2026-10-27T09:01:00Z' };
const cost = { from: '2026-10-01T00:00:00Z', to: '2026-10-28T00:00:00Z', timezone: 'UTC', is_estimate: true, read_bytes: '9223372036854775808', write_bytes: '0', storage_byte_hours: '3', inference_liu: null, read_usd: '0.000000000000000003', write_usd: '0', storage_usd: '0.3', inference_usd: null, total_usd: '0.300000000000000003', unpriced_metrics: ['inference'] };
const paid = { organization: { ...organization, plan: 'Pay-As-You-Go (active)' }, projects: [], retrieved_at: free.retrieved_at, cost };

async function fixture(t, response = free, status = 200, delay = 0) {
  const root = await mkdtemp(join(tmpdir(), 'lambdadb-usage-'));
  const calls = [];
  const server = createServer(async (req, res) => {
    calls.push({ method: req.method, url: req.url, headers: req.headers });
    if (delay) await new Promise(r => setTimeout(r, delay));
    res.writeHead(status, { 'Content-Type': 'application/json' });
    const value = structuredClone(response);
    const id = new URL(req.url, 'http://localhost').searchParams.get('project_id');
    if (id && status === 200) value.project_id = id;
    res.end(JSON.stringify(value));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`, config = join(root, 'config.json');
  const settings = { endpoint: 'https://data.example.com', project: 'demo', apiKeyEnv: 'LAMBDADB_API_KEY', credentialStore: 'keychain', credentialId: credential };
  await writeFile(config, JSON.stringify(settings));
  await writeFile(`${config}.account.json`, JSON.stringify({ apiUrl: url, consoleUrl: 'https://console.example.com', memberId: member, email: 'test@example.com', expiresAt: new Date(Date.now() + 3600000).toISOString(), credentialStore: 'keychain', credentialId: credential }));
  await writeFile(`${config}.connections.json`, JSON.stringify([{ account: `${url}/${member}`, org, projectId: project, settings }]));
  const preload = join(root, 'vault.mjs');
  await writeFile(preload, `import { CredentialVault } from ${JSON.stringify(pathToFileURL(join(dirname(bin), 'credentials.js')).href)};
    CredentialVault.prototype.read = async (target) => { if (target.project !== 'account') throw Error('project key must not be read'); return ${JSON.stringify(secret)}; };
    CredentialVault.prototype.save = async () => { throw Error('no credential writes allowed'); };
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LAMBDADB_')));
  async function run(args = [], extra = {}) {
    const child = spawn(process.execPath, ['--import', preload, bin, 'usage', '--config', config, ...args], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
    const code = await new Promise((r, reject) => { child.on('error', reject); child.on('close', r); });
    clearTimeout(timer);
    assert.notEqual(code, null, stderr);
    assert.ok(!stdout.includes(secret) && !stderr.includes(secret));
    assert.ok(calls.every(c => c.method === 'GET' && c.headers.authorization === `Bearer ${secret}`));
    return { code, stdout, stderr, value: args.includes('--json') ? JSON.parse(stdout) : undefined };
  }
  return { run, config, calls, settings };
}

test('usage resolves the saved account/project and renders Free quotas without pricing or raw JSON', async t => {
  const f = await fixture(t);
  const before = await readFile(f.config, 'utf8');
  const result = await f.run();
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /Team — Free/);
  assert.match(result.stdout, /read: 25 \/ 100 bytes \(25.0%\)/);
  assert.match(result.stdout, /storage: unavailable \/ 200/);
  assert.match(result.stdout, /window starts: 2026-10-01T00:00:00.000Z/);
  assert.doesNotMatch(result.stdout, /\$|read_usd|[{}]/);
  assert.equal(f.calls[0].url, `/auth/cli/usage?project_id=${project}`);
  assert.equal(f.calls[0].headers['x-organization-id'], org);
  assert.equal(await readFile(f.config, 'utf8'), before);
  const json = await f.run(['--json']);
  assert.equal(json.value.command, 'usage');
  assert.equal(json.value.data.projects[0].quota.inference.used, undefined);
  assert.equal(json.value.data.cost, undefined);
});

test('paid usage preserves exact decimals, partial prices and explicit Org scope', async t => {
  const f = await fixture(t, paid);
  const result = await f.run(['--org-id', org, '--month', '2026-10', '--json']);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(result.value.data.cost, { ...cost, from: '2026-10-01T00:00:00.000Z', to: '2026-10-28T00:00:00.000Z' });
  assert.equal(f.calls[0].url, '/auth/cli/usage?month=2026-10');
  const human = await f.run(['--org-id', org]);
  assert.match(human.stdout, /Partial priced subtotal: \$0.300000000000000003/);
  assert.match(human.stdout, /inference: unavailable LIU — cost unavailable/);
  assert.match(human.stdout, /not a month-end forecast or invoice/);
});

test('invalid usage inputs fail before requests and never start interactive auth', async t => {
  const f = await fixture(t);
  for (const flags of [['--org', org], ['--month', '2026-13'], ['--org-id', 'bad'], ['--project-id', project]]) {
    const result = await f.run([...flags, '--json']);
    assert.equal(result.code, 2); assert.equal(f.calls.length, 0);
  }
  await rm(`${f.config}.account.json`);
  const result = await f.run(['--json']);
  assert.equal(result.code, 2); assert.match(result.value.error.message, /login first/); assert.equal(f.calls.length, 0);
});

test('environment connections and stale saved identities require an explicit Org instead of guessing', async t => {
  const f = await fixture(t);
  for (const settings of [{ endpoint: f.settings.endpoint, project: 'demo', apiKeyEnv: 'LAMBDADB_API_KEY' }, { ...f.settings, project: 'different' }]) {
    await writeFile(f.config, JSON.stringify(settings));
    const result = await f.run(['--json']);
    assert.equal(result.code, 2); assert.match(result.value.error.message, /--org-id UUID/); assert.equal(f.calls.length, 0);
  }
  assert.equal((await f.run(['--org-id', org, '--json'])).code, 0);
});

test('unsafe or mismatched usage responses are rejected without inventing zero usage', async t => {
  for (const bad of [
    { ...free, organization: { ...organization, id: project } },
    { ...free, projects: [{ ...free.projects[0], quota: { ...quota, read: { used: Number.MAX_SAFE_INTEGER + 1 } } }] },
    { ...paid, cost: { ...cost, read_usd: 0.1 } },
    { ...paid, cost: { ...cost, total_usd: null } },
  ]) {
    const f = await fixture(t, bad);
    assert.equal((await f.run(['--org-id', org, '--json'])).code, 2);
  }
});

test('usage access, compatibility and timeout errors retain request-failure semantics with actionable hints', async t => {
  for (const [status, hint] of [[403, /owner or admin/], [404, /matching Backend/]]) {
    const f = await fixture(t, { error: 'hidden-server-detail' }, status);
    const result = await f.run(['--org-id', org, '--json']);
    assert.equal(result.code, 3); assert.equal(result.value.error.httpStatus, status); assert.match(result.value.error.hint, hint);
    assert.ok(!result.stdout.includes('hidden-server-detail')); assert.equal(f.calls.length, 1);
  }
  const f = await fixture(t, free, 200, 400);
  const result = await f.run(['--org-id', org, '--timeout-ms', '100', '--json']);
  assert.equal(result.code, 3); assert.equal(f.calls.length, 1);
});
