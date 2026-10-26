import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { accountPath, loadAccount, login, management, parseOrganization, readOptional, withManagementLock, writeMetadata, type AccountOptions, type Organization } from './account.js';
import { configPath, endpoint, fileIdentity, saveSettings, type SelectedSettings } from './config.js';
import { CredentialVault, credentialReference } from './credentials.js';
import { openBrowser, projectAuthorization } from './device-auth.js';
import { InputError, ManagementError } from './errors.js';
import type { Output } from './output.js';

export type Project = { id: string; name: string; status: string; organization_id: string; base_url?: string };
export function uuid(value: string | undefined, label: string): string {
  if (!value || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) throw new InputError(`${label} must be an explicit UUID. Run orgs list or projects list to find it.`);
  return value;
}
export async function organizations(options: AccountOptions, output: Output): Promise<Organization[]> {
  const api = await management(options, output), response = await api.request('organizations');
  if (!Array.isArray(response.organizations)) throw new InputError('Invalid Organization list response.');
  return response.organizations.map(v => parseOrganization(v, api.account));
}
export async function projects(options: AccountOptions, org: string, output: Output): Promise<Project[]> {
  uuid(org, 'Organization');
  return listProjects(await management(options, output), org);
}
async function listProjects(api: Awaited<ReturnType<typeof management>>, org: string): Promise<Project[]> {
  const response = await api.request('projects', 'GET', undefined, org);
  if (!Array.isArray(response.projects)) throw new InputError('Invalid project list response.');
  return response.projects.map(value => {
    const p = value as Project;
    uuid(p.id, 'Project');
    if (typeof p.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(p.name) || typeof p.status !== 'string' || p.organization_id !== org) throw new InputError('Invalid project identity in response.');
    return { id: p.id, name: p.name, status: p.status, organization_id: p.organization_id, ...(typeof p.base_url === 'string' ? { base_url: endpoint(p.base_url) } : {}) };
  });
}
export async function createProject(options: AccountOptions, input: { org?: string; defaultOrg?: boolean; name: string; region: string }, output: Output) {
  if (!!input.org === !!input.defaultOrg) throw new InputError('Choose exactly one of --org UUID or --default-org.');
  if (input.org) uuid(input.org, 'Organization');
  if (!/^[a-zA-Z0-9_-]{3,45}$/.test(input.name) || !input.region) throw new InputError('Project name must contain 3–45 letters, digits, underscores or hyphens; --region is required.');
  const api = await management(options, output);
  const result = await api.request('projects', 'POST', { name: input.name, cloud_provider: 'aws', region: input.region, default_organization: !!input.defaultOrg }, input.org);
  try {
    uuid(result.id as string, 'Created project'); uuid(result.organization_id as string, 'Organization');
    if (typeof result.status !== 'string') throw new Error();
  } catch { throw new ManagementError('write_outcome_unknown', undefined); }
  return { id: result.id as string, organization_id: result.organization_id as string, name: input.name, status: result.status as string };
}
type SavedConnection = { account: string; org: string; projectId: string; settings?: SelectedSettings; pendingKeyName?: string };
const connectionsPath = async (options: AccountOptions) => `${await fileIdentity(configPath(options))}.connections.json`;
async function connections(options: AccountOptions) {
  const path = await connectionsPath(options), before = await readOptional(path);
  let items: SavedConnection[] = [];
  if (before) {
    try {
      items = JSON.parse(before);
      if (!Array.isArray(items)) throw new Error();
      for (const item of items) {
        if (Object.keys(item).some(k => !['account','org','projectId','settings','pendingKeyName'].includes(k)) || typeof item.account !== 'string') throw new Error();
        uuid(item.org, 'Organization'); uuid(item.projectId, 'Project');
        if (item.pendingKeyName !== undefined && (typeof item.pendingKeyName !== 'string' || !/^lambdadb-cli-[0-9a-f-]{36}$/.test(item.pendingKeyName))) throw new Error();
        if (item.settings) {
          const s = item.settings; credentialReference(s.credentialStore, s.credentialId); endpoint(s.endpoint);
          if (Object.keys(s).some(k => !['endpoint','project','apiKeyEnv','credentialStore','credentialId','credentialKeyId','credentialKeyName'].includes(k)) || !/^[a-zA-Z0-9_-]+$/.test(s.project)) throw new Error();
        }
      }
    } catch { throw new InputError('Invalid saved project connections. Restore the file; never store keys in metadata.'); }
  }
  return { path, before, items };
}
export async function useProject(options: AccountOptions, org: string, projectId: string, issueKey: boolean, output: Output, vault = new CredentialVault(), client?: Awaited<ReturnType<typeof management>>) {
  uuid(org, 'Organization'); uuid(projectId, 'Project');
  return withManagementLock(options, async () => {
    const api = client ?? await management(options, output);
    const project = (await listProjects(api, org)).find(p => p.id === projectId);
    const orgResponse = await api.request('organizations');
    const orgs = Array.isArray(orgResponse.organizations) ? orgResponse.organizations.map(v => parseOrganization(v, api.account)) : [];
    if (!orgs.some(o => o.id === org && o.role !== 'member')) throw new InputError('Project connection requires Organization owner or admin access.');
    if (!project) throw new InputError('The project is not available in this Organization.');
    if (project.status !== 'ACTIVE') throw new InputError(`Project is ${project.status}. Resume with projects use after it is ACTIVE; do not create a replacement.`);
    const cache = await connections(options), account = `${api.account.apiUrl}/${api.account.memberId}`;
    let item = cache.items.find(c => c.account === account && c.org === org && c.projectId === projectId);
    const original = configPath(options), destination = await fileIdentity(original), before = await readOptional(destination);
    output.diagnostic(`CLI settings: ${destination}; saved project references: ${cache.path}.`);
    if (item?.pendingKeyName) output.diagnostic(`Previous delivery was uncertain: inspect/revoke ${item.pendingKeyName} in Console before replacing it.`);
    let selected = item?.settings;
    if (!selected || issueKey) {
      if (!issueKey) throw new InputError(`No reusable connection. ${item?.pendingKeyName ? `Inspect/revoke ${item.pendingKeyName} in Console first. ` : ''}Run projects use --org ${org} --project-id ${projectId} --issue-key to explicitly issue a project key.`);
      const store = await vault.select(options.credentialStore ?? api.account.credentialStore);
      output.diagnostic(`Project credential store: ${store}. The key retains existing API permissions, including writes; MCP write-tool visibility is configured separately.`);
      if (store === 'keyutils') output.diagnostic('Kernel credentials can expire or disappear after reboot. Metadata is retained; replacement requires explicit key issuance.');
      const requestId = randomUUID(), keyName = `lambdadb-cli-${requestId}`;
      output.diagnostic(`Issuing ${keyName}. If delivery fails, inspect it in Console; no request will be retried automatically.`);
      if (!item) { item = { account, org, projectId }; cache.items.push(item); }
      item.pendingKeyName = keyName;
      await writeMetadata(cache.path, cache.items, cache.before);
      const pending = await readOptional(cache.path);
      const granted = projectAuthorization(await api.request('connect', 'POST', { organization_id: org, project_id: projectId, request_id: requestId }), output, keyName);
      if (granted.project !== project.name) throw new InputError('Issued key target does not match the selected project. Inspect the named key in Console.');
      selected = { endpoint: granted.endpoint, project: granted.project, apiKeyEnv: 'LAMBDADB_API_KEY', credentialStore: store, credentialId: randomUUID(), credentialKeyId: granted.credentialKeyId, credentialKeyName: keyName };
      const target = { ...selected, ...credentialReference(selected.credentialStore, selected.credentialId) };
      await vault.save(target, granted.apiKey);
      try { item.settings = selected; delete item.pendingKeyName; await writeMetadata(cache.path, cache.items, pending); }
      catch (error) { await vault.remove(target).catch(() => {}); throw error; }
    } else {
      if (selected.project !== project.name) throw new InputError('Saved project identity changed. Reconnect explicitly.');
      await vault.read({ ...selected, ...credentialReference(selected.credentialStore, selected.credentialId) });
    }
    if (await fileIdentity(original) !== destination || await readOptional(destination) !== before) throw new InputError('CLI settings changed. The connection is cached; rerun projects use without --issue-key.');
    await saveSettings({ ...options, ...selected, config: destination });
    output.diagnostic('CLI project selected. Existing agent entries remain pinned; rerun init to update their connection.');
    return selected;
  });
}

