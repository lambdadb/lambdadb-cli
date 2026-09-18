import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { InputError } from './errors.js';

export type Settings = { endpoint?: string; project?: string; apiKeyEnv?: string };
export type Config = Required<Settings> & { apiKey: string; timeoutMs: number };
export type Options = Settings & { config?: string; timeoutMs?: string };

export function configPath(options: Options): string {
  return resolve(options.config ?? process.env.LAMBDADB_CONFIG
    ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'lambdadb', 'config.json'));
}

export function endpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new InputError('Endpoint must be an absolute HTTPS origin.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new InputError('Endpoint must be an HTTPS origin without credentials, path, query or fragment (HTTP loopback is allowed for local tests).');
  }
  return url.origin;
}

export function name(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{3,52}$/.test(value)) {
    throw new InputError(`${label} must contain 3–52 letters, digits, underscores or hyphens.`);
  }
  return value;
}

function environmentName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new InputError('API-key environment variable name is invalid.');
  return value;
}

export function integer(value: string, label: string, min: number, max: number): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new InputError(`${label} must be an integer from ${min} to ${max}.`);
  }
  return Number(value);
}

export async function loadSettings(path: string, explicitlySelected = false): Promise<Settings> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !explicitlySelected) return {};
    throw new InputError('Cannot read the selected configuration file.');
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(k => !['endpoint', 'project', 'apiKeyEnv'].includes(k))
      || Object.values(value).some(v => typeof v !== 'string')) throw new Error();
    return value;
  } catch { throw new InputError('Configuration must be a JSON object with only endpoint, project and apiKeyEnv strings. Never store an API key in it.'); }
}

export async function settings(options: Options, creating = false): Promise<Required<Settings>> {
  const saved = await loadSettings(configPath(options), !creating && !!(options.config ?? process.env.LAMBDADB_CONFIG));
  const selectedEndpoint = options.endpoint ?? process.env.LAMBDADB_ENDPOINT ?? saved.endpoint;
  const project = options.project ?? process.env.LAMBDADB_PROJECT ?? saved.project;
  if (!selectedEndpoint || !project) throw new InputError('Endpoint and project are required. Run configure or set LAMBDADB_ENDPOINT and LAMBDADB_PROJECT.');
  // Project names are encoded as a single SDK URL segment, with no implicit playground fallback.
  if (!/^[a-zA-Z0-9_-]+$/.test(project)) throw new InputError('Project must contain only letters, digits, underscores or hyphens.');
  return {
    endpoint: endpoint(selectedEndpoint), project,
    apiKeyEnv: environmentName(options.apiKeyEnv ?? process.env.LAMBDADB_API_KEY_ENV ?? saved.apiKeyEnv ?? 'LAMBDADB_API_KEY'),
  };
}

export async function resolveConfig(options: Options): Promise<Config> {
  const selected = await settings(options);
  const apiKey = process.env[selected.apiKeyEnv];
  if (!apiKey || !apiKey.trim() || /[\r\n]/.test(apiKey)) throw new InputError('The selected API-key environment variable is missing or invalid. Supply it through your shell or CI secret manager.');
  return {
    ...selected, apiKey,
    timeoutMs: integer(options.timeoutMs ?? process.env.LAMBDADB_TIMEOUT_MS ?? '30000', 'Timeout', 1, 3600000),
  };
}

export async function saveSettings(options: Options): Promise<{ path: string; settings: Required<Settings> }> {
  const value = await settings(options, true);
  const path = configPath(options);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } catch { throw new InputError('Cannot save configuration. Check the selected path and directory permissions.'); }
  finally { await rm(temp, { force: true }).catch(() => {}); }
  return { path, settings: value };
}
