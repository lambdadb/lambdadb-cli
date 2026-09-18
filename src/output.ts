import type { SafeError } from './errors.js';

export type Envelope = {
  schemaVersion: 1; command: string; ok: boolean;
  target?: Record<string, unknown>; data?: unknown; error?: SafeError;
};

// These values are CLI protocol tokens, never arbitrary API or document data.
const protocolValues = new Set([
  'command', 'error.code', 'target.ref.kind',
  'data.state', 'data.searchable', 'data.batches.*.state', 'data.batches.*.error.code',
  'data.checks.*.name', 'data.checks.*.status',
]);
// These document/metadata maps carry user-defined field names in MVP responses.
const freeFormMaps = new Set(['doc', 'indexConfigs', 'tags']);

export class Output {
  json = false;
  private secrets = new Set<string>();

  protect(secret: string | undefined) { if (secret) this.secrets.add(secret); }

  private redact(text: string): string {
    for (const secret of this.secrets) text = text.split(secret).join('[REDACTED]');
    return text;
  }

  diagnostic(message: string) {
    // eslint-disable-next-line no-control-regex -- Strip terminal control bytes from diagnostics.
    process.stderr.write(`${this.redact(message).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')}\n`);
  }

  emit(envelope: Envelope, summary: string) {
    // Preserve the protocol while redacting variable values and arbitrary map keys.
    // Normalize dates first, and redact before serialization to preserve valid JSON.
    const sanitize = (value: unknown, path = '', freeForm = false): unknown => {
      if (typeof value === 'string') return !freeForm && protocolValues.has(path) ? value : this.redact(value);
      if (Array.isArray(value)) return value.map(item => sanitize(item, `${path}.*`, freeForm));
      if (value && typeof value === 'object') {
        const entries = Object.entries(value).map(([key, item]) => ({ key, item, name: freeForm ? this.redact(key) : key }));
        // Reserve every base name, including unchanged keys that appear later.
        // Only renamed keys receive suffixes; unrelated field names stay intact.
        const reserved = new Set(entries.map(entry => entry.name));
        const used = new Set(entries.filter(entry => entry.key === entry.name).map(entry => entry.name));
        const suffixes = new Map<string, number>();
        return Object.fromEntries(entries.map(({ key, item, name }) => {
          let unique = name;
          if (key !== name && used.has(unique)) {
            let suffix = suffixes.get(name) ?? 1;
            do { unique = `${name}#${suffix++}`; } while (reserved.has(unique) || used.has(unique));
            suffixes.set(name, suffix);
          }
          used.add(unique);
          return [unique, sanitize(item, path ? `${path}.${key}` : key, freeForm || freeFormMaps.has(key))];
        }));
      }
      return value;
    };
    const serialized = JSON.stringify(sanitize(JSON.parse(JSON.stringify(envelope))), null, this.json ? undefined : 2);
    if (this.json) process.stdout.write(`${serialized}\n`);
    else {
      const safe = JSON.parse(serialized) as Envelope;
      process.stdout.write(`${this.redact(summary)}\n`);
      if (safe.target) process.stdout.write(`${JSON.stringify(safe.target)}\n`);
      if (safe.data !== undefined) process.stdout.write(`${JSON.stringify(safe.data, null, 2)}\n`);
    }
    if (envelope.error) this.diagnostic(`${envelope.error.message} ${envelope.error.hint}`);
  }
}