type Ask = (label: string, fallback?: string) => Promise<string | undefined>;
async function choose<T>(items: T[], label: (item: T) => string, ask: Ask, prompt: string): Promise<T> {
  if (!items.length) throw new InputError('No choices are available.');
  // eslint-disable-next-line no-control-regex -- Keep item names from adding fake choices or terminal escapes.
  const labels = items.map((item, i) => `${i + 1}. ${label(item).replace(/[\x00-\x1f\x7f]/g, ' ')}`);
  const answer = await ask(`${prompt}\n${labels.join('\n')}\nChoose a number`, '1');
  const index = Number(answer) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= items.length) throw new InputError('Choose one of the listed numbers.');
  const choice = items[index];
  if (choice === undefined) throw new InputError('Choose one of the listed numbers.');
  return choice;
}
export async function terminalSetup(options: AccountOptions, output: Output, ask: Ask) {
  if (!await readOptional(await accountPath(options))) await login(options, output);
  else {
    try { await loadAccount(options); }
    catch { if (await ask('Login is unavailable or expired. Authorize login again? Type yes', 'no') !== 'yes') throw new InputError('Run login to renew account access.'); await login(options, output); }
  }
  let orgs = await organizations(options, output);
  let org = orgs.length ? await choose(orgs, o => `${o.name} (${o.role}, ${o.plan}, projects ${o.projects_count}/${o.max_projects})`, ask, 'Organization') : undefined;
  let available = org ? await projects(options, org.id, output) : [];
  let project: Project | undefined;
  for (;;) {
    if (org?.role === 'member') throw new InputError('Connecting requires an Organization owner or admin to issue a project key. Select another Organization, or obtain a key from your admin and use environment setup.');
    const atLimit = org && org.projects_count >= org.max_projects;
    const action = await ask(atLimit && org
      ? `Project limit reached (${org.projects_count}/${org.max_projects}). Enter use, billing, or cancel`
      : `Enter use for an existing project${available.length ? '' : ' (none yet)'}, create, or cancel`, available.length ? 'use' : atLimit ? 'billing' : 'create');
    if (action === 'cancel') throw new InputError('Setup canceled. Saved login and project connections remain available.');
    if (action === 'billing' && org) {
      output.diagnostic(`${org.can_upgrade ? 'Review your plan or request a limit increase' : 'Ask the Organization owner to activate billing'}: ${org.billing_url}`);
      if (org.can_upgrade && await ask('Open billing in your browser? Type yes', 'no') === 'yes') openBrowser(org.billing_url, output);
      if (await ask('After billing is updated, type retry to recheck limits, or cancel', 'cancel') !== 'retry') throw new InputError('Rerun init --connect when ready. No project was created.');
      const id = org.id; orgs = await organizations(options, output); org = orgs.find(o => o.id === id);
      if (!org) throw new InputError('Organization access changed. Rerun init to select another Organization.');
      available = await projects(options, org.id, output); continue;
    }
    if (action === 'use') { project = await choose(available, p => `${p.name} (${p.status})`, ask, 'Project'); break; }
    if (action !== 'create' || atLimit) throw new InputError('Choose one of the displayed actions.');
    const api = await management(options, output), response = await api.request('regions');
    const regions = response.regions as { region: string; name: string; is_open: boolean; cloud_provider: string }[];
    if (!Array.isArray(regions)) throw new InputError('Invalid region list.');
    const region = await choose(regions.filter(r => r.is_open && r.cloud_provider === 'aws'), r => `${r.name} (${r.region})`, ask, 'Region');
    const name = await ask('Project name');
    output.diagnostic(`Create ${name ?? ''} in ${org?.name ?? 'your default Organization'} (${region.region}).`);
    if (await ask('Create this project? Type yes', 'no') !== 'yes') throw new InputError('No project was requested.');
    const created = await createProject(options, { org: org?.id, defaultOrg: !org, name: name ?? '', region: region.region }, output);
    project = created;
    const deadline = Date.now() + 10 * 60_000;
    while (project.status !== 'ACTIVE' && Date.now() < deadline) {
      output.diagnostic('Project is provisioning. Waiting; interruption is safe. Rerun init to select this project.');
      await delay(5000, undefined, { signal: options.signal });
      const found = (await projects(options, created.organization_id, output)).find(p => p.id === created.id);
      if (!found) throw new InputError('Created project was not listed. Check Console before creating another.');
      project = found;
    }
    if (project.status !== 'ACTIVE') throw new InputError('Provisioning is still pending. Rerun init --connect later and select the existing project.');
    break;
  }
  const a = await loadAccount(options), cache = await connections(options);
  const saved = cache.items.find(c => c.account === `${a.apiUrl}/${a.memberId}` && c.projectId === project.id && c.org === project.organization_id);
  let issue = !saved?.settings;
  if (saved?.settings) {
    try { await new CredentialVault().read({ ...saved.settings, ...credentialReference(saved.settings.credentialStore, saved.settings.credentialId) }); }
    catch { output.diagnostic('The saved project credential is unavailable. Review its named key in Console before replacement.'); issue = true; }
  }
  if (issue) {
    if (saved?.pendingKeyName) output.diagnostic(`Inspect/revoke ${saved.pendingKeyName} in Console before replacing the uncertain connection.`);
    if (await ask('Issue a new project key and store it in your OS credential store? Type yes', 'no') !== 'yes') throw new InputError('No project key was requested.');
  }
  return useProject(options, project.organization_id, project.id, issue, output);
}
