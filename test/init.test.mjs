import { terminalInput, keys, enter, down, up, left, cancel } from './terminal-input.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { lstat, mkdtemp, mkdir, readFile, realpath, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, delimiter } from 'node:path';
import { parse as toml } from 'smol-toml';
import { parse as jsonc } from 'jsonc-parser';
import { pathToFileURL } from 'node:url';

const cli = process.env.LAMBDADB_TEST_CLI ?? resolve('dist/cli.js');
const secret = 'synthetic-init-key-never-persist';
const { Output } = await import(pathToFileURL(join(dirname(cli), 'output.js')).href);

test('interactive diagnostics share secret protection with final output and strip terminal controls', () => {
  const output = new Output(), messages = [];
  const scoped = output.withDiagnostics(message => messages.push(message));
  output.protect('account-secret');
  scoped.protect('project-secret');
  scoped.diagnostic('account-secret project-secret \x1b[2J\x07');
  assert.deepEqual(messages, ['[REDACTED] [REDACTED] [2J']);
  assert.equal(output.safeDiagnostic('project-secret'), '[REDACTED]');
});

async function fixture(t, status = 200, onRequest) {
  const root = await mkdtemp(join(tmpdir(), 'lambdadb-init-'));
  const home = join(root, 'home');
  const cwd = join(root, 'project');
  await mkdir(home); await mkdir(cwd);
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    await onRequest?.();
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { collections: [] } : { message: secret }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }); });
  const config = join(home, 'cli.json');
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LAMBDADB_')
    && !['XDG_CONFIG_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'VSCODE_PORTABLE', 'VSCODE_APPDATA', 'COPILOT_HOME', 'APPDATA', 'HOME', 'USERPROFILE', 'NO_COLOR', 'FORCE_COLOR', 'npm_command'].includes(key)));
  async function run(args, env = {}, answers) {
    const preload = join(root, 'interactive.mjs');
    if (answers) await writeFile(preload, 'process.stdin.isTTY = true; process.stdin.setRawMode = () => process.stdin; process.stderr.isTTY = true; process.stderr.columns = 100;\n');
    const child = spawn(process.execPath, [...(answers ? ['--import', preload] : []), cli, ...args], { cwd, env: {
      ...cleanEnv, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), APPDATA: join(home, 'AppData', 'Roaming'), LAMBDADB_CONFIG: config,
      LAMBDADB_ENDPOINT: endpoint, LAMBDADB_PROJECT: 'existing-project', CUSTOM_PROJECT_KEY: secret,
      LAMBDADB_API_KEY_ENV: 'CUSTOM_PROJECT_KEY', ...(answers ? { TERM: 'xterm-256color' } : {}), ...env,
    }, stdio: [answers ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => { stderr += chunk; });
    const answered = terminalInput(child, answers);
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    const code = await new Promise((r, reject) => { child.once('error', reject); child.once('close', r); });
    clearTimeout(timer);
    assert.notEqual(code, null, `CLI stalled: ${stdout} ${stderr}`);
    if (answers) assert.equal(answered(), answers.length, stderr);
    assert.ok(!stdout.includes(secret) && !stderr.includes(secret), 'credential leaked to CLI output');
    return { code, stdout, stderr, data: args.includes('--json') && stdout ? JSON.parse(stdout) : undefined };
  }
  async function file(path, content) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
  const init = (names = 'codex,claude,cursor', scope = 'project', extra = []) =>
    ['init', '--non-interactive', '--agents', names, '--scope', scope, '--json', ...extra];
  return { root, home, cwd, config, endpoint, run, init, file, requests };
}

test('init preserves unrelated TOML/JSONC, forwards environment names, installs skills and safely reruns', async t => {
  const f = await fixture(t);
  const codex = join(f.cwd, '.codex/config.toml');
  const claude = join(f.cwd, '.mcp.json');
  const cursor = join(f.cwd, '.cursor/mcp.json');
  const originalToml = '# Keep my comment\nmodel = "custom-model"\n[mcp_servers.other]\ncommand = "other"\n';
  const originalJson = '{\n  // Keep this server and comment\n  "mcpServers": { "other": {"command":"other"} },\n  "custom": {"enabled":true},\n}\n';
  await f.file(codex, originalToml);
  await f.file(claude, originalJson);
  await f.file(cursor, originalJson);
  let result = await f.run(f.init());
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.data.data.queryReadinessVerified, false);
  assert.equal(result.data.data.writesVerified, false);
  assert.equal(result.data.data.writeTools, false);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].method, 'GET');
  assert.match(f.requests[0].url, /^\/projects\/existing-project\/collections\?size=1$/);
  assert.ok(Object.values(f.requests[0].headers).includes(secret));
  assert.match(result.stderr, /project.*MCP|MCP.*project/);
  assert.match(result.stderr, /Manual Console step/);
  const first = await Promise.all([codex, claude, cursor, f.config].map(path => readFile(path, 'utf8')));
  assert.ok(first.every(text => !text.includes(secret)));
  assert.ok(first[0].startsWith(originalToml));
  assert.equal(toml(first[0]).model, 'custom-model');
  assert.deepEqual(toml(first[0]).mcp_servers.lambdadb.env_vars, ['CUSTOM_PROJECT_KEY']);
  assert.ok(!toml(first[0]).mcp_servers.lambdadb.args.includes('--write-tools'));
  for (const [index, placeholder] of [[1, '${CUSTOM_PROJECT_KEY}'], [2, '${env:CUSTOM_PROJECT_KEY}']]) {
    const parsed = jsonc(first[index]);
    assert.deepEqual(parsed.custom, { enabled: true });
    assert.deepEqual(parsed.mcpServers.other, { command: 'other' });
    assert.deepEqual(parsed.mcpServers.lambdadb.env, { CUSTOM_PROJECT_KEY: placeholder });
    assert.match(first[index], /Keep this server and comment/);
  }
  assert.deepEqual(JSON.parse(first[3]), { endpoint: f.endpoint, project: 'existing-project', apiKeyEnv: 'CUSTOM_PROJECT_KEY' });
  assert.equal((await stat(f.config)).mode & 0o777, 0o600);
  for (const directory of ['.agents', '.claude', '.cursor']) {
    const skill = await readFile(join(f.cwd, directory, 'skills/lambdadb/SKILL.md'), 'utf8');
    assert.match(skill, /^---\nname: lambdadb\n/);
    assert.ok(!skill.includes(secret));
    const reference = await readFile(join(f.cwd, directory, 'skills/lambdadb/references/usage.md'), 'utf8');
    assert.equal(reference, await readFile(new URL('../skills/lambdadb/references/usage.md', import.meta.url), 'utf8'));
    assert.ok(!reference.includes(secret));
  }
  result = await f.run(f.init());
  assert.equal(result.code, 0);
  assert.ok(result.data.data.files.every(file => file.action === 'unchanged'));
  assert.deepEqual(await Promise.all([codex, claude, cursor, f.config].map(path => readFile(path, 'utf8'))), first);
  // An explicit rerun can change target and write capability without duplication.
  result = await f.run(f.init('codex,claude,cursor', 'project', ['--project', 'second-project', '--write-tools']));
  assert.equal(result.code, 0, result.stderr);
  for (const path of [codex, claude, cursor]) {
    const text = await readFile(path, 'utf8');
    assert.ok(text.includes('second-project'));
    assert.ok(text.includes('--write-tools'));
    assert.ok(!text.includes(secret));
  }
  assert.equal((await readFile(codex, 'utf8')).split('[mcp_servers.lambdadb]').length, 2);
  result = await f.run(f.init());
  assert.equal(result.code, 0);
  assert.equal(result.data.data.writeTools, false, 'rerunning without opt-in restores read-only tools');
  assert.ok(!toml(await readFile(codex, 'utf8')).mcp_servers.lambdadb.args.includes('--write-tools'));
});

