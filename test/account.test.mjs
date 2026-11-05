import { stripVTControlCharacters } from 'node:util';
import { terminalInput, keys, enter, down, up, left, cancel } from './terminal-input.mjs';
import { oauthServer, session, consoleUrl } from './helpers/oauth-server.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, rm, symlink, lstat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
const bin = process.env.LAMBDADB_TEST_CLI ?? resolve('dist/cli.js');
const moduleURL = (name) => pathToFileURL(join(dirname(bin), name)).href;
const { login, logout, loadAccount, accountRequest, parseOrganization, accountPath, management } = await import(
  moduleURL('account.js')
);
const { useProject, organizations, createProject } = await import(moduleURL('projects.js'));
const { CredentialVault } = await import(moduleURL('credentials.js'));
const { ManagementError, describeError } = await import(moduleURL('errors.js'));
const { formatLogin, formatLogout, formatOrganizations, formatProjects, formatRegions, formatCreated, formatUse } = await import(moduleURL('account-ui.js'));
const { defaultConfigPath } = await import(moduleURL('config.js'));
const quiet = { diagnostic() {}, protect() {} };
const org = '11111111-1111-4111-8111-111111111111';
const first = '22222222-2222-4222-8222-222222222222';
const second = '33333333-3333-4333-8333-333333333333';
const connection = '55555555-5555-4555-8555-555555555555';
const team = (overrides = {}) => ({ id: org, name: 'Team', role: 'owner', status: 'active', max_projects: 1, projects_count: 1, ...overrides });
const account = () => ({
  apiUrl: 'https://api.example.com',
  consoleUrl,
  issuer: 'https://auth.example.com/',
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
  return oauthServer(t, async (call, res) => {
    await handler(call, res);
    return true;
  });
}
/** Saves an OAuth login for fixture and routes the OS store to memory for this test. */
async function signedIn(t, fixture, saved = session()) {
  const { config } = await directory(t);
  const a = { ...account(), apiUrl: fixture.url, issuer: fixture.issuer, memberId: fixture.state.memberId };
  await writeFile(await accountPath({ config }), JSON.stringify(a));
  const store = new Map([[a.credentialId, saved]]);
  const proto = CredentialVault.prototype;
  const original = { read: proto.read, save: proto.save, remove: proto.remove, select: proto.select };
  proto.read = async (ref) => {
    if (!store.has(ref.credentialId)) throw new Error('locked');
    return store.get(ref.credentialId);
  };
  proto.save = async (ref, value) => void store.set(ref.credentialId, value);
  proto.remove = async (ref) => void store.delete(ref.credentialId);
  proto.select = async () => 'keychain';
  t.after(() => Object.assign(proto, original));
  return { config, account: a, store };
}
const domain = (handler) => (call, res) => {
  if (/^\/(\.well-known|oauth2)\//.test(call.path) || call.path === '/members/me') return false;
  if (call.path.startsWith('/subscriptions/')) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'subscription not found' }));
    return true;
  }
  return handler(call, res) ?? true;
};

test('account login saves only metadata, replaces and revokes the previous grant, and logout preserves project settings', async (t) => {
  const { config } = await directory(t),
    vault = memory();
  const previous = '{"project":"keep"}\n';
  await writeFile(config, previous);
  const fixture = await oauthServer(t);
  const options = { config, apiUrl: fixture.url, browser: false };
  const firstLogin = await login(options, quiet, vault);
  assert.equal(firstLogin.memberId, fixture.state.memberId);
  assert.equal(firstLogin.issuer, fixture.issuer);
  assert.equal(firstLogin.consoleUrl, consoleUrl);
  const content = await readFile(await accountPath(options), 'utf8');
  const saved = JSON.parse(vault.saved.get(firstLogin.credentialId));
  assert.ok(saved.refresh_token && saved.access_token);
  assert.ok(!content.includes(saved.refresh_token) && !content.includes(saved.access_token));
  const nextLogin = await login({ config, browser: false }, quiet, vault);
  assert.equal(nextLogin.apiUrl, fixture.url, 'renewal must retain the selected account server');
  assert.notEqual(nextLogin.credentialId, firstLogin.credentialId);
  assert.equal(vault.saved.size, 1);
  assert.equal(fixture.state.revoked[0].token, saved.refresh_token);
  assert.equal(await logout(options, quiet, vault).then((r) => r.remoteRevoked), true);
  assert.equal(vault.saved.size, 0);
  assert.equal(fixture.state.revoked.length, 2);
  assert.equal(await readFile(config, 'utf8'), previous);
  await assert.rejects(loadAccount(options), /login first/);
});

test('login names the API origin before authorization, and how to leave a reused non-default origin', async (t) => {
  const recorder = () => {
    const messages = [];
    return { messages, diagnostic: (m) => messages.push(m), protect() {} };
  };
  const fixture = await oauthServer(t);
  const { config } = await directory(t),
    vault = memory();
  let output = recorder();
  await login({ config, apiUrl: fixture.url, browser: false }, output, vault);
  assert.equal(output.messages[0], `Signing in to ${fixture.url}`);
  // The reported upgrade: an old-format login pointing at another environment.
  const { issuer: _, ...legacy } = { ...account(), apiUrl: fixture.url };
  vault.saved.set(legacy.credentialId, 'b'.repeat(64));
  await writeFile(await accountPath({ config }), JSON.stringify(legacy));
  output = recorder();
  const reused = await login({ config, browser: false }, output, vault);
  assert.equal(reused.apiUrl, fixture.url);
  assert.match(
    output.messages[0],
    new RegExp(`^Signing in to ${fixture.url.replaceAll('.', '\\.')}, saved by your last login\\.\\nFor production, run \\S+ logout first or pass --api-url https://api\\.lambdadb\\.ai\\.$`),
  );
  const link = output.messages.findIndex((m) => m.startsWith(`Open this link on any device:\n${fixture.issuer.replace(/\/$/, '')}/`));
  assert.ok(link > 0, output.messages.join('\n'));

  // The default and a saved production origin are named without a change hint.
  // An aborted signal stops discovery before any request leaves this process.
  for (const saved of [undefined, 'https://api.lambdadb.ai']) {
    const { config: fresh } = await directory(t);
    if (saved) await writeFile(await accountPath({ config: fresh }), JSON.stringify({ ...legacy, apiUrl: saved }));
    output = recorder();
    await assert.rejects(login({ config: fresh, browser: false, signal: AbortSignal.abort() }, output, memory()), /Cannot reach https:\/\/api\.lambdadb\.ai/);
    assert.equal(output.messages[0], 'Signing in to https://api.lambdadb.ai');
  }
});

test('a login that cannot identify its member saves nothing and revokes the new grant', async (t) => {
  const { config } = await directory(t),
    vault = memory();
  const fixture = await oauthServer(t, (call, res) => {
    if (call.path !== '/members/me') return false;
    res.statusCode = 403;
    res.end(JSON.stringify({ error: 'access_denied' }));
    return true;
  });
  await assert.rejects(login({ config, apiUrl: fixture.url, browser: false }, quiet, vault), /access_denied/);
  assert.equal(vault.saved.size, 0);
  assert.equal(fixture.state.revoked.length, 1);
  await assert.rejects(readFile(await accountPath({ config })), { code: 'ENOENT' });
});

test('account metadata rejects secrets, expiry, API origin changes and the old login format before credential access', async (t) => {
  const { config } = await directory(t),
    a = account();
  const path = await accountPath({ config });
  await writeFile(path, JSON.stringify(a));
  await assert.rejects(loadAccount({ config, apiUrl: 'https://other.example.com' }), /different API origin/);
  await writeFile(path, JSON.stringify({ ...a, session_token: 'never-persist' }));
  await assert.rejects(loadAccount({ config }), /Invalid account metadata/);
  await writeFile(path, JSON.stringify({ ...a, expiresAt: '2020-01-01T00:00:00Z' }));
  await assert.rejects(loadAccount({ config }), /expired/);
  const { issuer: _, ...legacy } = a;
  await writeFile(path, JSON.stringify(legacy));
  await assert.rejects(loadAccount({ config }), /now uses LambdaDB OAuth/);
});

