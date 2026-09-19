import { open } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import type { CreateCollectionInput, QueryCollectionInput, ReadRef } from '@functional-systems/lambdadb';
import { createCollectionRequestToJSON, queryCollectionRequestBodyToJSON } from '@functional-systems/lambdadb/models/operations';
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

export function queryInput(body: Record<string, unknown>, ref: ReadRef): QueryCollectionInput {
  if (body.ref !== undefined) {
    const supplied = object(body.ref, 'File ref');
    if (Object.keys(supplied).some(k => !['kind', 'name'].includes(k)) || supplied.kind !== ref.kind || supplied.name !== ref.name) {
      throw new InputError('File ref conflicts with --ref. Use the same explicit target in both.');
    }
  }
  const input: Record<string, unknown> = { ...body, ref };
  // Public API accepts null size, while SDK 0.5.1 only accepts undefined/number.
  if (input.size === null) delete input.size;
  if (input.size !== undefined && (!Number.isInteger(input.size) || Number(input.size) < 1 || Number(input.size) > 100)) {
    throw new InputError('Query size must be an integer from 1 to 100, null or omitted.');
  }
  try { queryCollectionRequestBodyToJSON(input as QueryCollectionInput); }
  catch { throw new InputError('Invalid query request. Check request fields and types; consistentRead:true requires a branch ref.'); }
  return input as QueryCollectionInput;
}

export function createInput(collectionName: string, indexConfigs: Record<string, unknown>): CreateCollectionInput {
  const input = { collectionName, indexConfigs } as CreateCollectionInput;
  try { createCollectionRequestToJSON(input); }
  catch { throw new InputError('Invalid index configuration. Provide a nonempty field-to-index map matching the SDK contract.'); }
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
