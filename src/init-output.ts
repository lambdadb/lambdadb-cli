import { relative, isAbsolute, sep } from 'node:path';
import { styleText } from 'node:util';
import { agentAdapters, type Agent } from './agents.js';
import { defaultConfigPath } from './config.js';
import { wrapAnsi } from 'fast-wrap-ansi';
import type { initialize } from './init.js';

const agentName = (agent: Agent) => agentAdapters.find(adapter => adapter.id === agent)!.name;

type FilePlan = { path: string; aliases?: string[]; destination?: string; kind: string; action: string };

// Project names and paths can contain terminal control characters.
const text = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, ' '); // eslint-disable-line no-control-regex

export function formatPlan(files: FilePlan[], agents: Agent[], scope: string, writeTools: boolean, context: { cwd: string; home: string }, details = false) {
  const displayPath = (path: string) => {
    for (const [root, prefix] of [[context.cwd, '.'], [context.home, '~']] as const) {
      const part = relative(root, path);
      if (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)) return text(part ? `${prefix}${sep}${part}` : prefix);
    }
    return text(path);
  };
  const changed = files.filter(file => file.action !== 'unchanged');
  const unchanged = files.filter(file => file.action === 'unchanged');
  const visible = details ? [...changed, ...unchanged] : changed;
  return [
    ...(agents.length ? [
      `Agents: ${agents.map(agentName).join(', ')}`,
      `Scope: ${scope} (${text(scope === 'project' ? context.cwd : context.home)})`,
      `MCP tools: ${writeTools ? 'read and write (explicit opt-in)' : 'read-only'}`,
      '',
    ] : []),
    ...(visible.length ? [details ? 'All files (. = current directory, ~ = home):' : 'Files to change (. = current directory, ~ = home):'] : ['No file changes.']),
    ...visible.map(file => `  ${file.action.padEnd(9)} ${[file.path, ...(file.aliases ?? [])].map(displayPath).join(', ')}${file.destination ? ` -> ${text(file.destination)}` : ''}`),
    ...(!details && unchanged.length ? [`${unchanged.length} file${unchanged.length === 1 ? '' : 's'} unchanged.`] : []),
  ].join('\n');
}

export function formatInit(data: Awaited<ReturnType<typeof initialize>>, config: string, interactive = false) {
  const { settings, agents } = data;
  const count = data.files.filter(file => file.action !== 'unchanged').length;
  const customConfig = config !== defaultConfigPath();
  if (interactive) {
    const instruction = (value: string) => wrapAnsi(text(value), Math.max(20, (process.stderr.columns || 80) - 4), { hard: true })
      .split('\n').map(line => `    ${line}`).join('\n');
    const row = (label: string, value: string) => `  ${styleText('dim', label.padEnd(8))} ${text(value)}`;
    return [
      row('Project', settings.project),
      row('Agents', agents.length ? agents.map(agentName).join(', ') : 'Skipped'),
      ...(agents.length ? [row('Install', `${data.scope} scope · MCP ${data.writeTools ? 'read and write' : 'read-only'}`)] : []),
      ...(customConfig ? [row('Config', config)] : []),
      '',
      `  ${styleText('bold', 'Next')}`,
      ...(agents.length ? [
        instruction(settings.credentialStore
          ? `Restart/reload as the same OS user with ${settings.credentialStore} accessible and npx on PATH.`
          : `Restart/reload with ${settings.apiKeyEnv} in the agent environment and npx on PATH. GUI launches may not inherit shell exports.`),
        ...agentAdapters.filter(adapter => agents.includes(adapter.id)).map(adapter => instruction(adapter.instructions)),
        `    Ask: "${customConfig ? `Use LambdaDB with CLI config ${JSON.stringify(config)}. ` : ''}List my LambdaDB collections and help me search one. Do not modify data."`,
      ] : [`    lambdadb collections list --json${customConfig ? ' (pass --config with the path above)' : ''}`]),
      '',
      styleText('dim', '  Run your first query to verify search.'),
    ].join('\n');
  }
  return [
    `Connected to ${text(settings.project)}`,
    'Authentication and collection access verified; search not yet verified.',
    ...(customConfig ? [`CLI config: ${text(config)}`] : []),
    ...(agents.length ? [`Agents: ${agents.join(', ')} (${data.scope} scope; MCP ${data.writeTools ? 'read and write' : 'read-only'})`] : []),
    ...(count ? [`Files: ${count} created/updated.`] : []),
    '',
    ...(agents.length ? [
      'Next:',
      settings.credentialStore
        ? `  Restart/reload selected agents with ${settings.credentialStore} accessible and npx on PATH.`
        : `  Restart/reload selected agents with ${settings.apiKeyEnv} available in their environment.`,
      ...agentAdapters.filter(adapter => agents.includes(adapter.id)).map(adapter => `  - ${adapter.instructions}`),
      `  Ask: "Use LambdaDB with CLI config ${JSON.stringify(config)}. List collections and help me search one. Do not modify data."`,
    ] : [`Next: lambdadb collections list --json${customConfig ? ' (pass --config with the path above)' : ''}`]),
  ].map(text).join('\n');
}
