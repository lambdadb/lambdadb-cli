import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { lstat, mkdtemp, mkdir, readFile, realpath, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, delimiter } from 'node:path';
import { parse as toml } from 'smol-toml';
import { parse as jsonc } from 'jsonc-parser';

const cli = process.env.LAMBDADB_TEST_CLI ?? resolve('dist/cli.js');
const secret = 'synthetic-init-key-never-persist';

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
    && !['XDG_CONFIG_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'VSCODE_PORTABLE', 'VSCODE_APPDATA', 'COPILOT_HOME', 'APPDATA', 'HOME', 'USERPROFILE'].includes(key)));
  async function run(args, env = {}, answers) {
    const preload = join(root, 'interactive.mjs');
    if (answers) await writeFile(preload, 'process.stdin.isTTY = true; process.stderr.isTTY = true;\n');
    const child = spawn(process.execPath, [...(answers ? ['--import', preload] : []), cli, ...args], { cwd, env: {
      ...cleanEnv, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), APPDATA: join(home, 'AppData', 'Roaming'), LAMBDADB_CONFIG: config,
      LAMBDADB_ENDPOINT: endpoint, LAMBDADB_PROJECT: 'existing-project', CUSTOM_PROJECT_KEY: secret,
      LAMBDADB_API_KEY_ENV: 'CUSTOM_PROJECT_KEY', ...env,
    }, stdio: [answers ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    let answered = 0, cursor = 0;
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (answers && answered < answers.length && stderr.slice(cursor).includes(answers[answered][0])) {
        cursor = stderr.length;
        const answer = answers[answered++][1];
        if (typeof answer === 'string') child.stdin.write(answer + '\n');
        else {
          let delay = 0;
          for (const key of answer.keys) { setTimeout(() => child.stdin.write(key), delay); delay += 40; }
        }
      }
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    const code = await new Promise((r, reject) => { child.once('error', reject); child.once('close', r); });
    clearTimeout(timer);
    assert.notEqual(code, null, `CLI stalled: ${stdout} ${stderr}`);
    if (answers) assert.equal(answered, answers.length, stderr);
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
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.data.data.files.length, 1);
  assert.equal(f.requests.length, 1);
  assert.ok(!(await readFile(f.config, 'utf8')).includes(secret));
});

test('MCP launcher maps the custom credential at runtime, overrides inherited write opt-in and keeps stdout for stdio', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const bin = join(f.root, 'bin');
  const capture = join(f.root, 'child.json');
  await f.file(join(bin, 'npx'), `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(process.env.CAPTURE, JSON.stringify({args:process.argv.slice(2),endpoint:process.env.LAMBDADB_BASE_URL,project:process.env.LAMBDADB_PROJECT_NAME,key:process.env.LAMBDADB_PROJECT_API_KEY,writes:process.env.LAMBDADB_MCP_ENABLE_WRITE_TOOLS,npmExecKeys:Object.keys(process.env).filter(key=>/^npm_config_(package|call)$/i.test(key)),registry:process.env.npm_config_registry}));\nprocess.stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\\n');\nprocess.exit(Number(process.env.CHILD_EXIT ?? 0));\n`);
  const { chmod } = await import('node:fs/promises');
  await chmod(join(bin, 'npx'), 0o755);
  const env = { PATH: bin + delimiter + process.env.PATH, CAPTURE: capture, LAMBDADB_MCP_ENABLE_WRITE_TOOLS: 'true', LAMBDADB_PROJECT_API_KEY: 'wrong-inherited-key', npm_config_package: '@functional-systems/lambdadb-cli@0.1.7-dev.1', NPM_CONFIG_CALL: 'outer-command', npm_config_registry: 'https://registry.npmjs.org' };
  let result = await f.run(['mcp'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '{"jsonrpc":"2.0","id":1,"result":{}}\n');
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), {
    args: ['-y', '@functional-systems/lambdadb-mcp@0.1.6-dev.21'], endpoint: f.endpoint,
    project: 'existing-project', key: secret, writes: 'false', npmExecKeys: [], registry: env.npm_config_registry,
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

test('interactive first-use init offers account setup by default and can cancel before remote actions', async t => {
  const f = await fixture(t);
  const result = await f.run(['init', '--no-browser'], { LAMBDADB_ENDPOINT: '', LAMBDADB_PROJECT: '' }, [
    ['Choose a number', 'cancel'],
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /1\. Sign in and select or create a project/);
  assert.doesNotMatch(result.stderr, /Project data API endpoint:/);
  assert.equal(f.requests.length, 0);
  await assert.rejects(readFile(f.config), { code: 'ENOENT' });
});

test('interactive init accepts an existing environment key without account login', async t => {
  const f = await fixture(t);
  const result = await f.run(['init', '--agents', 'none', '--scope', 'project'], { LAMBDADB_ENDPOINT: '', LAMBDADB_PROJECT: '' }, [
    ['Choose a number', '2'], ['Project data API endpoint', f.endpoint], ['Existing project name', 'existing-project'],
    ['Environment variable holding your API key', ''],
    ['Apply these changes', 'yes'],
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.requests.length, 1);
  assert.doesNotMatch(result.stderr, /Continue with account login/);
  assert.equal(JSON.parse(await readFile(f.config, 'utf8')).apiKeyEnv, 'CUSTOM_PROJECT_KEY');
});

test('interactive reruns show the current project and safely reuse or select another project', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(f.init('none'))).code, 0);
  const before = await readFile(f.config, 'utf8');
  const reused = await f.run(['init', '--agents', 'none', '--scope', 'project'], {}, [
    ['Choose a number', '1'], ['Apply these changes', 'yes'],
  ]);
  assert.equal(reused.code, 0, reused.stderr);
  assert.match(reused.stderr, /Current project: existing-project at http:/);
  assert.match(reused.stderr, /Select or create another project/);
  assert.doesNotMatch(reused.stderr, /Project data API endpoint:/);
  assert.equal(await readFile(f.config, 'utf8'), before);
  assert.equal(f.requests.length, 2);
  const canceled = await f.run(['init'], {}, [['Choose a number', 'cancel']]);
  assert.equal(canceled.code, 2);
  assert.equal(await readFile(f.config, 'utf8'), before);
  assert.equal(f.requests.length, 2);
  const invalid = await f.run(['init'], {}, [['Choose a number', 'browser'], ['Choose a number', 'cancel']]);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /Choose 1 or 2/);
  assert.equal(f.requests.length, 2);
});

test('explicit interactive connection flags bypass account selection', async t => {
  const f = await fixture(t);
  const result = await f.run(['init', '--endpoint', f.endpoint, '--project', 'existing-project', '--agents', 'none', '--scope', 'project'], {}, [
    ['Project data API endpoint', ''], ['Existing project name', ''], ['Environment variable holding your API key', ''],
    ['Apply these changes', 'yes'],
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Choose a number/);
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

test('interactive checkbox distinguishes detection from selection and supports toggling agents', async t => {
  const f = await fixture(t);
  await f.file(join(f.home, '.codex', 'config.toml'), '');
  await f.file(join(f.home, '.claude', 'settings.json'), '{}');
  assert.equal((await f.run(f.init('none'))).code, 0);
  const result = await f.run(['init'], {}, [
    ['Choose a number', '1'],
    ['Select agents (Space to toggle', { keys: [' ', '\x1b[B', ' ', '\x1b[A', ' ', '\r'] }],
    ['Apply these changes', 'yes'],
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /codex \(detected\)/);
  assert.match(result.stderr, /claude \(detected\)/);
  assert.match(result.stdout, /Agents: claude \(project scope; MCP read-only\)/);
  assert.match(result.stdout, /Connected to existing-project/);
  assert.match(result.stdout, /Search readiness has not been checked/);
  assert.doesNotMatch(result.stdout, /"checks"|"settings"|"nextSteps"|"files"|credentialId/);
  assert.match(result.stderr, /create\s+\.\/\.mcp.json/);
  assert.doesNotMatch(result.stdout, /\.mcp.json/);
  assert.ok(await readFile(join(f.cwd, '.mcp.json'), 'utf8'));
  await assert.rejects(readFile(join(f.cwd, '.codex', 'config.toml')), { code: 'ENOENT' });
  assert.equal(f.requests.length, 2);
});

test('interactive detected agents remain unselected on Enter; checkbox cancellation makes no writes', async t => {
  const f = await fixture(t);
  await f.file(join(f.home, '.codex', 'config.toml'), '');
  assert.equal((await f.run(f.init('none'))).code, 0);
  const before = await readFile(f.config, 'utf8');
  const result = await f.run(['init'], {}, [
    ['Choose a number', '1'], ['Select agents (Space to toggle', { keys: ['\r'] }], ['Apply these changes', 'yes'],
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Agents: none/);
  assert.equal(await readFile(f.config, 'utf8'), before);
  await assert.rejects(readFile(join(f.cwd, '.codex', 'config.toml')), { code: 'ENOENT' });
  const canceled = await f.run(['init'], {}, [
    ['Choose a number', '1'], ['Select agents (Space to toggle', { keys: ['\x03'] }],
  ]);
  assert.equal(canceled.code, 2, canceled.stderr);
  assert.match(canceled.stderr, /Init canceled/);
  assert.equal(f.requests.length, 2);
  assert.equal(await readFile(f.config, 'utf8'), before);
});

test('interactive review can change scope and explicitly enable write tools before applying', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(f.init('none'))).code, 0);
  const result = await f.run(['init', '--agents', 'codex'], {}, [
    ['Choose a number', '1'], ['Apply these changes', 'settings'],
    ['Agent configuration scope', 'user'], ['Enable MCP write tools?', 'yes'],
    ['Apply these changes', 'yes'],
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Scope: project/);
  assert.match(result.stderr, /Scope: user/);
  assert.match(result.stdout, /user scope; MCP read and write/);
  const mcp = toml(await readFile(join(f.home, '.codex', 'config.toml'), 'utf8'));
  assert.ok(mcp.mcp_servers.lambdadb.args.includes('--write-tools'));
  await assert.rejects(readFile(join(f.cwd, '.codex', 'config.toml')), { code: 'ENOENT' });
});

for (const enabledBy of ['flag', 'earlier settings']) {
  test(`interactive settings retain write tools enabled by ${enabledBy} when Enter accepts the default`, async t => {
    const f = await fixture(t);
    assert.equal((await f.run(f.init('none'))).code, 0);
    const result = await f.run(['init', '--agents', 'codex', ...(enabledBy === 'flag' ? ['--write-tools'] : [])], {}, [
      ['Choose a number', '1'],
      ...(enabledBy === 'earlier settings' ? [
        ['Apply these changes', 'settings'], ['Agent configuration scope', 'project'], ['Enable MCP write tools?', 'yes'],
      ] : []),
      ['Apply these changes', 'settings'], ['Agent configuration scope', 'user'], ['Enable MCP write tools?', ''],
      ['Apply these changes', 'yes'],
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Enable MCP write tools\? Type yes to opt in \[yes\]/);
    assert.match(result.stdout, /user scope; MCP read and write/);
    const mcp = toml(await readFile(join(f.home, '.codex/config.toml'), 'utf8'));
    assert.ok(mcp.mcp_servers.lambdadb.args.includes('--write-tools'));
  });
}

for (const step of ['checkbox', 'user scope']) {
  test(`interactive manual setup canceled at ${step} reports no saved connection`, async t => {
    const f = await fixture(t);
    const result = await f.run(['init', '--endpoint', f.endpoint, '--project', 'existing-project', ...(step === 'user scope' ? ['--agents', 'cline'] : [])], {}, [
      ['Project data API endpoint', ''], ['Existing project name', ''], ['Environment variable holding your API key', ''],
      ...(step === 'checkbox' ? [['Select agents (Space to toggle', { keys: ['\x03'] }]] : [['Selected agents require user scope', 'cancel']]),
    ]);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /Init canceled\. No files were changed\./);
    assert.doesNotMatch(result.stderr, /setup is retained/);
    await assert.rejects(readFile(f.config), { code: 'ENOENT' });
    assert.equal(f.requests.length, 0);
  });
}

test('interactive Cline still requires explicit approval of user scope', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(f.init('none'))).code, 0);
  const result = await f.run(['init', '--agents', 'cline'], {}, [
    ['Choose a number', '1'], ['Selected agents require user scope', 'project'], ['Selected agents require user scope', 'cancel'],
  ]);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /Choose user or cancel/);
  assert.equal(f.requests.length, 1);
});

