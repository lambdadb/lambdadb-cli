import type { ClientRequestOptions, CollectionDocs } from '@functional-systems/lambdadb';
import { definitelyRejected, describeError, InputError, type SafeError } from './errors.js';
import type { DocumentRow } from './input.js';

export type Batch = { rows: DocumentRow[]; bytes: number };
export type BatchResult = {
  batch: number; firstLine: number; lastLine: number; documents: number;
  state: 'accepted' | 'failed' | 'unknown'; error?: SafeError;
};
export type ImportResult = {
  state: 'accepted' | 'failed' | 'partial' | 'unknown';
  total: number; accepted: number; failed: number; unknown: number; notAttempted: number;
  searchable: 'not_verified'; batches: BatchResult[];
};

export function planBatches(rows: DocumentRow[], branch: string, batchSize: number, maxBytes: number, bulk: boolean): Batch[] {
  const overhead = Buffer.byteLength(JSON.stringify(bulk ? { docs: [] } : { docs: [], branch }));
  const batches: Batch[] = [];
  let current: Batch = { rows: [], bytes: overhead };
  for (const row of rows) {
    if (overhead + row.bytes > maxBytes) throw new InputError(`JSONL line ${row.line} exceeds the batch byte limit. Increase the limit within the mode's supported range.`);
    if (current.rows.length && (current.rows.length >= batchSize || current.bytes + 1 + row.bytes > maxBytes)) {
      batches.push(current);
      current = { rows: [], bytes: overhead };
    }
    current.bytes += row.bytes + (current.rows.length ? 1 : 0);
    current.rows.push(row);
  }
  if (current.rows.length) batches.push(current);
  return batches;
}

// Domain workflow: no terminal I/O. Stop on the first failure, preserving acknowledged progress.
export async function importDocuments(
  docs: Pick<CollectionDocs, 'upsert' | 'bulkUpsertDocs'>,
  batches: Batch[], branch: string, bulk: boolean, options: ClientRequestOptions,
  progress: (batch: BatchResult) => void = () => {},
): Promise<ImportResult> {
  const total = batches.reduce((sum, b) => sum + b.rows.length, 0);
  const result: ImportResult = {
    state: 'accepted', total, accepted: 0, failed: 0, unknown: 0, notAttempted: total,
    searchable: 'not_verified', batches: [],
  };
  for (const [index, batch] of batches.entries()) {
    if (options.signal?.aborted) {
      result.state = result.accepted > 0 ? 'partial' : 'failed';
      break;
    }
    const item: BatchResult = {
      batch: index + 1, firstLine: batch.rows[0]!.line, lastLine: batch.rows.at(-1)!.line,
      documents: batch.rows.length, state: 'accepted',
    };
    try {
      const body = { docs: batch.rows.map(row => row.doc), branch };
      // Mutations are never automatically retried: no public idempotency/receipt contract.
      const requestOptions: ClientRequestOptions = { ...options, retries: { strategy: 'none' } };
      if (bulk) await docs.bulkUpsertDocs(body, requestOptions);
      else await docs.upsert(body, requestOptions);
    } catch (error) {
      item.state = definitelyRejected(error) ? 'failed' : 'unknown';
      item.error = describeError(error);
    }
    result[item.state] += item.documents;
    result.notAttempted -= item.documents;
    result.batches.push(item);
    progress(item);
    if (item.state !== 'accepted') {
      result.state = item.state === 'unknown' ? 'unknown' : result.accepted > 0 ? 'partial' : 'failed';
      break;
    }
  }
  return result;
}
