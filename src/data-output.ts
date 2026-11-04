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
  return styleText('dim', [scope, at, host && `(${host})`].filter(Boolean).join('  '));
}

const indexSummary = (configs: unknown) => Object.entries((configs ?? {}) as Record<string, Row>)
  .map(([field, config]) => config?.type === 'vector' && config.dimensions ? `${field} (vector ${config.dimensions})` : `${field} (${plain(config?.type ?? '?')})`)
  .join(', ');

const nextPage = (command: string, token: unknown) => typeof token === 'string' && token ? `${command} --page-token ${shellArg(token)}` : undefined;

export function formatDoctor(): string {
  const ok = styleText('green', '✓');
  return [
    `${ok} Configuration`,
    `${ok} Authentication and collection access`,
    '',
    'Connected. Writes and search readiness were not checked.',
    `Next: ${cli} collections list`,
  ].join('\n');
}

export function formatCollections(page: { collections: Row[]; nextPageToken?: unknown }, again = `${cli} collections list`): string {
  const next = nextPage(again, page.nextPageToken);
  return listing('Collections', ['NAME', 'DOCS', 'INDEXES', 'UPDATED'],
    page.collections.map(c => [c.collectionName, count(c.numDocs), indexSummary(c.indexConfigs), time(c.updatedAt)]),
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
    row('Documents', `${count(c.numDocs)} on the committed main branch`),
    ...(c.description ? [row('About', c.description)] : []),
    ...(tags ? [row('Tags', tags)] : []),
    row('Branch', c.defaultBranchName),
    row('Partitions', partition ? `${count(c.numPartitions)} by ${plain(partition.fieldName)}` : count(c.numPartitions)),
    row('Snapshots', `kept ${count(c.snapshotRetentionInDays)} days`),
    row('Created', time(c.createdAt)),
    row('Updated', time(c.updatedAt)),
    '',
    table(['FIELD', 'INDEX', 'SETTINGS'], Object.entries((c.indexConfigs ?? {}) as Record<string, Row>).map(([field, config]) => {
      const { type, ...rest } = config ?? {};
      return [field, type, Object.entries(rest).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ')];
    })),
    '',
    'Document counts are not a readiness signal; run a query to verify search.',
  ].join('\n');
}

export const formatBranches = (listed: { branches: Row[] }) => listing('Branches', ['NAME', 'PARENT', 'CREATED'],
  listed.branches.map(b => [b.name, (b.parentBranch as Row | undefined)?.name ?? '', time(b.createdAt)]), 'No branches.');

export const formatTags = (listed: { tags: Row[] }) => listing('Tags', ['NAME', 'CREATED'],
  listed.tags.map(t => [t.name, time(t.createdAt)]), 'No tags.');

export const formatAliases = (listed: { aliases: Row[] }) => listing('Aliases', ['NAME', 'TARGET', 'REVISION', 'CREATED'],
  listed.aliases.map(a => [a.aliasName, `${String(a.targetKind ?? '').toLowerCase()}:${plain(a.targetName)}${a.dangling ? ' (dangling)' : ''}`, count(a.aliasRevision), time(a.createdAt)]), 'No aliases.');

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
