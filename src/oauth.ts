import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { endpoint } from './config.js';
import { InputError } from './errors.js';
import type { Output } from './output.js';

/** The provisioned public native client; see the OAuth contract in the Backend. */
export const CLI_CLIENT_ID = 'lambdadb-cli';
export const ACCOUNT_SCOPE = ['account:manage', 'offline_access'];
export const CONNECTION_SCOPE = ['connection:read', 'connection:issue'];
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
// Login and consent attempts expire after 15 minutes on the provider.
const ATTEMPT_MS = 15 * 60_000;

export type Provider = {
  apiUrl: string;
  issuer: string;
  audience: string;
  consoleUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceEndpoint: string;
  revocationEndpoint: string;
};
export type Tokens = { accessToken: string; refreshToken?: string; expiresAt: number; scope: string[] };
type Reply = { status: number; ok: boolean; value: Record<string, unknown> };

async function call(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Reply> {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { ...init, redirect: 'error', signal: requestSignal });
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    // Explicitly cancel the body: Node 22 fetch can lose abort propagation after
    // headers when garbage collection runs, even while our signal stays alive.
    const abortBody = () => { void reader.cancel().catch(() => {}); };
    requestSignal.addEventListener('abort', abortBody, { once: true });
    try {
      requestSignal.throwIfAborted();
      for (;;) {
        const { done, value } = await reader.read();
        requestSignal.throwIfAborted();
        if (done) break;
        size += value.length;
        if (size > 65_536) throw new Error('response too large');
        chunks.push(value);
      }
    } finally {
      requestSignal.removeEventListener('abort', abortBody);
      await reader.cancel().catch(() => {});
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const value = text ? JSON.parse(text) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not a JSON object');
  return { status: response.status, ok: response.ok, value };
}

const form = (values: Record<string, string | undefined>) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
  body: new URLSearchParams(Object.entries(values).filter((e): e is [string, string] => e[1] !== undefined)).toString(),
});

/** An issuer is an HTTPS origin with a trailing slash (HTTP loopback for local tests). */
function issuerURL(value: unknown): string {
  if (typeof value !== 'string') throw new Error();
  const url = new URL(value);
  if (url.pathname !== '/' || url.search || url.hash || !value.endsWith('/')) throw new Error();
  endpoint(url.origin);
  return value;
}

/** Provider endpoints must stay on the issuer's origin. */
function onIssuer(value: unknown, issuer: string): string {
  if (typeof value !== 'string') throw new Error();
  const url = new URL(value);
  if (url.origin !== new URL(issuer).origin || url.username || url.password || url.hash) throw new Error();
  return url.href;
}

/** Reads the issuer's provider metadata; refresh and revocation need only the saved issuer. */
export async function providerMetadata(issuer: string, signal: AbortSignal | undefined, timeoutMs: number) {
  let reply: Reply;
  try {
    reply = await call(`${issuer}.well-known/openid-configuration`, { headers: { Accept: 'application/json' } }, signal, timeoutMs);
  } catch {
    throw new InputError('The LambdaDB sign-in service could not be reached. Check connectivity and retry.');
  }
  try {
    const v = reply.value;
    if (!reply.ok || v.issuer !== issuer) throw new Error();
    return {
      authorizationEndpoint: onIssuer(v.authorization_endpoint, issuer),
      tokenEndpoint: onIssuer(v.token_endpoint, issuer),
      deviceEndpoint: onIssuer(v.device_authorization_endpoint, issuer),
      revocationEndpoint: onIssuer(v.revocation_endpoint, issuer),
    };
  } catch {
    throw new InputError('The LambdaDB sign-in service returned invalid metadata. Check client/server versions.');
  }
}

/**
 * Discovers the issuer from RFC 9728 metadata on the API origin the user chose,
 * so a single --api-url selects the whole environment.
 */
export async function discover(apiUrl: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<Provider> {
  let reply: Reply;
  try {
    reply = await call(`${apiUrl}/.well-known/oauth-protected-resource`, { headers: { Accept: 'application/json' } }, signal, timeoutMs);
  } catch {
    throw new InputError(`Cannot reach ${apiUrl}. Check connectivity and --api-url, then run login again.`);
  }
  if (reply.status === 404)
    throw new InputError(
      `${apiUrl} does not offer OAuth login yet. Use a server with OAuth enabled, or obtain a project key in Console and use --api-key-env NAME.`,
    );
  let issuer: string, consoleUrl: string;
  try {
    const v = reply.value;
    const servers = v.authorization_servers;
    if (!reply.ok || typeof v.resource !== 'string' || endpoint(v.resource) !== apiUrl) throw new Error();
    if (!Array.isArray(servers) || servers.length !== 1) throw new Error();
    issuer = issuerURL(servers[0]);
    consoleUrl = endpoint(String(v.lambdadb_console_url));
  } catch {
    throw new InputError('The API returned invalid OAuth metadata. Check client/server versions.');
  }
  return { apiUrl, issuer, audience: apiUrl, consoleUrl, ...(await providerMetadata(issuer, signal, timeoutMs)) };
}

export function openBrowser(url: string, output: Output) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => output.diagnostic('Could not open a browser. Open the printed URL yourself.'));
    child.unref();
  } catch {
    output.diagnostic('Open the printed URL yourself.');
  }
}

