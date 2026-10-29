import { loadAccount, management, parseOrganization, type AccountOptions, type Organization } from './account.js';
import { connectedProject, uuid } from './projects.js';
import { InputError, ManagementError } from './errors.js';
import type { Output } from './output.js';

type Metric = { used?: number; limit?: number; exceeded?: boolean };
type Quota = { period: string; window_start_at?: string; updated_at?: string; read: Metric; write: Metric; storage: Metric; inference: Metric };
type UsageProject = { id: string; name: string; organization_id: string; quota_enabled?: boolean; quota?: Quota };
const resources = ['read', 'write', 'storage', 'inference'] as const;
const quantities = ['read_bytes', 'write_bytes', 'storage_byte_hours', 'inference_liu'] as const;
const amounts = ['read_usd', 'write_usd', 'storage_usd', 'inference_usd', 'total_usd'] as const;
type Cost = { from: string; to: string; timezone: string; is_estimate: true; unpriced_metrics: string[] } & Record<typeof quantities[number] | typeof amounts[number], string | null>;
export type Usage = { organization: Organization; projects: UsageProject[]; retrieved_at: string; project_id?: string; cost?: Cost };
type UsageOptions = AccountOptions & { orgId?: string; projectId?: string; month?: string };

function invalid(): never { throw new InputError('Invalid usage response. Check Backend/CLI compatibility; missing usage is not zero.'); }
function timestamp(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if ((typeof value !== 'string' && typeof value !== 'number') || !Number.isFinite(new Date(value).getTime())) invalid();
  return new Date(value as string | number).toISOString();
}
function metric(value: unknown): Metric {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) invalid();
  const v = value as Metric;
  for (const key of ['used', 'limit'] as const) if (v[key] !== undefined && (!Number.isSafeInteger(v[key]) || v[key]! < 0)) invalid();
  if (v.exceeded !== undefined && typeof v.exceeded !== 'boolean') invalid();
  return { ...(v.used !== undefined ? { used: v.used } : {}), ...(v.limit !== undefined ? { limit: v.limit } : {}), ...(v.exceeded !== undefined ? { exceeded: v.exceeded } : {}) };
}
function decimal(value: unknown, nullable: boolean): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) invalid();
  return value as string;
}

export async function usage(options: UsageOptions, output: Output): Promise<Usage> {
  if (options.month !== undefined && !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(options.month)) throw new InputError('Use --month YYYY-MM (UTC). Free exposes only the current quota window.');
  if (options.projectId && !options.orgId) throw new InputError('--project-id requires --org-id. Omit both to use the saved project connection.');
  if (options.orgId !== undefined) uuid(options.orgId, 'Organization');
  if (options.projectId !== undefined) uuid(options.projectId, 'Project');
  const account = await loadAccount(options);
  const selected = options.orgId ? { org: options.orgId, projectId: options.projectId } : await connectedProject(options, account);
  const api = await management(options, output);
  const params = new URLSearchParams();
  if (selected.projectId) params.set('project_id', selected.projectId);
  if (options.month) params.set('month', options.month);
  let response: Record<string, unknown>;
  try { response = await api.request(`usage${params.size ? `?${params}` : ''}`, 'GET', undefined, selected.org); }
  catch (error) {
    if (error instanceof ManagementError) throw new ManagementError('usage_request_failed', error.status, error.details);
    throw error;
  }
  const organization = parseOrganization(response.organization, account);
  if (organization.id !== selected.org || !Array.isArray(response.projects) || response.project_id !== selected.projectId) invalid();
  const retrieved = timestamp(response.retrieved_at);
  if (!retrieved) invalid();
  const projects: UsageProject[] = response.projects.map((value: unknown) => {
    const p = value as UsageProject;
    if (!p || p.organization_id !== selected.org || typeof p.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(p.name)) invalid();
    uuid(p.id, 'Project');
    if (selected.projectId && p.id !== selected.projectId) invalid();
    if (p.quota_enabled !== undefined && typeof p.quota_enabled !== 'boolean') invalid();
    let quota: Quota | undefined;
    if (p.quota !== undefined && p.quota !== null) {
      const q = p.quota;
      if (typeof q.period !== 'string') invalid();
      quota = { period: q.period, window_start_at: timestamp(q.window_start_at), updated_at: timestamp(q.updated_at), read: metric(q.read), write: metric(q.write), storage: metric(q.storage), inference: metric(q.inference) };
    }
    return { id: p.id, name: p.name, organization_id: p.organization_id, quota_enabled: p.quota_enabled, ...(quota ? { quota } : {}) };
  });
  if (organization.plan === 'Free') return { organization, projects, project_id: selected.projectId, retrieved_at: retrieved };
  if (!organization.plan.startsWith('Pay-As-You-Go (')) invalid();
  const c = response.cost as Cost;
  if (!c || c.is_estimate !== true || c.timezone !== 'UTC' || !Array.isArray(c.unpriced_metrics) || c.unpriced_metrics.some(m => !resources.includes(m as typeof resources[number]))) invalid();
  const from = timestamp(c.from), to = timestamp(c.to);
  if (!from || !to || from >= to) invalid();
  const cost: Cost = { from, to, timezone: 'UTC', is_estimate: true, unpriced_metrics: c.unpriced_metrics, read_bytes: decimal(c.read_bytes, false), write_bytes: decimal(c.write_bytes, false), storage_byte_hours: decimal(c.storage_byte_hours, false), inference_liu: decimal(c.inference_liu, true), read_usd: decimal(c.read_usd, true), write_usd: decimal(c.write_usd, true), storage_usd: decimal(c.storage_usd, true), inference_usd: decimal(c.inference_usd, true), total_usd: decimal(c.total_usd, false) };
  return { organization, projects, project_id: selected.projectId, retrieved_at: retrieved, cost };
}

