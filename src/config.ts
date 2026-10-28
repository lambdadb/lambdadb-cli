import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CredentialVault, credentialReference, type CredentialReference } from './credentials.js';
import { InputError } from './errors.js';

export type Settings = { endpoint?: string; project?: string; apiKeyEnv?: string; credentialKeyId?: string; credentialKeyName?: string } & Partial<CredentialReference>;
export type SelectedSettings = Required<Pick<Settings, 'endpoint' | 'project' | 'apiKeyEnv'>> & Partial<CredentialReference> & Pick<Settings, 'credentialKeyId' | 'credentialKeyName'>;
export type Config = SelectedSettings & { apiKey: string; timeoutMs: number };
export type Options = Settings & { config?: string; timeoutMs?: string };

export function timeoutMs(options: Options): number {
  return integer(options.timeoutMs ?? process.env.LAMBDADB_TIMEOUT_MS ?? '30000', 'Timeout', 1, 3600000);
}

export function defaultConfigPath(): string {
  return resolve(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'lambdadb', 'config.json'));
}

export function configPath(options: Options): string {
  return resolve(options.config ?? process.env.LAMBDADB_CONFIG ?? defaultConfigPath());
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
      || Object.keys(value).some(k => !['endpoint', 'project', 'apiKeyEnv', 'credentialStore', 'credentialId', 'credentialKeyId', 'credentialKeyName'].includes(k))
      || Object.values(value).some(v => typeof v !== 'string')) throw new Error();
    for (const key of ['credentialKeyId', 'credentialKeyName']) {
      if (value[key] !== undefined && (!value.credentialStore || !/^[a-zA-Z0-9_-]{1,128}$/.test(value[key]))) throw new Error();
    }
    if (value.credentialStore !== undefined || value.credentialId !== undefined) credentialReference(value.credentialStore, value.credentialId);
    return value;
  } catch { throw new InputError('Configuration must be a JSON object with endpoint, project, apiKeyEnv and optional credentialStore/credentialId/credentialKeyId/credentialKeyName strings. Never store an API key in it.'); }
}

export async function settings(options: Options, creating = false): Promise<SelectedSettings> {
  const saved = await loadSettings(configPath(options), !creating && !!(options.config ?? process.env.LAMBDADB_CONFIG));
  const selectedEndpoint = options.endpoint ?? process.env.LAMBDADB_ENDPOINT ?? saved.endpoint;
  const project = options.project ?? process.env.LAMBDADB_PROJECT ?? saved.project;
  if (!selectedEndpoint || !project) throw new InputError('Endpoint and project are required. Run configure or set LAMBDADB_ENDPOINT and LAMBDADB_PROJECT.');
  // Project names are encoded as a single SDK URL segment, with no implicit playground fallback.
  if (!/^[a-zA-Z0-9_-]+$/.test(project)) throw new InputError('Project must contain only letters, digits, underscores or hyphens.');
  const stored = options.credentialStore || options.credentialId ? credentialReference(options.credentialStore, options.credentialId) :
    saved.credentialStore ? credentialReference(saved.credentialStore, saved.credentialId) : undefined;
  const previousIdentity = stored?.credentialId === saved.credentialId ? saved : {};
  const identity = {
    ...(options.credentialKeyId ?? previousIdentity.credentialKeyId ? { credentialKeyId: options.credentialKeyId ?? previousIdentity.credentialKeyId } : {}),
    ...(options.credentialKeyName ?? previousIdentity.credentialKeyName ? { credentialKeyName: options.credentialKeyName ?? previousIdentity.credentialKeyName } : {}),
  };
  return {
    ...(stored && (options.credentialStore || !(options.apiKeyEnv ?? process.env.LAMBDADB_API_KEY_ENV)) ? { ...stored, ...identity } : {}),
    endpoint: endpoint(selectedEndpoint), project,
    apiKeyEnv: environmentName(options.apiKeyEnv ?? process.env.LAMBDADB_API_KEY_ENV ?? saved.apiKeyEnv ?? 'LAMBDADB_API_KEY'),
  };
}

export async function resolveConfig(options: Options, creating = false): Promise<Config> {
  const selected = await settings(options, creating);
  const apiKey = selected.credentialStore && selected.credentialId
    ? await new CredentialVault().read({ ...selected, ...credentialReference(selected.credentialStore, selected.credentialId) })
    : process.env[selected.apiKeyEnv];
  if (!apiKey || !apiKey.trim() || /[\r\n]/.test(apiKey)) throw new InputError('The selected API-key environment variable is missing or invalid. Supply it through your shell or CI secret manager.');
  return {
    ...selected, apiKey,
    timeoutMs: timeoutMs(options),
  };
}

export async function saveSettings(options: Options): Promise<{ path: string; settings: SelectedSettings }> {
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

export async function fileIdentity(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new InputError(`Cannot resolve configuration path: ${path}.`);
    const info = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new InputError(`Cannot resolve configuration path: ${path}.`);
    });
    if (info?.isSymbolicLink()) throw new InputError(`Configuration symbolic link has a missing target: ${path}. Restore its target before rerunning init.`);
    return join(await fileIdentity(dirname(path)), basename(path));
  }
}
