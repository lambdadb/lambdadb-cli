import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { oauthServer, consoleUrl } from './helpers/oauth-server.mjs';
const moduleURL = (name) => pathToFileURL(join(dirname(process.env.LAMBDADB_TEST_CLI ?? resolve('dist/cli.js')), name)).href;
const { discover, authorize, refresh, revoke, ACCOUNT_SCOPE, CONNECTION_SCOPE } = await import(moduleURL('oauth.js'));

function recorder() {
  const messages = [], secrets = [];
  return { messages, secrets, diagnostic: (m) => messages.push(m), protect: (v) => secrets.push(v) };
}

test('discovery starts from the API origin and keeps every provider endpoint on the issuer', async (t) => {
  const fixture = await oauthServer(t);
  const provider = await discover(fixture.url, undefined, 5000);
  assert.equal(provider.issuer, fixture.issuer);
  assert.equal(provider.audience, fixture.url);
  assert.equal(provider.consoleUrl, consoleUrl);
  assert.equal(provider.tokenEndpoint, `${fixture.url}/oauth2/token`);

  const foreign = await oauthServer(t, (call, res) => {
    if (call.path !== '/.well-known/openid-configuration') return false;
    res.end(JSON.stringify({ issuer: `${foreign.url}/`, authorization_endpoint: 'https://attacker.invalid/auth', token_endpoint: `${foreign.url}/t`, device_authorization_endpoint: `${foreign.url}/d`, revocation_endpoint: `${foreign.url}/r` }));
    return true;
  });
  await assert.rejects(discover(foreign.url, undefined, 5000), /invalid metadata/);

  const other = await oauthServer(t, (call, res) => {
    if (call.path !== '/.well-known/oauth-protected-resource') return false;
    res.end(JSON.stringify({ resource: 'https://api.other.invalid', authorization_servers: [`${other.url}/`], lambdadb_console_url: consoleUrl }));
    return true;
  });
  await assert.rejects(discover(other.url, undefined, 5000), /invalid OAuth metadata/);
});

test('a server without OAuth reports it instead of falling back to the legacy login', async (t) => {
  const fixture = await oauthServer(t, (call, res) => {
    res.statusCode = 404;
    res.end('{}');
    return true;
  });
  await assert.rejects(discover(fixture.url, undefined, 5000), /does not offer OAuth login yet/);
  assert.deepEqual(fixture.calls.map((c) => c.path), ['/.well-known/oauth-protected-resource']);
});

test('device authorization shows the issuer link and code, protects the device code and returns the account grant', async (t) => {
  const fixture = await oauthServer(t);
  const provider = await discover(fixture.url, undefined, 5000);
  const output = recorder();
  const granted = await authorize(provider, { scope: ACCOUNT_SCOPE, refresh: true, browser: false }, output, AbortSignal.timeout(5000), 5000);
  assert.ok(granted.refreshToken);
  assert.deepEqual(granted.scope, ACCOUNT_SCOPE);
  assert.match(output.messages.join('\n'), new RegExp(`^Sign in on any device with this link:\\n${fixture.url}/oauth2/device/verify\\?user_code=AbCd1234\\nCode: AbCd1234\\nApprove only a request you started\\.\\nWaiting for approval`));
  const start = fixture.calls.find((c) => c.path === '/oauth2/device/auth');
  assert.deepEqual(start.body, { client_id: 'lambdadb-cli', scope: 'account:manage offline_access', audience: fixture.url });
  const poll = fixture.calls.find((c) => c.path === '/oauth2/token');
  assert.ok(output.secrets.includes(poll.body.device_code));
});

test('device denial and expiry stop polling without retrying approval', async (t) => {
  for (const [outcome, message] of [['access_denied', /denied or canceled/], ['expired_token', /expired/]]) {
    const fixture = await oauthServer(t, undefined, { devicePoll: () => outcome });
    const provider = await discover(fixture.url, undefined, 5000);
    await assert.rejects(authorize(provider, { scope: ACCOUNT_SCOPE, refresh: true, browser: false }, recorder(), AbortSignal.timeout(5000), 5000), message);
    assert.equal(fixture.calls.filter((c) => c.path === '/oauth2/token').length, 1);
  }
});

