import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, symlink, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
const { authorizeDevice, connectDevice } = await import(pathToFileURL(join(dirname(process.env.LAMBDADB_TEST_CLI ?? resolve('dist/cli.js')), 'device-auth.js')).href);

async function service(t, token, beforeToken = async () => {}) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, body: JSON.parse(body) });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/start')) {
      res.end(JSON.stringify({ device_code: 'a'.repeat(64), user_code: 'ABCDE-FG234', verification_uri: 'https://app.example.com/auth/cli', expires_in: 15, interval: 1 }));
    } else { await beforeToken(); res.statusCode = token.status; res.end(JSON.stringify(token.body)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}

test('device authorization accepts only a project credential, displays another-device URL, and never prints its secrets', async t => {
  const fixture = await service(t, { status: 200, body: { endpoint: 'https://project.example.com', project: 'project', credentials: { api_key: 'synthetic-secret', key: { key_id: 'key-id' } } } });
  const messages = [], protectedValues = [];
  const result = await authorizeDevice(fixture.url, false, { diagnostic: m => messages.push(m), protect: v => protectedValues.push(v) }, AbortSignal.timeout(5000));
  assert.equal(result.apiKey, 'synthetic-secret');
  assert.equal(result.credentialKeyId, 'key-id');
  assert.equal(result.credentialKeyName, 'lambdadb-cli-ABCDEFG234');
  assert.deepEqual(protectedValues, ['a'.repeat(64), 'synthetic-secret']);
  assert.match(messages.join('\n'), /any device/);
  assert.ok(!messages.join('\n').includes(result.apiKey));
  assert.deepEqual(fixture.calls[1].body, { device_code: 'a'.repeat(64) });
});

test('uncertain issuance is never automatically retried', async t => {
  const fixture = await service(t, { status: 400, body: { error: 'issuance_unconfirmed', detail: 'synthetic-secret' } });
  await assert.rejects(authorizeDevice(fixture.url, false, { diagnostic() {}, protect() {} }, AbortSignal.timeout(5000)), /No automatic retry/);
  assert.equal(fixture.calls.filter(call => call.path.endsWith('/token')).length, 1);
});

test('non-interactive init refuses browser authorization before any remote action', async () => {
  const child = spawn(process.execPath, [process.env.LAMBDADB_TEST_CLI ?? resolve('dist/cli.js'), 'init', '--connect', '--non-interactive', '--agents', 'none', '--scope', 'project', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.resume();
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 2);
  assert.match(JSON.parse(stdout).error.message, /requires an interactive init session/);
});

const issuedKey = { status: 200, body: { endpoint: 'https://project.example.com', project: 'project', credentials: { api_key: 'synthetic-secret', key: { key_id: 'key-id' } } } };
const quiet = { diagnostic() {}, protect() {} };

async function connectionFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'lambdadb-device-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const saved = new Map();
  const vault = {
    async save(reference, secret) { saved.set(reference.credentialId, secret); },
    async remove(reference) { saved.delete(reference.credentialId); },
  };
  return { dir, saved, vault };
}

test('browser connection preserves the selected config symlink and stores only credential metadata', { skip: process.platform === 'win32' }, async t => {
  const { dir, saved, vault } = await connectionFixture(t);
  const target = join(dir, 'target.json'), config = join(dir, 'config.json');
  await writeFile(target, '{}\n');
  await symlink(target, config);
  const fixture = await service(t, issuedKey);
  const selected = await connectDevice({ config, apiUrl: fixture.url, browser: false }, 'keychain', quiet, vault);
  assert.ok((await lstat(config)).isSymbolicLink());
  const content = await readFile(target, 'utf8');
  assert.equal(JSON.parse(content).credentialId, selected.credentialId);
  assert.equal(JSON.parse(content).credentialKeyId, 'key-id');
  assert.ok(!content.includes('synthetic-secret'));
  assert.equal(saved.get(selected.credentialId), 'synthetic-secret');
});

test('browser connection preserves concurrent settings edits and removes its new local credential', async t => {
  const { dir, saved, vault } = await connectionFixture(t);
  const config = join(dir, 'config.json');
  await writeFile(config, '{}\n');
  const concurrent = '{"project":"concurrent-project"}\n';
  const fixture = await service(t, issuedKey, () => writeFile(config, concurrent));
  await assert.rejects(connectDevice({ config, apiUrl: fixture.url, browser: false }, 'keychain', quiet, vault), /Configuration changed during authorization/);
  assert.equal(await readFile(config, 'utf8'), concurrent);
  assert.equal(saved.size, 0);
  assert.equal(fixture.calls.filter(call => call.path.endsWith('/token')).length, 1);
});
