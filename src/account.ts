import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, open, stat, utimes } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { configPath, endpoint, fileIdentity, timeoutMs, type Options } from './config.js';
import { CredentialVault, credentialReference, type CredentialReference } from './credentials.js';
import { cli } from './command.js';
import { ACCOUNT_SCOPE, CLI_CLIENT_ID, CONNECTION_SCOPE, authorize, discover, providerMetadata, refresh, revoke, type Tokens } from './oauth.js';
import { CredentialStoreError, InputError, ManagementError } from './errors.js';
import type { Output } from './output.js';

export type AccountOptions = Options & { apiUrl?: string; browser?: boolean; signal?: AbortSignal; guided?: boolean };
export type Account = CredentialReference & {
  apiUrl: string;
  consoleUrl: string;
  issuer: string;
  memberId: string;
  email: string;
  expiresAt: string;
};
/** The OS-store secret of an account login: the provider grant, never a project key. */
type Session = { refresh_token: string; access_token: string; access_expires_at: number };

// Each refresh rotates the token and renews its seven-day lifetime.
const REFRESH_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const EXPIRY_MARGIN_MS = 60_000;
const ACCOUNT_KEYS = ['apiUrl', 'consoleUrl', 'issuer', 'memberId', 'email', 'expiresAt', 'credentialStore', 'credentialId'];

export const accountVault = () => new CredentialVault(undefined, process.platform, 'account');
export const accountPath = async (options: Options) =>
  `${await fileIdentity(configPath(options))}.account.json`;
export const accountTarget = (a: Pick<Account, 'apiUrl' | 'credentialStore' | 'credentialId'>) => ({ ...a, endpoint: a.apiUrl, project: 'account' });

export async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new InputError(`Cannot read ${path}. Check file permissions.`);
  }
}
export async function writeMetadata(path: string, value: unknown, before: string | undefined) {
  const destination = await fileIdentity(path);
  if ((await readOptional(path)) !== before)
    throw new InputError(`Configuration changed: ${path}. Retry after reviewing it.`);
  const temp = `${destination}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temp, destination);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}
export async function withManagementLock<T>(options: Options, action: () => Promise<T>): Promise<T> {
  const path = `${await fileIdentity(configPath(options))}.management.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch {
    throw new InputError(
      `Another management operation may be running. After confirming it has stopped, remove ${path} and retry.`,
    );
  }
  try {
    await handle.writeFile(String(process.pid));
    return await action();
  } finally {
    await handle.close();
    await rm(path, { force: true });
  }
}

/**
 * Serializes refresh-token rotation across concurrent CLI processes. Unlike the
 * management lock it waits, because parallel read commands are normal. The
 * holder refreshes the lock's time while it works, however long its requests
 * may take, so only a lock without that heartbeat (a killed process) is stale.
 * Each holder removes only the lock that still carries its own token.
 */
