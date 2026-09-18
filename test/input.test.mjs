import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_INPUT_DOCUMENTS, readJsonl } from '../dist/input.js';

test('JSONL accepts the document-count boundary, excludes blank lines and preserves physical CRLF line numbers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lambdadb-input-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'input.jsonl');
  await writeFile(path, '\r\n' + '{}\r\n'.repeat(MAX_INPUT_DOCUMENTS - 1) + '\r\n{"id":"last"}');
  const rows = await readJsonl(path);
  assert.equal(rows.length, MAX_INPUT_DOCUMENTS);
  assert.equal(rows[0].line, 2);
  assert.equal(rows.at(-1).line, MAX_INPUT_DOCUMENTS + 2);
  assert.deepEqual(rows.at(-1).doc, { id: 'last' });
  await writeFile(path, '{}\n'.repeat(MAX_INPUT_DOCUMENTS) + '\n{}\n');
  await assert.rejects(readJsonl(path), /100000-document local limit at line 100002/);
});
