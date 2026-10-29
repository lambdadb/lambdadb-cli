import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { configPath, endpoint, fileIdentity, timeoutMs, type Options } from './config.js';
import { CredentialVault, credentialReference, type CredentialReference } from './credentials.js';
import { cli } from './command.js';
import { authorizeAccount } from './device-auth.js';
import { InputError, ManagementError } from './errors.js';
import type { Output } from './output.js';

export type AccountOptions = Options & { apiUrl?: string; browser?: boolean; signal?: AbortSignal; guided?: boolean };
export type Account = CredentialReference & {
  apiUrl: string;
  consoleUrl: string;
  memberId: string;
  email: string;
  expiresAt: string;
};
export const accountVault = () => new CredentialVault(undefined, process.platform, 'account');
export const accountPath = async (options: Options) =>
  `${await fileIdentity(configPath(options))}.account.json`;
export const accountTarget = (a: Account) => ({ ...a, endpoint: a.apiUrl, project: 'account' });

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
function parseAccount(text: string): Account {
  let a: Account;
  try {
    a = JSON.parse(text);
    credentialReference(a.credentialStore, a.credentialId);
    if (
      Object.keys(a).some(
        (k) =>
          ![
            'apiUrl',
            'consoleUrl',
            'memberId',
            'email',
            'expiresAt',
            'credentialStore',
            'credentialId',
          ].includes(k),
      ) ||
      typeof a.memberId !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(a.memberId) ||
      typeof a.email !== 'string' ||
      typeof a.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(a.expiresAt))
    )
      throw new Error();
    if (endpoint(a.apiUrl) !== a.apiUrl || endpoint(a.consoleUrl) !== a.consoleUrl) throw new Error();
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

export async function accountRequest(
  account: Account,
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
  // CLI-authored request name for diagnostics; never includes query values.
  const request = `${method} ${path.split('?')[0]}`;
  try {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]) : AbortSignal.timeout(requestTimeoutMs);
    response = await fetch(`${account.apiUrl}/auth/cli/${path}`, {
      method,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
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
    // A rejection remains definite without a JSON body. A connect conflict may
    // represent an already claimed issuance, whose result cannot be recovered.
    const status = response?.status;
    if (status !== undefined && status >= 400 && status < 500 && status !== 408 &&
      !(path === 'connect' && status === 409)) {
      throw new ManagementError('management_request_failed', status, { request });
    }
    throw new ManagementError(
      method === 'GET' ? 'management_unavailable' : 'write_outcome_unknown',
      status,
      { request },
    );
  }
  if (!response.ok) {
    const known = [
      'login_required',
      'access_denied',
      'project_limit_reached',
      'issuance_unconfirmed',
      'project_not_ready_or_forbidden',
      'project_request_rejected',
    ];
    const code =
      method !== 'GET' && (response.status >= 500 || response.status === 408) && value.error !== 'issuance_unconfirmed'
        ? 'write_outcome_unknown'
        : typeof value.error === 'string' && known.includes(value.error)
          ? value.error
          : 'management_request_failed';
    // Only a small allowlist of non-secret fields may reach diagnostics.
    const details: Record<string, unknown> = { request };
    if (typeof value.invitation_id === 'string' && /^[0-9a-f-]{36}$/.test(value.invitation_id)) {
      details.invitation_id = value.invitation_id;
      details.invitation_url = `${account.consoleUrl}/invites/${value.invitation_id}`;
    }
    if (code === 'project_limit_reached')
      details.organization = parseOrganization(value.organization, account);
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
export function parseOrganization(value: unknown, a: Account): Organization {
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
export async function management(options: AccountOptions, output: Output) {
  const requestTimeoutMs = timeoutMs(options);
  const account = await loadAccount(options);
  let token: string;
  try {
    token = await accountVault().read(accountTarget(account));
  } catch {
    throw new InputError(
      'Cannot read the CLI account session. Unlock the recorded OS store or run login explicitly. No account credential is forwarded to MCP.',
    );
  }
  output.protect(token);
  return {
    account,
    request: (path: string, method = 'GET', body?: object, org?: string) =>
      accountRequest(account, token, path, method, body, org, options.signal, requestTimeoutMs),
  };
}
export async function login(options: AccountOptions, output: Output, vault = accountVault()) {
  const requestTimeoutMs = timeoutMs(options);
  return withManagementLock(options, async () => {
    const path = await accountPath(options),
      before = await readOptional(path);
    let previousOrigin: string | undefined;
    if (before) {
      try {
        previousOrigin = parseAccount(before).apiUrl;
      } catch {
        /* Explicit login can replace malformed non-secret metadata. */
      }
    }
    const apiUrl = endpoint(options.apiUrl ?? previousOrigin ?? 'https://api.lambdadb.ai');
    const store = await vault.select(options.credentialStore ?? 'auto');
    output.diagnostic(
      options.guided ? `Account login: ${store}, expires within seven days.` : `Account session: ${store}; non-secret metadata: ${path}. Login lasts up to seven days. Project credentials are separate.`,
    );
    if (store === 'keyutils')
      output.diagnostic(
        'Kernel credentials can expire or disappear after reboot. Run login again explicitly if unavailable.',
      );
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      const granted = await authorizeAccount(
        apiUrl,
        options.browser !== false,
        output,
        options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal,
        requestTimeoutMs,
      );
      const account: Account = {
        apiUrl,
        consoleUrl: granted.consoleUrl,
        memberId: granted.memberId,
        email: granted.email,
        expiresAt: granted.expiresAt,
        credentialStore: store,
        credentialId: randomUUID(),
      };
      try {
        await vault.save(accountTarget(account), granted.token);
        await writeMetadata(path, account, before);
      } catch (error) {
        await accountRequest(account, granted.token, 'logout', 'POST', {}, undefined, options.signal, requestTimeoutMs).catch(() =>
          output.diagnostic('Server-session cleanup could not be confirmed; it expires within seven days.'),
        );
        await vault.remove(accountTarget(account)).catch(() => {});
        throw error;
      }
      if (before) {
        // Retire only a parseable previous account slot after the replacement is durable.
        try {
          const old = parseAccount(before);
          const token = await vault.read(accountTarget(old));
          output.protect(token);
          await revokeAccount(old, token, options);
          await vault.remove(accountTarget(old));
        } catch {
          output.diagnostic(
            'Previous login cleanup could not be confirmed. It expires within seven days; project keys are unaffected.',
          );
        }
      }
      return account;
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
  });
}
export async function logout(options: AccountOptions, output: Output, vault = accountVault()) {
  timeoutMs(options);
  return withManagementLock(options, async () => {
    const path = await accountPath(options),
      before = await readOptional(path);
    if (!before) return;
    // Expired sessions may still be removed locally, without opening a browser.
    const account = parseAccount(before);
    if (options.apiUrl && endpoint(options.apiUrl) !== account.apiUrl)
      throw new InputError('The account belongs to another API origin.');
    const token = await vault.read(accountTarget(account));
    output.protect(token);
    await revokeAccount(account, token, options);
    await vault.remove(accountTarget(account));
    if ((await readOptional(path)) !== before)
      throw new InputError('Account metadata changed. Review it before removing it.');
    await rm(await fileIdentity(path));
  });
}

async function revokeAccount(account: Account, token: string, options: AccountOptions): Promise<void> {
  try {
    await accountRequest(account, token, 'logout', 'POST', {}, undefined, options.signal, timeoutMs(options));
  } catch (error) {
    // An expired or already revoked session is safe to remove locally.
    if (!(error instanceof ManagementError && error.status === 401)) throw error;
  }
}