test('user scope honors CODEX_HOME and preserves existing skill and unrelated Claude account state', async t => {
  const f = await fixture(t);
  const codexHome = join(f.root, 'custom-codex');
  await f.file(join(f.home, '.claude.json'), '{"account":{"id":"preserved"},"mcpServers":{"other":{"command":"x"}}}');
  const skillPath = join(f.home, '.agents/skills/lambdadb/SKILL.md');
  await f.file(skillPath, 'User-maintained LambdaDB skill\n');
  const result = await f.run(f.init('codex,claude,cursor', 'user'), { CODEX_HOME: codexHome });
  assert.equal(result.code, 0, result.stderr);
  assert.match(await readFile(join(codexHome, 'config.toml'), 'utf8'), /mcp_servers.lambdadb/);
  assert.equal(await readFile(skillPath, 'utf8'), 'User-maintained LambdaDB skill\n');
  await assert.rejects(readFile(join(dirname(skillPath), 'references/usage.md')), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(join(f.home, '.claude.json'), 'utf8')).account, { id: 'preserved' });
  assert.ok(result.data.data.files.every(file => !file.path.startsWith(f.cwd)));
});

test('skill references preserve user edits and missing bundled references are restored safely', async t => {
  const f = await fixture(t);
  const reference = join(await realpath(f.cwd), '.agents/skills/lambdadb/references/usage.md');
  assert.equal((await f.run(f.init('codex'))).code, 0);
  const bundled = await readFile(reference, 'utf8');
  await f.file(reference, 'User-maintained usage notes\n');
  let result = await f.run(f.init('codex'));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(reference, 'utf8'), 'User-maintained usage notes\n');
  assert.equal(result.data.data.files.find(file => file.path === reference).action, 'unchanged');
  await rm(reference);
  result = await f.run(f.init('codex'));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(reference, 'utf8'), bundled);
  assert.equal(result.data.data.files.find(file => file.path === reference).action, 'create');
});

test('additional agents preserve configuration, credentials and reruns in their supported scopes', async t => {
  for (const scope of ['project', 'user']) {
    for (const agent of ['vscode', 'gemini', 'opencode', 'copilot', 'kiro', ...(scope === 'user' ? ['cline'] : [])]) {
      await t.test(`${agent} ${scope}`, async t => {
        const f = await fixture(t);
        const vscodeUser = process.platform === 'darwin' ? join(f.home, 'Library', 'Application Support', 'Code', 'User')
          : process.platform === 'win32' ? join(f.home, 'AppData', 'Roaming', 'Code', 'User') : join(f.home, '.config', 'Code', 'User');
        const root = scope === 'project' ? f.cwd : f.home;
        const cases = {
          vscode: { path: scope === 'project' ? join(root, '.vscode', 'mcp.json') : join(vscodeUser, 'mcp.json'),
            map: 'servers', other: { type: 'stdio', command: 'keep' },
            extra: { inputs: [{ id: 'keep-input', type: 'promptString', description: 'Keep input' }] },
            skill: join(root, scope === 'project' ? '.github' : '.copilot', 'skills', 'lambdadb', 'SKILL.md'), placeholder: '${env:CUSTOM_PROJECT_KEY}' },
          gemini: { path: join(root, '.gemini', 'settings.json'), map: 'mcpServers', other: { command: 'keep' },
            extra: { ui: { theme: 'Default' } }, skill: join(root, '.gemini', 'skills', 'lambdadb', 'SKILL.md'), placeholder: '${CUSTOM_PROJECT_KEY}' },
          opencode: { path: scope === 'project' ? join(root, 'opencode.jsonc') : join(root, '.config', 'opencode', 'opencode.jsonc'),
            map: 'mcp', other: { type: 'local', command: ['keep'] }, extra: { model: 'provider/model' },
            skill: scope === 'project' ? join(root, '.opencode', 'skills', 'lambdadb', 'SKILL.md') : join(root, '.config', 'opencode', 'skills', 'lambdadb', 'SKILL.md'),
            placeholder: '{env:CUSTOM_PROJECT_KEY}' },
          copilot: { path: scope === 'project' ? join(root, '.mcp.json') : join(root, '.copilot', 'mcp-config.json'),
            map: 'mcpServers', other: { type: 'stdio', command: 'keep' }, extra: {},
            skill: join(root, scope === 'project' ? '.github' : '.copilot', 'skills', 'lambdadb', 'SKILL.md'), placeholder: '${CUSTOM_PROJECT_KEY}' },
          kiro: { path: join(root, '.kiro', 'settings', 'mcp.json'), map: 'mcpServers', other: { command: 'keep' }, extra: {},
            skill: join(root, '.kiro', 'skills', 'lambdadb', 'SKILL.md'), placeholder: '${CUSTOM_PROJECT_KEY}' },
          cline: { path: join(vscodeUser, 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
            map: 'mcpServers', other: { command: 'keep' }, extra: {},
            skill: join(root, '.cline', 'skills', 'lambdadb', 'SKILL.md'), placeholder: '${env:CUSTOM_PROJECT_KEY}' },
        };
        const c = cases[agent];
        const original = { [c.map]: { other: c.other }, ...c.extra };
        await f.file(c.path, `${['cline', 'copilot'].includes(agent) ? '' : '// Keep this comment\n'}${JSON.stringify(original, null, 2)}\n`);
        let result = await f.run(f.init(agent, scope));
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.data.data.files.length, 4);
        const text = await readFile(c.path, 'utf8');
        const value = jsonc(text);
        const server = value[c.map].lambdadb;
        assert.deepEqual(value[c.map].other, c.other);
        for (const key of Object.keys(c.extra)) assert.deepEqual(value[key], c.extra[key]);
        if (!['cline', 'copilot'].includes(agent)) assert.match(text, /Keep this comment/);
        assert.ok(!text.includes(secret));
        assert.equal((server.env ?? server.environment).CUSTOM_PROJECT_KEY, c.placeholder);
        const args = agent === 'opencode' ? server.command.slice(1) : server.args;
        assert.equal(agent === 'opencode' ? server.command[0] : server.command, 'npx');
        assert.deepEqual(args.slice(2), ['mcp', '--endpoint', f.endpoint, '--project', 'existing-project', '--api-key-env', 'CUSTOM_PROJECT_KEY']);
        assert.equal(server.type, ['gemini', 'kiro'].includes(agent) ? undefined : agent === 'opencode' ? 'local' : 'stdio');
        assert.match(await readFile(c.skill, 'utf8'), /name: lambdadb/);
        assert.equal(await readFile(join(dirname(c.skill), 'references/usage.md'), 'utf8'),
          await readFile(new URL('../skills/lambdadb/references/usage.md', import.meta.url), 'utf8'));
        result = await f.run(f.init(agent, scope));
        assert.equal(result.code, 0, result.stderr);
        assert.ok(result.data.data.files.every(file => file.action === 'unchanged'));
        assert.equal(await readFile(c.path, 'utf8'), text);
        result = await f.run(f.init(agent, scope, ['--write-tools', '--project', 'second-project']));
        assert.equal(result.code, 0, result.stderr);
        const updated = jsonc(await readFile(c.path, 'utf8'))[c.map].lambdadb;
        const updatedArgs = agent === 'opencode' ? updated.command : updated.args;
        assert.ok(updatedArgs.includes('--write-tools'));
        assert.ok(updatedArgs.includes('second-project'));
        assert.equal(f.requests.length, 3);
        assert.ok(f.requests.every(request => request.method === 'GET'));
        // Existing, user-edited entries must remain untouched on rerun.
        const edited = jsonc(await readFile(c.path, 'utf8'));
        (edited[c.map].lambdadb.env ?? edited[c.map].lambdadb.environment).UNRELATED = 'preserve';
        await f.file(c.path, JSON.stringify(edited));
        result = await f.run(f.init(agent, scope));
        assert.equal(result.code, 2);
        assert.equal(await readFile(c.path, 'utf8'), JSON.stringify(edited));
        assert.equal(f.requests.length, 3);
      });
    }
  }
});