function tokens(value: Record<string, unknown>, requested: string[], refresh: boolean): Tokens {
  const scope = typeof value.scope === 'string' ? value.scope.split(' ').filter(Boolean) : requested;
  if (
    typeof value.access_token !== 'string' ||
    !/^\S{16,4096}$/.test(value.access_token) ||
    typeof value.token_type !== 'string' ||
    value.token_type.toLowerCase() !== 'bearer' ||
    !Number.isInteger(value.expires_in) ||
    Number(value.expires_in) < 1 ||
    Number(value.expires_in) > 86_400 ||
    (refresh && (typeof value.refresh_token !== 'string' || !/^\S{16,4096}$/.test(value.refresh_token))) ||
    scope.some((s) => !requested.includes(s))
  )
    throw new InputError('The sign-in service returned an invalid token response. Check client/server versions.');
  return {
    accessToken: value.access_token,
    ...(refresh ? { refreshToken: value.refresh_token as string } : {}),
    expiresAt: Date.now() + Number(value.expires_in) * 1000,
    scope,
  };
}

const base64url = (bytes: Buffer) => bytes.toString('base64url');
const errorCode = (value: unknown) => (typeof value === 'string' && /^[a-z_]{1,64}$/.test(value) ? value : 'unknown_error');

function denied(code: string): InputError {
  return code === 'access_denied'
    ? new InputError('Authorization was denied or canceled. Nothing was saved.', '')
    : new InputError(`Authorization failed (${code}). Run the command again explicitly. Nothing was saved.`, '');
}

