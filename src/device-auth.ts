import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { endpoint } from './config.js';
import { InputError } from './errors.js';
import type { Output } from './output.js';

async function request(
  origin: string,
  path: string,
  body: object,
  signal: AbortSignal,
  requestTimeoutMs = 30_000,
): Promise<{ ok: boolean; value: Record<string, unknown> }> {
  try {
    const response = await fetch(`${origin}/auth/device/${path}`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
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
    } finally {
      await reader.cancel().catch(() => {});
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return { ok: response.ok, value };
  } catch {
    throw new InputError(
      'Account login response could not be confirmed. Check connectivity and run login again explicitly. An undelivered session expires within seven days. No project key was requested.',
    );
  }
}

export function openBrowser(url: string, output: Output) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () =>
      output.diagnostic('Could not open a browser. Open the verification URL on any device.'),
    );
    child.unref();
  } catch {
    output.diagnostic('Open the verification URL on any device.');
  }
}

async function pollDevice(
  apiUrl: string,
  browser: boolean,
  output: Output,
  signal: AbortSignal,
  requestTimeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const origin = endpoint(apiUrl);
  const start = await request(origin, 'login', {}, signal, requestTimeoutMs);
  const s = start.value;
  if (!start.ok)
    throw new InputError(
      'CLI authorization is unavailable on this server. Check deployment/configuration, or obtain a project key in Console and use --api-key-env NAME.',
    );
  if (
    typeof s.device_code !== 'string' ||
    !/^[0-9a-f]{64}$/.test(s.device_code) ||
    typeof s.user_code !== 'string' ||
    !/^[A-Z2-7]{5}-[A-Z2-7]{5}$/.test(s.user_code) ||
    typeof s.verification_uri !== 'string' ||
    !Number.isInteger(s.expires_in) ||
    Number(s.expires_in) < 1 ||
    Number(s.expires_in) > 900 ||
    !Number.isInteger(s.interval) ||
    Number(s.interval) < 1 ||
    Number(s.interval) > 30
  )
    throw new InputError('Invalid CLI authorization contract. Check client/server versions.');
  output.protect(s.device_code);
  let url: URL;
  try {
    url = new URL(s.verification_uri);
    endpoint(url.origin);
    if (url.username || url.password || url.pathname !== '/auth/cli' || url.search || url.hash)
      throw new Error();
  } catch {
    throw new InputError('Invalid Console verification URL. Check server configuration.');
  }
  url.searchParams.set('user_code', s.user_code);
  output.diagnostic(
    `Open ${url.href} on any device. Confirm code ${s.user_code} and approve the CLI request. Only approve a request you started.`,
  );
  if (browser) openBrowser(url.href, output);
  const deadline = Date.now() + Number(s.expires_in) * 1000;
  let interval = Number(s.interval) * 1000;
  while (Date.now() < deadline) {
    await delay(Math.min(interval, Math.max(0, deadline - Date.now())), undefined, { signal });
    if (Date.now() >= deadline) break;
    const token = await request(
      origin,
      'token',
      { device_code: s.device_code },
      AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]),
      requestTimeoutMs,
    );
    if (token.ok) {
      return token.value;
    }
    if (token.value.error === 'account_session_limit')
      throw new InputError(
        'Too many active CLI logins. Run logout on another device/profile, or wait for unused sessions to expire (at most seven days), then run login again.',
      );
    if (token.value.error === 'authorization_pending') continue;
    if (token.value.error === 'slow_down') {
      interval = Math.min(interval + 5000, 30_000);
      continue;
    }
    if (token.value.error === 'access_denied')
      throw new InputError('Authorization was denied or project access changed. No connection was saved.');
    if (token.value.error === 'expired_token') break;
    throw new InputError(
      'Account login could not be confirmed. Run login again explicitly; an undelivered session expires within seven days. No project key was requested.',
    );
  }
  throw new InputError('Login authorization expired. Run lambdadb login again. No project was created.');
}

export function projectAuthorization(v: Record<string, unknown>, output: Output, fallbackName: string) {
  const credentials = v.credentials as { api_key?: unknown; key?: { key_id?: unknown } } | undefined;
  if (typeof credentials?.api_key === 'string') output.protect(credentials.api_key);
  if (
    typeof v.endpoint !== 'string' ||
    typeof v.project !== 'string' ||
    !/^[a-zA-Z0-9_-]+$/.test(v.project) ||
    typeof credentials?.api_key !== 'string' ||
    !credentials.api_key.trim() ||
    /[\r\n]/.test(credentials.api_key)
  ) {
    throw new InputError(
      'Issued key response is invalid. Inspect the named CLI key in Console; no automatic retry was made.',
    );
  }
  const keyId = credentials.key?.key_id;
  if (typeof keyId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(keyId))
    throw new InputError(
      'Issued key identity is invalid. Review the named CLI key in Console before reconnecting.',
    );
  return {
    endpoint: endpoint(v.endpoint),
    project: v.project,
    apiKey: credentials.api_key,
    credentialKeyId: keyId,
    credentialKeyName: typeof v.key_name === 'string' ? v.key_name : fallbackName,
  };
}

export async function authorizeAccount(
  apiUrl: string,
  browser: boolean,
  output: Output,
  signal: AbortSignal,
  requestTimeoutMs = 30_000,
) {
  const result = await pollDevice(apiUrl, browser, output, signal, requestTimeoutMs);
  const a = result.account as Record<string, unknown> | undefined;
  if (typeof a?.session_token === 'string') output.protect(a.session_token);
  if (
    !a ||
    typeof a.session_token !== 'string' ||
    !/^[0-9a-f]{64}$/.test(a.session_token) ||
    typeof a.member_id !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(a.member_id) ||
    typeof a.email !== 'string' ||
    typeof a.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(a.expires_at)) ||
    Date.parse(a.expires_at) <= Date.now() ||
    typeof a.console_url !== 'string'
  )
    throw new InputError(
      'Invalid CLI account response. Run login explicitly after checking the server version.',
    );
  return {
    token: a.session_token,
    memberId: a.member_id,
    email: a.email,
    expiresAt: a.expires_at,
    consoleUrl: endpoint(a.console_url),
  };
}
