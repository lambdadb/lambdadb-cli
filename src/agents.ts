import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { jsonConfig, strictJsonConfig, tomlConfig, type McpLaunch } from './agent-config.js';
import { InputError } from './errors.js';

export type AgentScope = 'project' | 'user';
export type AgentContext = { cwd: string; home: string; env: NodeJS.ProcessEnv; platform?: NodeJS.Platform };
type AgentPaths = { mcp: string; skill?: string };
export type AgentAdapter = {
  id: string;
  executable: string | readonly string[];
  scopes?: readonly AgentScope[];
  detectionDirectories(context: AgentContext): string[];
  paths(scope: AgentScope, context: AgentContext): AgentPaths | Promise<AgentPaths>;
  configure(path: string, text: string | undefined, launch: McpLaunch): string;
  instructions: string;
};

const codexServer = ({ command, args, apiKeyEnv, runtimeEnv }: McpLaunch) => ({ command, args, env_vars: apiKeyEnv ? [apiKeyEnv] : runtimeEnv ?? [] });
const claudeServer = ({ command, args, apiKeyEnv }: McpLaunch) => ({
  type: 'stdio', command, args, env: apiKeyEnv ? { [apiKeyEnv]: `\${${apiKeyEnv}}` } : {},
});
const cursorServer = ({ command, args, apiKeyEnv }: McpLaunch) => ({
  type: 'stdio', command, args, env: apiKeyEnv ? { [apiKeyEnv]: `\${env:${apiKeyEnv}}` } : {},
});
const geminiServer = ({ command, args, apiKeyEnv }: McpLaunch) => ({
  command, args, env: apiKeyEnv ? { [apiKeyEnv]: `\${${apiKeyEnv}}` } : {},
});
const opencodeServer = ({ command, args, apiKeyEnv }: McpLaunch) => ({
  type: 'local', command: [command, ...args], environment: apiKeyEnv ? { [apiKeyEnv]: `{env:${apiKeyEnv}}` } : {},
});

function vscodeUserDirectory({ cwd, home, env, platform = process.platform }: AgentContext): string {
  if (env.VSCODE_PORTABLE) return resolve(cwd, env.VSCODE_PORTABLE, 'user-data', 'User');
  const appData = env.VSCODE_APPDATA ?? (platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : platform === 'win32' ? env.APPDATA ?? join(home, 'AppData', 'Roaming')
    : env.XDG_CONFIG_HOME ?? join(home, '.config'));
  return resolve(cwd, appData, 'Code', 'User');
}

function geminiDirectory({ cwd, home, env }: AgentContext): string {
  return resolve(cwd, env.GEMINI_CLI_HOME ?? home, '.gemini');
}

