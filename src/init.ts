import checkbox from '@inquirer/checkbox';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { configPath, fileIdentity, loadSettings, resolveConfig, saveSettings, settings, type Options, type SelectedSettings } from './config.js';
import { terminalSetup } from './projects.js';
import { InputError } from './errors.js';
import type { Output } from './output.js';
import { checkConnection, runtime } from './runtime.js';
import { mcpPackage } from './mcp.js';
import { formatPlan } from './init-output.js';
import { mcpLaunch } from './agent-config.js';
import { agentAdapters, agentNames, detectAgents, type Agent, type AgentAdapter, type AgentContext, type AgentScope } from './agents.js';

type InitOptions = Options & { browser?: boolean; apiUrl?: string; nonInteractive?: boolean; agents?: string; scope?: string; writeTools?: boolean; json?: boolean };
type Change = { path: string; before: string | undefined; after: string; kind: string };
type PlannedChange = Change & { destination: string; aliases: string[] };
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

async function plan(selected: SelectedSettings, chosen: Agent[], scope: AgentScope, options: InitOptions, context: AgentContext): Promise<PlannedChange[]> {
  const changes: Change[] = [];
  const path = configPath(options);
  changes.push({ path, before: await readOptional(path), after: JSON.stringify(selected, null, 2) + '\n', kind: 'CLI settings (no key)' });
  const skill = await readFile(new URL('../skills/lambdadb/SKILL.md', import.meta.url), 'utf8');
  const usage = await readFile(new URL('../skills/lambdadb/references/usage.md', import.meta.url), 'utf8');
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
    if (previousSkill === undefined || previousSkill === skill) {
      const referencePath = join(dirname(skillPath), 'references', 'usage.md');
      const previousReference = await readOptional(referencePath);
      changes.push({ path: referencePath, before: previousReference, after: previousReference ?? usage, kind: `${agent} skill reference (${scope})` });
    }
  }
  const unique = new Map<string, PlannedChange>();
  for (const change of changes) {
    const identity = await fileIdentity(change.path);
    const previous = unique.get(identity);
    if (!previous) { unique.set(identity, { ...change, destination: identity, aliases: [] }); continue; }
    if (change.path === configPath(options) || previous.path === configPath(options)) {
      throw new InputError('The CLI --config path overlaps an agent configuration or skill path. Choose a separate CLI configuration path and rerun init.');
    }
    if (previous.before !== change.before || previous.after !== change.after) {
      throw new InputError(`Agents request conflicting changes to ${change.path}. Select them separately and inspect the shared file before retrying.`);
    }
    previous.kind += `; ${change.kind}`;
    if (change.path !== previous.path && !previous.aliases.includes(change.path)) previous.aliases.push(change.path);
  }
  return [...unique.values()];
}

