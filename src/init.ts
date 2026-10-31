import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { configPath, fileIdentity, loadSettings, resolveConfig, saveSettings, settings, type Options, type SelectedSettings } from './config.js';
import { terminalSetup } from './projects.js';
import { InputError } from './errors.js';
import type { Output } from './output.js';
import { checkConnection, runtime } from './runtime.js';
import { mcpPackage } from './mcp.js';
import { cli } from './command.js';
import { formatPlan } from './init-output.js';
import { InitUI } from './init-ui.js';
import { mcpLaunch } from './agent-config.js';
import { agentAdapters, agentNames, detectAgents, type Agent, type AgentAdapter, type AgentContext, type AgentScope } from './agents.js';
import { isBundledReference, isBundledSkill } from './skill-history.js';

type InitOptions = Options & { browser?: boolean; apiUrl?: string; nonInteractive?: boolean; agents?: string; scope?: string; writeTools?: boolean; json?: boolean };
// after undefined deletes the file.
type Change = { path: string; before: string | undefined; after: string | undefined; kind: string };
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
  for (const agent of chosen) {
    const adapter: AgentAdapter = agentAdapters.find(adapter => adapter.id === agent)!;
    const paths = await adapter.paths(scope, context);
    const before = await readOptional(paths.mcp);
    const after = adapter.configure(paths.mcp, before, mcpLaunch(selected, !!options.writeTools, version));
    changes.push({ path: paths.mcp, before, after, kind: `${agent} MCP (${scope})` });
    const skillPath = paths.skill;
    if (!skillPath) continue;
    const previousSkill = await readOptional(skillPath);
    // Unmodified copies of any bundled version follow the package; user edits are preserved.
    const bundled = previousSkill === undefined || previousSkill === skill || isBundledSkill(previousSkill);
    changes.push({ path: skillPath, before: previousSkill, after: bundled ? skill : previousSkill, kind: `${agent} skill (${scope}${bundled ? '' : ', existing skill preserved'})` });
    // Releases through 0.1.7 installed references/usage.md next to the skill; it is part of SKILL.md now.
    // Only a regular file is removed: a symbolic link would delete its shared target, and a
    // directory or other entry is the user's.
    const referencePath = join(dirname(skillPath), 'references', 'usage.md');
    const referenceInfo = await lstat(referencePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new InputError(`Cannot read ${referencePath}. Check file permissions.`);
    });
    const previousReference = bundled && referenceInfo?.isFile() ? await readOptional(referencePath) : undefined;
    if (previousReference !== undefined && isBundledReference(previousReference)) {
      changes.push({ path: referencePath, before: previousReference, after: undefined, kind: `${agent} skill reference (${scope}, merged into SKILL.md)` });
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

function checkSaveCanceled(signal?: AbortSignal) {
  if (signal?.aborted) throw new InputError('Init canceled while saving setup. Some files may already be updated. Rerun init to review and finish setup.', '');
}

async function apply(changes: PlannedChange[], options: Options, signal?: AbortSignal) {
  checkSaveCanceled(signal);
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
    checkSaveCanceled(signal);
    if (change.path === configPath(options)) { await saveSettings({ ...options, config: change.destination }); continue; }
    if (change.after === undefined) {
      try { await rm(change.destination); await rmdir(dirname(change.destination)).catch(() => {}); }
      catch { throw new InputError(`Cannot remove ${change.path}. Check permissions and rerun init; earlier files may already have been updated.`); }
      continue;
    }
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

export function interactiveInit(options: Pick<InitOptions, 'nonInteractive' | 'json'>): boolean {
  return !options.nonInteractive && !options.json && !!process.stdin.isTTY && !!process.stderr.isTTY;
}

const scopeLabel = (scope: string) => scope === 'project' ? 'This repository' : 'Your OS user';

export async function initialize(options: InitOptions, output: Output) {
  const interactive = interactiveInit(options);
  if (!interactive && !options.nonInteractive) {
    throw new InputError(`Init needs a terminal. For automation or --json, pass --non-interactive --agents ${agentNames} (or none) --scope project (or user).`, '');
  }
  const context = { cwd: process.cwd(), home: homedir(), env: process.env };
  const detected = await detectAgents(context);
  let connectionSaved = false;
  let accountSetup = false;
  const canceled = () => (connectionSaved || accountSetup)
    ? new InputError('Init canceled. Completed login/project setup is retained. Rerun init to continue with the saved connection or select another project.', '')
    : new InputError('Init canceled. No files were changed.', `Rerun ${cli} init when ready.`);
  const ui = interactive ? new InitUI(output, canceled) : undefined;
  if (ui) output = output.withDiagnostics(message => ui.info(message));
  try {
    if (ui) {
      ui.start();
      let saved = await loadSettings(configPath(options));
      let reuseConnection = false;
      const explicitConnection = options.endpoint || options.project || options.apiKeyEnv || options.credentialId;
      if (!explicitConnection) {
        const currentEndpoint = process.env.LAMBDADB_ENDPOINT ?? saved.endpoint;
        const currentProject = process.env.LAMBDADB_PROJECT ?? saved.project;
        const reuse = !!currentEndpoint || !!saved.credentialStore;
        for (;;) {
          const choice = await ui.select('Connection', reuse ? [
            { value: 'reuse', label: 'Use current project', hint: currentProject ?? 'Not set' },
            { value: 'account', label: 'Choose another project' },
            { value: 'details', label: 'View connection details' },
            { value: 'cancel', label: 'Cancel' },
          ] : [
            { value: 'account', label: 'Sign in or create an account', hint: 'Recommended' },
            { value: 'environment', label: 'Use an existing API key', hint: 'From an environment variable' },
            { value: 'cancel', label: 'Cancel' },
          ]);
          if (choice === 'cancel') throw canceled();
          if (choice === 'details') {
            ui.note(`Project: ${currentProject ?? 'Not set'}\nEndpoint: ${currentEndpoint ?? 'Not set'}\nSettings: ${configPath(options)}`, 'Current connection');
            continue;
          }
          accountSetup = choice === 'account';
          reuseConnection = choice === 'reuse' && !!currentEndpoint && !!currentProject;
          break;
        }
      }
      if (accountSetup) {
        const path = configPath(options);
        await fileIdentity(path); // Validate symlinks before login or project changes.
        ui.info(`Settings: ${path.startsWith(context.home + sep) ? '~' + path.slice(context.home.length) : path}\nKeys: OS credential store`);
        const selected = await terminalSetup({ ...options, guided: true, signal: ui.signal }, output, ui);
        options = { ...options, ...selected };
        saved = selected;
        connectionSaved = true;
      }
      if (!reuseConnection && (!saved.credentialStore || (options.apiKeyEnv && !options.credentialStore))) {
        ui.info('Get the project endpoint, name and API key in Console:\nhttps://app.lambdadb.ai\nExport the key securely; enter only its environment-variable name below.');
        options.endpoint = await ui.text('Project API endpoint', options.endpoint ?? process.env.LAMBDADB_ENDPOINT ?? saved.endpoint);
        options.project = await ui.text('Project name', options.project ?? process.env.LAMBDADB_PROJECT ?? saved.project);
        options.apiKeyEnv = await ui.text('API key environment variable', options.apiKeyEnv ?? process.env.LAMBDADB_API_KEY_ENV ?? saved.apiKeyEnv ?? 'LAMBDADB_API_KEY');
        output.protect(options.apiKeyEnv ? process.env[options.apiKeyEnv] : undefined);
      }
      if (options.agents === undefined) {
        const agents = await ui.agents(agentAdapters.map(adapter => ({ value: adapter.id, label: adapter.name,
          ...(detected.includes(adapter.id) ? { hint: 'Detected' } : {}),
        })));
        options.agents = agents.join(',') || 'none';
      }
      const scopes = availableScopes(selectedAgents(options.agents));
      // Guided defaults install for the OS user with write tools so Enter alone yields a
      // complete setup; Change options can narrow either. Non-interactive runs stay explicit.
      if (options.scope === undefined) options.scope = scopes.includes('user') ? 'user' : 'project';
      options.writeTools ??= true;
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
          const scope = await ui!.select('Configuration scope', [
            ...scopes.map(value => ({ value, label: scopeLabel(value) })),
            { value: 'cancel', label: 'Cancel' },
          ], 'cancel');
          if (scope === 'cancel') throw canceled();
          options.scope = scope;
        }
      }
    };
    let changes = await planWithScopeRecovery();
    const describe = () => changes.map(change => ({ path: change.path, ...(change.aliases.length ? { aliases: change.aliases } : {}), ...(change.destination !== change.path ? { destination: change.destination } : {}), kind: change.kind,
      action: change.before === change.after ? 'unchanged' : change.after === undefined ? 'delete' : change.before === undefined ? 'create' : 'update' }));
    let files = describe();
    if (ui) {
      const review = chosen.length > 0 || files.some(file => file.action !== 'unchanged');
      let details = false;
      while (review) {
        ui.note(formatPlan(files, chosen, options.scope!, !!options.writeTools, context, details), 'Review changes');
        const answer = await ui.select('Continue with this setup?', [
          { value: 'apply', label: 'Apply changes' },
          ...(chosen.length ? [{ value: 'settings', label: 'Change options' }] : []),
          { value: 'details', label: 'Show all files' },
          { value: 'cancel', label: 'Cancel' },
        ], 'apply');
        if (answer === 'apply') break;
        if (answer === 'details') { details = true; continue; }
        if (answer === 'cancel') throw canceled();
        const scopes = availableScopes(chosen);
        options.scope = await ui.select('Install for', scopes.map(value => ({ value,
          label: scopeLabel(value),
        })), options.scope);
        options.writeTools = await ui.confirm('Enable MCP write tools?', !!options.writeTools);
        changes = await planWithScopeRecovery();
        files = describe();
        details = false;
      }
    } else {
      for (const file of files) output.diagnostic(`${file.action}: ${[file.path, ...(file.aliases ?? [])].join(', ')}${file.destination ? ` -> ${file.destination}` : ''} — ${file.kind}`);
      output.diagnostic(`MCP: ${mcpPackage}; write tools ${options.writeTools ? 'enabled (explicit opt-in)' : 'disabled'}. ${selected.credentialStore ? `The bridge reads ${selected.credentialStore} using a non-secret reference.` : `Agents must inherit ${selected.apiKeyEnv}; only its name is stored.`}`);
    }
    const ctx = runtime(config, ui?.signal);
    let connection;
    try {
      connection = ui ? await ui.verify(() => checkConnection(ctx)) : await checkConnection(ctx);
    } finally { ctx.close(); }
    await apply(changes, options, ui?.signal);
    checkSaveCanceled(ui?.signal);
    ui?.finish();
    const nextSteps = [
      selected.credentialStore ? `Restart/reload selected agents as the same OS user with ${selected.credentialStore} accessible and npx on PATH. No shell key export is required.` : `Restart/reload selected agents from an environment containing ${selected.apiKeyEnv} and npx on PATH. GUI launches may not inherit shell exports.`,
      agentAdapters.filter(adapter => chosen.includes(adapter.id)).map(adapter => adapter.instructions).join(' '),
      `Agent prompt: Prefer LambdaDB CLI with --json and configuration file ${JSON.stringify(configPath(options))}; use the matching MCP connection if terminal execution is unavailable or I request MCP. List collections, inspect the collection I choose, then read a small sample at my selected ref (branch:main if none is intended). Help me search an actual indexed field. Do not create or modify data.`,
      `CLI reads: run ${cli} collections list --json and ${cli} collections describe --collection NAME --json, then ${cli} docs list --collection NAME --ref branch:main --size 5 --json for a sample. Pass the configuration file above with --config; replace NAME and ref with the chosen target.`,
      'If the project has no collections/data, populate it deliberately outside init. Connection success does not establish search readiness.',
    ];
    return { ...connection, settings: selected, detectedAgents: detected, agents: chosen, scope: options.scope,
      writeTools: !!options.writeTools, files, nextSteps };
  } catch (error) {
    ui?.finish('Setup stopped');
    throw error;
  } finally { ui?.dispose(); }
}
