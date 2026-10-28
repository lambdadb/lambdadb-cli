import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
const bin = process.env.LAMBDADB_TEST_CLI ?? resolve('dist/cli.js');
const moduleURL = (name) => pathToFileURL(join(dirname(bin), name)).href;
const { login, logout, loadAccount, accountRequest, parseOrganization, accountPath } = await import(
  moduleURL('account.js')
);
const { useProject } = await import(moduleURL('projects.js'));
const { CredentialVault } = await import(moduleURL('credentials.js'));
const { ManagementError, describeError } = await import(moduleURL('errors.js'));
const quiet = { diagnostic() {}, protect() {} };
const org = '11111111-1111-4111-8111-111111111111';
const first = '22222222-2222-4222-8222-222222222222';
const second = '33333333-3333-4333-8333-333333333333';
const account = () => ({
  apiUrl: 'https://api.example.com',
  consoleUrl: 'https://console.example.com',
  memberId: randomUUID(),
  email: 'test@example.com',
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  credentialStore: 'keychain',
  credentialId: randomUUID(),
});
function memory() {
  const saved = new Map();
  return {
    saved,
    async select() {
      return 'keychain';
    },
    async save(ref, value) {
      saved.set(ref.credentialId, value);
    },
    async read(ref) {
      if (!saved.has(ref.credentialId)) throw new Error('locked');
      return saved.get(ref.credentialId);
    },
    async remove(ref) {
      saved.delete(ref.credentialId);
    },
  };
}
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'lambdadb-account-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, config: join(dir, 'config.json') };
}
async function server(t, handler) {
  const calls = [];
  const instance = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const call = {
      path: req.url,
      method: req.method,
      auth: req.headers.authorization,
      orgId: req.headers['x-organization-id'],
      body: body ? JSON.parse(body) : undefined,
    };
    calls.push(call);
    res.setHeader('Content-Type', 'application/json');
    await handler(call, res);
  });
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    instance.closeAllConnections();
    instance.close();
  });
  return { url: `http://127.0.0.1:${instance.address().port}`, calls };
}

test('account login stores only metadata, renews explicitly, and logout preserves project settings', async (t) => {
  const { config } = await directory(t),
    vault = memory();
  const previous = '{"project":"keep"}\n';
  await writeFile(config, previous);
  const tokens = ['a'.repeat(64), 'b'.repeat(64)];
  let issued = 0;
  const a = account();
  const fixture = await server(t, (call, res) => {
    if (call.path === '/auth/device/login')
      return res.end(
        JSON.stringify({
          device_code: 'c'.repeat(64),
          user_code: 'ABCDE-FG234',
          verification_uri: `${a.consoleUrl}/auth/cli`,
          expires_in: 15,
          interval: 1,
        }),
      );
    if (call.path === '/auth/device/token')
      return res.end(
        JSON.stringify({
          account: {
            session_token: tokens[issued++],
            expires_at: a.expiresAt,
            member_id: a.memberId,
            email: a.email,
            console_url: a.consoleUrl,
          },
        }),
      );
    assert.equal(call.path, '/auth/cli/logout');
    if (call.auth === `Bearer ${tokens[0]}`) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: 'login_required' }));
    }
    res.statusCode = 204;
    res.end();
  });
  const options = { config, apiUrl: fixture.url, browser: false };
  const firstLogin = await login(options, quiet, vault);
  const content = await readFile(await accountPath(options), 'utf8');
  assert.ok(tokens.every((token) => !content.includes(token)));
  assert.equal(vault.saved.get(firstLogin.credentialId), tokens[0]);
  const nextLogin = await login({ config, browser: false }, quiet, vault);
  assert.equal(nextLogin.apiUrl, fixture.url, 'renewal must retain the selected account server');
  assert.notEqual(nextLogin.credentialId, firstLogin.credentialId);
  assert.equal(vault.saved.size, 1);
  assert.equal(fixture.calls.filter((c) => c.path === '/auth/cli/logout')[0].auth, `Bearer ${tokens[0]}`);
  await logout(options, quiet, vault);
  assert.equal(vault.saved.size, 0);
  assert.equal(await readFile(config, 'utf8'), previous);
  assert.equal(fixture.calls.filter((c) => c.path === '/auth/cli/logout').length, 2);
  await assert.rejects(loadAccount(options), /login first/);
});

