import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { configPath, endpoint, fileIdentity, saveSettings, type Options, type SelectedSettings } from './config.js';
import { CredentialVault, type CredentialStore } from './credentials.js';
import { InputError } from './errors.js';
import type { Output } from './output.js';

async function request(origin: string, path: string, body: object, signal: AbortSignal): Promise<{ ok: boolean; value: Record<string, unknown> }> {
  try {
    const response = await fetch(`${origin}/auth/device/${path}`, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65_536) throw new Error();
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return { ok: response.ok, value };
  } catch {
    throw new InputError('Cannot confirm the authorization response. Do not retry key issuance automatically. Check connectivity and the CLI key in Console; existing-key environment setup remains available.');
  }
}

function openBrowser(url: string, output: Output) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => output.diagnostic('Could not open a browser. Open the verification URL on any device.'));
    child.unref();
  } catch { output.diagnostic('Open the verification URL on any device.'); }
}

export async function authorizeDevice(apiUrl: string, browser: boolean, output: Output, signal: AbortSignal) {
  const origin = endpoint(apiUrl);
  const start = await request(origin, 'start', {}, signal);
  const s = start.value;
  if (!start.ok) throw new InputError('CLI authorization is unavailable on this server. Check deployment/configuration, or obtain a project key in Console and use --api-key-env NAME.');
  if (typeof s.device_code !== 'string' || !/^[0-9a-f]{64}$/.test(s.device_code) || typeof s.user_code !== 'string' || !/^[A-Z2-7]{5}-[A-Z2-7]{5}$/.test(s.user_code)
    || typeof s.verification_uri !== 'string' || !Number.isInteger(s.expires_in) || Number(s.expires_in) < 1 || Number(s.expires_in) > 900
    || !Number.isInteger(s.interval) || Number(s.interval) < 1 || Number(s.interval) > 30) throw new InputError('Invalid CLI authorization contract. Check client/server versions.');
  output.protect(s.device_code);
  let url: URL;
  try {
    url = new URL(s.verification_uri);
    endpoint(url.origin);
    if (url.username || url.password || url.pathname !== '/auth/cli' || url.search || url.hash) throw new Error();
  } catch { throw new InputError('Invalid Console verification URL. Check server configuration.'); }
  url.searchParams.set('user_code', s.user_code);
  output.diagnostic(`Open ${url.href} on any device. Confirm code ${s.user_code} and approve your chosen project. Only approve a request you started.`);
  output.diagnostic(`If delivery fails after approval, inspect key lambdadb-cli-${s.user_code.replace('-', '')} in Console before starting again.`);
  if (browser) openBrowser(url.href, output);
  const deadline = Date.now() + Number(s.expires_in) * 1000;
  let interval = Number(s.interval) * 1000;
  while (Date.now() < deadline) {
    await delay(Math.min(interval, Math.max(0, deadline - Date.now())), undefined, { signal });
    if (Date.now() >= deadline) break;
    const token = await request(origin, 'token', { device_code: s.device_code }, AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]));
    if (token.ok) {
      const v = token.value;
      const credentials = v.credentials as { api_key?: unknown; key?: { key_id?: unknown } } | undefined;
      if (typeof credentials?.api_key === 'string') output.protect(credentials.api_key);
      if (typeof v.endpoint !== 'string' || typeof v.project !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(v.project)
        || typeof credentials?.api_key !== 'string' || !credentials.api_key.trim() || /[\r\n]/.test(credentials.api_key)) {
        throw new InputError('Issued key response is invalid. Inspect the CLI key in Console; no automatic retry was made.');
      }
      const keyId = credentials.key?.key_id;
      if (typeof keyId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(keyId)) throw new InputError('Issued key identity is invalid. Review the named CLI key in Console before reconnecting.');
      return { endpoint: endpoint(v.endpoint), project: v.project, apiKey: credentials.api_key,
        credentialKeyId: keyId, credentialKeyName: `lambdadb-cli-${s.user_code.replace('-', '')}` };
    }
    if (token.value.error === 'authorization_pending') continue;
    if (token.value.error === 'slow_down') { interval = Math.min(interval + 5000, 30_000); continue; }
    if (token.value.error === 'access_denied') throw new InputError('Authorization was denied or project access changed. No connection was saved.');
    if (token.value.error === 'expired_token') break;
    throw new InputError('Key issuance could not be confirmed. Inspect the named CLI key in Console and revoke it if unused before explicitly reconnecting. No automatic retry was made.');
  }
  throw new InputError('Authorization expired. Your project may still be provisioning; select it again with init --connect when ready. Do not create another project to resume.');
}

export async function connectDevice(options: Options & { apiUrl?: string; browser?: boolean }, store: CredentialStore, output: Output, vault = new CredentialVault()): Promise<SelectedSettings> {
  const original = configPath(options);
  const destination = await fileIdentity(original);
  const read = () => readFile(destination, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new InputError('Cannot read the selected configuration before authorization.');
  });
  const before = await read();
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const authorization = await authorizeDevice(options.apiUrl ?? 'https://api.lambdadb.ai', options.browser !== false, output, cancellation.signal);
    const selected = { endpoint: authorization.endpoint, project: authorization.project, apiKeyEnv: 'LAMBDADB_API_KEY', credentialKeyId: authorization.credentialKeyId, credentialKeyName: authorization.credentialKeyName, credentialStore: store, credentialId: randomUUID() };
    await vault.save(selected, authorization.apiKey);
    try {
      // Save the usable connection before agent installation or doctor, so failures
      // resume with this key instead of issuing another key on a rerun.
      if (await fileIdentity(original) !== destination || await read() !== before) {
        throw new InputError('Configuration changed during authorization. No settings were overwritten. Review the named project key in Console before reconnecting.');
      }
      await saveSettings({ ...options, ...selected, config: destination });
    } catch (error) {
      await vault.remove(selected).catch(() => output.diagnostic('Local credential cleanup could not be confirmed. Check your OS store.'));
      throw error;
    }
    output.diagnostic(`Connection saved in ${configPath(options)}; project key stored in ${store}. Agent files contain only a credential reference.`);
    return selected;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
