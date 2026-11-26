import { styleText } from 'node:util';
import { cli } from './command.js';
import { listing, plain, table } from './human.js';

type Row = Record<string, unknown>;
type Ref = { kind: string; name: string };

/** ISO time without milliseconds; values the server did not send stay blank. */
const time = (value: unknown) => {
  if (value === undefined || value === null || value === '') return '';
  const date = new Date(value as string | number);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace(/\.\d{3}Z$/, 'Z') : plain(value);
};
const date = (value: unknown) => time(value).slice(0, 10);
const count = (value: unknown) => typeof value === 'number' ? value.toLocaleString('en-US') : '';
const json = (value: unknown, indent = '') => JSON.stringify(value, null, 2).split('\n').map(line => indent + line).join('\n');
/** A shell word: quoted only when it contains characters a POSIX shell would interpret. */
export const shellArg = (value: string) => /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/** The data target in one readable line instead of a JSON object. */
export function formatTarget(target: Row | undefined): string | undefined {
  if (!target?.project) return undefined;
  const ref = target.ref as Ref | undefined;
  const scope = [target.project, target.collection].filter(Boolean).map(plain).join(' / ');
  const at = ref ? `${plain(ref.kind)}:${plain(ref.name)}` : target.branch ? `branch:${plain(target.branch)}` : undefined;
  const host = typeof target.endpoint === 'string' ? (() => { try { return new URL(target.endpoint).host; } catch { return plain(target.endpoint); } })() : undefined;
  return [scope, at, host && `(${host})`].filter(Boolean).join('  ');
}

/** Field count with the three most common index types, so a wide schema stays on one line. */
function indexSummary(configs: unknown): string {
  const types = new Map<string, number>();
  for (const config of Object.values((configs ?? {}) as Record<string, Row>)) {
    const type = plain(config?.type ?? '?');
    types.set(type, (types.get(type) ?? 0) + 1);
  }
  const fields = [...types.values()].reduce((sum, n) => sum + n, 0);
  const shown = [...types].sort(([, a], [, b]) => b - a).slice(0, 3).map(([type, n]) => `${type} ${n}`);
  const more = types.size - shown.length;
  if (!fields) return '0 fields';
  return `${fields} field${fields === 1 ? '' : 's'}: ${[...shown, ...(more ? [`+${more}`] : [])].join(', ')}`;
}

/** One row per index field; an object field is followed by its nested fields as dotted paths. */
function fieldRows(configs: Record<string, Row>, prefix = ''): unknown[][] {
  return Object.entries(configs).flatMap(([field, config]) => {
    const { type, description, objectIndexConfigs, ...rest } = config ?? {};
    const settings = Object.entries(rest).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
    const nested = objectIndexConfigs && typeof objectIndexConfigs === 'object' ? fieldRows(objectIndexConfigs as Record<string, Row>, `${prefix}${field}.`) : [];
    return [[prefix + field, type, settings, description ?? ''], ...nested];
  });
}

const nextPage = (command: string, token: unknown) => typeof token === 'string' && token ? `${command} --page-token ${shellArg(token)}` : undefined;

export function formatDoctor(): string {
  const ok = styleText('green', '✓');
  return [
    `${ok} Configuration`,
    `${ok} Authentication and collection access`,
    '',
    'Connected.',
    `Next: ${cli} collections list`,
  ].join('\n');
}

export function formatCollections(page: { collections: Row[]; nextPageToken?: unknown }, again = `${cli} collections list`): string {
  const next = nextPage(again, page.nextPageToken);
  return listing('Collections', ['NAME', 'DOCS', 'INDEXES', 'UPDATED'],
    page.collections.map(c => [c.collectionName, count(c.numDocs), indexSummary(c.indexConfigs), date(c.updatedAt)]),
    'No collections yet.',
    next ?? (page.collections.length ? `${cli} collections describe --collection <NAME>` : `${cli} collections create --collection <NAME> --index-config <FILE>`));
}

