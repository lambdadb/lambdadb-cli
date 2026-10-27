import { createHash, randomUUID } from 'node:crypto';
import { InputError } from './errors.js';

export const credentialStores = ['keychain', 'windows', 'secret-service', 'keyutils'] as const;
export type CredentialStore = (typeof credentialStores)[number];
export type CredentialReference = { credentialStore: CredentialStore; credentialId: string };
export type CredentialTarget = { endpoint: string; project: string } & CredentialReference;
type Entry = {
  setSecret(value: Uint8Array, signal?: AbortSignal): Promise<void>;
  getSecret(signal?: AbortSignal): Promise<number[] | null>;
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
};
export type EntryFactory = (service: string, id: string, store: CredentialStore) => Promise<Entry>;
const nativeEntry: EntryFactory = async (service, id, store) => {
  const { AsyncEntry } = await import('@napi-rs/keyring');
  return new AsyncEntry(
    service,
    id,
    store === 'secret-service' || store === 'keyutils' ? { linux: { store } } : undefined,
  );
};

export function credentialReference(store: unknown, id: unknown): CredentialReference {
  if (
    !credentialStores.includes(store as CredentialStore) ||
    typeof id !== 'string' ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)
  ) {
    throw new InputError(
      'Credential reference must contain a supported store and UUID. Never put a key value in configuration.',
    );
  }
  return { credentialStore: store as CredentialStore, credentialId: id };
}

function supported(store: CredentialStore, platform: NodeJS.Platform): boolean {
  return platform === 'darwin'
    ? store === 'keychain'
    : platform === 'win32'
      ? store === 'windows'
      : platform === 'linux' && ['secret-service', 'keyutils'].includes(store);
}

export class CredentialVault {
  constructor(
    private factory: EntryFactory = nativeEntry,
    private platform: NodeJS.Platform = process.platform,
    private purpose: 'project' | 'account' = 'project',
  ) {}
  private async entry(target: CredentialTarget): Promise<Entry> {
    credentialReference(target.credentialStore, target.credentialId);
    if (!supported(target.credentialStore, this.platform))
      throw new InputError(
        'This credential reference belongs to a different OS. Use environment-variable setup or connect on this OS.',
      );
    const identity = createHash('sha256')
      .update(JSON.stringify([target.endpoint, target.project]))
      .digest('hex');
    return this.factory(
      `${this.purpose === 'account' ? 'ai.lambdadb.cli.account.v1' : 'ai.lambdadb.cli.v1'}:${identity}`,
      target.credentialId,
      target.credentialStore,
    );
  }
  async read(target: CredentialTarget): Promise<string> {
    try {
      const value = await (await this.entry(target)).getSecret(AbortSignal.timeout(15_000));
      if (value === null) throw new Error();
      const secret = Buffer.from(value).toString('utf8');
      if (!secret.trim() || /[\r\n]/.test(secret)) throw new Error();
      return secret;
    } catch {
      throw new InputError(
        `Cannot read the saved ${target.credentialStore} credential. Unlock the store or restore the same OS user session. Kernel keys can expire or disappear after reboot. No new key was issued. Reconnect explicitly with init and select another project, or use --api-key-env NAME. Review existing CLI keys in Console before reconnecting.`,
      );
    }
  }
  async save(target: CredentialTarget, key: string): Promise<void> {
    if (!key.trim() || /[\r\n]/.test(key) || (this.platform === 'win32' && Buffer.byteLength(key) > 2560))
      throw new InputError('The project key is invalid or exceeds the OS credential-store size limit.');
    let entry: Entry | undefined;
    let owned = false;
    try {
      entry = await this.entry(target);
      // Every new connection uses a fresh slot. Never overwrite an existing key.
      if ((await entry.getSecret(AbortSignal.timeout(15_000))) !== null) throw new Error();
      owned = true;
      await entry.setSecret(Buffer.from(key), AbortSignal.timeout(15_000));
      const saved = await entry.getSecret(AbortSignal.timeout(15_000));
      if (saved === null || !Buffer.from(saved).equals(Buffer.from(key))) throw new Error();
    } catch {
      if (owned && entry) await entry.deleteCredential(AbortSignal.timeout(15_000)).catch(() => {});
      throw new InputError(
        'Cannot verify OS credential storage. No plaintext fallback was used. Check the store, review the named CLI key in Console, and retry explicitly.',
      );
    }
  }
  async remove(target: CredentialTarget): Promise<void> {
    try {
      await (await this.entry(target)).deleteCredential(AbortSignal.timeout(15_000));
    } catch {
      throw new InputError(
        'Could not remove the local credential. Unlock the OS store and retry. Local deletion never revokes the server key.',
      );
    }
  }
  async select(requested = 'auto'): Promise<CredentialStore> {
    const choices: CredentialStore[] =
      requested === 'auto'
        ? this.platform === 'darwin'
          ? ['keychain']
          : this.platform === 'win32'
            ? ['windows']
            : this.platform === 'linux'
              ? ['secret-service', 'keyutils']
              : []
        : credentialStores.filter((store) => store === requested);
    for (const store of choices) {
      if (!supported(store, this.platform)) continue;
      const probe = {
        endpoint: 'https://credential-probe.invalid',
        project: 'probe',
        credentialStore: store,
        credentialId: randomUUID(),
      };
      try {
        await this.save(probe, randomUUID());
        await this.remove(probe);
        return store;
      } catch {
        /* Only a new connection may try another backend. */
      }
    }
    throw new InputError(
      'No usable OS credential store. On Linux, unlock Secret Service or enable kernel keyutils. Otherwise obtain a key in Console and use init --api-key-env NAME with the key exported securely. No key was requested.',
    );
  }
}