test('logout removes an old-format login locally without contacting the server', async (t) => {
  const { config } = await directory(t),
    vault = memory();
  const { issuer: _, ...legacy } = account();
  vault.saved.set(legacy.credentialId, 'b'.repeat(64));
  await writeFile(await accountPath({ config }), JSON.stringify(legacy));
  assert.deepEqual(await logout({ config }, quiet, vault), { remoteRevoked: false, apiUrl: legacy.apiUrl });
  assert.equal(vault.saved.size, 0);
  await assert.rejects(readFile(await accountPath({ config })), { code: 'ENOENT' });
});

test('an expired access token is renewed once, rotated into a fresh OS-store slot and reused', async (t) => {
  const fixture = await oauthServer(t, domain((call, res) => {
    res.end(JSON.stringify({ organizations: [team()] }));
  }));
  const refreshToken = 'refresh-known-0000000000';
  fixture.state.refresh.set(refreshToken, 'account:manage offline_access');
  const { config, account: before, store } = await signedIn(t, fixture, session({ refresh_token: refreshToken, access_expires_at: Date.now() - 1 }));
  assert.equal((await organizations({ config }, quiet))[0].plan, 'Free');
  const after = JSON.parse(await readFile(await accountPath({ config }), 'utf8'));
  assert.notEqual(after.credentialId, before.credentialId);
  assert.deepEqual([...store.keys()], [after.credentialId]);
  const rotated = JSON.parse(store.get(after.credentialId));
  assert.notEqual(rotated.refresh_token, refreshToken);
  await organizations({ config }, quiet);
  const refreshes = fixture.calls.filter((c) => c.path === '/oauth2/token');
  assert.equal(refreshes.length, 1);
  const used = fixture.calls.filter((c) => c.path === '/organizations').map((c) => c.auth);
  assert.deepEqual(used, [`Bearer ${rotated.access_token}`, `Bearer ${rotated.access_token}`]);
});

test('a command that read the login just before another command rotated it uses the replacement session', async (t) => {
  const fixture = await oauthServer(t, domain((call, res) => {
    res.end(JSON.stringify({ organizations: [] }));
  }));
  const { config, account: before, store } = await signedIn(t, fixture);
  const replacement = { ...before, credentialId: randomUUID() };
  const rotated = session({ access_token: 'access-rotated-elsewhere-000' });
  const read = CredentialVault.prototype.read;
  let raced = false;
  // The other command finishes its rotation between this command's metadata and slot reads.
  CredentialVault.prototype.read = async function (ref) {
    if (!raced && ref.credentialId === before.credentialId) {
      raced = true;
      store.set(replacement.credentialId, rotated);
      await writeFile(await accountPath({ config }), JSON.stringify(replacement));
      store.delete(before.credentialId);
    }
    return read.call(this, ref);
  };
  assert.deepEqual(await organizations({ config }, quiet), []);
  assert.ok(raced);
  assert.equal(fixture.calls.find((c) => c.path === '/organizations').auth, 'Bearer access-rotated-elsewhere-000');
  assert.equal(fixture.calls.filter((c) => c.path === '/oauth2/token').length, 0);
});

test('renewal waits for a live refresh lock, clears only a lock without heartbeat, and never removes another owner\'s lock', async (t) => {
  let replaceLockDuringRefresh = false;
  let lock;
  const fixture = await oauthServer(t, async (call, res) => {
    if (call.path === '/oauth2/token' && replaceLockDuringRefresh) await writeFile(lock, 'other-owner');
    return domain((c, r) => r.end(JSON.stringify({ organizations: [] })))(call, res);
  });
  const known = ['refresh-a-0000000000000', 'refresh-b-0000000000000', 'refresh-c-0000000000000'];
  for (const token of known) fixture.state.refresh.set(token, 'account:manage offline_access');
  const expired = (refresh_token) => session({ refresh_token, access_expires_at: Date.now() - 1 });
  const { config, store } = await signedIn(t, fixture, expired(known[0]));
  lock = `${await accountPath({ config })}`.replace(/\.account\.json$/, '.account.lock');

  // A live holder delays renewal until it releases the lock.
  await writeFile(lock, 'live-owner');
  setTimeout(() => rm(lock, { force: true }), 600);
  const started = Date.now();
  await organizations({ config }, quiet);
  assert.ok(Date.now() - started >= 500, 'renewal must wait for a live lock');

  // A lock whose heartbeat stopped (a killed process) is cleared.
  const stale = (await import('node:fs/promises')).stat;
  const saved = JSON.parse(await readFile(await accountPath({ config }), 'utf8'));
  store.set(saved.credentialId, expired(known[1]));
  await writeFile(lock, 'killed-owner');
  const past = new Date(Date.now() - 60_000);
  await utimes(lock, past, past);
  await organizations({ config }, quiet);
  await assert.rejects(stale(lock), { code: 'ENOENT' });

  // A lock replaced by another owner while renewing is left in place.
  const latest = JSON.parse(await readFile(await accountPath({ config }), 'utf8'));
  store.set(latest.credentialId, expired(known[2]));
  replaceLockDuringRefresh = true;
  await organizations({ config }, quiet);
  assert.equal(await readFile(lock, 'utf8'), 'other-owner');
  assert.equal(fixture.calls.filter((c) => c.path === '/oauth2/token').length, 3);
});

test('a rejected access token is renewed and the request retried once; a revoked login requires login again', async (t) => {
  let rejections = 1;
  const fixture = await oauthServer(t, domain((call, res) => {
    if (rejections-- > 0) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: 'invalid_token' }));
    }
    res.end(JSON.stringify({ organizations: [] }));
  }));
  const refreshToken = 'refresh-known-1111111111';
  fixture.state.refresh.set(refreshToken, 'account:manage offline_access');
  const { config } = await signedIn(t, fixture, session({ refresh_token: refreshToken }));
  assert.deepEqual(await organizations({ config }, quiet), []);
  assert.equal(fixture.calls.filter((c) => c.path === '/organizations').length, 2);
  rejections = 1;
  fixture.state.refresh.clear();
  await assert.rejects(organizations({ config }, quiet), /login expired or was revoked/);
});

test('an unanswered refresh ends the saved login instead of replaying the refresh token', async (t) => {
  const fixture = await oauthServer(t, (call, res) => {
    if (call.path !== '/oauth2/token') return false;
    res.socket.destroy(); // The provider may have rotated the token, but the answer is lost.
    return true;
  });
  const { config } = await signedIn(t, fixture, session({ access_expires_at: Date.now() - 1 }));
  await assert.rejects(organizations({ config }, quiet), /may have changed\. Run login again/);
  await assert.rejects(organizations({ config }, quiet), /CLI login expired/);
  assert.equal(fixture.calls.filter((c) => c.path === '/oauth2/token').length, 1);
});

test('a command loaded before another command\'s failed renewal does not replay the refresh token', async (t) => {
  const fixture = await oauthServer(t, (call, res) => {
    if (call.path !== '/oauth2/token') return false;
    res.socket.destroy();
    return true;
  });
  const { config } = await signedIn(t, fixture, session({ access_expires_at: Date.now() - 1 }));
  const [firstCommand, secondCommand] = [await management({ config }, quiet), await management({ config }, quiet)];
  await assert.rejects(firstCommand.request('organizations'), /may have changed/);
  await assert.rejects(secondCommand.request('organizations'), /CLI login expired/);
  assert.equal(fixture.calls.filter((c) => c.path === '/oauth2/token').length, 1);
});