export function formatCollection(described: { collection: Row }): string {
  const c = described.collection;
  const row = (label: string, value: unknown) => `  ${styleText('dim', label.padEnd(11))} ${plain(value)}`;
  const tags = Object.entries((c.tags ?? {}) as Row).map(([k, v]) => `${k}=${v}`).join(', ');
  const partition = c.partitionConfig as Row | undefined;
  return [
    `Collection ${plain(c.collectionName)}`,
    '',
    row('Documents', `${count(c.numDocs)} on branch main`),
    ...(c.description ? [row('About', c.description)] : []),
    ...(tags ? [row('Tags', tags)] : []),
    row('Branch', c.defaultBranchName),
    row('Partitions', partition ? `${count(c.numPartitions)} by ${plain(partition.fieldName)}` : count(c.numPartitions)),
    row('Snapshots', `kept ${count(c.snapshotRetentionInDays)} days`),
    row('Created', time(c.createdAt)),
    row('Updated', time(c.updatedAt)),
    '',
    table(['FIELD', 'INDEX', 'SETTINGS', 'DESCRIPTION'], fieldRows((c.indexConfigs ?? {}) as Record<string, Row>)),
  ].join('\n');
}

/** The index fields of one ref, as collections describe lists them. */
const fields = (configs: unknown) => table(['FIELD', 'INDEX', 'SETTINGS', 'DESCRIPTION'], fieldRows((configs ?? {}) as Record<string, Row>));
const detail = (label: string, value: unknown) => `  ${styleText('dim', label.padEnd(12))} ${plain(value)}`;
const snapshot = (value: unknown) => {
  const s = value as Row | null | undefined;
  return s ? `${plain(s.snapshotId)} committed ${time(s.snapshotCommittedAt)}` : 'none';
};
const aliasTarget = (a: Row) => `${String(a.targetKind ?? '').toLowerCase()}:${plain(a.targetName)}${a.dangling ? ' (dangling)' : ''}`;
/** The next step of a ref list: the command for the following page, when the server returned a token. */
const refNext = (again: string | undefined, token: unknown) => again ? nextPage(again, token) : undefined;

export const formatBranches = (listed: { branches: Row[]; nextPageToken?: unknown }, again?: string) => listing('Branches', ['NAME', 'PARENT', 'DOCS', 'INDEXES', 'DATA UPDATED', 'CREATED'],
  listed.branches.map(b => [b.name, (b.parentBranch as Row | undefined)?.name ?? '', count(b.numDocs), indexSummary(b.indexConfigs), time(b.dataUpdatedAt), time(b.createdAt)]), 'No branches.', refNext(again, listed.nextPageToken));

/** A tag created before its source's first snapshot has none until a build publishes the writes it captured. */
const unpublished = (t: Row) => t.snapshotId === null;
const tagUpdated = (t: Row) => unpublished(t) ? 'not published' : time(t.dataUpdatedAt);

export const formatTags = (listed: { tags: Row[]; nextPageToken?: unknown }, again?: string) => listing('Tags', ['NAME', 'DOCS', 'INDEXES', 'DATA UPDATED', 'CREATED'],
  listed.tags.map(t => [t.name, count(t.numDocs), indexSummary(t.indexConfigs), tagUpdated(t), time(t.createdAt)]), 'No tags.', refNext(again, listed.nextPageToken));

export const formatAliases = (listed: { aliases: Row[]; nextPageToken?: unknown }, again?: string) => listing('Aliases', ['NAME', 'TARGET', 'INDEXES', 'REVISION', 'CREATED'],
  listed.aliases.map(a => [a.aliasName, aliasTarget(a), a.indexConfigs ? indexSummary(a.indexConfigs) : '', count(a.aliasRevision), time(a.createdAt)]), 'No aliases.', refNext(again, listed.nextPageToken));

export function formatBranch(described: { branch: Row }): string {
  const b = described.branch;
  const parent = b.parentBranch as Row | null | undefined;
  return [
    `Branch ${plain(b.name)}`,
    '',
    detail('Documents', count(b.numDocs)),
    ...(parent ? [detail('Parent', parent.name)] : []),
    detail('Head', snapshot(b.headSnapshot)),
    ...(b.parentSnapshot ? [detail('Forked from', snapshot(b.parentSnapshot))] : []),
    detail('Data updated', time(b.dataUpdatedAt) || 'never'),
    detail('Created', time(b.createdAt)),
    '',
    fields(b.indexConfigs),
  ].join('\n');
}