async function apply(changes: PlannedChange[], options: Options) {
  // Detect concurrent edits before writing anything. Individual writes are atomic;
  // a disk/permission failure can still leave a partial install, safe to rerun.
  for (const change of changes) {
    for (const path of [change.path, ...change.aliases]) {
      if (await fileIdentity(path) !== change.destination) throw new InputError(`Configuration changed during init: ${path}. Rerun init to review the new plan.`);
    }
    if (await readOptional(change.destination) !== change.before) {
      throw new InputError(`Configuration changed during init: ${change.path}. Rerun init to review the new plan.`);
    }
  }
  for (const change of changes.filter(change => change.before !== change.after)) {
    if (change.path === configPath(options)) { await saveSettings({ ...options, config: change.destination }); continue; }
    const temp = `${change.destination}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(change.destination), { recursive: true });
      await writeFile(temp, change.after, { flag: 'wx', mode: 0o600 });
      await rename(temp, change.destination);
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
  let prompt = interactive ? createInterface({ input: process.stdin, output: process.stderr }) : undefined;
  let connectionSaved = false;
  let accountSetup = false;
  const canceled = () => new InputError((connectionSaved || accountSetup)
    ? 'Init canceled. Completed login/project setup is retained. Rerun init to continue with the saved connection or select another project.'
    : 'Init canceled. No files were changed.');
  const ask = async (label: string, fallback?: string) => {
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort();
    prompt!.once('SIGINT', cancel);
    prompt!.once('close', cancel);
    try {
      // eslint-disable-next-line no-control-regex -- Server names must not inject terminal escapes into prompts.
      label = label.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' ');
      const answer = (await prompt!.question(`${label}${fallback ? ` [${fallback}]` : ''}: `, { signal: cancellation.signal })).trim();
      return answer || fallback;
    } catch (error) {
      if (cancellation.signal.aborted) throw canceled();
      throw error;
    } finally {
      prompt!.removeListener('SIGINT', cancel);
      prompt!.removeListener('close', cancel);
    }
  };
  try {
    if (interactive) {
      output.diagnostic('\n1/3 Connect to LambdaDB');
      let saved = await loadSettings(configPath(options));
      let reuseConnection = false;
      const explicitConnection = options.endpoint || options.project || options.apiKeyEnv || options.credentialId;
      if (!explicitConnection) {
        const currentEndpoint = process.env.LAMBDADB_ENDPOINT ?? saved.endpoint;
        const currentProject = process.env.LAMBDADB_PROJECT ?? saved.project;
        const reuse = !!currentEndpoint || !!saved.credentialStore;
        let choice: string | undefined;
        for (;;) {
          choice = await ask(reuse
            ? `Current project: ${currentProject ?? '(not set)'} at ${currentEndpoint ?? '(not set)'}\n1. Continue with this connection\n2. Select or create another project through account login\nChoose a number (or cancel)`
            : '1. Sign in and select or create a project (recommended)\n2. Use an existing project API key from an environment variable\nChoose a number (or cancel)', '1');
          if (choice === 'cancel') throw new InputError('Init canceled. No files were changed.');
          if (choice === '1' || choice === '2') break;
          output.diagnostic('Choose 1 or 2, or cancel.');
        }
        accountSetup = reuse ? choice === '2' : choice === '1';
        reuseConnection = reuse && choice === '1' && !!currentEndpoint && !!currentProject;
      }
      if (accountSetup) {
        const destination = await fileIdentity(configPath(options));
        output.diagnostic(`CLI settings: ${destination} (secrets: OS credential store).`);
        const cancellation = new AbortController();
        const cancel = () => cancellation.abort();
        prompt!.once('SIGINT', cancel); prompt!.once('close', cancel);
        let selected: SelectedSettings;
        try { selected = await terminalSetup({ ...options, guided: true, signal: cancellation.signal }, output, ask); }
        finally { prompt!.removeListener('SIGINT', cancel); prompt!.removeListener('close', cancel); }
        options = { ...options, ...selected };
        saved = selected;
        connectionSaved = true;
      }
      if (!reuseConnection && (!saved.credentialStore || (options.apiKeyEnv && !options.credentialStore))) {
        options.endpoint = await ask('Project data API endpoint', options.endpoint ?? process.env.LAMBDADB_ENDPOINT ?? saved.endpoint);
        options.project = await ask('Existing project name', options.project ?? process.env.LAMBDADB_PROJECT ?? saved.project);
        options.apiKeyEnv = await ask('Environment variable holding your API key (not its value)', options.apiKeyEnv ?? process.env.LAMBDADB_API_KEY_ENV ?? saved.apiKeyEnv ?? 'LAMBDADB_API_KEY');
        output.protect(options.apiKeyEnv ? process.env[options.apiKeyEnv] : undefined);
      }
      output.diagnostic('\n2/3 Choose coding agents');
      if (options.agents === undefined) {
        // Only one readline interface may own stdin at a time.
        prompt?.close();
        try {
          const agents = await checkbox<Agent>({
            message: 'Select agents (Space to toggle; Enter with none selected to skip)',
            pageSize: agentAdapters.length,
            choices: agentAdapters.map(adapter => ({ value: adapter.id, name: `${adapter.id}${detected.includes(adapter.id) ? ' (detected)' : ''}`, checked: false })),
          }, { output: process.stderr });
          options.agents = agents.join(',') || 'none';
        } catch (error) {
          if (error instanceof Error && ['ExitPromptError', 'AbortPromptError'].includes(error.name)) {
            throw canceled();
          }
          throw error;
        }
        prompt = createInterface({ input: process.stdin, output: process.stderr });
      }
      const scopes = availableScopes(selectedAgents(options.agents));
      if (options.scope === undefined) {
        if (scopes.includes('project')) options.scope = 'project';
        else for (;;) {
          const scope = await ask('Selected agents require user scope. Type user to install for your OS user, or cancel', 'cancel');
          if (scope === 'cancel') throw canceled();
          if (scope === 'user') { options.scope = scope; break; }
          output.diagnostic('Choose user or cancel.');
        }
      }
      options.writeTools ??= false;

    }
    const chosen = selectedAgents(options.agents);
    if (!['project', 'user'].includes(options.scope ?? '')) throw new InputError('Specify --scope project or --scope user. CLI settings still use --config or the normal user configuration path.');
    if (!availableScopes(chosen).includes(options.scope as AgentScope)) {
      throw new InputError(`The selected agents do not all support --scope ${options.scope}. Use --scope ${availableScopes(chosen).join(' or --scope ')} or remove agents that do not support the selected scope.`);
    }
    // Use the existing precedence and validation for both saved settings and auth.
    const selected = await settings(options, true);
    if (!interactive && !selected.credentialStore) output.diagnostic('Manual Console step: obtain an existing project endpoint, name and API key at https://app.lambdadb.ai. Export the key securely; environment setup never saves its value.');
    options = { ...options, ...selected };
    output.protect(process.env[selected.apiKeyEnv]);
    if (!selected.credentialStore && !process.env[selected.apiKeyEnv]?.trim()) throw new InputError(`Export ${selected.apiKeyEnv} securely in this shell, then rerun init. Obtain a project API key in the LambdaDB Console; never pass its value as a flag.`);
    const config = await resolveConfig(options, true);
    output.protect(config.apiKey);
    const planWithScopeRecovery = async () => {
      for (;;) {
        try { return await plan(selected, chosen, options.scope as AgentScope, options, context); }
        catch (error) {
          const scopes = availableScopes(chosen);
          if (!interactive || !chosen.length || scopes.length < 2 || !(error instanceof InputError)) throw error;
          output.diagnostic(`Cannot prepare ${options.scope} scope: ${error.message}`);
          for (;;) {
            const scope = await ask(`Choose a different agent scope: ${scopes.join(' or ')}, or cancel`, 'cancel');
            if (scope === 'cancel') throw canceled();
            if (scopes.includes(scope as AgentScope)) { options.scope = scope; break; }
            output.diagnostic(`Choose scope ${scopes.join(' or ')}, or cancel.`);
          }
        }
      }
    };
    let changes = await planWithScopeRecovery();
    const describe = () => changes.map(change => ({ path: change.path, ...(change.aliases.length ? { aliases: change.aliases } : {}), ...(change.destination !== change.path ? { destination: change.destination } : {}), kind: change.kind,
      action: change.before === change.after ? 'unchanged' : change.before === undefined ? 'create' : 'update' }));
    let files = describe();
    if (interactive) {
      const review = chosen.length > 0 || files.some(file => file.action !== 'unchanged');
      output.diagnostic(review ? '\n3/3 Review setup' : '\n3/3 Verify connection');
      let details = false;
      while (review) {
        output.diagnostic(formatPlan(files, chosen, options.scope!, !!options.writeTools, context, details));
        const choices = chosen.length ? 'yes, settings, details, or no' : 'yes, details, or no';
        const answer = await ask(`Apply these changes after verifying collection-list access? Type ${choices}`, 'no');
        if (answer === 'yes') break;
        if (answer === 'details') { details = true; continue; }
        if (answer === 'no') throw canceled();
        if (answer !== 'settings' || !chosen.length) { output.diagnostic(`Choose ${choices}.`); continue; }
        const scopes = availableScopes(chosen);
        for (;;) {
          const scope = await ask(`Agent configuration scope: ${scopes.join(' or ')}`, options.scope);
          if (scopes.includes(scope as AgentScope)) { options.scope = scope; break; }
          output.diagnostic(`Choose scope ${scopes.join(' or ')}.`);
        }
        options.writeTools = (await ask('Enable MCP write tools? Type yes to opt in', options.writeTools ? 'yes' : 'no')) === 'yes';
        changes = await planWithScopeRecovery();
        files = describe();
        details = false;
      }
    } else {
      for (const file of files) output.diagnostic(`${file.action}: ${[file.path, ...(file.aliases ?? [])].join(', ')}${file.destination ? ` -> ${file.destination}` : ''} — ${file.kind}`);
      output.diagnostic(`MCP: ${mcpPackage}; write tools ${options.writeTools ? 'enabled (explicit opt-in)' : 'disabled'}. ${selected.credentialStore ? `The bridge reads ${selected.credentialStore} using a non-secret reference.` : `Agents must inherit ${selected.apiKeyEnv}; only its name is stored.`}`);
    }
    const ctx = runtime(config);
    let connection;
    try { connection = await checkConnection(ctx); } finally { ctx.close(); }
    await apply(changes, options);
    const nextSteps = [
      selected.credentialStore ? `Restart/reload selected agents as the same OS user with ${selected.credentialStore} accessible and npx on PATH. No shell key export is required.` : `Restart/reload selected agents from an environment containing ${selected.apiKeyEnv} and npx on PATH. GUI launches may not inherit shell exports.`,
      agentAdapters.filter(adapter => chosen.includes(adapter.id)).map(adapter => adapter.instructions).join(' '),
      `Agent prompt: Prefer LambdaDB CLI with --json and configuration file ${JSON.stringify(configPath(options))}; use the matching MCP connection if terminal execution is unavailable or I request MCP. List collections, inspect the collection I choose, then read a small sample at my selected ref (branch:main if none is intended). Help me search an actual indexed field. Do not create or modify data.`,
      'CLI reads: run lambdadb collections list --json and lambdadb collections describe --collection NAME --json. Save {"size":5} in first-query.json, then run lambdadb query --collection NAME --ref branch:main --file first-query.json --json. Pass the configuration file above with --config; replace NAME and ref with the chosen target.',
      'If the project has no collections/data, populate it deliberately outside init. Connection success does not establish search readiness.',
    ];
    return { ...connection, settings: selected, detectedAgents: detected, agents: chosen, scope: options.scope,
      writeTools: !!options.writeTools, files, nextSteps };
  } finally { prompt?.close(); }
}
