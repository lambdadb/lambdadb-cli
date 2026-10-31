import { open } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import type { AliasTarget, BranchSource, CreateCollectionInput, QueryCollectionInput, ReadRef, RefSource, UpdateCollectionInput } from '@functional-systems/lambdadb';
import { createCollectionRequestToJSON, queryCollectionRequestBodyToJSON, updateCollectionRequestBodyToJSON } from '@functional-systems/lambdadb/models/operations';
import { InputError } from './errors.js';
import { name } from './config.js';

export const MAX_INPUT_BYTES = 64 * 1024 * 1024;
export const MAX_INPUT_DOCUMENTS = 100_000;

export async function readText(path: string, limit = MAX_INPUT_BYTES): Promise<string> {
  let file;
  try { file = await open(path, 'r'); }
  catch { throw new InputError('Cannot open input file.'); }
  try {
    if (!(await file.stat()).isFile()) throw new InputError('Input must be a regular file.');
    // Read one immutable in-memory input snapshot; never submit a partially validated file.
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > limit) throw new InputError(`Input exceeds the ${limit}-byte local limit. Split the file first.`);
      chunks.push(chunk as Buffer);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError('Cannot read input as UTF-8.');
  } finally { await file.close(); }
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}

export async function readJson(path: string): Promise<Record<string, unknown>> {
  const text = await readText(path, 4 * 1024 * 1024);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new InputError('Input file contains invalid JSON.'); }
  return object(value, 'Input');
}

export function parseRef(value: string): ReadRef {
  const [kind, refName, extra] = value.split(':');
  if (!['branch', 'tag', 'alias'].includes(kind ?? '') || extra !== undefined) {
    throw new InputError('Ref must be branch:NAME, tag:NAME or alias:NAME.');
  }
  return { kind: kind as ReadRef['kind'], name: name(refName, 'Ref name') };
}

// Unix epoch milliseconds or an ISO 8601 time, forwarded as the API's millisecond cutoff.
// Date.parse normalizes impossible calendar values (February 30 becomes March 2) and
// accepts loose formats, so the ISO form is matched and its fields are checked instead.
const isoTime = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](?:0\d|1[0-4]):[0-5]\d))?$/;
export function parseAsOf(value: string): number {
  const invalid = new InputError('--as-of must be Unix epoch milliseconds or an ISO 8601 time.');
  if (/^\d+$/.test(value)) {
    const milliseconds = Number(value);
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) throw invalid;
    return milliseconds;
  }
  const match = isoTime.exec(value);
  if (!match) throw invalid;
  const [year, month, day, hour = '0', minute = '0', second = '0', fraction = '0', zone = 'Z'] = match.slice(1);
  const fields: [number, number, number, number, number, number, number] = [Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, '0'))];
  const local = new Date(Date.UTC(...fields));
  const roundTrip = [local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds()];
  if (roundTrip.some((field, index) => field !== fields[index])) throw invalid;
  // The pattern bounds the offset to ±14:59 with two-digit minutes below 60.
  const offsetMinutes = zone === 'Z' ? 0 : (zone.startsWith('-') ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  const milliseconds = local.getTime() - offsetMinutes * 60_000;
  if (milliseconds <= 0) throw invalid;
  return milliseconds;
}

// A branch creation copies another branch; a tag pins a branch or a tag. Aliases are never sources.
export function parseSource(value: string | undefined, asOf: string | undefined, allowTag: false): BranchSource | undefined;
export function parseSource(value: string | undefined, asOf: string | undefined, allowTag: true): RefSource | undefined;
export function parseSource(value: string | undefined, asOf: string | undefined, allowTag: boolean): RefSource | undefined {
  const accepted = allowTag ? 'branch:NAME or tag:NAME; aliases cannot be tag sources' : 'branch:NAME; tags and aliases cannot be branch sources';
  const ref = value === undefined ? undefined : parseRef(value);
  if (ref && (ref.kind === 'alias' || (ref.kind === 'tag' && !allowTag))) throw new InputError(`Source must be ${accepted}.`);
  if (asOf === undefined) return ref as RefSource | undefined;
  if (ref && ref.kind !== 'branch') throw new InputError('--as-of requires a branch source.');
  // Omitted source means main, so an as-of alone pins main's history.
  return { kind: 'branch', name: ref?.name ?? 'main', asOf: parseAsOf(asOf) } satisfies BranchSource;
}