test('interactive review summarizes unchanged files, expands details and retains the full JSON plan', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(f.init('none'))).code, 0);
  const result = await f.run(['init', '--agents', 'codex'], {}, [
    ['Choose a number', '1'], ['Apply these changes', 'details'], ['Apply these changes', 'yes'],
  ]);
  assert.equal(result.code, 0, result.stderr);
  const [summary, detail] = result.stderr.split('All files (. = current directory, ~ = home):');
  assert.match(summary, /Files to change/);
  assert.match(summary, /create\s+\.\/\.codex\/config.toml/);
  assert.match(summary, /1 file unchanged/);
  assert.doesNotMatch(summary, /unchanged\s+~\/cli.json/);
  assert.match(detail, /unchanged\s+~\/cli.json/);
  assert.ok(detail.indexOf('create') < detail.indexOf('unchanged'));
  const json = await f.run(f.init('codex'));
  assert.equal(json.code, 0, json.stderr);
  assert.equal(json.data.data.files.length, 4);
  assert.ok(json.data.data.files.every(file => file.action === 'unchanged'));
  const rerun = await f.run(['init', '--agents', 'codex'], {}, [
    ['Choose a number', '1'], ['Apply these changes', 'no'],
  ]);
  assert.equal(rerun.code, 2);
  assert.match(rerun.stderr, /No file changes\./);
  assert.match(rerun.stderr, /4 files unchanged/);
  assert.equal(f.requests.length, 3);
});

