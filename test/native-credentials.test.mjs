import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

// Opt-in only: writes a uniquely named synthetic OS credential and removes it.
test('native OS credential survives fresh-process doctor and MCP bridge reads', { skip: process.env.LAMBDADB_TEST_NATIVE_CREDENTIALS !== '1', timeout: 90000 }, async t => {
  const cli = process.env.LAMBDADB_TEST_CLI ?? resolve('dist/cli.js');
  const moduleURL = pathToFileURL(join(dirname(cli), 'credentials.js')).href;
  const { CredentialVault } = await import(moduleURL);
  const vault = new CredentialVault();
  const store = await vault.select(process.env.LAMBDADB_TEST_CREDENTIAL_STORE ?? 'auto');
  const root = await mkdtemp(join(tmpdir(), 'lambdadb-native-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const secret = `synthetic-${randomUUID()}`;
  const server = createServer((req, res) => {
    assert.equal(req.headers['x-api-key'], secret);
    res.setHeader('Content-Type', 'application/json');
    res.end('{"collections":[]}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const target = { endpoint: `http://127.0.0.1:${server.address().port}`, project: 'synthetic-test', credentialStore: store, credentialId: randomUUID() };
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LAMBDADB_')));
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ ...target, apiKeyEnv: 'UNSET_PROJECT_KEY' }), { mode: 0o600 });
  const digest = createHash('sha256').update(secret).digest('hex');
  async function run(args, extra = {}) {
    const child = spawn(process.execPath, [cli, ...args, '--config', config], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => out += chunk); child.stderr.on('data', chunk => err += chunk);
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    const code = await new Promise(resolve => child.on('close', resolve));
    clearTimeout(timer);
    assert.equal(code, 0, err); assert.ok(!out.includes(secret) && !err.includes(secret));
    return JSON.parse(out);
  }
  try {
    await vault.save(target, secret);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createHash } from 'node:crypto';
      const { CredentialVault } = await import(process.env.TEST_MODULE);
      const key = await new CredentialVault().read(JSON.parse(process.env.TEST_TARGET));
      process.stdout.write(createHash('sha256').update(key).digest('hex'));
    `], { encoding: 'utf8', timeout: 25000, env: { ...env, TEST_MODULE: moduleURL, TEST_TARGET: JSON.stringify(target) } });
    assert.equal(child.status, 0, 'Fresh-process read failed');
    assert.equal(child.stdout, digest);
    const doctor = await run(['doctor', '--json']);
    assert.equal(doctor.ok, true);
    assert.equal(doctor.data.queryReadinessVerified, false);
    if (process.platform !== 'win32') {
      const bin = join(root, 'bin'); await mkdir(bin);
      await writeFile(join(bin, 'npx'), `#!${process.execPath}\nconst { createHash } = require('node:crypto');\nprocess.stdout.write(JSON.stringify({jsonrpc:'2.0', id:1, result:{hash:createHash('sha256').update(process.env.LAMBDADB_PROJECT_API_KEY).digest('hex'), writes:process.env.LAMBDADB_MCP_ENABLE_WRITE_TOOLS}}));\n`, { mode: 0o700 });
      const mcp = await run(['mcp'], { PATH: bin + delimiter + env.PATH });
      assert.equal(mcp.result.hash, digest);
      assert.equal(mcp.result.writes, 'false');
    }
  } finally { await vault.remove(target); }
  await assert.rejects(vault.read(target), /Cannot read the saved/);
});