test('all six agents can be installed together with separate skill paths', async t => {
  const f = await fixture(t);
  const names = 'codex,claude,cursor,vscode,gemini,opencode';
  const result = await f.run(f.init(names));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.data.data.agents, names.split(','));
  assert.equal(result.data.data.files.length, 19);
  assert.equal(f.requests.length, 1);
});

test('all nine agents install together at user scope, sharing the Copilot and VS Code skill once', async t => {
  const f = await fixture(t);
  const names = 'codex,claude,cursor,vscode,gemini,opencode,copilot,kiro,cline';
  let result = await f.run(f.init(names, 'user'));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.data.data.agents, names.split(','));
  assert.equal(result.data.data.files.length, 26);
  const shared = result.data.data.files.find(file => file.path === join(f.home, '.copilot', 'skills', 'lambdadb', 'SKILL.md'));
  assert.match(shared.kind, /vscode skill.*copilot skill/);
  const sharedReference = result.data.data.files.filter(file => file.path === join(dirname(shared.path), 'references/usage.md'));
  assert.equal(sharedReference.length, 1);
  assert.match(sharedReference[0].kind, /vscode skill reference.*copilot skill reference/);
  assert.equal(f.requests.length, 1);
  result = await f.run(f.init(names, 'user'));
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.data.data.files.every(file => file.action === 'unchanged'));
});

test('Claude and Copilot share a project MCP file and VS Code and Copilot share a skill safely', async t => {
  const f = await fixture(t);
  let result = await f.run(f.init('claude,vscode,copilot'));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.data.data.files.length, 7);
  const sharedMcp = result.data.data.files.find(file => basename(file.path) === '.mcp.json');
  assert.match(sharedMcp.kind, /claude MCP.*copilot MCP/);
  const text = await readFile(sharedMcp.path, 'utf8');
  assert.equal(JSON.parse(text).mcpServers.lambdadb.env.CUSTOM_PROJECT_KEY, '${CUSTOM_PROJECT_KEY}');
  result = await f.run(f.init('claude,vscode,copilot'));
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.data.data.files.every(file => file.action === 'unchanged'));
  assert.equal(await readFile(sharedMcp.path, 'utf8'), text);
});

test('shared MCP symlinks and CLI settings symlinks retain their targets across updates and reruns', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const shared = join(f.root, 'shared-mcp.json');
  const cliTarget = join(f.root, 'shared-cli.json');
  const cwd = await realpath(f.cwd);
  const gemini = join(cwd, '.gemini', 'settings.json');
  const kiro = join(cwd, '.kiro', 'settings', 'mcp.json');
  await f.file(shared, '// Preserve shared settings\n{"mcpServers":{"other":{"command":"keep"}}}\n');
  await f.file(cliTarget, JSON.stringify({ endpoint: f.endpoint, project: 'old-project', apiKeyEnv: 'CUSTOM_PROJECT_KEY' }));
  for (const path of [gemini, kiro]) {
    await mkdir(dirname(path), { recursive: true });
    await symlink(shared, path);
  }
  await symlink(cliTarget, f.config);
  let result = await f.run(f.init('gemini,kiro'));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.data.data.files.length, 6, 'shared MCP target must be planned only once');
  assert.equal(result.data.data.files.find(file => file.path === gemini).destination, await realpath(shared));
  assert.deepEqual(result.data.data.files.find(file => file.path === gemini).aliases, [kiro]);
  assert.match(result.stderr, / -> .*shared-mcp.json/);
  assert.match(await readFile(shared, 'utf8'), /Preserve shared settings/);
  assert.deepEqual(jsonc(await readFile(shared, 'utf8')).mcpServers.other, { command: 'keep' });
  assert.equal(JSON.parse(await readFile(cliTarget, 'utf8')).project, 'existing-project');
  for (const path of [gemini, kiro, f.config]) assert.ok((await lstat(path)).isSymbolicLink());
  assert.deepEqual(jsonc(await readFile(gemini, 'utf8')), jsonc(await readFile(kiro, 'utf8')));
  assert.ok(jsonc(await readFile(shared, 'utf8')).mcpServers.lambdadb);
  assert.ok(!(await readFile(shared, 'utf8')).includes(secret));
  result = await f.run(f.init('gemini,kiro'));
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.data.data.files.every(file => file.action === 'unchanged'));
  for (const path of [gemini, kiro, f.config]) assert.ok((await lstat(path)).isSymbolicLink());
  assert.equal(f.requests.length, 2);
});

