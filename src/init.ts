import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { configPath, loadSettings, resolveConfig, saveSettings, settings, type Options, type Settings } from './config.js';
import { InputError } from './errors.js';
import type { Output } from './output.js';
import { checkConnection, runtime } from './runtime.js';
import { mcpPackage } from './mcp.js';
import { mcpLaunch } from './agent-config.js';
import { agentAdapters, agentNames, detectAgents, type Agent, type AgentAdapter, type AgentContext, type AgentScope } from './agents.js';

type InitOptions = Options & { nonInteractive?: boolean; agents?: string; scope?: string; writeTools?: boolean; json?: boolean };
type Change = { path: string; before: string | undefined; after: string; kind: string };
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version as string;

function selectedAgents(value: string | undefined): Agent[] {
  if (value === 'none') return [];
  const values = value?.split(',').map(v => v.trim());
  if (!values?.length || values.some(v => !agentAdapters.some(adapter => adapter.id === v))) {
    throw new InputError(`Choose --agents ${agentNames} (comma-separated subset), or --agents none.`);
  }
  return [...new Set(values)] as Agent[];
}

function availableScopes(chosen: Agent[]): AgentScope[] {
  return (['project', 'user'] as const).filter(scope => chosen.every(agent => {
    const adapter: AgentAdapter = agentAdapters.find(adapter => adapter.id === agent)!;
    return !adapter.scopes || adapter.scopes.includes(scope);
  }));
}

async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new InputError(`Cannot read ${path}. Check file permissions.`);
  }
}

async function fileIdentity(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new InputError(`Cannot resolve configuration path: ${path}.`);
    return join(await fileIdentity(dirname(path)), basename(path));
  }
}

async function plan(selected: Required<Settings>, chosen: Agent[], scope: AgentScope, options: InitOptions, context: AgentContext): Promise<Change[]> {
  const changes: Change[] = [];
  const path = configPath(options);
  changes.push({ path, before: await readOptional(path), after: JSON.stringify(selected, null, 2) + '\n', kind: 'CLI settings (no key)' });
  const skill = await readFile(new URL('../skills/lambdadb/SKILL.md', import.meta.url), 'utf8');
  for (const agent of chosen) {
    const adapter: AgentAdapter = agentAdapters.find(adapter => adapter.id === agent)!;
    const paths = await adapter.paths(scope, context);
    const before = await readOptional(paths.mcp);
    const after = adapter.configure(paths.mcp, before, mcpLaunch(selected, !!options.writeTools, version));
    changes.push({ path: paths.mcp, before, after, kind: `${agent} MCP (${scope})` });
    const skillPath = paths.skill;
    if (!skillPath) continue;
    const previousSkill = await readOptional(skillPath);
    // Preserve existing skills, including user edits, rather than taking ownership.
    changes.push({ path: skillPath, before: previousSkill, after: previousSkill ?? skill, kind: `${agent} skill (${scope}${previousSkill && previousSkill !== skill ? ', existing skill preserved' : ''})` });
  }
  const unique = new Map<string, Change>();
  for (const change of changes) {
    const identity = await fileIdentity(change.path);
    const previous = unique.get(identity);
    if (!previous) { unique.set(identity, change); continue; }
    if (change.path === configPath(options) || previous.path === configPath(options)) {
      throw new InputError('The CLI --config path overlaps an agent configuration or skill path. Choose a separate CLI configuration path and rerun init.');
    }
    if (previous.before !== change.before || previous.after !== change.after) {
      throw new InputError(`Agents request conflicting changes to ${change.path}. Select them separately and inspect the shared file before retrying.`);
    }
    previous.kind += `; ${change.kind}`;
  }
  return [...unique.values()];
}