test('a rotated session that cannot be saved ends the saved login', async (t) => {
  const fixture = await oauthServer(t, domain((call, res) => res.end(JSON.stringify({ organizations: [] }))));
  const refreshToken = 'refresh-known-2222222222';
  fixture.state.refresh.set(refreshToken, 'account:manage offline_access');
  const { config, account: before } = await signedIn(t, fixture, session({ refresh_token: refreshToken, access_expires_at: Date.now() - 1 }));
  // Restore before signedIn's own cleanup so the patch never leaks into later tests.
  const save = CredentialVault.prototype.save;
  CredentialVault.prototype.save = async () => { throw new Error('store locked'); };
  try {
    await assert.rejects(organizations({ config }, quiet), /store locked/);
  } finally {
    CredentialVault.prototype.save = save;
  }
  const after = JSON.parse(await readFile(await accountPath({ config }), 'utf8'));
  assert.equal(after.credentialId, before.credentialId);
  await assert.rejects(organizations({ config }, quiet), /CLI login expired/);
  assert.equal(fixture.calls.filter((c) => c.path === '/oauth2/token').length, 1);
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

function projectClient(a, onIssue = async () => {}) {
  const calls = [];
  return {
    calls,
    account: a,
    role: 'owner',
    async request(path, method, body) {
      calls.push({ path, method, body });
      if (path === 'organizations') return { organizations: [team({ role: this.role })] };
      if (path.startsWith('subscriptions/')) throw new ManagementError('management_request_failed', 404);
      assert.equal(path, 'projects');
      return {
        projects: [first, second].map((id, i) => ({
          id,
          organization_id: org,
          name: `project-${i}`,
          status: 'ACTIVE',
        })),
      };
    },
    async issueKey({ projectId, recoveryId, onConnection }) {
      calls.push({ path: 'connect', body: { projectId, recoveryId } });
      const id = randomUUID();
      await onConnection(id);
      await onIssue();
      return {
        connection_id: id,
        endpoint: 'https://project.example.com',
        project_id: projectId,
        project_name: `project-${projectId === first ? 0 : 1}`,
        key_id: 'key-id',
        api_key: `synthetic-${projectId}`,
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
  assert.match(selected.credentialKeyName, /^lambdadb-connection-[0-9a-f-]{36}$/);
  assert.equal(api.calls.filter((c) => c.path === 'connect').length, 2);
  assert.equal(await readFile(agent, 'utf8'), '{"mcpServers":{"pinned":"keep"}}');
  const cache = await readFile(`${config}.connections.json`, 'utf8');
  assert.ok(!cache.includes('synthetic-') && !cache.includes('pendingConnectionId'));
  assert.equal(vault.saved.size, 2);
});

test('uncertain issuance records the connection for recovery and rerun never silently issues another key', async (t) => {
  const { config } = await directory(t),
    vault = memory();
  const api = projectClient(account(), async () => {
    throw new ManagementError('issuance_unconfirmed', 409);
  });
  await assert.rejects(useProject({ config }, org, first, true, quiet, vault, api), /issuance_unconfirmed/);
  await assert.rejects(
    useProject({ config }, org, first, false, quiet, vault, api),
    /Inspect\/revoke lambdadb-connection-/,
  );
  assert.equal(api.calls.filter((c) => c.path === 'connect').length, 1);
  assert.equal(vault.saved.size, 0);
  const pending = JSON.parse(await readFile(`${config}.connections.json`, 'utf8'))[0];
  assert.equal(pending.pendingKeyName, `lambdadb-connection-${pending.pendingConnectionId}`);
  // An explicit replacement names the uncertain attempt so Console can offer its exact key.
  await assert.rejects(useProject({ config }, org, first, true, quiet, vault, api), /issuance_unconfirmed/);
  assert.equal(api.calls.filter((c) => c.path === 'connect')[1].body.recoveryId, pending.pendingConnectionId);
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

test('a full Organization reports its limit with only safe metadata and a trusted billing link', async (t) => {
  const fixture = await oauthServer(t, domain((call, res) => {
    if (call.method === 'GET') return res.end(JSON.stringify({ organizations: [team({ role: 'admin', billing_url: 'https://attacker.invalid', secret: 'hidden' })] }));
    res.statusCode = 403;
    res.end(JSON.stringify({ error: 'free tier project limit reached (max 1)', secret: 'hidden' }));
  }));
  const { config } = await signedIn(t, fixture);
  let failure;
  try {
    await createProject({ config }, { orgId: org, name: 'demo', region: 'ap-northeast-2' }, quiet);
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, 'project_limit_reached');
  assert.equal(failure.details.organization.can_upgrade, false);
  assert.equal(failure.details.organization.billing_url, `${consoleUrl}/organization/billing/open?org_id=${org}`);
  assert.match(describeError(failure).hint, /org_id=/);
  assert.ok(!JSON.stringify(failure).includes('hidden'));
  assert.equal(parseOrganization(failure.details.organization, { consoleUrl }).max_projects, 1);
  const post = fixture.calls.find((c) => c.method === 'POST' && c.path === '/projects');
  assert.deepEqual(post.body, { name: 'demo', cloud_provider: 'aws', region: 'ap-northeast-2' });
  assert.equal(post.orgId, org);
});

test('management write failures are uncertain and never automatically retried', async (t) => {
  const fixture = await server(t, (_call, res) => {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'project_request_rejected', secret: 'hidden' }));
  });
  await assert.rejects(
    accountRequest({ ...account(), apiUrl: fixture.url }, 'token', 'projects', 'POST', {}),
    (e) => e.code === 'write_outcome_unknown' && e.details.request === 'POST projects'
      && describeError(e).message === 'Account management request failed: write_outcome_unknown (HTTP 500) during POST projects.',
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

test('key issuance creates a project connection, approves it separately and discards the setup token', async (t) => {
  const fixture = await oauthServer(t, domain((call, res) => {
    if (call.path === '/organizations') return res.end(JSON.stringify({ organizations: [team()] }));
    if (call.path === '/projects') return res.end(JSON.stringify({ projects: [{ id: first, name: 'first', status: 'ACTIVE', organization_id: org }] }));
    if (call.path === '/project-connections') {
      assert.equal(call.auth, undefined);
      res.statusCode = 201;
      return res.end(JSON.stringify({ connection_id: connection, expires_at: new Date(Date.now() + 900_000).toISOString() }));
    }
    assert.equal(call.path, `/project-connections/${connection}/key`);
    res.statusCode = 201;
    res.end(JSON.stringify({ connection_id: connection, endpoint: 'https://project.example.com', project_id: first, project_name: 'first', key_id: 'key-1', api_key: 'synthetic-issued-secret' }));
  }));
  const { config } = await signedIn(t, fixture);
  const vault = memory();
  const options = { config, browser: false };
  const selected = await useProject(options, org, first, true, quiet, vault, await management(options, quiet));
  assert.equal(selected.credentialKeyName, `lambdadb-connection-${connection}`);
  assert.equal(selected.credentialKeyId, 'key-1');
  assert.equal(vault.saved.get(selected.credentialId), 'synthetic-issued-secret');
  assert.deepEqual(fixture.calls.find((c) => c.path === '/project-connections').body, { client_id: 'lambdadb-cli', project_id: first });
  const start = fixture.calls.find((c) => c.path === '/oauth2/device/auth').body;
  assert.equal(start.scope, 'connection:read connection:issue');
  assert.equal(start.connection_id, connection);
  const key = fixture.calls.find((c) => c.path.endsWith('/key'));
  assert.equal(key.body, undefined, 'the issuance claim must have an empty body');
  assert.match(key.auth, /^Bearer access-/);
  assert.equal(fixture.state.revoked.at(-1).token, key.auth.slice(7));
  assert.equal(fixture.state.revoked.at(-1).token_type_hint, 'access_token');
});

// Run the real CLI and HTTP client; only OS credential access is simulated.
async function cliFixture(t, handler, saveAllowed = false) {
  const { dir, config } = await directory(t);
  const fixture = await oauthServer(t, (call, res) => {
    if (/^\/(\.well-known|oauth2)\//.test(call.path) || call.path === '/members/me') return false;
    if (call.path.startsWith('/subscriptions/')) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'subscription not found' }));
      return true;
    }
    if (call.path === '/project-connections' && call.method === 'POST') {
      res.statusCode = 201;
      res.end(JSON.stringify({ connection_id: connection, expires_at: new Date(Date.now() + 900_000).toISOString() }));
      return true;
    }
    return Promise.resolve(handler(call, res)).then(() => true);
  });
  await writeFile(`${config}.account.json`, JSON.stringify({ ...account(), apiUrl: fixture.url, issuer: fixture.issuer }));
  const saved = session({ access_token: 'synthetic-account-token', refresh_token: 'synthetic-refresh-token' });
  const preload = join(dir, 'credential-store.mjs');
  await writeFile(preload, `
    import { CredentialVault } from ${JSON.stringify(moduleURL('credentials.js'))};
    CredentialVault.prototype.select = async () => 'keychain';
    CredentialVault.prototype.read = async function () { return this.purpose === 'account' ? ${JSON.stringify(saved)} : 'synthetic-project-key-0000'; };
    CredentialVault.prototype.remove = async () => {};
    CredentialVault.prototype.save = async () => { ${saveAllowed ? '' : "throw Error('unexpected secret persistence');"} };
    if (process.env.LAMBDADB_TEST_INTERACTIVE) { process.stdin.isTTY = true; process.stdin.setRawMode = () => process.stdin; process.stderr.isTTY = true; process.stderr.columns = Number(process.env.LAMBDADB_TEST_COLUMNS || 100); }
    if (global.gc) setInterval(() => global.gc(), 20).unref();
  `);
  // Guided init installs user-scope agent files, so the home directory must be the fixture's,
  // never the developer's real one.
  const home = join(dir, 'home');
  await mkdir(home);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LAMBDADB_')
    && !['XDG_CONFIG_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'VSCODE_PORTABLE', 'VSCODE_APPDATA', 'COPILOT_HOME', 'APPDATA', 'HOME', 'USERPROFILE'].includes(key)));
  const domainCalls = () => fixture.calls.filter((c) => !/^\/(\.well-known|oauth2)\//.test(c.path) && !c.path.startsWith('/subscriptions/'));
  return {
    ...fixture, config, domainCalls,
    async run(args, extra = {}, answers, nodeArgs = [], onSpawn = () => {}) {
      const child = spawn(process.execPath, [...nodeArgs, '--import', preload, bin, ...args, '--config', config, ...(answers ? [] : ['--json'])], {
        cwd: dir,
        env: { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), APPDATA: join(home, 'AppData', 'Roaming'),
          ...extra, ...(answers ? { LAMBDADB_TEST_INTERACTIVE: 'true', TERM: 'xterm-256color' } : {}) }, stdio: [answers ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
      onSpawn(child);
      let stdout = '', stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', chunk => { stderr += chunk; });
      const answered = terminalInput(child, answers);
      const timer = setTimeout(() => child.kill(), 8000);
      try {
        const code = await new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('close', resolve);
        });
        for (const secret of ['synthetic-account-token', 'synthetic-refresh-token']) {
          assert.ok(!stdout.includes(secret));
          assert.ok(!stderr.includes(secret));
        }
        if (answers) assert.equal(answered(), answers.length, stderr);
        return { code, stdout, value: answers ? undefined : JSON.parse(stdout), stderr };
      } finally { clearTimeout(timer); }
    },
  };
}

const issued = (overrides = {}) => ({ connection_id: connection, endpoint: 'https://api.example.com', project_id: first, project_name: 'first', key_id: 'key-id', api_key: 'synthetic-issued-secret', ...overrides });
const keyRequest = 'POST project-connections/{id}/key';
for (const scenario of [
  { name: 'missing issued key identity', status: 201, body: issued({ key_id: undefined }), exit: 5,
    message: `Account management request failed: issuance_unconfirmed (the response did not match the expected contract) during ${keyRequest}.` },
  { name: 'invalid issued endpoint', status: 201, body: issued({ endpoint: 'https://invalid.example/path' }), exit: 5,
    message: `Account management request failed: issuance_unconfirmed (the response did not match the expected contract) during ${keyRequest}.` },
  { name: 'HTTP 408', status: 408, body: { error: 'request_timeout' }, exit: 5,
    message: `Account management request failed: write_outcome_unknown (HTTP 408) during ${keyRequest}.` },
  { name: 'claimed issuance', status: 409, body: { error: 'issuance_unconfirmed' }, exit: 5,
    message: `Account management request failed: issuance_unconfirmed (HTTP 409) during ${keyRequest}.` },
  { name: 'definite forbidden rejection', status: 403, body: { error: 'owner_or_admin_required' }, exit: 3,
    message: `Account management request failed: owner_or_admin_required (HTTP 403) during ${keyRequest}.` },
  { name: 'definite rate-limit rejection', status: 429, body: { error: 'rate_limited' }, exit: 3,
    message: `Account management request failed: management_request_failed (HTTP 429) during ${keyRequest}.` },
]) {
  test(`actual CLI: ${scenario.name} preserves pending identity without automatic reissuance`, async (t) => {
    const fixture = await cliFixture(t, (call, res) => {
      if (call.path === '/projects') return res.end(JSON.stringify({ projects: [{ id: first, name: 'first', status: 'ACTIVE', organization_id: org }] }));
      if (call.path === '/organizations') return res.end(JSON.stringify({ organizations: [team()] }));
      assert.equal(call.path, `/project-connections/${connection}/key`);
      res.statusCode = scenario.status;
      res.end(JSON.stringify(scenario.body));
    });
    const args = ['projects', 'use', '--org-id', org, '--project-id', first];
    const result = await fixture.run([...args, '--issue-key', '--no-browser']);
    assert.equal(result.code, scenario.exit, result.stderr);
    assert.equal(result.value.data?.state, scenario.exit === 5 ? 'unknown' : undefined);
    assert.notEqual(result.value.error.code, 'INPUT_ERROR');
    assert.equal(result.value.error.message, scenario.message);
    assert.ok(!JSON.stringify(result).includes('synthetic-issued-secret'));
    const path = `${fixture.config}.connections.json`;
    const before = await readFile(path, 'utf8');
    assert.equal(JSON.parse(before)[0].pendingKeyName, `lambdadb-connection-${connection}`);
    assert.equal(JSON.parse(before)[0].settings, undefined);
    assert.ok(!before.includes('synthetic-issued-secret'));
    const rerun = await fixture.run(args);
    assert.equal(rerun.code, 2);
    assert.match(rerun.value.error.message, /Inspect\/revoke lambdadb-connection-/);
    assert.equal(await readFile(path, 'utf8'), before);
    assert.equal(fixture.calls.filter((c) => c.path.endsWith('/key')).length, 1);
  });
}

for (const mode of ['flag', 'environment', 'flag overrides environment']) {
  test(`actual CLI: management timeout from ${mode} covers response bodies`, async (t) => {
    const fixture = await cliFixture(t, async (_call, res) => {
      res.write('{"clouds":');
      // Timeout cases keep the body open so response completion cannot race the
      // abort timer on a busy runner. Only the override case must finish in time.
      if (mode === 'flag overrides environment') {
        await new Promise((resolve) => setTimeout(resolve, 700));
        res.end('{}}');
      }
    });
    const args = ['projects', 'regions'];
    if (mode !== 'environment') args.push('--timeout-ms', mode === 'flag' ? '200' : '2000');
    const result = await fixture.run(args, mode === 'flag' ? {} : { LAMBDADB_TIMEOUT_MS: '200' });
    assert.equal(result.code, mode === 'flag overrides environment' ? 0 : 3);
    assert.equal(fixture.calls.length, 1);
  });
}

for (const scenario of [
  { name: 'read', issue: false, status: 200, exit: 3 },
  { name: 'uncertain issuance', issue: true, status: 200, exit: 5 },
  { name: 'definite issuance rejection', issue: true, status: 403, exit: 3 },
]) {
  test(`actual CLI: ${scenario.name} body timeout survives garbage collection`, async t => {
    const fixture = await cliFixture(t, (call, res) => {
      if (call.path === '/projects') return res.end(JSON.stringify({ projects: [{ id: first, name: 'first', status: 'ACTIVE', organization_id: org }] }));
      if (call.path === '/organizations') return res.end(JSON.stringify({ organizations: [team()] }));
      assert.equal(call.path, scenario.issue ? `/project-connections/${connection}/key` : '/projects/regions');
      res.statusCode = scenario.status;
      res.write('{'); // Leave the body open until the client's timeout cancels it.
    });
    const args = scenario.issue ? ['projects', 'use', '--org-id', org, '--project-id', first, '--issue-key', '--no-browser'] : ['projects', 'regions'];
    const result = await fixture.run(args, { LAMBDADB_TIMEOUT_MS: '500' }, undefined, ['--expose-gc']);
    assert.equal(result.code, scenario.exit, result.stderr);
    assert.equal(result.value.data?.state, scenario.exit === 5 ? 'unknown' : undefined);
    assert.equal(fixture.calls.filter(c => c.path.endsWith(scenario.issue ? '/key' : '/regions')).length, 1);
    if (scenario.issue) {
      const pending = JSON.parse(await readFile(`${fixture.config}.connections.json`, 'utf8'))[0];
      assert.equal(pending.pendingKeyName, `lambdadb-connection-${connection}`);
      assert.equal(pending.settings, undefined);
    }
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

test('actual CLI: login honors the per-request timeout without retries', async (t) => {
  const fixture = await oauthServer(t, async (_call, res) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    res.end('{}');
    return true;
  });
  const { config } = await directory(t);
  const child = spawn(process.execPath, [bin, 'login', '--no-browser', '--api-url', fixture.url, '--timeout-ms', '200', '--config', config, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 2);
  assert.match(JSON.parse(out).error.message, /Cannot reach/);
  assert.equal(fixture.calls.length, 1);
});

test('actual CLI: sequential management requests each receive a fresh timeout budget', async (t) => {
  const fixture = await cliFixture(t, async (call, res) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (call.path === '/projects') return res.end(JSON.stringify({ projects: [{ id: first, name: 'first', status: 'ACTIVE', organization_id: org }] }));
    assert.equal(call.path, '/organizations');
    res.end(JSON.stringify({ organizations: [team()] }));
  });
  const result = await fixture.run(['projects', 'use', '--org-id', org, '--project-id', first, '--timeout-ms', '500']);
  assert.equal(result.code, 2);
  assert.match(result.value.error.message, /--issue-key/);
  assert.equal(fixture.domainCalls().length, 2);
});

for (const scenario of [
  { name: 'confirmed revocation', status: 200, delay: 0, remoteRevoked: true },
  { name: 'rejected revocation', status: 503, delay: 0, remoteRevoked: false },
  { name: 'revocation timeout', status: 200, delay: 700, remoteRevoked: false },
]) {
  test(`actual CLI: logout always removes the local login and reports ${scenario.name}`, async (t) => {
    const fixture = await cliFixture(t, () => assert.fail('logout must not call domain routes'));
    fixture.calls.length = 0;
    const real = fixture.url;
    // Replace only the revocation answer; discovery stays real.
    const revoke = await oauthServer(t, async (call, res) => {
      if (call.path !== '/oauth2/revoke') return false;
      await new Promise((resolve) => setTimeout(resolve, scenario.delay));
      res.statusCode = scenario.status;
      res.end();
      return true;
    });
    await writeFile(`${fixture.config}.account.json`, JSON.stringify({ ...account(), apiUrl: real, issuer: revoke.issuer }));
    const result = await fixture.run(['logout', '--timeout-ms', '300']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.value.data.loggedOut, true);
    assert.equal(result.value.data.remoteRevoked, scenario.remoteRevoked);
    await assert.rejects(readFile(`${fixture.config}.account.json`), { code: 'ENOENT' });
    const revocation = revoke.calls.find((c) => c.path === '/oauth2/revoke');
    assert.deepEqual(revocation.body, { token: 'synthetic-refresh-token', token_type_hint: 'refresh_token', client_id: 'lambdadb-cli' });
    assert.equal(revoke.calls.filter((c) => c.path === '/oauth2/revoke').length, 1);
  });
}

test('actual CLI: termination during the key claim interrupts it and keeps the issuance uncertain', async (t) => {
  let child;
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path === '/projects') return res.end(JSON.stringify({ projects: [{ id: first, name: 'first', status: 'ACTIVE', organization_id: org }] }));
    if (call.path === '/organizations') return res.end(JSON.stringify({ organizations: [team()] }));
    assert.equal(call.path, `/project-connections/${connection}/key`);
    res.write('{'); // The claim is in flight when the user presses Ctrl-C.
    child.kill('SIGINT');
  });
  const started = Date.now();
  const result = await fixture.run(['projects', 'use', '--org-id', org, '--project-id', first, '--issue-key', '--no-browser'], { LAMBDADB_TIMEOUT_MS: '60000' }, undefined, [], (spawned) => { child = spawned; });
  assert.equal(result.code, 5, result.stderr);
  assert.equal(result.value.data.state, 'unknown');
  assert.ok(Date.now() - started < 7000, 'termination must not wait for the request timeout');
  assert.equal(JSON.parse(await readFile(`${fixture.config}.connections.json`, 'utf8'))[0].pendingKeyName, `lambdadb-connection-${connection}`);
});

test('actual CLI: a bodyless key-issuance conflict retains uncertain issuance', async (t) => {
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path === '/projects') return res.end(JSON.stringify({ projects: [{ id: first, name: 'first', status: 'ACTIVE', organization_id: org }] }));
    if (call.path === '/organizations') return res.end(JSON.stringify({ organizations: [team()] }));
    assert.equal(call.path, `/project-connections/${connection}/key`);
    res.statusCode = 409;
    res.end();
  });
  const result = await fixture.run(['projects', 'use', '--org-id', org, '--project-id', first, '--issue-key', '--no-browser']);
  assert.equal(result.code, 5);
  assert.equal(result.value.data.state, 'unknown');
  assert.equal(result.value.error.httpStatus, 409);
  assert.ok(JSON.parse(await readFile(`${fixture.config}.connections.json`, 'utf8'))[0].pendingKeyName);
  assert.equal(fixture.calls.filter((c) => c.path.endsWith('/key')).length, 1);
});

test('actual CLI: plain init enters account project setup and reuses a valid login', async t => {
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path === '/organizations') return res.end(JSON.stringify({ organizations: [{ id: org, name: 'Team', role: 'owner', status: 'active', max_projects: 1, projects_count: 0 }] }));
    if (call.path === '/projects') return res.end(JSON.stringify({ projects: [] }));
    assert.equal(call.path, '/projects/regions');
    res.end(JSON.stringify({ clouds: { aws: [{ region: 'ap-northeast-2', region_name: 'Seoul', is_open: true }] } }));
  });
  const result = await fixture.run(['init', '--no-browser'], {}, [
    ['Connection', enter], ['Region', cancel],
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /No projects yet/);
  assert.deepEqual(fixture.domainCalls().map(c => c.path), ['/organizations', '/projects', '/projects/regions']);
  await assert.rejects(readFile(fixture.config), { code: 'ENOENT' });
});