const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
async function withRefreshLock<T>(options: AccountOptions, action: () => Promise<T>): Promise<T> {
  const path = `${await fileIdentity(configPath(options))}.account.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + 40_000;
  for (;;) {
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await readFile(path, 'utf8').catch(() => undefined);
      const age = await stat(path).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (owner !== undefined && age > LOCK_STALE_MS) {
        // Remove only the stale lock observed, never one another waiter just created.
        if ((await readFile(path, 'utf8').catch(() => undefined)) === owner) await rm(path, { force: true });
      } else if (Date.now() > deadline) {
        throw new InputError(`Another CLI command is renewing account access. Retry; if this persists, remove ${path}.`);
      } else {
        await delay(200, undefined, { signal: options.signal });
      }
      continue;
    }
    const heartbeat = setInterval(() => {
      const now = new Date();
      void utimes(path, now, now).catch(() => {});
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      await handle.writeFile(token);
      await handle.close();
      return await action();
    } finally {
      clearInterval(heartbeat);
      await handle.close().catch(() => {});
      if ((await readFile(path, 'utf8').catch(() => undefined)) === token) await rm(path, { force: true });
    }
  }
}

function legacy(text: string): (CredentialReference & { apiUrl: string }) | undefined {
  try {
    const a = JSON.parse(text);
    if (a.issuer !== undefined || typeof a.apiUrl !== 'string') return undefined;
    return { apiUrl: endpoint(a.apiUrl), ...credentialReference(a.credentialStore, a.credentialId) };
  } catch {
    return undefined;
  }
}
function parseAccount(text: string): Account {
  if (legacy(text))
    throw new InputError(`CLI login now uses LambdaDB OAuth. Run ${cli} login again; project connections are preserved.`, '');
  let a: Account;
  try {
    a = JSON.parse(text);
    credentialReference(a.credentialStore, a.credentialId);
    if (
      Object.keys(a).some((k) => !ACCOUNT_KEYS.includes(k)) ||
      typeof a.memberId !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(a.memberId) ||
      typeof a.email !== 'string' ||
      typeof a.issuer !== 'string' ||
      typeof a.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(a.expiresAt))
    )
      throw new Error();
    if (endpoint(a.apiUrl) !== a.apiUrl || endpoint(a.consoleUrl) !== a.consoleUrl || new URL(a.issuer).href !== a.issuer) throw new Error();
  } catch {
    throw new InputError(
      'Invalid account metadata. Never store tokens in configuration; restore the file or run login.',
    );
  }
  return a;
}
export async function loadAccount(options: AccountOptions): Promise<Account> {
  const text = await readOptional(await accountPath(options));
  if (!text)
    throw new InputError(
      `Run ${cli} login first. Project-key environment setup remains available without account login.`, '',
    );
  const a = parseAccount(text);
  if (options.apiUrl && endpoint(options.apiUrl) !== a.apiUrl)
    throw new InputError(
      'This login belongs to a different API origin. Run login with --api-url for that server.',
    );
  if (Date.parse(a.expiresAt) <= Date.now())
    throw new InputError(
      `CLI login expired. Run ${cli} login again; existing project connections are preserved.`, '',
    );
  return a;
}

const encodeSession = (t: Tokens) =>
  JSON.stringify({ refresh_token: t.refreshToken, access_token: t.accessToken, access_expires_at: t.expiresAt });
async function readSession(vault: CredentialVault, account: Account, output: Output): Promise<Session> {
  let text: string;
  try {
    text = await vault.read(accountTarget(account));
  } catch {
    throw new CredentialStoreError(
      'Cannot read the CLI account session. Unlock the recorded OS store or run login explicitly. No account credential is forwarded to MCP.',
      'Retry from an interactive terminal of the same OS user with the store unlocked, or run login again.',
    );
  }
  output.protect(text);
  try {
    const s = JSON.parse(text) as Session;
    if (typeof s.refresh_token !== 'string' || typeof s.access_token !== 'string' || !Number.isFinite(s.access_expires_at)) throw new Error();
    output.protect(s.refresh_token);
    output.protect(s.access_token);
    return s;
  } catch {
    throw new InputError(`The saved account session is unreadable. Run ${cli} login again.`, '');
  }
}

/** Calls an existing Backend API route with an account access token. */
export async function accountRequest(
  account: Pick<Account, 'apiUrl' | 'consoleUrl'>,
  token: string,
  path: string,
  method = 'GET',
  body?: object,
  org?: string,
  signal?: AbortSignal,
  requestTimeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  let response: Response | undefined;
  let value: Record<string, unknown>;
  // CLI-authored request name for diagnostics; never includes query values or IDs.
  const request = `${method} ${path.replace(/\?.*$/, '').replace(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, '{id}')}`;
  try {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]) : AbortSignal.timeout(requestTimeoutMs);
    response = await fetch(`${account.apiUrl}/${path}`, {
      method,
      redirect: 'error',
      headers: {
        // Anonymous routes such as project-connection creation take no token.
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
        ...(org ? { 'X-Organization-ID': org } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: requestSignal,
    });
    if (response.status === 204) return {};
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    // Explicitly cancel the body: Node 22 fetch can lose abort propagation after
    // headers when garbage collection runs, even while our signal stays alive.
    const abortBody = () => { void reader.cancel().catch(() => {}); };
    requestSignal.addEventListener('abort', abortBody, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      requestSignal.throwIfAborted();
      for (;;) {
        const next = await reader.read();
        requestSignal.throwIfAborted();
        if (next.done) break;
        size += next.value.length;
        if (size > 2_000_000) throw new Error();
        chunks.push(next.value);
      }
    } finally {
      requestSignal.removeEventListener('abort', abortBody);
      await reader.cancel().catch(() => {});
    }
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  } catch {
    // A rejection remains definite without a JSON body. A key-issuance conflict
    // may represent an already claimed issuance, whose result cannot be recovered.
    const status = response?.status;
    if (status !== undefined && status >= 400 && status < 500 && status !== 408 &&
      !(/\/key$/.test(path) && status === 409)) {
      throw new ManagementError(status === 401 ? 'login_required' : status === 403 ? 'access_denied' : 'management_request_failed', status, { request });
    }
    throw new ManagementError(
      method === 'GET' ? 'management_unavailable' : 'write_outcome_unknown',
      status,
      { request, response: response ? 'incomplete' : 'none' },
    );
  }
  if (!response.ok) {
    const known = ['issuance_unconfirmed', 'recovery_required', 'project_not_ready', 'expired', 'owner_or_admin_required', 'target_unavailable'];
    const code =
      method !== 'GET' && (response.status >= 500 || response.status === 408) && value.error !== 'issuance_unconfirmed'
        ? 'write_outcome_unknown'
        : typeof value.error === 'string' && known.includes(value.error)
          ? value.error
          : response.status === 401
            ? 'login_required'
            : response.status === 403
              ? 'access_denied'
              : 'management_request_failed';
    // Only a small allowlist of non-secret fields may reach diagnostics.
    const details: Record<string, unknown> = { request };
    if (typeof value.invitation_id === 'string' && /^[0-9a-f-]{36}$/.test(value.invitation_id)) {
      details.invitation_id = value.invitation_id;
      details.invitation_url = `${account.consoleUrl}/invites/${value.invitation_id}`;
    }
    throw new ManagementError(code, response.status, details);
  }
  return value;
}
export type Organization = {
  id: string;
  name: string;
  role: string;
  plan: string;
  max_projects: number;
  projects_count: number;
  billing_url: string;
  can_upgrade: boolean;
};
export function parseOrganization(value: unknown, a: Pick<Account, 'consoleUrl'>): Organization {
  const v = value as Organization;
  if (
    !v ||
    typeof v.id !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(v.id) ||
    typeof v.name !== 'string' ||
    !['owner', 'admin', 'member'].includes(v.role) ||
    typeof v.plan !== 'string' ||
    !Number.isInteger(v.max_projects) ||
    v.max_projects < 0 ||
    !Number.isInteger(v.projects_count) ||
    v.projects_count < 0
  )
    throw new InputError('Invalid Organization response. Check server compatibility.');
  return {
    id: v.id,
    name: v.name,
    role: v.role,
    plan: v.plan,
    max_projects: v.max_projects,
    projects_count: v.projects_count,
    billing_url: `${a.consoleUrl}/organization/billing/open?org_id=${encodeURIComponent(v.id)}`,
    can_upgrade: v.role === 'owner',
  };
}

/**
 * Renews the access token under the refresh lock. Another process may already
 * have rotated it, so the saved login is reread first. The rotated session goes
 * into a fresh OS-store slot before the metadata points to it.
 */
async function renew(options: AccountOptions, output: Output, vault: CredentialVault, account: Account, rejected?: string) {
  return withRefreshLock(options, async () => {
    const path = await accountPath(options);
    const before = await readOptional(path);
    if (!before) throw new InputError(`Run ${cli} login first.`, '');
    const latest = parseAccount(before);
    if (latest.memberId !== account.memberId || latest.apiUrl !== account.apiUrl)
      throw new InputError('The saved login changed during this command. Rerun it.', '');
    const session = await readSession(vault, latest, output);
    if (session.access_token !== rejected && session.access_expires_at - EXPIRY_MARGIN_MS > Date.now())
      return { account: latest, token: session.access_token, expiresAt: session.access_expires_at };
    const provider = await providerMetadata(latest.issuer, options.signal, timeoutMs(options));
    const rotated = await refresh(provider, session.refresh_token, options.signal, timeoutMs(options));
    output.protect(rotated.accessToken);
    output.protect(rotated.refreshToken);
    const next: Account = { ...latest, credentialId: randomUUID(), expiresAt: new Date(Date.now() + REFRESH_LIFETIME_MS).toISOString() };
    await vault.save(accountTarget(next), encodeSession(rotated));
    try {
      await writeMetadata(path, next, before);
    } catch (error) {
      await vault.remove(accountTarget(next)).catch(() => {});
      throw error;
    }
    await vault.remove(accountTarget(latest)).catch(() => {});
    return { account: next, token: rotated.accessToken, expiresAt: rotated.expiresAt };
  });
}

/**
 * Reads the saved login and its session. A concurrent renewal can replace the
 * OS-store slot between reading the metadata and the slot, so a failed read is
 * retried while the metadata keeps pointing to a newer slot.
 */
async function loadSession(options: AccountOptions, vault: CredentialVault, output: Output) {
  for (let attempt = 1; ; attempt++) {
    const account = await loadAccount(options);
    try {
      return { account, session: await readSession(vault, account, output) };
    } catch (error) {
      const latest = await readOptional(await accountPath(options));
      if (attempt >= 3 || !latest || parseAccount(latest).credentialId === account.credentialId) throw error;
    }
  }
}

export async function management(options: AccountOptions, output: Output, vault = accountVault()) {
  const requestTimeoutMs = timeoutMs(options);
  const loaded = await loadSession(options, vault, output);
  let account = loaded.account;
  const saved = loaded.session;
  let token = saved.access_token;
  let expiresAt = saved.access_expires_at;
  // An expired token counts as rejected, so a newer one saved by another process is reused.
  const current = async (rejected?: string) => {
    if (rejected === undefined && expiresAt - EXPIRY_MARGIN_MS > Date.now()) return token;
    ({ account, token, expiresAt } = await renew(options, output, vault, account, rejected ?? token));
    return token;
  };
  const api = {
    get account() {
      return account;
    },
    accessToken: () => current(),
    request: async (path: string, method = 'GET', body?: object, org?: string) => {
      const used = await current();
      try {
        return await accountRequest(account, used, path, method, body, org, options.signal, requestTimeoutMs);
      } catch (error) {
        // A rejected token never reached the route handler, so a retry is safe.
        if (!(error instanceof ManagementError && error.status === 401)) throw error;
        const renewed = await current(used);
        return accountRequest(account, renewed, path, method, body, org, options.signal, requestTimeoutMs);
      }
    },
    /**
     * Issues one project key through a separate OAuth approval bound to the exact
     * project, then discards the setup token. onConnection runs before approval so
     * the caller can record recovery identity; an uncertain earlier attempt is
     * passed as recoveryId instead of being replaced silently.
     */
    issueKey: async (request: { projectId: string; recoveryId?: string; onConnection: (connectionId: string) => Promise<void> }) => {
      const provider = await discover(account.apiUrl, options.signal, requestTimeoutMs);
      const created = await accountRequest(
        account,
        '',
        'project-connections',
        'POST',
        { client_id: CLI_CLIENT_ID, project_id: request.projectId, ...(request.recoveryId ? { recovery_id: request.recoveryId } : {}) },
        undefined,
        options.signal,
        requestTimeoutMs,
      );
      const connectionId = created.connection_id;
      if (typeof connectionId !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(connectionId))
        throw new InputError('Invalid project connection response. Check client/server versions. No key was requested.');
      await request.onConnection(connectionId);
      const cancellation = new AbortController();
      const cancel = () => cancellation.abort();
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      try {
        const setup = await authorize(
          provider,
          { scope: CONNECTION_SCOPE, connectionId, refresh: false, browser: options.browser !== false },
          output,
          options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal,
          requestTimeoutMs,
        );
        output.protect(setup.accessToken);
        try {
          if (!setup.scope.includes('connection:issue'))
            throw new InputError('Key issuance was not approved for this project. No key was created.', '');
          // The issuance claim takes an empty body; the server rejects any request fields.
          return await accountRequest(account, setup.accessToken, `project-connections/${connectionId}/key`, 'POST', undefined, undefined, options.signal, requestTimeoutMs);
        } finally {
          // The setup token has no further use; the project key is independent of it.
          await revoke(provider, setup.accessToken, 'access_token', undefined, requestTimeoutMs);
        }
      } finally {
        process.removeListener('SIGINT', cancel);
        process.removeListener('SIGTERM', cancel);
      }
    },
  };
  return api;
}

export async function login(options: AccountOptions, output: Output, vault = accountVault()) {
  const requestTimeoutMs = timeoutMs(options);
  return withManagementLock(options, async () => {
    const path = await accountPath(options),
      before = await readOptional(path);
    let previousOrigin: string | undefined;
    if (before) {
      try {
        previousOrigin = legacy(before)?.apiUrl ?? parseAccount(before).apiUrl;
      } catch {
        /* Explicit login can replace malformed non-secret metadata. */
      }
    }
    const apiUrl = endpoint(options.apiUrl ?? previousOrigin ?? 'https://api.lambdadb.ai');
    const store = await vault.select(options.credentialStore ?? 'auto');
    output.diagnostic(
      options.guided ? `Account login: ${store}, renewed while in use.` : `Account session: ${store}; non-secret metadata: ${path}. Login renews while in use and ends after seven idle days. Project credentials are separate.`,
    );
    if (store === 'keyutils')
      output.diagnostic(
        'Kernel credentials can expire or disappear after reboot. Run login again explicitly if unavailable.',
      );
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    const signal = options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal;
    try {
      const provider = await discover(apiUrl, signal, requestTimeoutMs);
      const granted = await authorize(provider, { scope: ACCOUNT_SCOPE, refresh: true, browser: options.browser !== false }, output, signal, requestTimeoutMs);
      output.protect(granted.accessToken);
      output.protect(granted.refreshToken);
      const discard = () => revoke(provider, granted.refreshToken!, 'refresh_token', undefined, requestTimeoutMs);
      let account: Account;
      try {
        if (!granted.scope.includes('account:manage')) throw new InputError('Account access was not granted. Nothing was saved.', '');
        const me = await accountRequest(provider, granted.accessToken, 'members/me', 'GET', undefined, undefined, signal, requestTimeoutMs);
        if (typeof me.id !== 'string' || !/^[0-9a-f-]{36}$/.test(me.id) || typeof me.email !== 'string')
          throw new InputError('Invalid member response. Check client/server versions.');
        account = {
          apiUrl,
          consoleUrl: provider.consoleUrl,
          issuer: provider.issuer,
          memberId: me.id,
          email: me.email,
          expiresAt: new Date(Date.now() + REFRESH_LIFETIME_MS).toISOString(),
          credentialStore: store,
          credentialId: randomUUID(),
        };
        await vault.save(accountTarget(account), encodeSession(granted));
      } catch (error) {
        if (!(await discard())) output.diagnostic('The new login could not be revoked remotely; it expires after seven idle days.');
        throw error;
      }
      try {
        await writeMetadata(path, account, before);
      } catch (error) {
        if (!(await discard())) output.diagnostic('The new login could not be revoked remotely; it expires after seven idle days.');
        await vault.remove(accountTarget(account)).catch(() => {});
        throw error;
      }
      if (before) await retire(before, vault, output, requestTimeoutMs);
      return account;
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
  });
}

/** Retires a replaced login after the new one is durable; project keys are unaffected. */
async function retire(before: string, vault: CredentialVault, output: Output, requestTimeoutMs: number) {
  const old = legacy(before);
  if (old) {
    await vault.remove(accountTarget(old)).catch(() => {});
    output.diagnostic('The previous non-OAuth CLI login was removed locally; its server session expires within seven days.');
    return;
  }
  try {
    const previous = parseAccount(before);
    const session = await readSession(vault, previous, output);
    const revoked = await revoke(await providerMetadata(previous.issuer, undefined, requestTimeoutMs), session.refresh_token, 'refresh_token', undefined, requestTimeoutMs);
    await vault.remove(accountTarget(previous));
    if (!revoked) throw new Error();
  } catch {
    output.diagnostic('Previous login cleanup could not be confirmed. It ends after seven idle days; project keys are unaffected.');
  }
}

/** Revokes this login's grant and removes it locally; reports whether revocation was confirmed. */
export async function logout(options: AccountOptions, output: Output, vault = accountVault()): Promise<{ remoteRevoked: boolean } | undefined> {
  const requestTimeoutMs = timeoutMs(options);
  return withManagementLock(options, async () => {
    const path = await accountPath(options),
      before = await readOptional(path);
    if (!before) return undefined;
    const old = legacy(before);
    if (old) {
      if (options.apiUrl && endpoint(options.apiUrl) !== old.apiUrl) throw new InputError('The account belongs to another API origin.');
      await vault.remove(accountTarget(old));
    } else {
      // Expired logins may still be removed locally, without opening a browser.
      const account = parseAccount(before);
      if (options.apiUrl && endpoint(options.apiUrl) !== account.apiUrl)
        throw new InputError('The account belongs to another API origin.');
      const session = await readSession(vault, account, output);
      // Local removal proceeds even when the provider cannot confirm revocation.
      const revoked = await providerMetadata(account.issuer, options.signal, requestTimeoutMs)
        .then((provider) => revoke(provider, session.refresh_token, 'refresh_token', options.signal, requestTimeoutMs))
        .catch(() => false);
      await vault.remove(accountTarget(account));
      if ((await readOptional(path)) !== before)
        throw new InputError('Account metadata changed. Review it before removing it.');
      await rm(await fileIdentity(path));
      return { remoteRevoked: revoked };
    }
    if ((await readOptional(path)) !== before)
      throw new InputError('Account metadata changed. Review it before removing it.');
    await rm(await fileIdentity(path));
    return { remoteRevoked: false };
  });
}