function opencodeDirectory({ cwd, home, env }: AgentContext): string {
  return resolve(cwd, env.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode');
}

async function opencodePaths(scope: AgentScope, context: AgentContext): Promise<AgentPaths> {
  const root = scope === 'user' ? opencodeDirectory(context) : context.cwd;
  const json = join(root, 'opencode.json');
  const jsonc = join(root, 'opencode.jsonc');
  const [hasJson, hasJsonc] = await Promise.all([exists(json), exists(jsonc)]);
  if (hasJson && hasJsonc) throw new InputError(`Both ${json} and ${jsonc} exist. Consolidate the active OpenCode configuration before running init so no LambdaDB entry is shadowed.`);
  return { mcp: hasJsonc ? jsonc : json, skill: join(scope === 'user' ? root : join(root, '.opencode'), 'skills', 'lambdadb', 'SKILL.md') };
}

function opencodeMapPath(value: Record<string, unknown>): readonly string[] {
  const mcp = value.mcp;
  if (mcp && typeof mcp === 'object' && !Array.isArray(mcp) && 'servers' in mcp) {
    const servers = mcp.servers;
    // A V1 server may itself be named "servers". Preserve that server's shape.
    const legacyServer = servers && typeof servers === 'object' && 'type' in servers && typeof servers.type === 'string';
    if (!legacyServer) {
      if ('lambdadb' in mcp) throw new InputError('OpenCode has both a V1 LambdaDB entry and a V2 MCP server map. Consolidate the LambdaDB entry before rerunning init.');
      return ['mcp', 'servers'];
    }
  }
  // V1 configuration remains supported by V2; never migrate unrelated settings.
  return ['mcp'];
}

function copilotDirectory({ cwd, home, env }: AgentContext): string {
  return resolve(cwd, env.COPILOT_HOME ?? join(home, '.copilot'));
}

async function copilotPaths(scope: AgentScope, context: AgentContext): Promise<AgentPaths> {
  if (scope === 'user') return { mcp: join(copilotDirectory(context), 'mcp-config.json'),
    skill: join(copilotDirectory(context), 'skills', 'lambdadb', 'SKILL.md') };
  const rootConfig = join(context.cwd, '.mcp.json');
  const sharedConfig = join(context.cwd, '.github', 'mcp.json');
  return { mcp: await exists(rootConfig) || !await exists(sharedConfig) ? rootConfig : sharedConfig,
    skill: join(context.cwd, '.github', 'skills', 'lambdadb', 'SKILL.md') };
}

function copilotMapPath(value: Record<string, unknown>): readonly string[] {
  if ('mcpServers' in value || Object.keys(value).length === 0) return ['mcpServers'];
  // Copilot also reads bare maps. Do not hide those entries behind a new wrapper.
  const bare = Object.values(value).every(entry => entry && typeof entry === 'object' && !Array.isArray(entry)
    && ('command' in entry || 'url' in entry || 'type' in entry));
  if (!bare) throw new InputError('Copilot MCP configuration must contain mcpServers or a bare map of server definitions. Fix it before rerunning init.');
  return [];
}

function clineSettingsDirectory(context: AgentContext): string {
  return join(vscodeUserDirectory(context), 'globalStorage', 'saoudrizwan.claude-dev', 'settings');
}

// Register new agents here; init consumes this contract without agent-specific branches.
export const agentAdapters = [
  {
    id: 'codex', executable: 'codex',
    detectionDirectories: ({ cwd, home, env }) => [env.CODEX_HOME ?? join(home, '.codex'), join(cwd, '.codex')],
    paths(scope, { cwd, home, env }) {
      const root = scope === 'user' ? home : cwd;
      const directory = scope === 'user' ? resolve(env.CODEX_HOME ?? join(root, '.codex')) : join(root, '.codex');
      return { mcp: join(directory, 'config.toml'), skill: join(root, '.agents', 'skills', 'lambdadb', 'SKILL.md') };
    },
    configure: (path, text, launch) => tomlConfig(path, text, launch, codexServer),
    instructions: 'Codex: trust the project if using project scope, start a new session, and check /mcp.',
  },
  {
    id: 'claude', executable: 'claude',
    detectionDirectories: ({ cwd, home, env }) => [env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), join(cwd, '.claude')],
    paths(scope, { cwd, home, env }) {
      const root = scope === 'user' ? home : cwd;
      const directory = scope === 'user' ? resolve(env.CLAUDE_CONFIG_DIR ?? join(root, '.claude')) : join(root, '.claude');
      return { mcp: scope === 'user' ? join(env.CLAUDE_CONFIG_DIR ? directory : root, '.claude.json') : join(root, '.mcp.json'),
        skill: join(directory, 'skills', 'lambdadb', 'SKILL.md') };
    },
    configure: (path, text, launch) => jsonConfig(path, text, launch, claudeServer),
    instructions: 'Claude Code: restart and approve the project MCP server if prompted; check /mcp.',
  },
  {
    id: 'cursor', executable: ['cursor', 'cursor-agent'],
    detectionDirectories: ({ cwd, home }) => [join(home, '.cursor'), join(cwd, '.cursor')],
    paths(scope, { cwd, home }) {
      const root = scope === 'user' ? home : cwd;
      return { mcp: join(root, '.cursor', 'mcp.json'), skill: join(root, '.cursor', 'skills', 'lambdadb', 'SKILL.md') };
    },
    configure: (path, text, launch) => jsonConfig(path, text, launch, cursorServer),
    instructions: 'Cursor: restart/reload and check MCP settings.',
  },
  {
    id: 'vscode', executable: 'code',
    detectionDirectories: context => [join(context.home, '.vscode'), join(context.cwd, '.vscode'), vscodeUserDirectory(context)],
    paths(scope, context) {
      return { mcp: scope === 'user' ? join(vscodeUserDirectory(context), 'mcp.json') : join(context.cwd, '.vscode', 'mcp.json'),
        skill: join(scope === 'user' ? context.home : context.cwd, scope === 'user' ? '.copilot' : '.github', 'skills', 'lambdadb', 'SKILL.md') };
    },
    configure: (path, text, launch) => jsonConfig(path, text, launch, cursorServer, ['servers']),
    instructions: 'VS Code: reload the window, trust the workspace, and use MCP: List Servers to start/check lambdadb. Init targets the Local harness and the default user profile, not portable Copilot or remote profiles.',
  },
  {
    id: 'gemini', executable: 'gemini',
    detectionDirectories: context => [geminiDirectory(context), join(context.cwd, '.gemini')],
    paths(scope, context) {
      const root = scope === 'user' ? geminiDirectory(context) : join(context.cwd, '.gemini');
      return { mcp: join(root, 'settings.json'), skill: join(root, 'skills', 'lambdadb', 'SKILL.md') };
    },
    configure: (path, text, launch) => jsonConfig(path, text, launch, geminiServer),
    instructions: 'Gemini CLI: restart or run /mcp refresh and /skills reload, trust the workspace if prompted, and check /mcp and /skills list.',
  },
  {
    id: 'opencode', executable: 'opencode',
    detectionDirectories: context => [opencodeDirectory(context), join(context.cwd, '.opencode'), join(context.cwd, 'opencode.json'), join(context.cwd, 'opencode.jsonc')],
    paths: opencodePaths,
    configure: (path, text, launch) => jsonConfig(path, text, launch, opencodeServer, opencodeMapPath),
    instructions: 'OpenCode: restart and run opencode mcp list. Init preserves existing V2 mcp.servers maps; new files use V1 syntax supported by V1 and V2. Custom config files and organization policies may override these settings.',
  },
  {
    id: 'copilot', executable: 'copilot',
    detectionDirectories: context => [copilotDirectory(context), join(context.cwd, '.github', 'mcp.json')],
    paths: copilotPaths,
    configure: (path, text, launch) => strictJsonConfig(path, text, launch, claudeServer, copilotMapPath),
    instructions: 'GitHub Copilot CLI: restart with the configured credential source available, trust the repository, then check /mcp and run /skills reload. Project MCP settings override user settings.',
  },
  {
    id: 'kiro', executable: ['kiro', 'kiro-cli'],
    detectionDirectories: ({ cwd, home }) => [join(home, '.kiro'), join(cwd, '.kiro')],
    paths(scope, { cwd, home }) {
      const directory = join(scope === 'user' ? home : cwd, '.kiro');
      return { mcp: join(directory, 'settings', 'mcp.json'), skill: join(directory, 'skills', 'lambdadb', 'SKILL.md') };
    },
    configure: (path, text, launch) => jsonConfig(path, text, launch, geminiServer),
    instructions: 'Kiro IDE/CLI: restart with the configured credential source available and check /mcp. For environment mode, approve the selected variable in Mcp Approved Env Vars when prompted. Custom agents must include the MCP JSON and skill resources; init does not alter agent permissions or definitions.',
  },
  {
    id: 'cline', executable: [], scopes: ['user'],
    detectionDirectories: context => [clineSettingsDirectory(context)],
    paths(_scope, context) {
      return { mcp: join(clineSettingsDirectory(context), 'cline_mcp_settings.json'),
        skill: join(context.home, '.cline', 'skills', 'lambdadb', 'SKILL.md') };
    },
    configure: (path, text, launch) => strictJsonConfig(path, text, launch, cursorServer),
    instructions: 'Cline VS Code extension: reload VS Code with the configured credential source available and check MCP Servers and the Skills menu. Init targets the default stable VS Code profile, not Cline CLI or other editors/profiles. No tools are auto-approved.',
  },
] as const satisfies readonly AgentAdapter[];

export type Agent = typeof agentAdapters[number]['id'];
export const agentNames = agentAdapters.map(adapter => adapter.id).join(',');

async function exists(path: string, executable = false) {
  try { await access(path, executable ? constants.X_OK : constants.F_OK); return true; }
  catch { return false; }
}

export async function detectAgents(context: AgentContext): Promise<Agent[]> {
  const paths = (context.env.PATH ?? '').split(delimiter);
  const found = await Promise.all(agentAdapters.map(async adapter => {
    const executables = typeof adapter.executable === 'string' ? [adapter.executable] : adapter.executable;
    const commands = executables.flatMap(executable => process.platform === 'win32'
      ? [executable + '.exe', executable + '.cmd', executable] : [executable]);
    const matches = await Promise.all([
      ...adapter.detectionDirectories(context).map(path => exists(path)),
      ...paths.flatMap(path => commands.map(command => exists(join(path, command), true))),
    ]);
    return matches.some(Boolean) ? adapter.id : undefined;
  }));
  return found.filter((agent): agent is Agent => agent !== undefined);
}