test('actual CLI: login only saves account access and guides explicit next commands', async t => {
  const fixture = await cliFixture(t, () => assert.fail('login must not call domain routes'), true);
  await rm(`${fixture.config}.account.json`);
  const result = await fixture.run(['login', '--no-browser', '--api-url', fixture.url]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /oauth2\/device\/verify\?user_code=AbCd1234\nCode: AbCd1234/);
  // The environment is named before the approval link.
  assert.ok(result.stderr.startsWith(`Signing in to ${fixture.url}\n`), result.stderr);
  assert.equal(result.value.data.email, fixture.state.email);
  assert.deepEqual(fixture.domainCalls().map((c) => c.path), ['/members/me']);
  const saved = JSON.parse(await readFile(`${fixture.config}.account.json`, 'utf8'));
  assert.equal(saved.memberId, fixture.state.memberId);
  assert.equal(saved.issuer, fixture.issuer);
  assert.ok(!/access-|refresh-/.test(result.stderr + JSON.stringify(saved)));
  await assert.rejects(readFile(fixture.config), { code: 'ENOENT' });
});

test('login and logout summaries name the account, session and next step without raw metadata', () => {
  const signedIn = { ...account(), apiUrl: 'https://api.lambdadb.ai', email: 'a\u001b[31m@example.com' };
  assert.equal(formatLogin(signedIn, defaultConfigPath(), false), [
    'Signed in as a [31m@example.com (https://api.lambdadb.ai).',
    'Session saved in macOS Keychain; it ends after seven idle days.',
    'Next: lambdadb init to connect a project and set up coding agents, or lambdadb orgs list to manage projects.',
  ].join('\n'));
  assert.match(formatLogin(signedIn, '/tmp/custom.json', false), /\nConfig: \/tmp\/custom\.json \(pass --config to later commands\)\.\n/);
  assert.ok(!/memberId|credentialId/.test(formatLogin(signedIn, defaultConfigPath(), true)));
  const unchanged = 'Project keys and agent connections are unchanged.';
  assert.equal(formatLogout(undefined), `Not signed in. ${unchanged}`);
  assert.equal(formatLogout({ remoteRevoked: true, email: 'test@example.com', apiUrl: 'https://api.lambdadb.ai' }), `Signed out of test@example.com (https://api.lambdadb.ai).\n${unchanged}`);
  assert.match(formatLogout({ remoteRevoked: false, apiUrl: 'https://api.lambdadb.ai' }), /^Signed out of https:\/\/api\.lambdadb\.ai on this computer\. The server did not confirm revocation/);
});