export function parseTarget(value: string): AliasTarget {
  const ref = parseRef(value);
  if (ref.kind === 'alias') throw new InputError('Alias target must be branch:NAME or tag:NAME.');
  return ref;
}

export function queryInput(body: Record<string, unknown>, ref: ReadRef): QueryCollectionInput {
  if (body.ref !== undefined) {
    const supplied = object(body.ref, 'File ref');
    if (Object.keys(supplied).some(k => !['kind', 'name'].includes(k)) || supplied.kind !== ref.kind || supplied.name !== ref.name) {
      throw new InputError('File ref conflicts with --ref. Use the same explicit target in both.');
    }
  }
  const input: Record<string, unknown> = { ...body, ref };
  // Public API accepts null size, while the SDK only accepts undefined/number.
  if (input.size === null) delete input.size;
  // The SDK requires integer sizes and facets for zero; bound non-reranked queries here.
  if (typeof input.size === 'number' && (input.size < 0 || input.size > 1000)) {
    throw new InputError('Query size must be from 0 to 1000; zero requires facets.');
  }
  try { queryCollectionRequestBodyToJSON(input as QueryCollectionInput); }
  catch { throw new InputError('Invalid query request. Check fields, types and rerank settings; size:0 requires facets, rerank requires a scoring query without sort, and consistentRead:true requires a branch ref.'); }
  return input as QueryCollectionInput;
}

const invalidIndexConfig = 'Invalid index configuration. Provide a nonempty field-to-index map matching the SDK contract: vector dimensions 64–4096, similarity cosine or euclidean, and exactly one embedding sourceField or sources.';

export function createInput(collectionName: string, indexConfigs: Record<string, unknown>): CreateCollectionInput {
  const input = { collectionName, indexConfigs } as CreateCollectionInput;
  try { createCollectionRequestToJSON(input); }
  catch { throw new InputError(invalidIndexConfig); }
  return input;
}

export function updateInput(indexConfigs: Record<string, unknown>): UpdateCollectionInput {
  const input = { indexConfigs } as UpdateCollectionInput;
  try { updateCollectionRequestBodyToJSON(input); }
  catch { throw new InputError(invalidIndexConfig); }
  return input;
}

export type DocumentRow = { line: number; doc: Record<string, unknown>; bytes: number };

export async function readJsonl(path: string): Promise<DocumentRow[]> {
  const text = await readText(path);
  const rows: DocumentRow[] = [];
  // Do not allocate an array entry for every physical line (including blank ones).
  let offset = 0;
  let lineNumber = 0;
  while (offset < text.length) {
    const newline = text.indexOf('\n', offset);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(offset, end);
    offset = end + 1;
    lineNumber++;
    if (!line.trim()) continue;
    if (rows.length >= MAX_INPUT_DOCUMENTS) {
      throw new InputError(`JSONL exceeds the ${MAX_INPUT_DOCUMENTS}-document local limit at line ${lineNumber}. Split the file first.`);
    }
    let doc: Record<string, unknown>;
    try { doc = object(JSON.parse(line), 'Document'); }
    catch { throw new InputError(`JSONL line ${lineNumber} must be a JSON object.`); }
    if ('id' in doc && (typeof doc.id !== 'string' || doc.id.length === 0)) {
      throw new InputError(`JSONL line ${lineNumber} has an invalid id; use a nonempty string or omit it.`);
    }
    rows.push({ line: lineNumber, doc, bytes: Buffer.byteLength(JSON.stringify(doc)) });
  }
  if (rows.length === 0) throw new InputError('JSONL input contains no documents.');
  return rows;
}
