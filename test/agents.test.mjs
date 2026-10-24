import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { agentAdapters, detectAgents } from '../dist/agents.js';

test('agent detection uses adapter directories with isolated environment and custom user profiles', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lambdadb-agents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { cwd: join(root, 'project'), home: join(root, 'home'), env: { PATH: '' } };
  await mkdir(context.cwd); await mkdir(context.home);
  assert.deepEqual(await detectAgents(context), []);
  context.env.CODEX_HOME = join(root, 'codex-profile');
  context.env.CLAUDE_CONFIG_DIR = join(root, 'claude-profile');
  await mkdir(context.env.CODEX_HOME);
  await mkdir(context.env.CLAUDE_CONFIG_DIR);
  await mkdir(join(context.cwd, '.cursor'));
  assert.deepEqual(await detectAgents(context), ['codex', 'claude', 'cursor']);
  await rm(context.env.CODEX_HOME, { recursive: true });
  await rm(context.env.CLAUDE_CONFIG_DIR, { recursive: true });
  await mkdir(join(context.home, '.codex'));
  assert.deepEqual(await detectAgents(context), ['cursor'], 'a custom profile replaces the default user detection path');
});

test('agent detection recognizes a PATH executable without an agent configuration directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lambdadb-agent-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  await writeFile(executable, '');
  await chmod(executable, 0o755);
  assert.deepEqual(await detectAgents({ cwd: join(root, 'project'), home: join(root, 'home'), env: { PATH: root } }), ['claude']);
});

test('Cursor CLI is detected before its first configuration is created', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lambdadb-cursor-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, process.platform === 'win32' ? 'cursor-agent.cmd' : 'cursor-agent');
  await writeFile(executable, '');
  await chmod(executable, 0o755);
  assert.deepEqual(await detectAgents({ cwd: join(root, 'project'), home: join(root, 'home'), env: { PATH: root } }), ['cursor']);
});

test('VS Code user paths follow the default profile on each platform and supported environment overrides', async () => {
  const adapter = agentAdapters.find(adapter => adapter.id === 'vscode');
  const context = { cwd: resolve('test-project'), home: resolve('test-home'), env: {} };
  const config = join(context.home, 'config'), roaming = join(context.home, 'roaming');
  const custom = join(context.home, 'custom'), portable = join(context.home, 'portable');
  for (const [platform, env, expected] of [
    ['darwin', {}, join(context.home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')],
    ['linux', {}, join(context.home, '.config', 'Code', 'User', 'mcp.json')],
    ['linux', { XDG_CONFIG_HOME: config }, join(config, 'Code', 'User', 'mcp.json')],
    ['win32', { APPDATA: roaming }, join(roaming, 'Code', 'User', 'mcp.json')],
    ['darwin', { VSCODE_APPDATA: custom }, join(custom, 'Code', 'User', 'mcp.json')],
    ['linux', { VSCODE_APPDATA: custom, VSCODE_PORTABLE: portable }, join(portable, 'user-data', 'User', 'mcp.json')],
  ]) {
    const paths = await adapter.paths('user', { ...context, platform, env });
    assert.equal(paths.mcp, expected);
    assert.equal(paths.skill, join(context.home, '.copilot', 'skills', 'lambdadb', 'SKILL.md'));
  }
});

test('new agents are detected from isolated project and user directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lambdadb-new-agents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { cwd: join(root, 'project'), home: join(root, 'home'), env: { PATH: '', GEMINI_CLI_HOME: join(root, 'gemini-profile'), XDG_CONFIG_HOME: join(root, 'config') } };
  await mkdir(context.cwd);
  await mkdir(join(context.env.GEMINI_CLI_HOME, '.gemini'), { recursive: true });
  await mkdir(join(context.env.XDG_CONFIG_HOME, 'opencode'), { recursive: true });
  await mkdir(join(context.cwd, '.vscode'));
  assert.deepEqual(await detectAgents(context), ['vscode', 'gemini', 'opencode']);
});

test('Copilot and Cline use their own user settings and Kiro CLI is detected by its alternate executable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lambdadb-more-agents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { cwd: join(root, 'project'), home: join(root, 'home'), platform: 'linux',
    env: { PATH: root, COPILOT_HOME: join(root, 'copilot-profile'), XDG_CONFIG_HOME: join(root, 'config') } };
  const copilot = agentAdapters.find(adapter => adapter.id === 'copilot');
  const cline = agentAdapters.find(adapter => adapter.id === 'cline');
  const paths = await copilot.paths('user', context);
  assert.equal(paths.mcp, join(context.env.COPILOT_HOME, 'mcp-config.json'));
  assert.equal(paths.skill, join(context.env.COPILOT_HOME, 'skills', 'lambdadb', 'SKILL.md'));
  const clinePaths = await cline.paths('user', context);
  assert.equal(clinePaths.mcp, join(context.env.XDG_CONFIG_HOME, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'));
  assert.deepEqual(cline.scopes, ['user']);
  await mkdir(context.env.COPILOT_HOME);
  await mkdir(join(context.env.XDG_CONFIG_HOME, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings'), { recursive: true });
  const executable = join(root, process.platform === 'win32' ? 'kiro-cli.cmd' : 'kiro-cli');
  await writeFile(executable, '');
  await chmod(executable, 0o755);
  const detected = await detectAgents(context);
  assert.ok(detected.includes('copilot'));
  assert.ok(detected.includes('kiro'));
  assert.ok(detected.includes('cline'));
});