test('account metadata rejects secrets, expiry and API origin changes before credential access', async (t) => {
  const { config } = await directory(t),
    a = account();
  const path = await accountPath({ config });
  await writeFile(path, JSON.stringify(a));
  await assert.rejects(loadAccount({ config, apiUrl: 'https://other.example.com' }), /different API origin/);
  await writeFile(path, JSON.stringify({ ...a, session_token: 'never-persist' }));
  await assert.rejects(loadAccount({ config }), /Invalid account metadata/);
  await writeFile(path, JSON.stringify({ ...a, expiresAt: '2020-01-01T00:00:00Z' }));
  await assert.rejects(loadAccount({ config }), /expired/);
});

test('account credentials cannot be read through a project or MCP credential namespace', async () => {
  const values = new Map();
  const factory = async (service, id) => ({
    async getSecret() {
      return values.get(service + id) ?? null;
    },
    async setSecret(v) {
      values.set(service + id, [...v]);
    },
    async deleteCredential() {
      return values.delete(service + id);
    },
  });
  const a = account(),
    target = { ...a, endpoint: a.apiUrl, project: 'account' };
  await new CredentialVault(factory, 'darwin', 'account').save(target, 'account-only');
  await assert.rejects(new CredentialVault(factory, 'darwin').read(target), /Cannot read/);
  assert.equal(await new CredentialVault(factory, 'darwin', 'account').read(target), 'account-only');
});

function projectClient(a, onConnect = async () => {}) {
  const calls = [];
  return {
    calls,
    account: a,
    role: 'owner',
    async request(path, method, body) {
      calls.push({ path, method, body });
      if (path === 'organizations')
        return {
          organizations: [
            { id: org, name: 'Team', role: this.role, plan: 'Free', max_projects: 1, projects_count: 1 },
          ],
        };
      if (path === 'projects')
        return {
          projects: [first, second].map((id, i) => ({
            id,
            organization_id: org,
            name: `project-${i}`,
            status: 'ACTIVE',
          })),
        };
      assert.equal(path, 'connect');
      await onConnect();
      return {
        endpoint: 'https://project.example.com',
        project: `project-${body.project_id === first ? 0 : 1}`,
        credentials: { api_key: `synthetic-${body.project_id}`, key: { key_id: 'key-id' } },
      };
    },
  };
}
test('project switching reuses saved keys and preserves pinned agents, including safe reruns', async (t) => {
  const { dir, config } = await directory(t),
    a = account(),
    vault = memory(),
    api = projectClient(a);
  const agent = join(dir, 'agent.json');
  await writeFile(agent, '{"mcpServers":{"pinned":"keep"}}');
  await assert.rejects(useProject({ config }, org, first, false, quiet, vault, api), /--issue-key/);
  const selected = await useProject({ config }, org, first, true, quiet, vault, api);
  await useProject({ config }, org, second, true, quiet, vault, api);
  await useProject({ config }, org, first, false, quiet, vault, api);
  await useProject({ config }, org, first, false, quiet, vault, api);
  assert.equal(JSON.parse(await readFile(config, 'utf8')).credentialId, selected.credentialId);
  assert.equal(api.calls.filter((c) => c.path === 'connect').length, 2);
  assert.equal(await readFile(agent, 'utf8'), '{"mcpServers":{"pinned":"keep"}}');
  assert.ok(!(await readFile(`${config}.connections.json`, 'utf8')).includes('synthetic-'));
  assert.equal(vault.saved.size, 2);
});

