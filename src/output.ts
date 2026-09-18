import type { SafeError } from './errors.js';

export type Envelope = {
  schemaVersion: 1; command: string; ok: boolean;
  target?: Record<string, unknown>; data?: unknown; error?: SafeError;
};

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
    // Redact strings and keys before serialization so arbitrary secret characters cannot break JSON.
    const sanitize = (value: unknown): unknown => {
      if (typeof value === 'string') return this.redact(value);
      if (Array.isArray(value)) return value.map(sanitize);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.redact(key), sanitize(item)]));
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