test('actual CLI: an interactive login and logout use the init frame and print no JSON', async t => {
  const fixture = await cliFixture(t, () => assert.fail('login must not call domain routes'), true);
  await rm(`${fixture.config}.account.json`);
  const signedIn = await fixture.run(['login', '--no-browser', '--api-url', fixture.url], {}, []);
  assert.equal(signedIn.code, 0, signedIn.stderr);
  assert.match(signedIn.stderr, /┌ {2}.*LambdaDB/);
  assert.match(signedIn.stderr, new RegExp(`● {2}Signing in to ${fixture.url}\n`));
  assert.match(signedIn.stderr, /│ {2}Code: AbCd1234\n/);
  assert.match(signedIn.stderr, /└ {2}Signed in as test@example\.com/);
  assert.match(signedIn.stdout, /Session.* macOS Keychain, ends after 7 idle days/);
  assert.match(signedIn.stdout, /lambdadb init .*Connect a project/);
  assert.ok(!/[{}]|memberId|credentialId/.test(signedIn.stdout), signedIn.stdout);
  const signedOut = await fixture.run(['logout'], {}, []);
  assert.equal(signedOut.code, 0, signedOut.stderr);
  assert.equal(signedOut.stdout, `Signed out of test@example.com (${fixture.url}).\nProject keys and agent connections are unchanged.\n`);
  const again = await fixture.run(['logout'], {}, []);
  assert.equal(again.stdout, 'Not signed in. Project keys and agent connections are unchanged.\n');
});