test('uncertain issuance records the key name and rerun never silently issues another key', async (t) => {
  const { config } = await directory(t),
    vault = memory();
  const api = projectClient(account(), async () => {
    throw new ManagementError('issuance_unconfirmed', 502);
  });
  await assert.rejects(useProject({ config }, org, first, true, quiet, vault, api), /issuance_unconfirmed/);
  await assert.rejects(
    useProject({ config }, org, first, false, quiet, vault, api),
    /Inspect\/revoke lambdadb-cli-/,
  );
  assert.equal(api.calls.filter((c) => c.path === 'connect').length, 1);
  assert.equal(vault.saved.size, 0);
  assert.ok(JSON.parse(await readFile(`${config}.connections.json`, 'utf8'))[0].pendingKeyName);
});

test('concurrent config edits are preserved and a cached issued key can resume without another write', async (t) => {
  const { config } = await directory(t),
    vault = memory();
  await writeFile(config, '{}');
  const api = projectClient(account(), () => writeFile(config, '{"project":"concurrent"}'));
  await assert.rejects(useProject({ config }, org, first, true, quiet, vault, api), /settings changed/);
  assert.equal(await readFile(config, 'utf8'), '{"project":"concurrent"}');
  await useProject({ config }, org, first, false, quiet, vault, api);
  assert.equal(api.calls.filter((c) => c.path === 'connect').length, 1);
});

test(
  'config symlinks share account metadata and project cache without replacing the symlink',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { dir, config } = await directory(t),
      alias = join(dir, 'alias.json');
    await writeFile(config, '{}');
    await symlink(config, alias);
    assert.equal(await accountPath({ config }), await accountPath({ config: alias }));
    const api = projectClient(account()),
      vault = memory();
    await useProject({ config: alias }, org, first, true, quiet, vault, api);
    await useProject({ config }, org, first, false, quiet, vault, api);
    assert.equal(api.calls.filter((c) => c.path === 'connect').length, 1);
    assert.ok((await lstat(alias)).isSymbolicLink());
  },
);

test('quota errors expose only safe Org metadata and a trusted Org-specific billing link', async (t) => {
  const fixture = await server(t, (_call, res) => {
    res.statusCode = 409;
    res.end(
      JSON.stringify({
        error: 'project_limit_reached',
        secret: 'hidden',
        organization: {
          id: org,
          name: 'Team',
          role: 'admin',
          plan: 'Free',
          max_projects: 1,
          projects_count: 1,
          billing_url: 'https://attacker.invalid',
          can_upgrade: true,
        },
      }),
    );
  });
  const a = { ...account(), apiUrl: fixture.url };
  let failure;
  try {
    await accountRequest(a, 'token', 'projects', 'POST', {});
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, 'project_limit_reached');
  assert.equal(failure.details.organization.can_upgrade, false);
  assert.equal(
    failure.details.organization.billing_url,
    `${a.consoleUrl}/organization/billing/open?org_id=${org}`,
  );
  assert.match(describeError(failure).hint, /org_id=/);
  assert.ok(!JSON.stringify(failure).includes('hidden'));
  assert.equal(parseOrganization(failure.details.organization, a).max_projects, 1);
});

test('management write failures are uncertain and never automatically retried', async (t) => {
  const fixture = await server(t, (_call, res) => {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'project_request_rejected', secret: 'hidden' }));
  });
  await assert.rejects(
    accountRequest({ ...account(), apiUrl: fixture.url }, 'token', 'projects', 'POST', {}),
    (e) => e.code === 'write_outcome_unknown',
  );
  assert.equal(fixture.calls.length, 1);
});

