import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
const moduleURL = name => pathToFileURL(join(dirname(process.env.LAMBDADB_TEST_CLI ?? resolve('dist/cli.js')), name)).href;
const { CredentialVault } = await import(moduleURL('credentials.js'));
const { loadSettings, settings } = await import(moduleURL('config.js'));
const { agentAdapters } = await import(moduleURL('agents.js'));
const { mcpLaunch } = await import(moduleURL('agent-config.js'));

function memoryStore() {
  const entries = new Map();
  const calls = [];
  const factory = async (service, id, store) => {
    calls.push(store);
    const key = `${store}:${service}:${id}`;
    return {
      async getSecret() { return entries.get(key) ?? null; },
      async setSecret(value) { entries.set(key, [...value]); },
      async deleteCredential() { return entries.delete(key); },
    };
  };
  return { factory, entries, calls };
}
const target = () => ({ endpoint: 'https://project.example.com', project: 'project', credentialStore: 'secret-service', credentialId: randomUUID() });

test('credential slots bind the key to a project, preserve existing keys, and never fall back on reads', async () => {
  const memory = memoryStore();
  const vault = new CredentialVault(memory.factory, 'linux');
  const selected = target();
  await vault.save(selected, 'synthetic-secret');
  await assert.rejects(vault.save(selected, 'replacement'), /Cannot verify/);
  assert.equal(await vault.read(selected), 'synthetic-secret');
  await assert.rejects(vault.read({ ...selected, project: 'another-project' }), /No new key was issued/);
  memory.entries.clear();
  await assert.rejects(vault.read(selected), /Kernel keys can expire/);
  assert.ok(memory.calls.every(store => store === 'secret-service'));
});

test('only a new Linux connection falls back to keyutils when Secret Service is unavailable', async () => {
  const memory = memoryStore();
  const vault = new CredentialVault(async (...args) => {
    if (args[2] === 'secret-service') throw new Error('locked');
    return memory.factory(...args);
  }, 'linux');
  assert.equal(await vault.select(), 'keyutils');
  assert.equal(memory.entries.size, 0, 'probe credential was not removed');
  await assert.rejects(vault.read(target()), /Cannot read the saved secret-service/);
});

test('a failed readback deletes only the new slot and never uses a plaintext fallback', async () => {
  let deleted = 0;
  const vault = new CredentialVault(async () => ({
    async getSecret() { return null; }, async setSecret() {}, async deleteCredential() { deleted++; return true; },
  }), 'linux');
  await assert.rejects(vault.save(target(), 'synthetic-secret'), /Cannot verify OS credential storage/);
  assert.equal(deleted, 1);
});

test('credential settings reject secrets and allow an explicit environment override', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lambdadb-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config.json');
  const saved = { ...target(), apiKeyEnv: 'PROJECT_KEY' };
  await writeFile(config, JSON.stringify(saved));
  assert.deepEqual(await loadSettings(config), saved);
  const override = await settings({ config, apiKeyEnv: 'ANOTHER_KEY' });
  assert.equal(override.credentialStore, undefined);
  await writeFile(config, JSON.stringify({ ...saved, apiKey: 'synthetic-secret' }));
  await assert.rejects(loadSettings(config), /Never store an API key/);
  await writeFile(config, JSON.stringify({ endpoint: saved.endpoint, project: saved.project, credentialStore: 'keyutils' }));
  await assert.rejects(loadSettings(config), /Configuration must be/);
});

test('all agent adapters preserve unrelated settings and rerun credential references without environment interpolation', async () => {
  const selected = { ...target(), apiKeyEnv: 'PROJECT_KEY' };
  const launch = mcpLaunch(selected, false, '0.1.7-dev.1');
  assert.equal(launch.apiKeyEnv, undefined);
  assert.ok(!launch.args.includes('--api-key-env'));
  assert.ok(!launch.args.includes('--write-tools'));
  for (const adapter of agentAdapters) {
    const path = adapter.id === 'codex' ? '/tmp/config.toml' : '/tmp/config.json';
    const before = adapter.id === 'codex' ? '# Preserve\nmodel = "keep"\n' : '{"mcpServers":{"other":{"command":"keep"}}}';
    const first = adapter.configure(path, before, launch);
    assert.ok(first.includes('keep'));
    assert.ok(!first.includes('PROJECT_KEY'));
    assert.equal(adapter.configure(path, first, launch), first, adapter.id);
  }
});
