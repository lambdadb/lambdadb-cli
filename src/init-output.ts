import { relative, isAbsolute, sep } from 'node:path';
import { agentAdapters, type Agent } from './agents.js';
import type { initialize } from './init.js';

type FilePlan = { path: string; aliases?: string[]; destination?: string; kind: string; action: string };

// Project names and paths can contain terminal control characters.
const text = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, ' '); // eslint-disable-line no-control-regex

export function formatPlan(files: FilePlan[], agents: Agent[], scope: string, writeTools: boolean, context: { cwd: string; home: string }) {
  const displayPath = (path: string) => {
    for (const [root, prefix] of [[context.cwd, '.'], [context.home, '~']] as const) {
      const part = relative(root, path);
      if (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)) return text(part ? `${prefix}${sep}${part}` : prefix);
    }
    return text(path);
  };
  return [
    `Agents: ${agents.join(', ') || 'none'}`,
    `Scope: ${scope}${agents.length ? ` (${text(scope === 'project' ? context.cwd : context.home)})` : ' (no agent files)'}`,
    `MCP tools: ${writeTools ? 'read and write (explicit opt-in)' : 'read-only'}`,
    '',
    'Files (. = current directory, ~ = home):',
    ...files.map(file => `  ${file.action.padEnd(9)} ${[file.path, ...(file.aliases ?? [])].map(displayPath).join(', ')}${file.destination ? ` -> ${text(file.destination)}` : ''}`),
    '',
    'Type settings below to change scope or MCP write tools.',
  ].join('\n');
}

export function formatInit(data: Awaited<ReturnType<typeof initialize>>, config: string) {
  const { settings, agents } = data;
  const count = data.files.filter(file => file.action !== 'unchanged').length;
  return [
    `Connected to ${text(settings.project)}`,
    'Authentication and collection access verified.',
    `Credentials: ${settings.credentialStore ?? `environment variable ${settings.apiKeyEnv}`}`,
    `CLI config: ${text(config)}`,
    `Agents: ${agents.join(', ') || 'none'}${agents.length ? ` (${data.scope} scope; MCP ${data.writeTools ? 'read and write' : 'read-only'})` : ''}`,
    `Files: ${count ? `${count} created/updated` : 'already up to date'}.`,
    '',
    'Next:',
    ...(agents.length ? [
      settings.credentialStore
        ? `  Restart/reload selected agents with ${settings.credentialStore} accessible and npx on PATH.`
        : `  Restart/reload selected agents with ${settings.apiKeyEnv} available in their environment.`,
      ...agentAdapters.filter(adapter => agents.includes(adapter.id)).map(adapter => `  - ${adapter.instructions}`),
      `  Ask: "Use LambdaDB with CLI config ${JSON.stringify(config)}. List collections and help me search one. Do not modify data."`,
    ] : ['  Run lambdadb collections list --json (add --config with the path above for a custom config).']),
    '',
    'Search readiness has not been checked. An empty project needs data before searching.',
  ].map(text).join('\n');
}
