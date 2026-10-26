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
  ['projects', 'use', '--org', org],
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