test('interactive review retries invalid actions and scope without applying an unreviewed plan', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(f.init('none'))).code, 0);
  const before = await readFile(f.config, 'utf8');
  const result = await f.run(['init', '--agents', 'codex'], {}, [
    ['Choose a number', 'oops'], ['Choose a number', '1'],
    ['Apply these changes', 'oops'], ['Apply these changes', 'settings'],
    ['Agent configuration scope', 'invalid'], ['Agent configuration scope', 'user'],
    ['Enable MCP write tools?', 'no'], ['Apply these changes', 'no'],
  ]);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /Choose 1 or 2, or cancel/);
  assert.match(result.stderr, /Choose yes, settings, details, or no/);
  assert.match(result.stderr, /Choose scope project or user/);
  assert.match(result.stderr, /Scope: user/);
  assert.equal(await readFile(f.config, 'utf8'), before);
  await assert.rejects(readFile(join(f.home, '.codex/config.toml')), { code: 'ENOENT' });
  assert.equal(f.requests.length, 1);
});

test('interactive planning conflict allows user scope without overwriting project settings', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(f.init('none'))).code, 0);
  const projectConfig = join(f.cwd, '.mcp.json');
  const original = '{"mcpServers":{"lambdadb":{"command":"manual-server"}}}\n';
  await f.file(projectConfig, original);
  const result = await f.run(['init', '--agents', 'claude'], {}, [
    ['Choose a number', '1'], ['Choose a different agent scope', 'invalid'],
    ['Choose a different agent scope', 'user'], ['Apply these changes', 'yes'],
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Cannot prepare project scope/);
  assert.match(result.stderr, /Scope: user/);
  assert.equal(await readFile(projectConfig, 'utf8'), original);
  const configured = JSON.parse(await readFile(join(f.home, '.claude.json'), 'utf8'));
  assert.ok(configured.mcpServers.lambdadb.args.includes('mcp'));
  assert.equal(f.requests.length, 2);
});

test('interactive planning recovery cancellation preserves files and non-interactive conflicts still fail', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(f.init('none'))).code, 0);
  const projectConfig = join(f.cwd, '.mcp.json');
  const original = '{"mcpServers":{"lambdadb":{"command":"manual-server"}}}\n';
  await f.file(projectConfig, original);
  const before = await readFile(f.config, 'utf8');
  const result = await f.run(['init', '--agents', 'claude'], {}, [
    ['Choose a number', '1'], ['Choose a different agent scope', 'cancel'],
  ]);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(await readFile(projectConfig, 'utf8'), original);
  assert.equal(await readFile(f.config, 'utf8'), before);
  await assert.rejects(readFile(join(f.home, '.claude.json')), { code: 'ENOENT' });
  const nonInteractive = await f.run(f.init('claude'));
  assert.equal(nonInteractive.code, 2);
  assert.doesNotMatch(nonInteractive.stderr, /Choose a different agent scope/);
  assert.equal(f.requests.length, 1);
});