async function apply(changes: Change[], options: Options) {
  // Detect concurrent edits before writing anything. Individual writes are atomic;
  // a disk/permission failure can still leave a partial install, safe to rerun.
  for (const change of changes) {
    if (await readOptional(change.path) !== change.before) throw new InputError(`Configuration changed during init: ${change.path}. Rerun init to review the new plan.`);
  }
  for (const change of changes.filter(change => change.before !== change.after)) {
    if (change.path === configPath(options)) { await saveSettings(options); continue; }
    const temp = `${change.path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(change.path), { recursive: true });
      await writeFile(temp, change.after, { flag: 'wx', mode: 0o600 });
      await rename(temp, change.path);
    } catch {
      throw new InputError(`Cannot update ${change.path}. Check permissions and rerun init; earlier files may already have been updated.`);
    } finally { await rm(temp, { force: true }).catch(() => {}); }
  }
}

export async function initialize(options: InitOptions, output: Output) {
  const interactive = !options.nonInteractive && !options.json && !!process.stdin.isTTY && !!process.stderr.isTTY;
  if (!interactive && !options.nonInteractive) {
    throw new InputError(`Init needs a terminal. For automation or --json, pass --non-interactive --agents ${agentNames} (or none) --scope project (or user).`);
  }
  const context = { cwd: process.cwd(), home: homedir(), env: process.env };
  const detected = await detectAgents(context);
  output.diagnostic('Manual Console step: open https://console.lambdadb.ai, select an existing project, and obtain its API endpoint, project name and API key. Export the key securely; init never accepts or saves a key value.');
  const prompt = interactive ? createInterface({ input: process.stdin, output: process.stderr }) : undefined;
  const ask = async (label: string, fallback?: string) => {
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort();
    prompt!.once('SIGINT', cancel);
    prompt!.once('close', cancel);
    try {
      const answer = (await prompt!.question(`${label}${fallback ? ` [${fallback}]` : ''}: `, { signal: cancellation.signal })).trim();
      return answer || fallback;
    } catch (error) {
      if (cancellation.signal.aborted) throw new InputError('Init canceled. No files were changed.');
      throw error;
    } finally {
      prompt!.removeListener('SIGINT', cancel);
      prompt!.removeListener('close', cancel);
    }
  };
  try {
    if (interactive) {
      const saved = await loadSettings(configPath(options));
      options.endpoint = await ask('API endpoint', options.endpoint ?? process.env.LAMBDADB_ENDPOINT ?? saved.endpoint);
      options.project = await ask('Existing project name', options.project ?? process.env.LAMBDADB_PROJECT ?? saved.project);
      options.apiKeyEnv = await ask('Environment variable holding your API key (not its value)', options.apiKeyEnv ?? process.env.LAMBDADB_API_KEY_ENV ?? saved.apiKeyEnv ?? 'LAMBDADB_API_KEY');
      output.protect(options.apiKeyEnv ? process.env[options.apiKeyEnv] : undefined);
      output.diagnostic(`Detected agents (heuristic): ${detected.join(', ') || 'none'}. You may also select an undetected agent.`);
      options.agents ??= await ask(`Agents: ${agentNames} (comma-separated), or none`, detected.join(',') || 'none');
      const scopes = availableScopes(selectedAgents(options.agents));
      options.scope ??= await ask(`Agent configuration scope: ${scopes.join(' or ')}`, scopes[0]);
      if (options.writeTools === undefined) options.writeTools = (await ask('Enable MCP write tools? Type yes to opt in', 'no')) === 'yes';
    }
    const chosen = selectedAgents(options.agents);
    if (!['project', 'user'].includes(options.scope ?? '')) throw new InputError('Specify --scope project or --scope user. CLI settings still use --config or the normal user configuration path.');
    if (!availableScopes(chosen).includes(options.scope as AgentScope)) {
      throw new InputError(`The selected agents do not all support --scope ${options.scope}. Use --scope ${availableScopes(chosen).join(' or --scope ')} or remove agents that do not support the selected scope.`);
    }
    // Use the existing precedence and validation for both saved settings and auth.
    const selected = await settings(options, true);
    options = { ...options, ...selected };
    output.protect(process.env[selected.apiKeyEnv]);
    if (!process.env[selected.apiKeyEnv]?.trim()) throw new InputError(`Export ${selected.apiKeyEnv} securely in this shell, then rerun init. Obtain a project API key in the LambdaDB Console; never pass its value as a flag.`);
    const config = await resolveConfig(options, true);
    const changes = await plan(selected, chosen, options.scope as AgentScope, options, context);
    const files = changes.map(change => ({ path: change.path, kind: change.kind,
      action: change.before === change.after ? 'unchanged' : change.before === undefined ? 'create' : 'update' }));
    for (const file of files) output.diagnostic(`${file.action}: ${file.path} — ${file.kind}`);
    output.diagnostic(`MCP: ${mcpPackage}; write tools ${options.writeTools ? 'enabled (explicit opt-in)' : 'disabled'}. Agents must inherit ${selected.apiKeyEnv}; only its name is stored.`);
    if (interactive && (await ask('Apply these changes after verifying collection-list access? Type yes', 'no')) !== 'yes') {
      throw new InputError('Init canceled. No files were changed.');
    }
    const ctx = runtime(config);
    let connection;
    try { connection = await checkConnection(ctx); } finally { ctx.close(); }
    await apply(changes, options);
    const nextSteps = [
      `Restart/reload selected agents from an environment containing ${selected.apiKeyEnv} and npx on PATH. GUI launches may not inherit shell exports.`,
      agentAdapters.filter(adapter => chosen.includes(adapter.id)).map(adapter => adapter.instructions).join(' '),
      'Agent prompt: Use LambdaDB MCP to list collections, inspect the collection I choose, then read up to five documents at branch:main with query omitted. Help me search an actual indexed field. Do not create or modify data.',
      'CLI alternative: run lambdadb collections list --json and lambdadb collections describe --collection NAME --json. Save {"size":5} in first-query.json, then run lambdadb query --collection NAME --ref branch:main --file first-query.json --json. Replace NAME with the collection you chose.',
      'If the project has no collections/data, populate it deliberately outside init. Connection success does not establish search readiness.',
    ];
    return { ...connection, settings: selected, detectedAgents: detected, agents: chosen, scope: options.scope,
      writeTools: !!options.writeTools, files, nextSteps };
  } finally { prompt?.close(); }
}