test('actual CLI: canceling an interactive browser login closes the frame without a second failure report', { skip: process.platform === 'win32' }, async t => {
  const fixture = await cliFixture(t, () => assert.fail('login must not call domain routes'));
  await rm(`${fixture.config}.account.json`);
  // No browser opener on PATH: the CLI waits for a callback that never comes.
  const result = await fixture.run(['login', '--api-url', fixture.url], { PATH: '/nonexistent' }, [], [], child => {
    child.stderr.on('data', chunk => { if (String(chunk).includes('Waiting for approval')) child.kill('SIGINT'); });
  });
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /└ {2}Authorization canceled\. Nothing was saved\.\n/);
  // stdout is redirected here, so it keeps the one-line summary; the cause is not repeated.
  assert.equal(result.stdout, 'Command failed.\n');
  assert.equal(result.stderr.match(/Authorization canceled/g).length, 1);
  await assert.rejects(readFile(`${fixture.config}.account.json`), { code: 'ENOENT' });
});

test('actual CLI: Org UUID selectors use --org-id for project listing and creation', async t => {
  const fixture = await cliFixture(t, (call, res) => {
    assert.equal(call.path, '/projects');
    assert.equal(call.orgId, org);
    if (call.method === 'GET') return res.end(JSON.stringify({ projects: [{ id: first, organization_id: org, name: 'demo', status: 'ACTIVE' }] }));
    assert.equal(call.method, 'POST');
    assert.deepEqual(call.body, { name: 'demo', cloud_provider: 'aws', region: 'ap-northeast-2' });
    res.end(JSON.stringify({ id: first, organization_id: org, status: 'CREATING' }));
  });
  assert.equal((await fixture.run(['projects', 'list', '--org-id', org])).code, 0);
  assert.equal((await fixture.run(['projects', 'create', '--org-id', org, '--name', 'demo', '--region', 'ap-northeast-2'])).code, 0);
  assert.equal(fixture.domainCalls().length, 2);
  for (const flags of [
    ['projects', 'list', '--org', org],
    ['projects', 'create', '--org-id', org, '--default-org', '--name', 'demo', '--region', 'ap-northeast-2'],
  ]) assert.equal((await fixture.run(flags)).code, 2);
  assert.equal(fixture.domainCalls().length, 2);
});

test('organization, project and region summaries are aligned tables with a next step', () => {
  const orgs = [{ id: org, name: '팀\u001b[31m', role: 'owner', plan: 'Free', max_projects: 3, projects_count: 1 }];
  assert.equal(formatOrganizations(orgs), [
    'Organizations (1)', '',
    '  NAME     ROLE   PLAN  PROJECTS  ID',
    `  팀 [31m  owner  Free  1 / 3     ${org}`, '',
    'Next: lambdadb projects list',
  ].join('\n'));
  assert.match(formatOrganizations([...orgs, { ...orgs[0], id: second }]), /\nNext: lambdadb projects list --org-id <ID>$/);
  assert.equal(formatOrganizations([]), 'No active Organizations.');
  assert.match(formatProjects([{ id: first, name: 'demo', status: 'ACTIVE', organization_id: org }], org), new RegExp(`^Projects \\(1\\)\\n\\n {2}NAME {2}STATUS {2}ID\\n {2}demo {2}ACTIVE {2}${first}\\n\\nNext: lambdadb projects use --org-id ${org} --project-id <ID> --issue-key$`));
  assert.equal(formatProjects([], undefined), 'No projects yet.\n\nNext: lambdadb projects regions, then lambdadb projects create');
  assert.match(formatRegions([{ cloud_provider: 'aws', region: 'ap-northeast-2', name: 'Seoul', is_open: false }]), /\n {2}ap-northeast-2 {2}Seoul {2}aws {4}no\n[^]*request another region in LambdaDB Console\.$/);
  assert.match(formatCreated({ id: first, organization_id: org, name: 'demo', status: 'CREATING' }), /^Project demo requested \(CREATING\)\./);
  const selected = { endpoint: 'https://api.example.com', project: 'demo', apiKeyEnv: 'LAMBDADB_API_KEY', credentialStore: 'keychain', credentialId: randomUUID(), credentialKeyName: `lambdadb-connection-${connection}` };
  assert.equal(formatUse(selected, false), [
    'Using project demo (https://api.example.com).',
    `Key: lambdadb-connection-${connection} in macOS Keychain.`,
    'Agents set up earlier keep their previous project; run lambdadb init to switch them.',
    'Next: lambdadb doctor to check the connection.',
  ].join('\n'));
});