test('retargeting a deduplicated symlink during verification aborts all file writes', { skip: process.platform === 'win32' }, async t => {
  let kiro, other;
  const f = await fixture(t, 200, async () => { await rm(kiro); await symlink(other, kiro); });
  const gemini = join(f.cwd, '.gemini', 'settings.json');
  kiro = join(f.cwd, '.kiro', 'settings', 'mcp.json');
  const shared = join(f.root, 'shared.json');
  other = join(f.root, 'other.json');
  const original = '{"mcpServers":{"other":{"command":"keep"}}}\n';
  await f.file(shared, original); await f.file(other, original);
  for (const path of [gemini, kiro]) {
    await mkdir(dirname(path), { recursive: true });
    await symlink(shared, path);
  }
  const result = await f.run(f.init('gemini,kiro'));
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.data.error.message, /Configuration changed during init/);
  assert.equal(await readFile(shared, 'utf8'), original);
  assert.equal(await readFile(other, 'utf8'), original);
  assert.equal(await realpath(kiro), await realpath(other));
  assert.equal(f.requests.length, 1);
  await assert.rejects(readFile(f.config), { code: 'ENOENT' });
});

test('dangling configuration symlinks fail before connection or file changes', { skip: process.platform === 'win32' }, async t => {
  for (const cliSettings of [false, true]) {
    const f = await fixture(t);
    const path = cliSettings ? f.config : join(f.cwd, '.gemini', 'settings.json');
    const missing = join(f.root, 'missing-target.json');
    await mkdir(dirname(path), { recursive: true });
    await symlink(missing, path);
    const result = await f.run(f.init('gemini'));
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.data.error.message, /symbolic link has a missing target/);
    assert.ok((await lstat(path)).isSymbolicLink());
    assert.equal(f.requests.length, 0);
    await assert.rejects(readFile(missing), { code: 'ENOENT' });
    if (!cliSettings) await assert.rejects(readFile(f.config), { code: 'ENOENT' });
  }
});

test('conflicting edits to a shared MCP file stop before any writes or connection', async t => {
  const f = await fixture(t);
  const path = join(f.cwd, '.mcp.json');
  const original = '{"other":{"command":"keep"}}';
  await f.file(path, original);
  const result = await f.run(f.init('claude,copilot'));
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.data.error.message, /conflicting changes/);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.equal(f.requests.length, 0);
  await assert.rejects(readFile(f.config), { code: 'ENOENT' });
});

test('Copilot preserves existing bare maps and selects the higher-priority project file', async t => {
  const f = await fixture(t);
  const shared = join(f.cwd, '.github', 'mcp.json');
  const root = join(f.cwd, '.mcp.json');
  const original = '{"other":{"command":"keep"}}\n';
  await f.file(shared, original);
  let result = await f.run(f.init('copilot'));
  assert.equal(result.code, 0, result.stderr);
  const text = await readFile(shared, 'utf8');
  assert.deepEqual(jsonc(text).other, { command: 'keep' });
  assert.equal(jsonc(text).mcpServers, undefined);
  assert.ok(jsonc(text).lambdadb);
  result = await f.run(f.init('copilot'));
  assert.equal(result.code, 0);
  assert.equal(await readFile(shared, 'utf8'), text);
  await f.file(root, '{"mcpServers":{"root-only":{"command":"keep-root"}}}');
  result = await f.run(f.init('copilot'));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(shared, 'utf8'), text);
  assert.ok(JSON.parse(await readFile(root, 'utf8')).mcpServers.lambdadb);
  assert.equal(JSON.parse(await readFile(root, 'utf8')).mcpServers['root-only'].command, 'keep-root');
});

test('Copilot user MCP settings honor COPILOT_HOME and do not persist the key', async t => {
  const f = await fixture(t);
  const directory = join(f.root, 'copilot-profile');
  const result = await f.run(f.init('copilot', 'user'), { COPILOT_HOME: directory });
  assert.equal(result.code, 0, result.stderr);
  const text = await readFile(join(directory, 'mcp-config.json'), 'utf8');
  assert.equal(JSON.parse(text).mcpServers.lambdadb.env.CUSTOM_PROJECT_KEY, '${CUSTOM_PROJECT_KEY}');
  assert.ok(!text.includes(secret));
  assert.match(await readFile(join(directory, 'skills', 'lambdadb', 'SKILL.md'), 'utf8'), /name: lambdadb/);
});

test('Cline project scope is rejected explicitly without silently writing user settings', async t => {
  const f = await fixture(t);
  const result = await f.run(f.init('codex,cline', 'project'));
  assert.equal(result.code, 2);
  assert.match(result.data.error.message, /Use --scope user/);
  assert.equal(f.requests.length, 0);
  await assert.rejects(readFile(f.config), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.home, '.cline', 'skills', 'lambdadb', 'SKILL.md')), { code: 'ENOENT' });
});

test('Cline refuses JSONC instead of generating settings that its strict JSON parser cannot read', async t => {
  const f = await fixture(t);
  const user = process.platform === 'darwin' ? join(f.home, 'Library', 'Application Support', 'Code', 'User')
    : process.platform === 'win32' ? join(f.home, 'AppData', 'Roaming', 'Code', 'User') : join(f.home, '.config', 'Code', 'User');
  const path = join(user, 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
  const original = '// Keep existing file untouched\n{"mcpServers":{}}';
  await f.file(path, original);
  const result = await f.run(f.init('cline', 'user'));
  assert.equal(result.code, 2);
  assert.match(result.data.error.message, /strict JSON/);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.equal(f.requests.length, 0);
  await assert.rejects(readFile(f.config), { code: 'ENOENT' });
});

test('Copilot leaves commented configuration untouched and requests strict JSON', async t => {
  const f = await fixture(t);
  const path = join(f.cwd, '.mcp.json');
  const original = '// Keep this file\n{"mcpServers":{}}';
  await f.file(path, original);
  const result = await f.run(f.init('copilot'));
  assert.equal(result.code, 2);
  assert.match(result.data.error.message, /strict JSON/);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.equal(f.requests.length, 0);
  await assert.rejects(readFile(f.config), { code: 'ENOENT' });
});

test('OpenCode retains the V2 server map and unrelated timeout settings without introducing a V1 entry', async t => {
  const f = await fixture(t);
  const path = join(f.cwd, 'opencode.json');
  const original = { mcp: { timeout: { catalog: 60000 }, servers: { other: { type: 'local', command: ['keep'] } } } };
  await f.file(path, JSON.stringify(original));
  let result = await f.run(f.init('opencode'));
  assert.equal(result.code, 0, result.stderr);
  let value = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(value.mcp.lambdadb, undefined);
  assert.equal(value.mcp.servers.lambdadb.type, 'local');
  assert.deepEqual(value.mcp.timeout, original.mcp.timeout);
  assert.deepEqual(value.mcp.servers.other, original.mcp.servers.other);
  const text = await readFile(path, 'utf8');
  result = await f.run(f.init('opencode'));
  assert.equal(result.code, 0);
  assert.equal(await readFile(path, 'utf8'), text);
  value.mcp.lambdadb = { type: 'local', command: ['custom-lambdadb'] };
  await f.file(path, JSON.stringify(value));
  result = await f.run(f.init('opencode'));
  assert.equal(result.code, 2);
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(value));
  assert.equal(f.requests.length, 2);
});