export function formatUsage(data: Usage): string {
  const lines = [`${data.organization.name} — ${data.organization.plan}`, `Org ID: ${data.organization.id}`, `Retrieved: ${data.retrieved_at}`];
  if (data.project_id) lines.push(`Project ID: ${data.project_id}`);
  if (data.organization.plan === 'Free') {
    if (!data.projects.length) lines.push('No active projects.');
    for (const p of data.projects) {
      lines.push(`\nProject: ${p.name}`);
      if (!p.quota || p.quota_enabled !== true) { lines.push('Quota data unavailable; no usage or limits inferred.'); continue; }
      const q = p.quota;
      lines.push(`Quota period: ${q.period}; window starts: ${q.window_start_at ?? 'unavailable'}; updated: ${q.updated_at ?? 'unavailable'}`);
      for (const r of resources) {
        const m = q[r], unit = r === 'inference' ? 'LIU' : 'bytes';
        const used = m.used?.toLocaleString('en-US') ?? 'unavailable', limit = m.limit?.toLocaleString('en-US') ?? 'unavailable';
        const percent = m.used !== undefined && m.limit !== undefined && m.limit > 0 ? ` (${(m.used / m.limit * 100).toFixed(1)}%)` : '';
        lines.push(`${r}: ${used} / ${limit} ${unit}${percent}${m.exceeded ? ' — limit exceeded' : ''}`);
      }
    }
    if (data.projects.length) lines.push('Based on recorded usage; recent activity may not be aggregated yet.');
  } else if (data.cost) {
    const c = data.cost;
    lines.push(`\nUsage period: ${c.from} to ${c.to} (exclusive, UTC; current bucket may still fill)`);
    resources.forEach((r, i) => {
      const quantity = quantities[i]!, amount = amounts[i]!;
      lines.push(`${r}: ${c[quantity] ?? 'unavailable'} ${['bytes','bytes','byte-hours','LIU'][i]} — ${c[amount] === null ? 'cost unavailable' : `$${c[amount]}`}`);
    });
    lines.push(`${c.unpriced_metrics.length ? 'Partial priced subtotal' : 'Estimated list-rate cost'}: $${c.total_usd} USD`);
    if (c.unpriced_metrics.length) lines.push(`Unpriced: ${c.unpriced_metrics.join(', ')}`);
    lines.push('Based on recorded usage, not a month-end forecast or invoice. Excludes free allowances, credits, taxes and billing rounding.');
  }
  // Organization names are user-controlled; do not allow terminal escape sequences.
  // eslint-disable-next-line no-control-regex
  return lines.join('\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' ');
}