const page = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>LambdaDB CLI</title><p>${message}</p>`;

/** Authorization Code with S256 PKCE and an RFC 8252 loopback callback. */
async function codeFlow(
  p: Provider,
  scope: string[],
  connectionId: string | undefined,
  refresh: boolean,
  output: Output,
  signal: AbortSignal,
  timeoutMs: number,
  open: (url: string, output: Output) => void,
): Promise<Tokens> {
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(24));
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let result: { code?: string; error?: string };
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error();
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const url = new URL(p.authorizationEndpoint);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: CLI_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: scope.join(' '),
      state,
      code_challenge: base64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      audience: p.audience,
      ...(connectionId ? { connection_id: connectionId } : {}),
    }))
      url.searchParams.set(k, v);
    output.diagnostic(`Opening your browser to sign in. If it does not open, visit this link on this computer:\n${url.href}\nApprove only a request you started. Over SSH or without a browser, press Ctrl-C and rerun with --no-browser.\nWaiting for approval...`);
    open(url.href, output);
    result = await new Promise((resolve, reject) => {
      // Every outcome clears both the deadline and the abort listener, so a
      // canceled attempt does not keep the process alive until the deadline.
      const settle = (finish: () => void) => {
        clearTimeout(expire);
        signal.removeEventListener('abort', abort);
        finish();
      };
      const expire = setTimeout(() => settle(() => reject(new InputError('Authorization expired. Run the command again explicitly. Nothing was saved.', ''))), ATTEMPT_MS);
      const abort = () => settle(() => reject(new InputError('Authorization canceled. Nothing was saved.', '')));
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      server.on('request', (req, res) => {
        const u = new URL(req.url ?? '/', redirectUri);
        if (req.method !== 'GET' || u.pathname !== '/callback' || u.searchParams.get('state') !== state) {
          res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
          return;
        }
        const error = u.searchParams.get('error');
        res
          .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          .end(page(error ? 'Authorization was not completed. Return to your terminal.' : 'LambdaDB CLI is authorized. You can close this window and return to your terminal.'));
        settle(() => resolve(error ? { error: errorCode(error) } : { code: u.searchParams.get('code') ?? '' }));
      });
    });
    if (result.error || !result.code) throw denied(result.error ?? 'invalid_request');
    let reply: Reply;
    try {
      reply = await call(
        p.tokenEndpoint,
        form({ grant_type: 'authorization_code', code: result.code, redirect_uri: redirectUri, client_id: CLI_CLIENT_ID, code_verifier: verifier }),
        signal,
        timeoutMs,
      );
    } catch {
      throw new InputError('Authorization could not be completed: the token response was not received. Run the command again explicitly.', '');
    }
    if (!reply.ok) throw denied(errorCode(reply.value.error));
    return tokens(reply.value, scope, refresh);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

/** RFC 8628 Device Authorization for SSH and headless use. */
async function deviceFlow(
  p: Provider,
  scope: string[],
  connectionId: string | undefined,
  refresh: boolean,
  output: Output,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Tokens> {
  let start: Reply;
  try {
    start = await call(
      p.deviceEndpoint,
      form({ client_id: CLI_CLIENT_ID, scope: scope.join(' '), audience: p.audience, connection_id: connectionId }),
      signal,
      timeoutMs,
    );
  } catch {
    throw new InputError('Device authorization could not start. Check connectivity and run the command again.', '');
  }
  if (!start.ok) throw denied(errorCode(start.value.error));
  const s = start.value;
  let link: string;
  try {
    if (
      typeof s.device_code !== 'string' ||
      !/^\S{8,512}$/.test(s.device_code) ||
      typeof s.user_code !== 'string' ||
      !/^[A-Za-z0-9-]{4,32}$/.test(s.user_code) ||
      !Number.isInteger(s.expires_in) ||
      Number(s.expires_in) < 1 ||
      Number(s.expires_in) > 1800 ||
      (s.interval !== undefined && (!Number.isInteger(s.interval) || Number(s.interval) < 1 || Number(s.interval) > 60))
    )
      throw new Error();
    onIssuer(s.verification_uri, p.issuer);
    link = s.verification_uri_complete === undefined ? String(s.verification_uri) : onIssuer(s.verification_uri_complete, p.issuer);
  } catch {
    throw new InputError('Invalid device authorization response. Check client/server versions.');
  }
  output.protect(s.device_code);
  output.diagnostic(`Sign in on any device with this link:\n${link}\nCode: ${s.user_code}\nApprove only a request you started.\nWaiting for approval... (Ctrl-C to cancel)`);
  const deadline = Date.now() + Number(s.expires_in) * 1000;
  let interval = Number(s.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await delay(Math.min(interval, Math.max(0, deadline - Date.now())), undefined, { signal });
    if (Date.now() >= deadline) break;
    let reply: Reply;
    try {
      reply = await call(
        p.tokenEndpoint,
        form({ grant_type: DEVICE_GRANT, device_code: s.device_code, client_id: CLI_CLIENT_ID }),
        signal,
        timeoutMs,
      );
    } catch {
      throw new InputError('Authorization could not be confirmed: the token response was not received. Run the command again explicitly.', '');
    }
    if (reply.ok) return tokens(reply.value, scope, refresh);
    const code = errorCode(reply.value.error);
    if (code === 'authorization_pending') continue;
    if (code === 'slow_down') {
      interval = Math.min(interval + 5000, 60_000);
      continue;
    }
    if (code === 'expired_token') break;
    throw denied(code);
  }
  throw new InputError('Authorization expired. Run the command again explicitly. Nothing was saved.', '');
}

/**
 * Runs one authorization attempt: a loopback browser flow on this computer, or
 * the device flow when the browser should not be opened (SSH, headless).
 */
export function authorize(
  p: Provider,
  request: { scope: string[]; connectionId?: string; refresh: boolean; browser: boolean },
  output: Output,
  signal: AbortSignal,
  timeoutMs: number,
  open = openBrowser,
): Promise<Tokens> {
  return request.browser
    ? codeFlow(p, request.scope, request.connectionId, request.refresh, output, signal, timeoutMs, open)
    : deviceFlow(p, request.scope, request.connectionId, request.refresh, output, signal, timeoutMs);
}

export class RefreshRejected extends InputError {}

/**
 * Rotates a refresh token. A rejection means the grant is gone; a lost response
 * leaves the rotation uncertain, and both require a fresh login rather than a
 * replay loop.
 */
export async function refresh(p: Pick<Provider, 'tokenEndpoint'>, refreshToken: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<Tokens> {
  let reply: Reply;
  try {
    reply = await call(p.tokenEndpoint, form({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLI_CLIENT_ID }), signal, timeoutMs);
  } catch {
    throw new InputError('Account access could not be renewed: the sign-in service did not answer, so the login may have changed. Run login again; project connections are preserved.', '');
  }
  if (!reply.ok)
    throw new RefreshRejected('CLI login expired or was revoked. Run login again; project connections are preserved.', '');
  return tokens(reply.value, ACCOUNT_SCOPE, true);
}

/** RFC 7009 revocation; reports whether the provider confirmed it. */
export async function revoke(
  p: Pick<Provider, 'revocationEndpoint'>,
  token: string,
  hint: 'refresh_token' | 'access_token',
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<boolean> {
  try {
    return (await call(p.revocationEndpoint, form({ token, token_type_hint: hint, client_id: CLI_CLIENT_ID }), signal, timeoutMs)).ok;
  } catch {
    return false;
  }
}
