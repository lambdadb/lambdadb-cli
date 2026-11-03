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
const organization = { id: org, name: 'Team', role: 'owner', status: 'active', max_projects: 1, projects_count: 1 };
const quota = { period: 'MONTH', window_start_at: 1790812800000, updated_at: '2026-10-27T09:00:00Z', read: { used: 25, limit: 100 }, write: { used: 0, limit: 0 }, storage: { limit: 200 }, inference: {} };
const free = { organization, projects: [{ id: project, organization_id: org, name: 'demo', quota_enabled: true, quota }] };
// Daily buckets whose exact sums exceed JavaScript's safe integer range.
const buckets = [
  { read_bytes: 9007199254740991, write_bytes: 0, storage_byte_hours: 1, inference_liu: '1', read_usd: '0.000000000000000001', write_usd: '0', storage_usd: '0.1', inference_usd: null, total_usd: '0.100000000000000001', unpriced_metrics: ['inference'] },
  { read_bytes: 1, write_bytes: 0, storage_byte_hours: 2, inference_liu: null, read_usd: '0.000000000000000002', write_usd: '0', storage_usd: '0.2', inference_usd: null, total_usd: '0.200000000000000002', unpriced_metrics: [] },
];
const cost = { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z', timezone: 'UTC', is_estimate: true, read_bytes: '9007199254740992', write_bytes: '0', storage_byte_hours: '3', inference_liu: null, read_usd: '0.000000000000000003', write_usd: '0', storage_usd: '0.3', inference_usd: null, total_usd: '0.300000000000000003', unpriced_metrics: ['inference'] };
const paid = { organization, subscription: 'active', projects: [], buckets };

async function fixture(t, scenario = free, status = 200, delay = 0) {
  const root = await mkdtemp(join(tmpdir(), 'lambdadb-usage-'));
  const calls = [];
  const server = createServer(async (req, res) => {
    calls.push({ method: req.method, url: req.url, headers: req.headers });
    if (delay) await new Promise(r => setTimeout(r, delay));
    const path = req.url.split('?')[0];
    const reply = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (status !== 200 && path === scenario.failing) return reply(status, { error: 'hidden-server-detail' });
    if (path === '/organizations') return reply(200, { organizations: [scenario.organization] });
    if (path === `/subscriptions/${org}`) return scenario.subscription ? reply(200, { status: scenario.subscription, stripe_customer_id: 'cus_hidden' }) : reply(404, { error: 'subscription not found' });
    if (path === '/projects') return reply(200, { projects: scenario.projects });
    if (path === `/organizations/${org}/metrics/usage-cost`) {
      const q = new URL(req.url, 'http://localhost').searchParams;
      return reply(200, { data: scenario.buckets, from: `${q.get('from')}T00:00:00Z`, to: `${q.get('to')}T00:00:00Z`, granularity: 'daily', timezone: 'UTC', is_estimate: true });
    }
    reply(404, { error: 'not_found' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`, config = join(root, 'config.json');
  const settings = { endpoint: 'https://data.example.com', project: 'demo', apiKeyEnv: 'LAMBDADB_API_KEY', credentialStore: 'keychain', credentialId: credential };
  await writeFile(config, JSON.stringify(settings));
  await writeFile(`${config}.account.json`, JSON.stringify({ apiUrl: url, consoleUrl: 'https://console.example.com', issuer: `${url}/`, memberId: member, email: 'test@example.com', expiresAt: new Date(Date.now() + 3600000).toISOString(), credentialStore: 'keychain', credentialId: credential }));
  await writeFile(`${config}.connections.json`, JSON.stringify([{ account: `${url}/${member}`, org, projectId: project, settings }]));
  const saved = JSON.stringify({ refresh_token: 'synthetic-usage-refresh-secret', access_token: secret, access_expires_at: Date.now() + 3600000 });
  const preload = join(root, 'vault.mjs');
  await writeFile(preload, `import { CredentialVault } from ${JSON.stringify(pathToFileURL(join(dirname(bin), 'credentials.js')).href)};
    CredentialVault.prototype.read = async (target) => { if (target.project !== 'account') throw Error('project key must not be read'); return ${JSON.stringify(saved)}; };
    CredentialVault.prototype.save = async () => { throw Error('no credential writes allowed'); };
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LAMBDADB_') && k !== 'npm_command'));
  async function run(args = [], extra = {}) {
    const child = spawn(process.execPath, ['--import', preload, bin, 'usage', '--config', config, ...args], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
    const code = await new Promise((r, reject) => { child.on('error', reject); child.on('close', r); });
    clearTimeout(timer);
    assert.notEqual(code, null, stderr);
    for (const value of [secret, 'synthetic-usage-refresh-secret', 'cus_hidden']) assert.ok(!stdout.includes(value) && !stderr.includes(value));
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
  assert.deepEqual(f.calls.map(c => c.url), ['/organizations', `/subscriptions/${org}`, '/projects']);
  assert.equal(f.calls[2].headers['x-organization-id'], org);
  assert.equal(await readFile(f.config, 'utf8'), before);
  const json = await f.run(['--json']);
  assert.equal(json.value.command, 'usage');
  assert.equal(json.value.data.projects[0].quota.inference.used, undefined);
  assert.equal(json.value.data.cost, undefined);
});

test('Free zero recorded usage does not invent timestamps or replace unknown counters', async t => {
  const response = structuredClone(free);
  response.projects[0].quota = { period: 'monthly', read: { used: 0, limit: 100 }, write: { used: 0, limit: 200 }, storage: { used: 0, limit: 300 }, inference: { limit: 400 } };
  const f = await fixture(t, response);
  const human = await f.run();
  assert.equal(human.code, 0, human.stdout);
  assert.match(human.stdout, /read: 0 \/ 100 bytes \(0.0%\)/);
  assert.match(human.stdout, /inference: unavailable \/ 400 LIU/);
  assert.match(human.stdout, /window starts: unavailable; updated: unavailable/);
  assert.match(human.stdout, /Based on recorded usage; recent activity may not be aggregated yet/);
  const json = await f.run(['--json']);
  assert.equal(json.code, 0, json.stdout);
  const actual = json.value.data.projects[0].quota;
  assert.equal(actual.read.used, 0);
  assert.equal(actual.inference.used, undefined);
  assert.equal(actual.read.exceeded, undefined);
  assert.equal(actual.window_start_at, undefined);
  assert.equal(actual.updated_at, undefined);
});

test('paid usage preserves exact decimals, partial prices and explicit Org scope', async t => {
  const f = await fixture(t, paid);
  const result = await f.run(['--org-id', org, '--month', '2026-10', '--json']);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(result.value.data.cost, cost);
  assert.equal(f.calls.at(-1).url, `/organizations/${org}/metrics/usage-cost?from=2026-10-01&to=2026-11-01&granularity=daily&timezone=UTC`);
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
  assert.equal(result.code, 2); assert.match(result.value.error.message, /Run lambdadb login first/); assert.equal(f.calls.length, 0);
  const viaNpx = await f.run(['--json'], { npm_command: 'exec' });
  assert.match(viaNpx.value.error.message, /Run npx -y @functional-systems\/lambdadb-cli@\S+ login first/); assert.equal(f.calls.length, 0);
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
    { ...free, projects: [{ ...free.projects[0], organization_id: project }] },
    { ...free, projects: [{ ...free.projects[0], quota: { ...quota, read: { used: Number.MAX_SAFE_INTEGER + 1 } } }] },
    { ...paid, buckets: [{ ...buckets[0], read_usd: 0.1 }] },
    { ...paid, buckets: [{ ...buckets[0], total_usd: null }] },
    { ...paid, buckets: [{ ...buckets[0], read_bytes: Number.MAX_SAFE_INTEGER + 2 }] },
  ]) {
    const f = await fixture(t, bad);
    assert.equal((await f.run(['--org-id', org, '--json'])).code, 2);
  }
});

test('usage access, compatibility and timeout errors retain request-failure semantics with actionable hints', async t => {
  const member = await fixture(t, { ...paid, organization: { ...organization, role: 'member' } });
  const denied = await member.run(['--org-id', org, '--json']);
  assert.equal(denied.code, 3); assert.equal(denied.value.error.httpStatus, 403); assert.match(denied.value.error.hint, /owner or admin/);
  assert.equal(member.calls.filter(c => c.url.includes('usage-cost')).length, 0);
  const costPath = `/organizations/${org}/metrics/usage-cost`;
  for (const [status, hint] of [[403, /owner or admin/], [404, /matching Backend/]]) {
    const f = await fixture(t, { ...paid, failing: costPath }, status);
    const result = await f.run(['--org-id', org, '--json']);
    assert.equal(result.code, 3); assert.equal(result.value.error.httpStatus, status); assert.match(result.value.error.hint, hint);
    assert.equal(result.value.error.message, `Account management request failed: usage_request_failed (HTTP ${status}) during GET organizations/{id}/metrics/usage-cost.`);
    assert.ok(!result.stdout.includes('hidden-server-detail')); assert.equal(f.calls.filter(c => c.url.startsWith(costPath)).length, 1);
  }
  const f = await fixture(t, free, 200, 400);
  const result = await f.run(['--org-id', org, '--timeout-ms', '100', '--json']);
  assert.equal(result.code, 3); assert.equal(f.calls.length, 1);
  assert.equal(result.value.error.httpStatus, undefined);
  assert.equal(result.value.error.message, 'Account management request failed: usage_request_failed (no HTTP response: the request timed out or the connection failed) during GET organizations.');
});