test('new agent adapters reject malformed server maps and ambiguous OpenCode filenames before connection', async t => {
  const f = await fixture(t);
  for (const [agent, relative, original] of [
    ['vscode', '.vscode/mcp.json', '{"servers":[]}'],
    ['gemini', '.gemini/settings.json', '{"mcpServers":null}'],
    ['opencode', 'opencode.json', '{"mcp":false}'],
    ['opencode', 'opencode.json', '{"mcp":{"servers":[]}}'],
  ]) {
    const path = join(f.cwd, relative);
    await f.file(path, original);
    const result = await f.run(f.init(agent));
    assert.equal(result.code, 2, result.stderr);
    assert.equal(await readFile(path, 'utf8'), original);
  }
  await f.file(join(f.cwd, 'opencode.json'), '{}');
  await f.file(join(f.cwd, 'opencode.jsonc'), '{}');
  const result = await f.run(f.init('opencode'));
  assert.equal(result.code, 2);
  assert.match(result.data.error.message, /Both .*opencode.json.*opencode.jsonc/);
  assert.equal(f.requests.length, 0);
  await assert.rejects(readFile(f.config), { code: 'ENOENT' });
});

test('an OpenCode V1 server named servers is preserved as a server', async t => {
  const f = await fixture(t);
  const path = join(f.cwd, 'opencode.json');
  const other = { type: 'local', command: ['keep'] };
  await f.file(path, JSON.stringify({ mcp: { servers: other } }));
  const result = await f.run(f.init('opencode'));
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(value.mcp.servers, other);
  assert.equal(value.mcp.lambdadb.type, 'local');
});

test('Gemini user scope honors GEMINI_CLI_HOME as a parent directory', async t => {
  const f = await fixture(t);
  const home = join(f.root, 'gemini-profile');
  const result = await f.run(f.init('gemini', 'user'), { GEMINI_CLI_HOME: home });
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(await readFile(join(home, '.gemini/settings.json'), 'utf8'));
  assert.equal(value.mcpServers.lambdadb.env.CUSTOM_PROJECT_KEY, '${CUSTOM_PROJECT_KEY}');
  assert.match(await readFile(join(home, '.gemini/skills/lambdadb/SKILL.md'), 'utf8'), /name: lambdadb/);
  await assert.rejects(readFile(join(f.home, '.gemini/settings.json')), { code: 'ENOENT' });
});

test('non-interactive init rejects missing choices, target or credentials before changing files or using the network', async t => {
  const f = await fixture(t);
  for (const [args, env, message] of [
    [['init', '--json'], {}, /--non-interactive/],
    [['init', '--non-interactive', '--json'], {}, /--agents/],
    [['init', '--non-interactive', '--agents', 'none', '--json'], {}, /--scope/],
    [f.init('invalid'), {}, /--agents/],
    [f.init(), { CUSTOM_PROJECT_KEY: '' }, /Export CUSTOM_PROJECT_KEY/],
    [f.init(), { LAMBDADB_ENDPOINT: '' }, /Endpoint and project/],
    [f.init(), { LAMBDADB_PROJECT: '' }, /Endpoint and project/],
    [f.init(), { CUSTOM_PROJECT_KEY: 'invalid\nkey' }, /missing or invalid/],
  ]) {
    const result = await f.run(args, env);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.data.error.message, message);
    await assert.rejects(readFile(f.config), { code: 'ENOENT' });
  }
  assert.equal(f.requests.length, 0);
});

test('custom Claude user directory contains both MCP settings and skill', async t => {
  const f = await fixture(t);
  const directory = join(f.root, 'claude-profile');
  const result = await f.run(f.init('claude', 'user'), { CLAUDE_CONFIG_DIR: directory });
  assert.equal(result.code, 0, result.stderr);
  const settings = JSON.parse(await readFile(join(directory, '.claude.json'), 'utf8'));
  assert.equal(settings.mcpServers.lambdadb.env.CUSTOM_PROJECT_KEY, '${CUSTOM_PROJECT_KEY}');
  assert.match(await readFile(join(directory, 'skills/lambdadb/SKILL.md'), 'utf8'), /name: lambdadb/);
  await assert.rejects(readFile(join(f.home, '.claude.json')), { code: 'ENOENT' });
});

test('overlapping CLI and agent configuration paths fail before connection or writes', async t => {
  const f = await fixture(t);
  const path = join(f.cwd, '.mcp.json');
  const result = await f.run(f.init('claude', 'project', ['--config', path]));
  assert.equal(result.code, 2);
  assert.match(result.data.error.message, /overlaps/);
  assert.equal(f.requests.length, 0);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('authentication failure leaves all configuration untouched and does not echo the service body', async t => {
  const f = await fixture(t, 401);
  const result = await f.run(f.init());
  assert.equal(result.code, 3);
  assert.equal(result.data.error.code, 'AUTH_ERROR');
  assert.equal(f.requests.length, 1);
  for (const path of [f.config, join(f.cwd, '.mcp.json'), join(f.cwd, '.codex/config.toml')]) {
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  }
});

test('invalid or conflicting configurations are preserved and stop init before connection or any writes', async t => {
  const f = await fixture(t);
  for (const [relative, content, agent] of [
    ['.mcp.json', '{broken', 'claude'],
    ['.mcp.json', '{"mcpServers":{"lambdadb":{"command":"my-server","env":{"TOKEN":"keep"}}}}', 'claude'],
    ['.cursor/mcp.json', '{"mcpServers":[]}', 'cursor'],
    ['.codex/config.toml', '[mcp_servers.lambdadb]\ncommand="my-server"\n', 'codex'],
    ['.codex/config.toml', 'mcp_servers={other={command="keep"}}\n', 'codex'],
    ['.codex/config.toml', 'invalid toml', 'codex'],
  ]) {
    const path = join(f.cwd, relative);
    await f.file(path, content);
    const result = await f.run(f.init(agent));
    assert.equal(result.code, 2, result.stderr);
    assert.equal(await readFile(path, 'utf8'), content);
    await assert.rejects(readFile(f.config), { code: 'ENOENT' });
  }
  assert.equal(f.requests.length, 0);
});

test('user edits inside an init-owned entry are preserved on rerun', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(f.init('codex,claude'))).code, 0);
  const codex = join(f.cwd, '.codex/config.toml');
  const edited = (await readFile(codex, 'utf8')).replace('env_vars =', 'startup_timeout_sec = 42\nenv_vars =');
  await f.file(codex, edited);
  let result = await f.run(f.init('codex'));
  assert.equal(result.code, 2);
  assert.equal(await readFile(codex, 'utf8'), edited);
  const claude = join(f.cwd, '.mcp.json');
  const value = JSON.parse(await readFile(claude, 'utf8'));
  value.mcpServers.lambdadb.env.OTHER = 'preserved';
  const json = JSON.stringify(value);
  await f.file(claude, json);
  result = await f.run(f.init('claude'));
  assert.equal(result.code, 2);
  assert.equal(await readFile(claude, 'utf8'), json);
});