test('the loopback browser flow uses S256 PKCE, the exact state and a connection binding', async (t) => {
  const fixture = await oauthServer(t);
  const provider = await discover(fixture.url, undefined, 5000);
  let opened;
  // Stand in for the browser: follow the provider redirect to the loopback callback.
  const open = async (url) => {
    opened = new URL(url);
    const redirect = await fetch(url, { redirect: 'manual' });
    await fetch(redirect.headers.get('location'));
  };
  const connection = '44444444-4444-4444-8444-444444444444';
  const output = recorder();
  const granted = await authorize(provider, { scope: CONNECTION_SCOPE, connectionId: connection, refresh: false, browser: true }, output, AbortSignal.timeout(5000), 5000, open);
  assert.ok(output.messages[0].startsWith(`Opening your browser to sign in. If it does not open, visit this link on this computer:\n${fixture.issuer.replace(/\/$/, '')}/oauth2/auth?`), output.messages[0]);
  assert.match(output.messages[0], /\nApprove only a request you started\. .*--no-browser\.\nWaiting for approval\.\.\.$/);
  assert.equal(granted.refreshToken, undefined);
  assert.equal(opened.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(opened.searchParams.get('connection_id'), connection);
  assert.equal(opened.searchParams.get('audience'), fixture.url);
  assert.match(opened.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const exchange = fixture.calls.find((c) => c.path === '/oauth2/token').body;
  assert.equal(exchange.grant_type, 'authorization_code');
  assert.ok(exchange.code_verifier.length >= 43);
});

test('a callback with another state is ignored, and a denial ends the attempt', async (t) => {
  const fixture = await oauthServer(t);
  const provider = await discover(fixture.url, undefined, 5000);
  const open = async (url) => {
    const redirect = new URL(new URL(url).searchParams.get('redirect_uri'));
    redirect.searchParams.set('state', 'forged');
    redirect.searchParams.set('code', 'forged');
    assert.equal((await fetch(redirect)).status, 404);
    redirect.searchParams.set('state', new URL(url).searchParams.get('state'));
    redirect.searchParams.delete('code');
    redirect.searchParams.set('error', 'access_denied');
    await fetch(redirect);
  };
  await assert.rejects(
    authorize(provider, { scope: ACCOUNT_SCOPE, refresh: true, browser: true }, recorder(), AbortSignal.timeout(5000), 5000, open),
    /denied or canceled/,
  );
  assert.equal(fixture.calls.filter((c) => c.path === '/oauth2/token').length, 0);
});

test('canceling the browser flow ends the process promptly instead of waiting for the attempt deadline', async (t) => {
  const fixture = await oauthServer(t);
  const script = `
    const { discover, authorize, ACCOUNT_SCOPE } = await import(${JSON.stringify(moduleURL('oauth.js'))});
    const provider = await discover(${JSON.stringify(fixture.url)}, undefined, 5000);
    const controller = new AbortController();
    const quiet = { diagnostic() {}, protect() {} };
    await authorize(provider, { scope: ACCOUNT_SCOPE, refresh: true, browser: true }, quiet, controller.signal, 5000, () => controller.abort())
      .catch((error) => console.log(error.message));
  `;
  const started = Date.now();
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.resume();
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  assert.equal(code, 0);
  assert.match(out, /Authorization canceled/);
  assert.ok(Date.now() - started < 5000, 'a canceled attempt must not wait for its 15-minute deadline');
});

test('a stalled OAuth response body honors the timeout under garbage collection', async (t) => {
  const fixture = await oauthServer(t, (call, res) => {
    if (call.path !== '/.well-known/oauth-protected-resource') return false;
    res.write('{'); // Leave the body open until the client's timeout cancels it.
    return true;
  });
  const script = `
    setInterval(() => globalThis.gc(), 20).unref();
    const { discover } = await import(${JSON.stringify(moduleURL('oauth.js'))});
    await discover(${JSON.stringify(fixture.url)}, undefined, 500).catch((error) => console.log(error.message));
  `;
  const started = Date.now();
  const child = spawn(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.resume();
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  assert.equal(code, 0);
  assert.match(out, /Cannot reach/);
  assert.ok(Date.now() - started < 4000, 'the request timeout must cancel a stalled body');
});

test('refresh rotation rejects a reused token, and revocation reports confirmation', async (t) => {
  const fixture = await oauthServer(t);
  const provider = await discover(fixture.url, undefined, 5000);
  const granted = await authorize(provider, { scope: ACCOUNT_SCOPE, refresh: true, browser: false }, recorder(), AbortSignal.timeout(5000), 5000);
  const rotated = await refresh(provider, granted.refreshToken, undefined, 5000);
  assert.notEqual(rotated.refreshToken, granted.refreshToken);
  await assert.rejects(refresh(provider, granted.refreshToken, undefined, 5000), /login again/);
  assert.equal(await revoke(provider, rotated.refreshToken, 'refresh_token', undefined, 5000), true);
  assert.deepEqual(fixture.state.revoked.at(-1), { token: rotated.refreshToken, token_type_hint: 'refresh_token', client_id: 'lambdadb-cli' });
});

test('removed init --connect is rejected instead of starting authorization', async () => {
  const child = spawn(
    process.execPath,
    [
      process.env.LAMBDADB_TEST_CLI ?? resolve('dist/cli.js'),
      'init',
      '--connect',
      '--non-interactive',
      '--agents',
      'none',
      '--scope',
      'project',
      '--json',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.resume();
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 2);
  assert.match(JSON.parse(stdout).error.message, /^Unknown option '--connect'\./);
});