test('actual CLI: project commands use the only Organization when --org-id is omitted and list choices otherwise', async t => {
  let orgs = [team({ name: 'Team' })];
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path === '/organizations') return res.end(JSON.stringify({ organizations: orgs }));
    assert.equal(call.path, '/projects');
    assert.equal(call.orgId, org);
    res.end(JSON.stringify({ projects: [{ id: first, organization_id: org, name: 'demo', status: 'ACTIVE' }] }));
  });
  const listed = await fixture.run(['projects', 'list']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(listed.value.data.projects.map(p => p.id), [first]);
  assert.match(listed.stderr, /^Organization: Team$/m);
  assert.deepEqual(fixture.domainCalls().map(c => c.path), ['/organizations', '/projects']);

  orgs = [team({ name: 'Team' }), team({ id: second, name: 'Other' })];
  fixture.calls.length = 0;
  for (const args of [['projects', 'list'], ['projects', 'use', '--project-id', first]]) {
    const ambiguous = await fixture.run(args);
    assert.equal(ambiguous.code, 2, ambiguous.stderr);
    assert.equal(ambiguous.value.error.message, `This account has 2 Organizations; choose one with --org-id:\nTeam  ${org}\nOther  ${second}`);
  }
  assert.ok(fixture.domainCalls().every(c => c.path === '/organizations'), JSON.stringify(fixture.domainCalls()));
  // A person sees the choice as a table and the next step, not as a failure.
  const choice = [
    'Choose an Organization and rerun with --org-id <ID>:', '',
    '  NAME   ROLE   PLAN  PROJECTS  ID',
    `  Team   owner  Free  1 / 1     ${org}`,
    `  Other  owner  Free  1 / 1     ${second}`,
  ].join('\n');
  const listed2 = await fixture.run(['projects', 'list'], {}, []);
  assert.equal(listed2.code, 2, listed2.stderr);
  assert.equal(listed2.stdout, `${choice}\n`);
  assert.doesNotMatch(listed2.stderr, /✖|Command failed/);
  const framedUse = await fixture.run(['projects', 'use', '--project-id', first], {}, []);
  assert.equal(framedUse.code, 2, framedUse.stderr);
  assert.match(stripVTControlCharacters(framedUse.stderr), /└ {2}Choose an Organization and rerun with --org-id <ID>:\n/);
  assert.doesNotMatch(framedUse.stderr, /✖|Command failed/);
  assert.equal(framedUse.stdout, `${choice}\n`);
});

test('actual CLI: a terminal shows a failure as its cause and next step; redirected stdout keeps its summary', async t => {
  const fixture = await cliFixture(t, () => assert.fail('no domain call is expected'));
  await rm(`${fixture.config}.account.json`);
  const failed = await fixture.run(['projects', 'list', '--org-id', 'not-a-uuid'], {}, []);
  assert.equal(failed.code, 2);
  assert.equal(stripVTControlCharacters(failed.stderr), '✖ Organization must be an explicit UUID. Run orgs list or projects list to find it.\n  Check --help and the input file or configuration.\n');
  // stdout is redirected here, so it keeps the one-line summary for scripts.
  assert.equal(failed.stdout, 'Command failed.\n');
});

test('actual CLI: a framed projects use with an uncertain key keeps the unknown-outcome headline and redirected summary', async t => {
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path === '/projects') return res.end(JSON.stringify({ projects: [{ id: first, name: 'first', status: 'ACTIVE', organization_id: org }] }));
    if (call.path === '/organizations') return res.end(JSON.stringify({ organizations: [team()] }));
    assert.equal(call.path, `/project-connections/${connection}/key`);
    res.statusCode = 409;
    res.end(JSON.stringify({ error: 'issuance_unconfirmed' }));
  });
  const result = await fixture.run(['projects', 'use', '--org-id', org, '--project-id', first, '--issue-key', '--no-browser'], {}, []);
  assert.equal(result.code, 5, result.stderr);
  assert.match(result.stderr, /└ {2}Write outcome unknown\. Inspect the target before retrying\.\n│? ?\s*Account management request failed: issuance_unconfirmed/);
  assert.equal(result.stdout, 'Write outcome unknown. Inspect the target before retrying.\n');
});

test('guided init selects an existing project at its limit without a billing detour or duplicate questions', async t => {
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path === '/organizations') return res.end(JSON.stringify({ organizations: [{ id: org, name: 'Team', role: 'owner', status: 'active', max_projects: 1, projects_count: 1 }] }));
    if (call.path === '/projects') return res.end(JSON.stringify({ projects: [{ id: first, name: 'first', status: 'ACTIVE', organization_id: org }] }));
    if (call.path === `/project-connections/${connection}/key`) return res.end(JSON.stringify(issued({ endpoint: fixture.url })));
    assert.equal(call.path, '/projects/first/collections?size=1');
    res.end(JSON.stringify({ collections: [] }));
  }, true);
  const result = await fixture.run(['init', '--agents', 'codex', '--no-browser'], {}, [
    ['Connection', enter], ['Project', enter],
    ['Create a key for first with write access?', keys(left, '\r')],
    ['Continue with this setup?', enter],
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Organization: Team/);
  assert.doesNotMatch(result.stderr, /Continue with account|Enter use|Project limit reached|rerun init to update|Enable MCP write tools\?/);
  assert.match(result.stdout, /Project\s+first/);
  const summary = result.stdout.replace(/\s+/g, ' ');
  assert.match(summary, /same OS user with keychain accessible and npx on PATH/);
  assert.match(summary, /Codex: trust the project/);
  assert.doesNotMatch(summary, /GUI launches|export LAMBDADB_API_KEY/);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-issued-secret/);
  assert.equal(fixture.calls.filter(c => c.path.endsWith('/key')).length, 1);
  assert.equal(fixture.domainCalls().filter(c => c.method !== 'GET').length, 2);
  const rerun = await fixture.run(['init', '--agents', 'none'], {}, [
    ['Connection', enter],
  ]);
  assert.equal(rerun.code, 0, rerun.stderr);
  assert.doesNotMatch(rerun.stderr, /Account metadata|Project references|Connected project:|Scope:|MCP tools:|Apply these changes/);
  assert.match(rerun.stderr, /Authentication and collection access verified/);
  assert.equal(fixture.calls.filter(c => c.path.endsWith('/key')).length, 1);
});

test('guided init still requires explicit new-key approval', async t => {
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path === '/organizations') return res.end(JSON.stringify({ organizations: [{ id: org, name: 'Team', role: 'owner', status: 'active', max_projects: 1, projects_count: 1 }] }));
    assert.ok(call.path === '/projects');
    res.end(JSON.stringify({ projects: [{ id: first, name: 'first', status: 'ACTIVE', organization_id: org }] }));
  });
  const result = await fixture.run(['init', '--agents', 'none'], {}, [
    ['Connection', enter], ['Project', enter], ['Create a key for first with write access?', enter],
  ]);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(fixture.domainCalls().filter(c => c.method !== 'GET').length, 0);
  await assert.rejects(readFile(fixture.config), { code: 'ENOENT' });
});

test('guided cancellation after project connection reports and retains the completed setup', async t => {
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path === '/organizations') return res.end(JSON.stringify({ organizations: [{ id: org, name: 'Team', role: 'owner', status: 'active', max_projects: 1, projects_count: 1 }] }));
    if (call.path === '/projects') return res.end(JSON.stringify({ projects: [{ id: first, name: 'first', status: 'ACTIVE', organization_id: org }] }));
    assert.equal(call.path, `/project-connections/${connection}/key`);
    res.end(JSON.stringify(issued({ endpoint: fixture.url })));
  }, true);
  const result = await fixture.run(['init', '--agents', 'cline', '--no-browser'], {}, [
    ['Connection', enter], ['Project', enter], ['Create a key for first with write access?', keys(left, '\r')], ['Continue with this setup?', keys(down, down, down, '\r')],
  ]);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /Completed login\/project setup is retained/);
  assert.equal(JSON.parse(await readFile(fixture.config, 'utf8')).project, 'first');
  assert.equal(fixture.calls.filter(c => c.path.endsWith('/key')).length, 1);
});

test('guided creation at the project limit offers billing without creating a project or key', async t => {
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path === '/organizations') return res.end(JSON.stringify({ organizations: [{ id: org, name: 'Team', role: 'owner', status: 'active', max_projects: 1, projects_count: 1 }] }));
    assert.ok(call.path === '/projects');
    res.end(JSON.stringify({ projects: [{ id: first, name: 'first', status: 'ACTIVE', organization_id: org }] }));
  });
  const result = await fixture.run(['init', '--agents', 'none', '--no-browser'], {}, [
    ['Connection', enter], ['Project', keys(down, '\r')],
    ['Open billing in your browser?', enter], ['After updating billing', enter],
  ]);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, new RegExp(`/organization/billing/open\\?org_id=${org}`));
  assert.equal(fixture.domainCalls().filter(c => c.method !== 'GET').length, 0);
  await assert.rejects(readFile(fixture.config), { code: 'ENOENT' });
});

