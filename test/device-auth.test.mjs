import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
const { authorizeAccount } = await import(
  pathToFileURL(join(dirname(process.env.LAMBDADB_TEST_CLI ?? resolve('dist/cli.js')), 'device-auth.js')).href
);

async function service(t, token, login = { status: 200 }) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, body: JSON.parse(body) });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/login')) {
      res.statusCode = login.status;
      if (login.body) {
        res.end(JSON.stringify(login.body));
        return;
      }
      res.end(
        JSON.stringify({
          device_code: 'a'.repeat(64),
          user_code: 'ABCDE-FG234',
          verification_uri: 'https://app.example.com/auth/cli',
          expires_in: 15,
          interval: 1,
        }),
      );
    } else {
      res.statusCode = token.status;
      res.end(JSON.stringify(token.body));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}

test('account authorization displays another-device URL and protects the session without requesting a project key', async (t) => {
  const fixture = await service(t, {
    status: 200,
    body: {
      account: {
        session_token: 'b'.repeat(64),
        member_id: '11111111-1111-4111-8111-111111111111',
        email: 'synthetic@example.com',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        console_url: 'https://app.example.com',
      },
    },
  });
  const messages = [],
    protectedValues = [];
  const result = await authorizeAccount(
    fixture.url,
    false,
    { diagnostic: (m) => messages.push(m), protect: (v) => protectedValues.push(v) },
    AbortSignal.timeout(5000),
  );
  assert.equal(result.token, 'b'.repeat(64));
  assert.deepEqual(protectedValues, ['a'.repeat(64), result.token]);
  assert.match(messages.join('\n'), /any device:\nhttps?:\/\/[^\n]+\nConfirm code ABCDE-FG234/);
  assert.ok(!messages.join('\n').includes(result.token));
  assert.deepEqual(
    fixture.calls.map((call) => call.path),
    ['/auth/device/login', '/auth/device/token'],
  );
  assert.deepEqual(fixture.calls[1].body, { device_code: 'a'.repeat(64) });
});

test('uncertain account redemption is never automatically retried', async (t) => {
  const fixture = await service(t, {
    status: 400,
    body: { error: 'issuance_unconfirmed', detail: 'synthetic-secret' },
  });
  await assert.rejects(
    authorizeAccount(fixture.url, false, { diagnostic() {}, protect() {} }, AbortSignal.timeout(5000)),
    /undelivered session expires/,
  );
  assert.equal(fixture.calls.filter((call) => call.path.endsWith('/token')).length, 1);
});

test('a server without the device authorization routes reports the HTTP status and origin', async (t) => {
  const fixture = await service(
    t,
    { status: 200, body: {} },
    { status: 404, body: { status: 404, title: 'Not Found' } },
  );
  await assert.rejects(
    authorizeAccount(fixture.url, false, { diagnostic() {}, protect() {} }, AbortSignal.timeout(5000)),
    new RegExp(`unavailable on this server \\(HTTP 404 from ${fixture.url}/auth/device/login\\)`),
  );
  assert.deepEqual(
    fixture.calls.map((call) => call.path),
    ['/auth/device/login'],
  );
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