test('agents none saves only non-secret CLI settings and still verifies connection', async t => {
  const f = await fixture(t);
  const result = await f.run(f.init('none'));
  assert.doesNotMatch(result.stderr, /No agents selected|Return to agent selection/);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.data.data.files.length, 1);
  assert.equal(f.requests.length, 1);
  assert.ok(!(await readFile(f.config, 'utf8')).includes(secret));
});

test('MCP launcher maps the custom credential at runtime, overrides inherited write opt-in, removes SDK debug logging and keeps stdout for stdio', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const bin = join(f.root, 'bin');
  const capture = join(f.root, 'child.json');
  await f.file(join(bin, 'npx'), `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(process.env.CAPTURE, JSON.stringify({args:process.argv.slice(2),endpoint:process.env.LAMBDADB_BASE_URL,project:process.env.LAMBDADB_PROJECT_NAME,key:process.env.LAMBDADB_PROJECT_API_KEY,writes:process.env.LAMBDADB_MCP_ENABLE_WRITE_TOOLS,npmExecKeys:Object.keys(process.env).filter(key=>/^npm_config_(package|call)$/i.test(key)),registry:process.env.npm_config_registry,debug:Object.hasOwn(process.env,'LAMBDADB_DEBUG')}));\nprocess.stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\\n');\nprocess.exit(Number(process.env.CHILD_EXIT ?? 0));\n`);
  const { chmod } = await import('node:fs/promises');
  await chmod(join(bin, 'npx'), 0o755);
  const env = { PATH: bin + delimiter + process.env.PATH, CAPTURE: capture, LAMBDADB_MCP_ENABLE_WRITE_TOOLS: 'true', LAMBDADB_PROJECT_API_KEY: 'wrong-inherited-key', npm_config_package: '@functional-systems/lambdadb-cli@0.1.7-dev.1', NPM_CONFIG_CALL: 'outer-command', npm_config_registry: 'https://registry.npmjs.org', LAMBDADB_DEBUG: 'true' };
  let result = await f.run(['mcp'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '{"jsonrpc":"2.0","id":1,"result":{}}\n');
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), {
    args: ['-y', '@functional-systems/lambdadb-mcp@0.2.0'], endpoint: f.endpoint,
    project: 'existing-project', key: secret, writes: 'false', npmExecKeys: [], registry: env.npm_config_registry, debug: false,
  });
  result = await f.run(['mcp', '--write-tools'], { ...env, CHILD_EXIT: '7', NPM_CONFIG_PACKAGE: 'another-package', npm_config_call: 'another-command' });
  assert.equal(result.code, 7);
  assert.equal(JSON.parse(await readFile(capture, 'utf8')).writes, 'true');
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')).npmExecKeys, []);
  for (const key of ['', '${CUSTOM_PROJECT_KEY}', '${env:CUSTOM_PROJECT_KEY}', '{env:CUSTOM_PROJECT_KEY}']) {
    result = await f.run(['mcp'], { ...env, CUSTOM_PROJECT_KEY: key });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
  }
  result = await f.run(['mcp', '--json'], env);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  result = await f.run(['mcp', '--invalid-option'], env);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
});

test('interactive first use uses a consistent menu and can cancel before requests', async t => {
  const f = await fixture(t);
  const result = await f.run(['init'], { LAMBDADB_ENDPOINT: '', LAMBDADB_PROJECT: '' }, [['Connection', cancel]]);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /Sign in or create an account/);
  assert.match(result.stderr, /Use an existing API key/);
  assert.equal(f.requests.length, 0);
  await assert.rejects(readFile(f.config), { code: 'ENOENT' });
});

test('manual setup reviews new settings without irrelevant agent options', async t => {
  const f = await fixture(t);
  const result = await f.run(['init', '--agents', 'none'], { LAMBDADB_ENDPOINT: '', LAMBDADB_PROJECT: '' }, [
    ['Connection', keys(down, '\r')], ['Project API endpoint', f.endpoint], ['Project name', 'existing-project'],
    ['API key environment variable', enter], ['Continue with this setup?', keys(up, up, '\r')],
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Review changes/);
  assert.match(result.stderr, /https:\/\/app\.lambdadb\.ai/);
  assert.match(result.stderr, /enter only its environment-variable name/);
  assert.match(result.stderr, /create\s+~\/cli.json/);
  assert.doesNotMatch(result.stderr, /Scope:|MCP tools:|Change options/);
  assert.equal(JSON.parse(await readFile(f.config, 'utf8')).apiKeyEnv, 'CUSTOM_PROJECT_KEY');
  assert.equal(f.requests.length, 1);
});

test('saved connections show optional details and verify without an apply prompt', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(f.init('none'))).code, 0);
  const before = await readFile(f.config, 'utf8');
  const result = await f.run(['init', '--agents', 'none'], {}, [['Connection', enter]]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Project\s+existing-project/);
  assert.match(result.stdout, /Agents\s+Skipped/);
  assert.match(result.stdout, /lambdadb collections list --json/);
  assert.match(result.stderr, /Authentication and collection access verified/);
  assert.doesNotMatch(result.stderr, /Review changes|Continue with this setup|MCP tools:/);
  assert.equal(await readFile(f.config, 'utf8'), before);
  const detail = await f.run(['init'], {}, [
    ['Connection', keys(down, down, '\r')], ['Connection', cancel],
  ]);
  assert.equal(detail.code, 2, detail.stderr);
  assert.match(detail.stderr, /Current connection/);
  assert.ok(detail.stderr.includes(f.endpoint));
  assert.equal(f.requests.length, 2);
});

test('npx runs suggest CLI commands that work without a global install', async t => {
  const f = await fixture(t);
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const command = `npx -y @functional-systems/lambdadb-cli@${version}`;
  const json = await f.run(f.init(), { npm_command: 'exec' });
  assert.equal(json.code, 0, json.stderr);
  const reads = JSON.parse(json.stdout).data.nextSteps.find(step => step.startsWith('CLI reads:'));
  assert.ok(reads.includes(`run ${command} collections list --json`), reads);
  assert.ok(!/(^|[^-])lambdadb (collections|query)/.test(reads), reads);
  const result = await f.run(['init', '--agents', 'none'], { npm_command: 'exec' }, [['Connection', enter]]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes(`${command} collections list --json`), result.stdout);
});