test('guided first-project creation skips the action picker but keeps region selection and explicit approval', async t => {
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path === '/organizations') return res.end(JSON.stringify({ organizations: [] }));
    assert.equal(call.path, '/projects/regions');
    res.end(JSON.stringify({ clouds: { aws: [{ region: 'ap-northeast-2', region_name: 'Seoul', is_open: true }] } }));
  });
  const result = await fixture.run(['init', '--agents', 'none'], {}, [
    ['Connection', enter], ['Region', enter],
    ['Project name', 'x'.repeat(46)],
    ['error:Use 3–45 letters', keys(...Array(46).fill('\x7f'), 'bad name', '\r')],
    ['error:Use 3–45 letters', keys(...Array(8).fill('\x7f'), 'example', '\r')], ['Create this project?', enter],
  ]);
  assert.equal(result.code, 2, result.stderr);
  assert.doesNotMatch(result.stderr, /◆ {2}Project\n/);
  assert.match(result.stderr, /Use 3–45 letters/);
  assert.match(result.stderr, /No project was requested/);
  assert.equal(fixture.domainCalls().filter(c => c.method !== 'GET').length, 0);
  await assert.rejects(readFile(fixture.config), { code: 'ENOENT' });
});

test('guided Org and project menus navigate without repeating requests', async t => {
  const otherOrg = '44444444-4444-4444-8444-444444444444';
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path === '/organizations') return res.end(JSON.stringify({ organizations: [org, otherOrg].map((id, index) => ({ id, name: `Team${index}`, role: 'owner', status: 'active', max_projects: 1, projects_count: 1 })) }));
    assert.ok(call.path === '/projects');
    assert.equal(call.orgId, org);
    res.end(JSON.stringify({ projects: [{ id: first, name: 'first', status: 'ACTIVE', organization_id: org }] }));
  });
  const result = await fixture.run(['init', '--agents', 'none'], {}, [
    ['Connection', enter], ['Organization', keys(down, up, '\r')],
    ['Project', enter], ['Create a key for first with write access?', enter],
  ]);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(fixture.domainCalls().length, 2);
  assert.equal(fixture.domainCalls().filter(c => c.method !== 'GET').length, 0);
});

test('guided setup offers only open regions and points to Console for the others', async t => {
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path === '/organizations') return res.end(JSON.stringify({ organizations: [] }));
    assert.equal(call.path, '/projects/regions');
    res.end(JSON.stringify({ clouds: { aws: [
      { region: 'eu-west-1', region_name: 'Ireland', is_open: false },
      { region: 'ap-northeast-2', region_name: 'Seoul', is_open: true },
    ] } }));
  });
  const result = await fixture.run(['init', '--agents', 'none'], {}, [
    ['Connection', enter], ['Region', enter], ['Project name', 'example'], ['Create this project?', cancel],
  ]);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /Only open regions are listed\. Request another region in Console: https:\/\/console\.example\.com\/organization\/projects/);
  assert.match(result.stderr, /Create example in your default Organization \(ap-northeast-2\)/);
  assert.doesNotMatch(result.stderr, /Ireland/);
  assert.deepEqual(fixture.domainCalls().filter(c => c.method !== 'GET'), []);
});

test('guided setup stops before any write when no region is open', async t => {
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path === '/organizations') return res.end(JSON.stringify({ organizations: [] }));
    assert.equal(call.path, '/projects/regions');
    res.end(JSON.stringify({ clouds: { aws: [{ region: 'eu-west-1', region_name: 'Ireland', is_open: false }] } }));
  });
  const result = await fixture.run(['init', '--agents', 'none'], {}, [['Connection', enter]]);
  assert.equal(result.code, 2, result.stderr);
  assert.match(stripVTControlCharacters(result.stderr), /No region is open for new projects\. Request one in Console: https:\/\/console\.example\.com\/organization\/projects/);
  assert.deepEqual(fixture.domainCalls().filter(c => c.method !== 'GET'), []);
});

test('actual CLI: creating a project in an unopened region explains the region request', async t => {
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path === '/projects/regions') return res.end(JSON.stringify({ clouds: { aws: [{ region: 'eu-west-1', region_name: 'Ireland', is_open: false }] } }));
    assert.equal(call.path, '/projects');
    assert.equal(call.method, 'POST');
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'region eu-west-1 is not available yet. Request it in the LambdaDB Console.' }));
  });
  const result = await fixture.run(['projects', 'create', '--org-id', org, '--name', 'demo', '--region', 'eu-west-1']);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(result.value.error.message, 'Region eu-west-1 is not open yet. Request it in Console: https://console.example.com/organization/projects. No project was created.');
  assert.deepEqual(fixture.domainCalls().map(c => `${c.method} ${c.path}`), ['POST /projects', 'GET /projects/regions']);
});

test('guided rerun selects a provisioning project without creating another or asking for a key', async t => {
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path === '/organizations') return res.end(JSON.stringify({ organizations: [{ id: org, name: 'Team', role: 'owner', status: 'active', max_projects: 1, projects_count: 1 }] }));
    assert.ok(call.path === '/projects');
    res.end(JSON.stringify({ projects: [{ id: first, name: 'pending', status: 'CREATING', organization_id: org }] }));
  });
  const result = await fixture.run(['init', '--agents', 'none'], {}, [
    ['Connection', enter], ['Project', enter],
  ]);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /is CREATING and is not ready to connect/);
  assert.match(result.stderr, /select this existing project once it is ACTIVE/);
  assert.doesNotMatch(result.stderr, /Create a key for/);
  assert.equal(fixture.domainCalls().filter(c => c.method !== 'GET').length, 0);
  await assert.rejects(readFile(`${fixture.config}.connections.json`), { code: 'ENOENT' });
});


test('guided cancellation during key delivery keeps unknown issuance and never retries', async t => {
  let child;
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path === '/organizations') return res.end(JSON.stringify({ organizations: [{ id: org, name: 'Team', role: 'owner', status: 'active', max_projects: 1, projects_count: 1 }] }));
    if (call.path === '/projects') return res.end(JSON.stringify({ projects: [{ id: first, name: 'first', status: 'ACTIVE', organization_id: org }] }));
    assert.equal(call.path, `/project-connections/${connection}/key`);
    res.write('{');
    child.kill('SIGINT');
  });
  const result = await fixture.run(['init', '--agents', 'none', '--no-browser'], {}, [
    ['Connection', enter], ['Project', enter], ['Create a key for first with write access?', keys(left, '\r')],
  ], [], spawned => { child = spawned; });
  assert.equal(result.code, 5, result.stderr);
  assert.match(result.stderr, /✖\S* Write outcome unknown\. Inspect the target before retrying\./);
  assert.equal(JSON.parse(await readFile(`${fixture.config}.connections.json`, 'utf8'))[0].pendingKeyName, `lambdadb-connection-${connection}`);
  assert.equal(fixture.calls.filter(call => call.path.endsWith('/key')).length, 1);
  await assert.rejects(readFile(fixture.config), { code: 'ENOENT' });
});


test('guided login preserves the complete approval URL in a narrow terminal', async t => {
  const fixture = await cliFixture(t, (call, res) => {
    if (call.path === '/organizations') return res.end(JSON.stringify({ organizations: [] }));
    assert.equal(call.path, '/projects/regions');
    res.end(JSON.stringify({ clouds: { aws: [{ region: 'ap-northeast-2', region_name: 'Seoul', is_open: true }] } }));
  }, true);
  await rm(`${fixture.config}.account.json`);
  const result = await fixture.run(['init', '--no-browser', '--api-url', fixture.url], { LAMBDADB_TEST_COLUMNS: '34' }, [
    ['Connection', enter], ['Region', cancel],
  ]);
  assert.equal(result.code, 2, result.stderr);
  assert.ok(result.stderr.includes(`${fixture.url}/oauth2/device/verify?user_code=AbCd1234`), 'the copyable URL must remain one unbroken token');
  assert.ok(!/access-|refresh-/.test(result.stderr));
  assert.equal(fixture.calls.filter(call => call.path.endsWith('/key')).length, 0);
});