for (const args of [
  ['projects', 'list'],
  ['projects', 'create', '--name', 'test'],
  ['projects', 'create', '--name', 'test', '--region', 'test'],
  ['projects', 'use', '--org-id', org],
  ['orgs', 'list'],
]) {
  test(`non-interactive ${args.join(' ')} fails promptly with actionable input/login errors`, async (t) => {
    const { config } = await directory(t);
    const child = spawn(process.execPath, [bin, ...args, '--config', config, '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.resume();
    const timer = setTimeout(() => child.kill(), 5000);
    t.after(() => clearTimeout(timer));
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 2);
    assert.equal(JSON.parse(out).error.code, 'INPUT_ERROR');
  });
}

test('account session limits stop polling with logout/expiry guidance instead of retrying approval', async (t) => {
  const { config } = await directory(t);
  const fixture = await server(t, (call, res) => {
    if (call.path === '/auth/device/login')
      return res.end(
        JSON.stringify({
          device_code: 'c'.repeat(64),
          user_code: 'ABCDE-FG234',
          verification_uri: 'https://console.example.com/auth/cli',
          expires_in: 15,
          interval: 1,
        }),
      );
    res.statusCode = 429;
    res.end(JSON.stringify({ error: 'account_session_limit' }));
  });
  await assert.rejects(
    login({ config, apiUrl: fixture.url, browser: false }, quiet, memory()),
    /logout on another device\/profile/,
  );
  assert.equal(fixture.calls.length, 2);
});

test('a demoted member can reuse a saved project key but cannot issue a replacement', async (t) => {
  const { config } = await directory(t),
    vault = memory(),
    api = projectClient(account());
  const selected = await useProject({ config }, org, first, true, quiet, vault, api);
  api.role = 'member';
  const reused = await useProject({ config }, org, first, false, quiet, vault, api);
  assert.equal(reused.credentialId, selected.credentialId);
  await assert.rejects(useProject({ config }, org, first, true, quiet, vault, api), /owner or admin/);
  assert.equal(api.calls.filter((c) => c.path === 'connect').length, 1);
  assert.equal(vault.saved.size, 1);
});

// Run the real CLI and HTTP client; only OS credential access is simulated.
async function cliFixture(t, handler, saveAllowed = false) {
  const { dir, config } = await directory(t);
  const fixture = await server(t, handler);
  await writeFile(`${config}.account.json`, JSON.stringify({ ...account(), apiUrl: fixture.url }));
  const preload = join(dir, 'credential-store.mjs');
  await writeFile(preload, `
    import { CredentialVault } from ${JSON.stringify(moduleURL('credentials.js'))};
    CredentialVault.prototype.select = async () => 'keychain';
    CredentialVault.prototype.read = async () => 'synthetic-account-token';
    CredentialVault.prototype.remove = async () => {};
    CredentialVault.prototype.save = async () => { ${saveAllowed ? '' : "throw Error('unexpected secret persistence');"} };
    if (process.env.LAMBDADB_TEST_INTERACTIVE) { process.stdin.isTTY = true; process.stderr.isTTY = true; }
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LAMBDADB_')));
  return {
    ...fixture, config,
    async run(args, extra = {}, answers) {
      const child = spawn(process.execPath, ['--import', preload, bin, ...args, '--config', config, ...(answers ? [] : ['--json'])], {
        env: { ...env, ...extra, ...(answers ? { LAMBDADB_TEST_INTERACTIVE: 'true' } : {}) }, stdio: [answers ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      let answered = 0, cursor = 0;
      child.stderr.on('data', (c) => {
        stderr += c;
        if (answers && answered < answers.length && stderr.slice(cursor).includes(answers[answered][0])) {
          cursor = stderr.length;
          child.stdin.write(answers[answered++][1] + '\n');
        }
      });
      const timer = setTimeout(() => child.kill(), 5000);
      try {
        const code = await new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('close', resolve);
        });
        assert.ok(!stdout.includes('synthetic-account-token'));
        assert.ok(!stderr.includes('synthetic-account-token'));
        if (answers) assert.equal(answered, answers.length, stderr);
        return { code, stdout, value: answers ? undefined : JSON.parse(stdout), stderr };
      } finally { clearTimeout(timer); }
    },
  };
}

for (const scenario of [
  { name: 'missing issued key identity', status: 200, body: { endpoint: 'https://api.example.com', project: 'first', credentials: { api_key: 'synthetic-issued-secret', key: {} } }, exit: 5 },
  { name: 'invalid issued endpoint', status: 200, body: { endpoint: 'https://invalid.example/path', project: 'first', credentials: { api_key: 'synthetic-issued-secret', key: { key_id: 'key-id' } } }, exit: 5 },
  { name: 'HTTP 408', status: 408, body: { error: 'project_request_rejected' }, exit: 5 },
  { name: 'claimed issuance', status: 409, body: { error: 'issuance_unconfirmed' }, exit: 5 },
  { name: 'definite forbidden rejection', status: 403, body: { error: 'project_not_ready_or_forbidden' }, exit: 3 },
  { name: 'definite rate-limit rejection', status: 429, body: { error: 'rate_limited' }, exit: 3 },
]) {
  test(`actual CLI: ${scenario.name} preserves pending identity without automatic reissuance`, async (t) => {
    const fixture = await cliFixture(t, (call, res) => {
      if (call.path.endsWith('/projects')) return res.end(JSON.stringify({ projects: [{ id: first, name: 'first', status: 'ACTIVE', organization_id: org }] }));
      if (call.path.endsWith('/organizations')) return res.end(JSON.stringify({ organizations: [{ id: org, name: 'Team', role: 'owner', plan: 'Free', max_projects: 1, projects_count: 1 }] }));
      assert.equal(call.path, '/auth/cli/connect');
      res.statusCode = scenario.status;
      res.end(JSON.stringify(scenario.body));
    });
    const args = ['projects', 'use', '--org-id', org, '--project-id', first];
    const result = await fixture.run([...args, '--issue-key']);
    assert.equal(result.code, scenario.exit);
    assert.equal(result.value.data?.state, scenario.exit === 5 ? 'unknown' : undefined);
    assert.notEqual(result.value.error.code, 'INPUT_ERROR');
    assert.ok(!JSON.stringify(result).includes('synthetic-issued-secret'));
    const path = `${fixture.config}.connections.json`;
    const before = await readFile(path, 'utf8');
    const pending = JSON.parse(before)[0].pendingKeyName;
    assert.equal(pending, `lambdadb-cli-${fixture.calls.find((c) => c.path.endsWith('/connect')).body.request_id}`);
    assert.equal(JSON.parse(before)[0].settings, undefined);
    assert.ok(!before.includes('synthetic-issued-secret'));
    const rerun = await fixture.run(args);
    assert.equal(rerun.code, 2);
    assert.match(rerun.value.error.message, /Inspect\/revoke lambdadb-cli-/);
    assert.equal(await readFile(path, 'utf8'), before);
    assert.equal(fixture.calls.filter((c) => c.path.endsWith('/connect')).length, 1);
  });
}

for (const mode of ['flag', 'environment', 'flag overrides environment']) {
  test(`actual CLI: management timeout from ${mode} covers response bodies`, async (t) => {
    const fixture = await cliFixture(t, async (_call, res) => {
      res.write('{"regions":');
      await new Promise((resolve) => setTimeout(resolve, 700));
      res.end('[]}');
    });
    const args = ['projects', 'regions'];
    if (mode !== 'environment') args.push('--timeout-ms', mode === 'flag' ? '200' : '2000');
    const result = await fixture.run(args, mode === 'flag' ? {} : { LAMBDADB_TIMEOUT_MS: '200' });
    assert.equal(result.code, mode === 'flag overrides environment' ? 0 : 3);
    assert.equal(fixture.calls.length, 1);
  });
}

for (const args of [['orgs', 'list'], ['login', '--no-browser'], ['logout']]) {
  test(`actual CLI: ${args[0]} validates timeout before network or credential access`, async (t) => {
    const fixture = await cliFixture(t, () => assert.fail('invalid input must not send a request'));
    for (const [flags, env] of [[['--timeout-ms', '0'], {}], [[], { LAMBDADB_TIMEOUT_MS: 'invalid' }]]) {
      const result = await fixture.run([...args, ...flags], env);
      assert.equal(result.code, 2);
      assert.match(result.value.error.message, /Timeout must be an integer/);
    }
    assert.equal(fixture.calls.length, 0);
  });
}

for (const command of [['login', '--no-browser'], ['logout']]) {
  test(`actual CLI: ${command[0]} honors per-request timeout without retries`, async (t) => {
    const fixture = await cliFixture(t, async (_call, res) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      res.end('{}');
    });
    const result = await fixture.run([...command, '--timeout-ms', '200']);
    assert.equal(result.code, command[0] === 'login' ? 2 : 5);
    assert.equal(fixture.calls.length, 1);
    if (command[0] === 'logout') {
      assert.equal(result.value.data.state, 'unknown');
      assert.ok(await readFile(`${fixture.config}.account.json`, 'utf8'));
    }
  });
}

test('actual CLI: sequential management requests each receive a fresh timeout budget', async (t) => {
  const fixture = await cliFixture(t, async (call, res) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (call.path.endsWith('/projects')) return res.end(JSON.stringify({ projects: [{ id: first, name: 'first', status: 'ACTIVE', organization_id: org }] }));
    assert.ok(call.path.endsWith('/organizations'));
    res.end(JSON.stringify({ organizations: [{ id: org, name: 'Team', role: 'owner', plan: 'Free', max_projects: 1, projects_count: 1 }] }));
  });
  const result = await fixture.run(['projects', 'use', '--org-id', org, '--project-id', first, '--timeout-ms', '500']);
  assert.equal(result.code, 2);
  assert.match(result.value.error.message, /--issue-key/);
  assert.equal(fixture.calls.length, 2);
});


for (const scenario of [
  { status: 401, body: '', exit: 0 },
  { status: 403, body: '<html>Forbidden</html>', exit: 3 },
  { status: 429, body: 'Too many requests', exit: 3 },
  { status: 408, body: '', exit: 5 },
  { status: 200, body: 'invalid response', exit: 5 },
]) {
  test(`actual CLI: logout preserves HTTP ${scenario.status} semantics without JSON`, async (t) => {
    const fixture = await cliFixture(t, (call, res) => {
      assert.equal(call.path, '/auth/cli/logout');
      res.statusCode = scenario.status;
      res.end(scenario.body);
    });
    const result = await fixture.run(['logout']);
    assert.equal(result.code, scenario.exit);
    if (scenario.exit) {
      assert.equal(result.value.error.httpStatus, scenario.status);
      assert.equal(result.value.data?.state, scenario.exit === 5 ? 'unknown' : undefined);
      assert.ok(await readFile(`${fixture.config}.account.json`, 'utf8'));
    } else {
      assert.equal(result.value.data.loggedOut, true);
      await assert.rejects(readFile(`${fixture.config}.account.json`), { code: 'ENOENT' });
    }
    assert.equal(fixture.calls.length, 1);
  });
}

test('actual CLI: a bodyless connect conflict retains uncertain issuance', async (t) => {
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path.endsWith('/projects')) return res.end(JSON.stringify({ projects: [{ id: first, name: 'first', status: 'ACTIVE', organization_id: org }] }));
    if (call.path.endsWith('/organizations')) return res.end(JSON.stringify({ organizations: [{ id: org, name: 'Team', role: 'owner', plan: 'Free', max_projects: 1, projects_count: 1 }] }));
    assert.equal(call.path, '/auth/cli/connect');
    res.statusCode = 409;
    res.end();
  });
  const result = await fixture.run(['projects', 'use', '--org-id', org, '--project-id', first, '--issue-key']);
  assert.equal(result.code, 5);
  assert.equal(result.value.data.state, 'unknown');
  assert.equal(result.value.error.httpStatus, 409);
  assert.ok(JSON.parse(await readFile(`${fixture.config}.connections.json`, 'utf8'))[0].pendingKeyName);
  assert.equal(fixture.calls.filter((c) => c.path.endsWith('/connect')).length, 1);
});

test('actual CLI: plain init enters account project setup and reuses a valid login', async t => {
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path.endsWith('/organizations')) return res.end(JSON.stringify({ organizations: [{ id: org, name: 'Team', role: 'owner', plan: 'Free', max_projects: 1, projects_count: 0 }] }));
    assert.ok(call.path.endsWith('/projects'));
    res.end(JSON.stringify({ projects: [] }));
  });
  const result = await fixture.run(['init', '--no-browser'], {}, [
    ['Choose a number', '1'], ['Project\n1. Create a new project', '2'],
  ]);
  assert.equal(result.code, 2);
  assert.deepEqual(fixture.calls.map(c => c.path), ['/auth/cli/organizations', '/auth/cli/projects']);
  await assert.rejects(readFile(fixture.config), { code: 'ENOENT' });
});

test('actual CLI: login only saves account access and guides explicit next commands', async t => {
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path === '/auth/device/login') return res.end(JSON.stringify({ device_code: 'c'.repeat(64), user_code: 'ABCDE-FG234', verification_uri: 'https://console.example.com/auth/cli', expires_in: 15, interval: 1 }));
    assert.equal(call.path, '/auth/device/token');
    res.end(JSON.stringify({ account: { session_token: 'b'.repeat(64), member_id: first, email: 'synthetic@example.com', expires_at: new Date(Date.now() + 3600000).toISOString(), console_url: 'https://console.example.com' } }));
  }, true);
  await rm(`${fixture.config}.account.json`);
  const result = await fixture.run(['login', '--no-browser', '--api-url', fixture.url]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /lambdadb init for guided project and agent setup/);
  assert.match(result.stderr, /lambdadb orgs list/);
  assert.equal(fixture.calls.length, 2);
  assert.ok(!result.stderr.includes('b'.repeat(64)));
  await assert.rejects(readFile(fixture.config), { code: 'ENOENT' });
});

test('actual CLI: Org UUID selectors use --org-id for project listing and creation', async t => {
  const fixture = await cliFixture(t, (call, res) => {
    assert.equal(call.path, '/auth/cli/projects');
    assert.equal(call.orgId, org);
    if (call.method === 'GET') return res.end(JSON.stringify({ projects: [{ id: first, organization_id: org, name: 'demo', status: 'ACTIVE' }] }));
    assert.equal(call.method, 'POST');
    assert.deepEqual(call.body, { name: 'demo', cloud_provider: 'aws', region: 'ap-northeast-2', default_organization: false });
    res.end(JSON.stringify({ id: first, organization_id: org, status: 'CREATING' }));
  });
  assert.equal((await fixture.run(['projects', 'list', '--org-id', org])).code, 0);
  assert.equal((await fixture.run(['projects', 'create', '--org-id', org, '--name', 'demo', '--region', 'ap-northeast-2'])).code, 0);
  assert.equal(fixture.calls.length, 2);
  for (const flags of [
    ['projects', 'list', '--org', org],
    ['projects', 'create', '--org-id', org, '--default-org', '--name', 'demo', '--region', 'ap-northeast-2'],
  ]) assert.equal((await fixture.run(flags)).code, 2);
  assert.equal(fixture.calls.length, 2);
});

test('guided init selects an existing project at its limit without a billing detour or duplicate questions', async t => {
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path.endsWith('/organizations')) return res.end(JSON.stringify({ organizations: [{ id: org, name: 'Team', role: 'owner', plan: 'Free', max_projects: 1, projects_count: 1 }] }));
    if (call.path.endsWith('/projects')) return res.end(JSON.stringify({ projects: [{ id: first, name: 'first', status: 'ACTIVE', organization_id: org }] }));
    if (call.path === '/auth/cli/connect') return res.end(JSON.stringify({ endpoint: fixture.url, project: 'first', credentials: { api_key: 'synthetic-issued-secret', key: { key_id: 'key-id' } } }));
    assert.equal(call.path, '/projects/first/collections?size=1');
    res.end(JSON.stringify({ collections: [] }));
  }, true);
  const result = await fixture.run(['init', '--agents', 'none', '--no-browser'], {}, [
    ['Choose a number', '1'], ['Project\n1. first (ACTIVE)', '1'],
    ['Create a key for first', 'yes'], ['Apply these changes', 'yes'],
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Organization: Team/);
  assert.doesNotMatch(result.stderr, /Continue with account|Enter use|Project limit reached|rerun init to update|Enable MCP write tools\?/);
  assert.match(result.stdout, /Connected to first/);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-issued-secret/);
  assert.equal(fixture.calls.filter(c => c.path === '/auth/cli/connect').length, 1);
  assert.equal(fixture.calls.filter(c => c.method !== 'GET').length, 1);
  const rerun = await fixture.run(['init', '--agents', 'none'], {}, [
    ['Choose a number', '1'], ['Apply these changes', 'yes'],
  ]);
  assert.equal(rerun.code, 0, rerun.stderr);
  assert.equal(fixture.calls.filter(c => c.path === '/auth/cli/connect').length, 1);
});

test('guided init still requires explicit new-key approval', async t => {
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path.endsWith('/organizations')) return res.end(JSON.stringify({ organizations: [{ id: org, name: 'Team', role: 'owner', plan: 'Free', max_projects: 1, projects_count: 1 }] }));
    assert.ok(call.path.endsWith('/projects'));
    res.end(JSON.stringify({ projects: [{ id: first, name: 'first', status: 'ACTIVE', organization_id: org }] }));
  });
  const result = await fixture.run(['init', '--agents', 'none'], {}, [
    ['Choose a number', '1'], ['Project\n1. first (ACTIVE)', '1'], ['Create a key for first', ''],
  ]);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(fixture.calls.filter(c => c.method !== 'GET').length, 0);
  await assert.rejects(readFile(fixture.config), { code: 'ENOENT' });
});

test('guided creation at the project limit offers billing without creating a project or key', async t => {
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path.endsWith('/organizations')) return res.end(JSON.stringify({ organizations: [{ id: org, name: 'Team', role: 'owner', plan: 'Free', max_projects: 1, projects_count: 1 }] }));
    assert.ok(call.path.endsWith('/projects'));
    res.end(JSON.stringify({ projects: [{ id: first, name: 'first', status: 'ACTIVE', organization_id: org }] }));
  });
  const result = await fixture.run(['init', '--agents', 'none', '--no-browser'], {}, [
    ['Choose a number', '1'], ['Project\n1. first (ACTIVE)', '2'],
    ['Open billing in your browser?', 'no'], ['After billing is updated', 'cancel'],
  ]);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, new RegExp(`/organization/billing/open\\?org_id=${org}`));
  assert.equal(fixture.calls.filter(c => c.method !== 'GET').length, 0);
  await assert.rejects(readFile(fixture.config), { code: 'ENOENT' });
});

test('guided project creation from the combined menu still requires explicit approval', async t => {
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path.endsWith('/organizations')) return res.end(JSON.stringify({ organizations: [] }));
    assert.equal(call.path, '/auth/cli/regions');
    res.end(JSON.stringify({ regions: [{ region: 'ap-northeast-2', name: 'Seoul', is_open: true, cloud_provider: 'aws' }] }));
  });
  const result = await fixture.run(['init', '--agents', 'none'], {}, [
    ['Choose a number', '1'], ['Project\n1. Create a new project', '1'],
    ['Region\n1. Seoul', '1'], ['Project name', 'example'], ['Create this project?', 'no'],
  ]);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /No project was requested/);
  assert.equal(fixture.calls.filter(c => c.method !== 'GET').length, 0);
  await assert.rejects(readFile(fixture.config), { code: 'ENOENT' });
});
