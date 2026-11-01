import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const cli = process.env.LAMBDADB_TEST_CLI ?? resolve('dist/cli.js');
const { isBundledSkill, isBundledReference, sha256 } = await import(pathToFileURL(join(dirname(cli), 'skill-history.js')).href);
const skillUrl = new URL('../skills/lambdadb/SKILL.md', import.meta.url);

test('the bundled skill is a single file whose hash is recorded for future upgrades', async () => {
  const skill = await readFile(skillUrl, 'utf8');
  assert.ok(isBundledSkill(skill), `Add ${sha256(skill)} (skills/lambdadb/SKILL.md) to src/skill-history.ts so init can upgrade this version later.`);
  await assert.rejects(readFile(new URL('../skills/lambdadb/references/usage.md', import.meta.url)), { code: 'ENOENT' });
  assert.match(skill, /^---\nname: lambdadb\ndescription: .{1,1024}\n---\n/);
  assert.ok(!/\s$/.test(skill.replace(/\n$/, '')), 'no trailing whitespace before the final newline');
});

test('every historical bundled version is recognized and user edits are not', async () => {
  const previous = await readFile(new URL('./fixtures/skill-0.1.7/SKILL.md', import.meta.url), 'utf8');
  const reference = await readFile(new URL('./fixtures/skill-0.1.7/references/usage.md', import.meta.url), 'utf8');
  const released = await readFile(new URL('./fixtures/skill-0.1.8/SKILL.md', import.meta.url), 'utf8');
  assert.ok(isBundledSkill(previous));
  assert.ok(isBundledReference(reference));
  assert.ok(isBundledSkill(released));
  assert.ok(!isBundledSkill(released + '\nUser note\n'));
  assert.ok(!isBundledSkill(previous + '\nUser note\n'));
  assert.ok(isBundledSkill('\uFEFF' + previous.replace(/\n/g, '\r\n')), 'BOM and CRLF are normalized');
  assert.ok(!isBundledReference(reference.replace('LambdaDB', 'My notes')));
  assert.ok(!isBundledSkill(''));
});

test('the skill routes query tasks to agent-readable docs pages and ships parseable request shapes', async () => {
  const skill = await readFile(skillUrl, 'utf8');
  const rows = skill.split('\n').filter(line => /^\| .* \| https:\/\/docs\.lambdadb\.ai\/\S+\.md \|$/.test(line));
  assert.ok(rows.length >= 10, `routing table rows: ${rows.length}`);
  for (const page of ['search-overview', 'query-string', 'boolean', 'vector', 'sparse-vector', 'hybrid', 'native-reranking', 'facets', 'limits']) {
    assert.ok(rows.some(row => row.includes(`/guides/search/${page}.md |`)), page);
  }
  assert.ok(rows.some(row => row.includes('/guides/collections/native-embeddings.md |')));
  for (const page of ['upsert-data', 'bulk-upsert-data', 'update-data', 'delete-data']) {
    assert.ok(rows.some(row => row.includes(`/guides/documents/${page}.md |`)), page);
  }
  assert.ok(rows.some(row => row.includes('/guides/data-versioning/branches-tags-aliases.md |')));
  assert.match(skill, /https:\/\/docs\.lambdadb\.ai\/llms\.txt/);
  const blocks = [...skill.matchAll(/```json\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]));
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].query.queryString, { query: 'serverless', defaultField: 'text' });
  assert.ok(Array.isArray(blocks[1].query.bool), 'bool is an array of clauses');
  assert.deepEqual(blocks[1].query.bool.map(clause => clause.occur), ['must', 'filter']);
  assert.ok(!/"term"|"match"|"must":\s*\[/.test(skill), 'no Elasticsearch-shaped examples');
});

test('the skill moves to a same-target MCP server only for a local credential-store failure', async () => {
  const skill = await readFile(skillUrl, 'utf8');
  const connection = skill.slice(skill.indexOf('## Choose and preserve the connection'), skill.indexOf('## Inspect before searching'));
  assert.match(connection, /`CREDENTIAL_STORE_ERROR`[^.]*before any server request/);
  assert.match(connection, /Compare the `target` endpoint and project[\s\S]*`--endpoint` and `--project`[\s\S]*continue through MCP when they match/);
  assert.match(connection, /Do not rerun `init` for this error/);
  assert.match(connection, /Do not switch transports to bypass a server `AUTH_ERROR` \(HTTP 401\/403\)/);
  const rows = skill.split('\n').filter(line => line.startsWith('| `CREDENTIAL_STORE_ERROR`') || line.startsWith('| HTTP 401/403'));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /no server request[\s\S]*match the envelope's `target`[\s\S]*Do not run `init`/);
  assert.match(rows[1], /do not switch identities or transports/);
});
