import { styleText } from 'node:util';
import type { SafeError } from './errors.js';

// Server-provided values can contain terminal control characters.
// eslint-disable-next-line no-control-regex
export const plain = (value: unknown) => String(value).replace(/[\x00-\x1f\x7f]/g, ' ');

// East Asian wide and fullwidth characters take two terminal columns.
const wide = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;
const columns = (value: string) => [...value].reduce((width, char) => width + (wide.test(char) ? 2 : 1), 0);

const storeNames: Record<string, string> = {
  keychain: 'macOS Keychain',
  windows: 'Windows Credential Manager',
  'secret-service': 'Secret Service',
  keyutils: 'kernel keyring',
};
export const storeName = (store: string) => storeNames[store] ?? plain(store);

/** Left-aligned columns with a dim header row, indented like the init summary. */
export function table(headers: string[], rows: unknown[][]): string {
  const cells = rows.map(row => row.map(plain));
  const widths = headers.map((header, i) => Math.max(header.length, ...cells.map(row => columns(row[i]!))));
  const line = (row: string[]) => `  ${row.map((cell, i) => i === row.length - 1 ? cell : cell + ' '.repeat(widths[i]! - columns(cell))).join('  ')}`.trimEnd();
  return [styleText('dim', line(headers)), ...cells.map(line)].join('\n');
}

/** A titled list with an empty state and an optional next step. */
export function listing(title: string, headers: string[], rows: unknown[][], empty: string, next?: string): string {
  return [
    rows.length ? `${title} (${rows.length})` : empty,
    ...(rows.length ? ['', table(headers, rows)] : []),
    ...(next ? ['', `Next: ${next}`] : []),
  ].join('\n');
}

/** The failure as a person at a terminal reads it: the cause, then the next step on its own line. */
export function failure(error: Pick<SafeError, 'message' | 'hint'>, headline?: string, target?: string): string {
  const dim = (line: string) => styleText('dim', line, { stream: process.stderr });
  const [first = '', ...rest] = (headline ?? error.message).split('\n');
  const detail = [...rest.map(line => `  ${line}`), ...[headline ? error.message : '', error.hint, target].filter(Boolean).flatMap(text => text!.split('\n')).map(line => dim(`  ${line}`))];
  return [`${styleText('red', '✖', { stream: process.stderr })} ${first}`, ...detail].join('\n');
}

/** The selected target as one line, so recovery hints that refer to it stay actionable. */
export function targetSummary(target: Record<string, unknown> | undefined): string | undefined {
  const entries = Object.entries(target ?? {}).filter(([, value]) => value !== undefined);
  if (!entries.length) return undefined;
  const value = (v: unknown) => v && typeof v === 'object' && 'kind' in v && 'name' in v ? `${(v as { kind: string }).kind}:${(v as { name: string }).name}` : String(v);
  return `Target: ${entries.map(([key, v]) => `${key} ${value(v)}`).join(', ')}`;
}