test('explicit target flags bypass the connection menu and retain text defaults', async t => {
  const f = await fixture(t);
  const result = await f.run(['init', '--endpoint', f.endpoint, '--project', 'existing-project', '--agents', 'none'], {}, [
    ['Project API endpoint', enter], ['Project name', enter], ['API key environment variable', enter],
    ['Continue with this setup?', keys(up, up, '\r')],
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Use current project/);
  assert.equal(f.requests.length, 1);
});

test('help presents init without a connect flag and explains browser approval and agent scope', async t => {
  const f = await fixture(t);
  const help = await f.run(['init', '--help']);
  assert.equal(help.code, 0);
  assert.doesNotMatch(help.stdout, /--connect/);
  assert.match(help.stdout, /Get started: lambdadb init/);
  assert.match(help.stdout, /browser approval is still required/);
  assert.match(help.stdout, /does not change CLI config/);
  const global = await f.run(['--help']);
  assert.match(global.stdout, /Advanced connection options:/);
  assert.match(global.stdout, /Project data API origin/);
  const login = await f.run(['login', '--help']);
  assert.match(login.stdout, /sign in and approve/);
  assert.equal(f.requests.length, 0);
});


test('agent multiselect is explicit, supports toggling, and displays friendly names', async t => {
  const f = await fixture(t);
  await f.file(join(f.home, '.codex/config.toml'), '');
  await f.file(join(f.home, '.claude/settings.json'), '{}');
  assert.equal((await f.run(f.init('none'))).code, 0);
  const result = await f.run(['init'], {}, [
    ['Connection', enter], ['Coding agents (Space: select one or more; Enter: confirm)', keys(' ', down, ' ', up, ' ', '\r')],
    ['Continue with this setup?', keys(up, up, up, '\r')],
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Codex|Claude Code/);
  assert.match(result.stdout, /Agents\s+Claude Code/);
  assert.match(result.stdout, /project scope · MCP read-only/);
  assert.doesNotMatch(result.stderr, /No agents selected/);
  assert.doesNotMatch(result.stdout, /"checks"|credentialId/);
  assert.ok(await readFile(join(f.cwd, '.mcp.json'), 'utf8'));
  await assert.rejects(readFile(join(f.cwd, '.codex/config.toml')), { code: 'ENOENT' });
  assert.equal(f.requests.length, 2);
});

test('explicitly skipping empty agent selection omits review and preserves read-only settings', async t => {
  const f = await fixture(t);
  await f.file(join(f.home, '.codex/config.toml'), '');
  assert.equal((await f.run(f.init('none'))).code, 0);
  const before = await readFile(f.config, 'utf8');
  const result = await f.run(['init'], { NO_COLOR: '1' }, [
    ['Connection', enter], ['Coding agents (Space: select one or more; Enter: confirm)', enter],
    ['No agents selected', keys(down, '\r')],
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Agents\s+Skipped/);
  assert.doesNotMatch(result.stderr, /Review changes|Continue with this setup|Scope:|MCP tools:/);
  // eslint-disable-next-line no-control-regex -- NO_COLOR must remove SGR color/style escapes.
  assert.doesNotMatch(result.stdout + result.stderr, /\x1b\[[0-9;]*m/);
  const canceled = await f.run(['init'], {}, [['Connection', enter], ['Coding agents (Space: select one or more; Enter: confirm)', cancel]]);
  assert.equal(canceled.code, 2, canceled.stderr);
  assert.equal(await readFile(f.config, 'utf8'), before);
  await assert.rejects(readFile(join(f.cwd, '.mcp.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.cwd, '.codex/config.toml')), { code: 'ENOENT' });
  assert.equal(f.requests.length, 2);
});

test('connection failure preserves settings and never prints a completion result', async t => {
  const f = await fixture(t, 403);
  const before = JSON.stringify({ endpoint: f.endpoint, project: 'existing-project', apiKeyEnv: 'CUSTOM_PROJECT_KEY' }, null, 2) + '\n';
  await f.file(f.config, before);
  const result = await f.run(['init', '--agents', 'none'], {}, [['Connection', enter]]);
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stderr, /Connection verification failed/);
  assert.doesNotMatch(result.stderr, /Setup complete/);
  assert.equal(await readFile(f.config, 'utf8'), before);
  assert.equal(f.requests.length, 1);
});

test('connection progress cancellation aborts the read and retains input-error semantics', async t => {
  const f = await fixture(t, 200, () => new Promise(() => {}));
  const before = JSON.stringify({ endpoint: f.endpoint, project: 'existing-project', apiKeyEnv: 'CUSTOM_PROJECT_KEY' }, null, 2) + '\n';
  await f.file(f.config, before);
  const result = await f.run(['init', '--agents', 'none'], {}, [
    ['Connection', enter], ['error:Verifying connection', { signal: 'SIGINT' }],
  ]);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /Init canceled/);
  assert.equal(await readFile(f.config, 'utf8'), before);
  assert.equal(f.requests.length, 1);
});

test('settings use select/confirm controls, retain write opt-in, and review the changed scope', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(f.init('none'))).code, 0);
  const result = await f.run(['init', '--agents', 'codex'], {}, [
    ['Connection', enter], ['Continue with this setup?', keys(up, up, '\r')],
    ['Install for', enter], ['Enable MCP write tools?', keys(left, '\r')],
    ['Continue with this setup?', keys(up, up, '\r')],
    ['Install for', keys(down, '\r')], ['Enable MCP write tools?', enter],
    ...Array.from({ length: 2 }, () => [
      ['Continue with this setup?', keys(up, up, '\r')],
      ['Install for', enter], ['Enable MCP write tools?', enter],
    ]).flat(),
    ['Continue with this setup?', keys(up, up, up, '\r')],
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /MaxListenersExceededWarning/);
  assert.match(result.stdout, /user scope · MCP read and write/);
  assert.ok(toml(await readFile(join(f.home, '.codex/config.toml'), 'utf8')).mcp_servers.lambdadb.args.includes('--write-tools'));
  await assert.rejects(readFile(join(f.cwd, '.codex/config.toml')), { code: 'ENOENT' });
});

test('flag-based write opt-in remains selected when settings confirmation uses Enter', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(f.init('none'))).code, 0);
  const result = await f.run(['init', '--agents', 'codex', '--write-tools'], {}, [
    ['Connection', enter], ['Continue with this setup?', keys(up, up, '\r')],
    ['Install for', keys(down, '\r')], ['Enable MCP write tools?', enter],
    ['Continue with this setup?', keys(up, up, up, '\r')],
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /user scope · MCP read and write/);
});

for (const step of ['agents', 'empty selection', 'user scope']) {
  test(`manual setup canceled at ${step} reports no saved connection`, async t => {
    const f = await fixture(t);
    const result = await f.run(['init', '--endpoint', f.endpoint, '--project', 'existing-project', ...(step === 'user scope' ? ['--agents', 'cline'] : [])], {}, [
      ['Project API endpoint', enter], ['Project name', enter], ['API key environment variable', enter],
      ...(step === 'agents' ? [['Coding agents (Space: select one or more; Enter: confirm)', cancel]]
        : step === 'empty selection' ? [['Coding agents (Space: select one or more; Enter: confirm)', enter], ['No agents selected', cancel]]
          : [['Install agent settings for your OS user?', enter]]),
    ]);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /Init canceled\. No files were changed\. Rerun lambdadb init when ready\.\n$/);
    assert.ok(!result.stderr.includes('Check --help'));
    await assert.rejects(readFile(f.config), { code: 'ENOENT' });
    assert.equal(f.requests.length, 0);
  });
}