/** A rollback result: the new head, or an empty head when the tag had no published snapshot, then the next read. */
export function formatRollback(rolledBack: Row, summary: string, next: string): string {
  return [
    summary,
    ...(rolledBack.headSnapshot ? ['', detail('Head', snapshot(rolledBack.headSnapshot))] : []),
    '',
    `Next: ${next}`,
  ].join('\n');
}

export function formatTag(described: { tag: Row }): string {
  const t = described.tag;
  return [
    `Tag ${plain(t.name)}`,
    '',
    detail('Documents', count(t.numDocs)),
    detail('Snapshot', unpublished(t) ? 'none yet; reads include the writes the tag captured' : snapshot(t)),
    detail('Data updated', tagUpdated(t)),
    detail('Created', time(t.createdAt)),
    '',
    fields(t.indexConfigs),
  ].join('\n');
}

export function formatAlias(described: { alias: Row }): string {
  const a = described.alias;
  return [
    `Alias ${plain(a.aliasName)}`,
    '',
    detail('Target', aliasTarget(a)),
    detail('Revision', count(a.aliasRevision)),
    detail('Created', time(a.createdAt)),
    '',
    a.indexConfigs ? fields(a.indexConfigs) : 'No index schema: the target of this alias is gone.',
  ].join('\n');
}

const scalar = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value);

/** Documents stay JSON because they are the content; each header carries the ID and the item's other fields, such as scores. */
function documents(items: Row[]): string[] {
  return items.flatMap((item, i) => {
    const doc = item.doc as Row | undefined;
    const fields = Object.entries(item).filter(([key]) => key !== 'doc' && key !== 'collection')
      .map(([key, value]) => `  ${key} ${JSON.stringify(value)}`).join('');
    return ['', styleText('bold', `${i + 1}. ${plain(doc?.id ?? '(no id)')}`) + fields, json(doc ?? item, '   ')];
  });
}

/** Response fields beyond the documents, such as facets, rerank status or maxScore, shown under their names. */
function extras(data: Row, known: string[]): string[] {
  const entries = Object.entries(data).filter(([key, value]) => !known.includes(key) && value !== undefined);
  const scalars = entries.filter(([, value]) => scalar(value)).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  const blocks = entries.filter(([, value]) => !scalar(value)).flatMap(([key, value]) => ['', `${key}:`, json(value, '  ')]);
  return [...(scalars.length ? ['', ...scalars] : []), ...blocks];
}

export function formatDocuments(page: Row & { docs: Row[] }, summary: string, nextCommand?: string): string {
  const next = nextCommand ? nextPage(nextCommand, page.nextPageToken) : undefined;
  const missing = Array.isArray(page.missingIds) && page.missingIds.length ? [`Missing: ${page.missingIds.map(plain).join(', ')}`] : [];
  return [
    summary,
    ...missing,
    ...documents(page.docs),
    ...extras(page, ['docs', 'nextPageToken', 'missingIds', 'isDocsInline', 'took', 'total']),
    ...(next ? ['', `Next page: ${next}`] : []),
  ].join('\n');
}

export function formatQuery(result: Row & { docs: Row[] }): string {
  const took = typeof result.took === 'number' ? ` in ${result.took} ms` : '';
  const total = typeof result.total === 'number' && result.total !== result.docs.length ? ` of ${count(result.total)}` : '';
  return formatDocuments(result, `${result.docs.length}${total} match(es)${took}.`);
}

export function formatSettings(saved: { endpoint?: string; project?: string; apiKeyEnv?: string; credentialStore?: string }, path: string): string {
  const row = (label: string, value: unknown) => `  ${styleText('dim', label.padEnd(9))} ${plain(value)}`;
  return [
    'Configuration saved.',
    '',
    row('Endpoint', saved.endpoint),
    row('Project', saved.project),
    row('Key', saved.credentialStore ? `saved credential (${plain(saved.credentialStore)})` : `$${plain(saved.apiKeyEnv ?? 'LAMBDADB_API_KEY')}`),
    row('File', path),
    '',
    `Next: ${saved.credentialStore ? '' : 'export the key in that variable, then run '}${cli} doctor`,
  ].join('\n');
}