test('file details preserve full JSON metadata and unchanged agents still offer settings', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(f.init('none'))).code, 0);
  const result = await f.run(['init', '--agents', 'codex'], {}, [
    ['Connection', enter], ['Continue with this setup?', keys(up, '\r')],
    ['Continue with this setup?', keys(up, up, up, '\r')],
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /All files/);
  assert.match(result.stderr, /unchanged\s+~\/cli.json/);
  const json = await f.run(f.init('codex'));
  assert.equal(json.code, 0, json.stderr);
  assert.equal(json.data.data.files.length, 4);
  assert.ok(json.data.data.files.every(file => file.action === 'unchanged'));
  const canceled = await f.run(['init', '--agents', 'codex'], {}, [['Connection', enter], ['Continue with this setup?', enter]]);
  assert.equal(canceled.code, 2, canceled.stderr);
  assert.match(canceled.stderr, /Change options/);
  assert.match(canceled.stderr, /No file changes/);
  assert.equal(f.requests.length, 3);
});

test('planning conflicts allow user scope without overwriting a manual project entry', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(f.init('none'))).code, 0);
  const path = join(f.cwd, '.mcp.json');
  const original = '{"mcpServers":{"lambdadb":{"command":"manual-server"}}}\n';
  await f.file(path, original);
  const result = await f.run(['init', '--agents', 'claude'], {}, [
    ['Connection', enter], ['Configuration scope', keys(up, '\r')],
    ['Continue with this setup?', keys(up, up, up, '\r')],
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.ok(JSON.parse(await readFile(join(f.home, '.claude.json'), 'utf8')).mcpServers.lambdadb);
  assert.equal(f.requests.length, 2);
  const nonInteractive = await f.run(f.init('claude'));
  assert.equal(nonInteractive.code, 2);
  assert.doesNotMatch(nonInteractive.stderr, /Configuration scope/);
});


test('whitespace-only interactive input retains endpoint, project and key-variable defaults', async t => {
  const f = await fixture(t);
  const result = await f.run(['init', '--endpoint', f.endpoint, '--project', 'existing-project', '--agents', 'none'], {}, [
    ['Project API endpoint', ' '], ['Project name', ' '], ['API key environment variable', ' '],
    ['Continue with this setup?', keys(up, up, '\r')],
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(f.config, 'utf8')), { endpoint: f.endpoint, project: 'existing-project', apiKeyEnv: 'CUSTOM_PROJECT_KEY' });
  assert.equal(f.requests.length, 1);
});

test('interactive agent guidance includes environment requirements, selected-agent steps and environment-selected config', async t => {
  const f = await fixture(t);
  const result = await f.run(['init', '--agents', 'codex,vscode'], {}, [
    ['Connection', enter], ['Continue with this setup?', keys(up, up, up, '\r')],
  ]);
  assert.equal(result.code, 0, result.stderr);
  const summary = result.stdout.replace(/\s+/g, ' ');
  assert.match(summary, /CUSTOM_PROJECT_KEY in the agent environment and npx on PATH/);
  assert.match(summary, /GUI launches may not inherit shell exports/);
  assert.match(summary, /Codex: trust the project/);
  assert.match(summary, /VS Code: reload the window, trust the workspace/);
  assert.doesNotMatch(summary, /Claude Code:|Gemini CLI:/);
  assert.ok(result.stdout.includes(`Config   ${f.config}`));
  assert.ok(result.stdout.includes(`CLI config ${JSON.stringify(f.config)}`));
});

test('the normal XDG config does not add custom-path guidance', async t => {
  const f = await fixture(t);
  const result = await f.run(['init', '--agents', 'none'], { LAMBDADB_CONFIG: undefined }, [
    ['Connection', enter], ['Continue with this setup?', keys(up, up, '\r')],
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Config|pass --config/);
  assert.ok(await readFile(join(f.home, '.config/lambdadb/config.json'), 'utf8'));
});

for (const stage of ['first', 'last']) {
  test(`Ctrl-C during the ${stage} agent file save reports cancellation instead of success`, async t => {
    const f = await fixture(t);
    assert.equal((await f.run(f.init('none'))).code, 0);
    const preload = join(f.root, 'cancel-save.mjs');
    await f.file(preload, `
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const original = fs.writeFile;
      fs.writeFile = async (path, ...args) => {
        const result = await original(path, ...args);
        if (String(path).includes(${JSON.stringify(stage === 'first' ? 'config.toml.' : 'usage.md.')})) {
          process.kill(process.pid, 'SIGINT');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        return result;
      };
      syncBuiltinESMExports();
    `);
    const result = await f.run(['init', '--agents', 'codex'], { NODE_OPTIONS: `--import=${preload}` }, [
      ['Connection', enter], ['Continue with this setup?', keys(up, up, up, '\r')],
    ]);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /Init canceled while saving setup/);
    assert.match(result.stderr, /Some files may already be updated/);
    assert.doesNotMatch(result.stderr + result.stdout, /Setup complete|No files were changed/);
    if (stage === 'first') await assert.rejects(readFile(join(f.cwd, '.agents/skills/lambdadb/SKILL.md')), { code: 'ENOENT' });
    assert.equal((await f.run(f.init('codex'))).code, 0);
    assert.ok(await readFile(join(f.cwd, '.agents/skills/lambdadb/references/usage.md'), 'utf8'));
    assert.ok(f.requests.every(request => request.method === 'GET'));
  });
}


test('Enter on a focused agent returns to selection by default until agents are checked', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(f.init('none'))).code, 0);
  const result = await f.run(['init'], {}, [
    ['Connection', enter],
    ['Coding agents (Space: select one or more; Enter: confirm)', keys(down, '\r')],
    ['No agents selected', enter],
    ['Coding agents (Space: select one or more; Enter: confirm)', enter],
    ['No agents selected', enter],
    ['Coding agents (Space: select one or more; Enter: confirm)', keys(down, ' ', down, ' ', '\r')],
    ['Continue with this setup?', keys(up, up, up, '\r')],
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Agents\s+Claude Code, Cursor/);
  assert.ok(await readFile(join(f.cwd, '.mcp.json'), 'utf8'));
  assert.ok(await readFile(join(f.cwd, '.cursor/mcp.json'), 'utf8'));
  await assert.rejects(readFile(join(f.cwd, '.codex/config.toml')), { code: 'ENOENT' });
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(request => request.method === 'GET'));
});
