import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  accountPath,
  loadAccount,
  login,
  management,
  parseOrganization,
  readOptional,
  withManagementLock,
  writeMetadata,
  type AccountOptions,
  type Account,
  type Organization,
} from './account.js';
import { configPath, endpoint, fileIdentity, saveSettings, settings, type SelectedSettings } from './config.js';
import { CredentialVault, credentialReference } from './credentials.js';
import { openBrowser, projectAuthorization } from './device-auth.js';
import { InputError, ManagementError } from './errors.js';
import type { Output } from './output.js';
import type { SetupPrompts } from './init-ui.js';

export type Project = {
  id: string;
  name: string;
  status: string;
  organization_id: string;
  base_url?: string;
};
export function uuid(value: string | undefined, label: string): string {
  if (!value || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value))
    throw new InputError(`${label} must be an explicit UUID. Run orgs list or projects list to find it.`);
  return value;
}
export async function organizations(options: AccountOptions, output: Output): Promise<Organization[]> {
  const api = await management(options, output),
    response = await api.request('organizations');
  if (!Array.isArray(response.organizations)) throw new InputError('Invalid Organization list response.');
  return response.organizations.map((v) => parseOrganization(v, api.account));
}
export async function projects(options: AccountOptions, org: string, output: Output): Promise<Project[]> {
  uuid(org, 'Organization');
  return listProjects(await management(options, output), org);
}
async function listProjects(api: Awaited<ReturnType<typeof management>>, org: string): Promise<Project[]> {
  const response = await api.request('projects', 'GET', undefined, org);
  if (!Array.isArray(response.projects)) throw new InputError('Invalid project list response.');
  return response.projects.map((value) => {
    const p = value as Project;
    uuid(p.id, 'Project');
    if (
      typeof p.name !== 'string' ||
      !/^[a-zA-Z0-9_-]+$/.test(p.name) ||
      typeof p.status !== 'string' ||
      p.organization_id !== org
    )
      throw new InputError('Invalid project identity in response.');
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      organization_id: p.organization_id,
      ...(typeof p.base_url === 'string' ? { base_url: endpoint(p.base_url) } : {}),
    };
  });
}
export async function createProject(
  options: AccountOptions,
  input: { orgId?: string; defaultOrg?: boolean; name: string; region: string },
  output: Output,
) {
  if (!!input.orgId === !!input.defaultOrg)
    throw new InputError('Choose exactly one of --org-id UUID or --default-org.');
  if (input.orgId) uuid(input.orgId, 'Organization');
  if (!/^[a-zA-Z0-9_-]{3,45}$/.test(input.name) || !input.region)
    throw new InputError(
      'Project name must contain 3–45 letters, digits, underscores or hyphens; --region is required.',
    );
  const api = await management(options, output);
  const result = await api.request(
    'projects',
    'POST',
    {
      name: input.name,
      cloud_provider: 'aws',
      region: input.region,
      default_organization: !!input.defaultOrg,
    },
    input.orgId,
  );
  try {
    uuid(result.id as string, 'Created project');
    uuid(result.organization_id as string, 'Organization');
    if (typeof result.status !== 'string') throw new Error();
  } catch {
    throw new ManagementError('write_outcome_unknown', undefined);
  }
  return {
    id: result.id as string,
    organization_id: result.organization_id as string,
    name: input.name,
    status: result.status as string,
  };
}
type SavedConnection = {
  account: string;
  org: string;
  projectId: string;
  settings?: SelectedSettings;
  pendingKeyName?: string;
};
const connectionsPath = async (options: AccountOptions) =>
  `${await fileIdentity(configPath(options))}.connections.json`;
async function connections(options: AccountOptions) {
  const path = await connectionsPath(options),
    before = await readOptional(path);
  let items: SavedConnection[] = [];
  if (before) {
    try {
      items = JSON.parse(before);
      if (!Array.isArray(items)) throw new Error();
      for (const item of items) {
        if (
          Object.keys(item).some(
            (k) => !['account', 'org', 'projectId', 'settings', 'pendingKeyName'].includes(k),
          ) ||
          typeof item.account !== 'string'
        )
          throw new Error();
        uuid(item.org, 'Organization');
        uuid(item.projectId, 'Project');
        if (
          item.pendingKeyName !== undefined &&
          (typeof item.pendingKeyName !== 'string' ||
            !/^lambdadb-cli-[0-9a-f-]{36}$/.test(item.pendingKeyName))
        )
          throw new Error();
        if (item.settings) {
          const s = item.settings;
          credentialReference(s.credentialStore, s.credentialId);
          endpoint(s.endpoint);
          if (
            Object.keys(s).some(
              (k) =>
                ![
                  'endpoint',
                  'project',
                  'apiKeyEnv',
                  'credentialStore',
                  'credentialId',
                  'credentialKeyId',
                  'credentialKeyName',
                ].includes(k),
            ) ||
            !/^[a-zA-Z0-9_-]+$/.test(s.project)
          )
            throw new Error();
        }
      }
    } catch {
      throw new InputError(
        'Invalid saved project connections. Restore the file; never store keys in metadata.',
      );
    }
  }
  return { path, before, items };
}
export async function connectedProject(options: AccountOptions, account: Account) {
  const hint = 'Cannot identify the current project for usage. Run init to select a project, or pass --org-id UUID for Org usage and optionally --project-id UUID. Usage requires account login, not a project key.';
  let selected: SelectedSettings;
  try { selected = await settings(options, true); } catch { throw new InputError(hint); }
  if (!selected.credentialId) throw new InputError(hint);
  const matches = (await connections(options)).items.filter(c => c.account === `${account.apiUrl}/${account.memberId}` && c.settings && c.settings.credentialId === selected.credentialId && c.settings.endpoint === selected.endpoint && c.settings.project === selected.project);
  const match = matches.length === 1 ? matches[0] : undefined;
  if (!match) throw new InputError(hint);
  return { org: match.org, projectId: match.projectId };
}

export async function useProject(
  options: AccountOptions,
  org: string,
  projectId: string,
  issueKey: boolean,
  output: Output,
  vault = new CredentialVault(),
  client?: Awaited<ReturnType<typeof management>>,
) {
  uuid(org, 'Organization');
  uuid(projectId, 'Project');
  return withManagementLock(options, async () => {
    const api = client ?? (await management(options, output));
    const project = (await listProjects(api, org)).find((p) => p.id === projectId);
    const orgResponse = await api.request('organizations');
    const orgs = Array.isArray(orgResponse.organizations)
      ? orgResponse.organizations.map((v) => parseOrganization(v, api.account))
      : [];
    const organization = orgs.find((o) => o.id === org);
    if (!organization) throw new InputError('The Organization is not available to this account.');
    if (!project) throw new InputError('The project is not available in this Organization.');
    if (project.status !== 'ACTIVE')
      throw new InputError(
        `Project is ${project.status}. Resume with projects use after it is ACTIVE; do not create a replacement.`,
      );
    const cache = await connections(options),
      account = `${api.account.apiUrl}/${api.account.memberId}`;
    let item = cache.items.find((c) => c.account === account && c.org === org && c.projectId === projectId);
    const original = configPath(options),
      destination = await fileIdentity(original),
      before = await readOptional(destination);
    if (!options.guided) output.diagnostic(`CLI settings: ${destination}; saved project references: ${cache.path}.`);
    if (item?.pendingKeyName)
      output.diagnostic(
        `Previous delivery was uncertain: inspect/revoke ${item.pendingKeyName} in Console before replacing it.`,
      );
    let selected = item?.settings;
    if (!selected || issueKey) {
      if (organization.role === 'member')
        throw new InputError(
          'Only an Organization owner or admin can issue a project key. Use a saved connection or obtain a key from your admin for environment setup.',
        );
      if (!issueKey)
        throw new InputError(
          `No reusable connection. ${item?.pendingKeyName ? `Inspect/revoke ${item.pendingKeyName} in Console first. ` : ''}Run projects use --org-id ${org} --project-id ${projectId} --issue-key to explicitly issue a project key.`,
        );
      const store = await vault.select(options.credentialStore ?? api.account.credentialStore);
      if (!options.guided) output.diagnostic(
        `Project credential store: ${store}. The key retains existing API permissions, including writes; MCP write-tool visibility is configured separately.`,
      );
      if (store === 'keyutils')
        output.diagnostic(
          'Kernel credentials can expire or disappear after reboot. Metadata is retained; replacement requires explicit key issuance.',
        );
      const requestId = randomUUID(),
        keyName = `lambdadb-cli-${requestId}`;
      output.diagnostic(
        options.guided ? `Creating project key in ${store}.\nRecovery name: ${keyName}` : `Issuing ${keyName}. If delivery fails, inspect it in Console; no request will be retried automatically.`,
      );
      if (!item) {
        item = { account, org, projectId };
        cache.items.push(item);
      }
      item.pendingKeyName = keyName;
      await writeMetadata(cache.path, cache.items, cache.before);
      const pending = await readOptional(cache.path);
      const response = await api.request('connect', 'POST', {
        organization_id: org,
        project_id: projectId,
        request_id: requestId,
      });
      let granted: ReturnType<typeof projectAuthorization>;
      try {
        granted = projectAuthorization(response, output, keyName);
        if (granted.project !== project.name) throw new Error();
      } catch {
        throw new ManagementError('issuance_unconfirmed', undefined, { pendingKeyName: keyName });
      }
      selected = {
        endpoint: granted.endpoint,
        project: granted.project,
        apiKeyEnv: 'LAMBDADB_API_KEY',
        credentialStore: store,
        credentialId: randomUUID(),
        credentialKeyId: granted.credentialKeyId,
        credentialKeyName: keyName,
      };
      const target = { ...selected, ...credentialReference(selected.credentialStore, selected.credentialId) };
      await vault.save(target, granted.apiKey);
      try {
        item.settings = selected;
        delete item.pendingKeyName;
        await writeMetadata(cache.path, cache.items, pending);
      } catch (error) {
        await vault.remove(target).catch(() => {});
        throw error;
      }
    } else {
      if (selected.project !== project.name)
        throw new InputError('Saved project identity changed. Reconnect explicitly.');
      await vault.read({
        ...selected,
        ...credentialReference(selected.credentialStore, selected.credentialId),
      });
    }
    if ((await fileIdentity(original)) !== destination || (await readOptional(destination)) !== before)
      throw new InputError(
        'CLI settings changed. The connection is cached; rerun projects use without --issue-key.',
      );
    await saveSettings({ ...options, ...selected, config: destination });
    if (!options.guided) output.diagnostic('CLI project selected. Existing agent entries remain pinned; rerun init to update their connection.');
    return selected;
  });
}

async function choose<T>(items: T[], label: (item: T) => string, prompts: SetupPrompts, title: string, hint?: (item: T) => string | undefined): Promise<T> {
  if (!items.length) throw new InputError('No choices are available.');
  const answer = await prompts.select(title, [
    ...items.map((item, index) => ({ value: String(index), label: label(item), ...(hint ? { hint: hint(item) } : {}) })),
    { value: 'cancel', label: 'Cancel' },
  ]);
  if (answer === 'cancel') throw new InputError('Setup canceled. Saved login and project connections remain available.');
  const selected = items[Number(answer)];
  if (selected === undefined) throw new InputError('Choose a listed option.');
  return selected;
}
export async function terminalSetup(options: AccountOptions, output: Output, prompts: SetupPrompts) {
  if (!(await readOptional(await accountPath(options)))) await login(options, output);
  else {
    try {
      await loadAccount(options);
    } catch {
      if (!(await prompts.confirm('Sign in again? Your saved login has expired.')))
        throw new InputError('Run login to renew account access.');
      await login(options, output);
    }
  }
  let orgs = await organizations(options, output);
  let org = orgs.length === 1 ? orgs[0] : orgs.length
    ? await choose(
        orgs,
        (o) => o.name,
        prompts,
        'Organization',
        o => `${o.role} · ${o.plan} · projects ${o.projects_count}/${o.max_projects}`,
      )
    : undefined;
  if (org) output.diagnostic(`Organization: ${org.name} (${org.role}, ${org.plan}).`);
  let available = org ? await projects(options, org.id, output) : [];
  let project: Project | undefined;
  for (;;) {
    const atLimit = org && org.projects_count >= org.max_projects;
    const choices: { label: string; hint?: string; action: string; index: number }[] = [
      ...available.map((p, index) => ({ label: p.name, hint: p.status === 'ACTIVE' ? 'Ready' : p.status, action: 'use', index })),
      { label: atLimit && org ? `Create a new project — limit ${org.projects_count}/${org.max_projects}; review billing` : 'Create a new project', action: atLimit ? 'billing' : 'create', index: -1 },
      ...(orgs.length > 1 ? [{ label: 'Choose another Organization', action: 'org', index: -1 }] : []),
    ];
    const startCreation = !available.length && !atLimit && orgs.length <= 1;
    if (startCreation) output.diagnostic('No projects yet. Set up your first project.');
    const choice = startCreation ? { action: 'create', index: -1 } : await choose(choices, value => value.label, prompts, 'Project', value => value.hint);
    if (choice.action === 'use') {
      project = available[choice.index];
      if (!project) throw new InputError('Choose a listed project.');
      break;
    }
    if (choice.action === 'org') {
      org = await choose(orgs, o => o.name, prompts, 'Organization', o => `${o.role} · ${o.plan}`);
      available = await projects(options, org.id, output);
      continue;
    }
    const action = choice.action;
    if (action === 'billing' && org) {
      output.diagnostic(
        `${org.can_upgrade ? 'Review your plan or request a limit increase' : 'Ask the Organization owner to activate billing'}: ${org.billing_url}`,
      );
      if (org.can_upgrade && await prompts.confirm('Open billing in your browser?'))
        openBrowser(org.billing_url, output);
      if (
        (await prompts.select('After updating billing', [{ value: 'retry', label: 'Recheck project limits' }, { value: 'cancel', label: 'Cancel' }], 'cancel')) !== 'retry'
      )
        throw new InputError('Rerun init and choose account-based project setup when ready. No project was created.');
      const id = org.id;
      orgs = await organizations(options, output);
      org = orgs.find((o) => o.id === id);
      if (!org)
        throw new InputError('Organization access changed. Rerun init to select another Organization.');
      available = await projects(options, org.id, output);
      continue;
    }
    if (org?.role === 'member')
      throw new InputError(
        'An owner or admin must connect the new project. Choose an existing saved connection or ask your admin for a project key.',
      );
    const api = await management(options, output),
      response = await api.request('regions');
    const regions = response.regions as {
      region: string;
      name: string;
      is_open: boolean;
      cloud_provider: string;
    }[];
    if (!Array.isArray(regions)) throw new InputError('Invalid region list.');
    const region = await choose(
      regions.filter((r) => r.cloud_provider === 'aws'),
      (r) => `${r.name} (${r.region})`,
      prompts,
      'Region',
      r => r.is_open ? 'Ready to deploy' : 'Additional regional setup · takes longer',
    );
    if (!region.is_open) output.diagnostic('This region needs additional deployment. Provisioning can take longer; you can return later to connect the created project.');
    const name = await prompts.text('Project name', undefined, value => /^[a-zA-Z0-9_-]{3,45}$/.test(value.trim())
      ? undefined : 'Use 3–45 letters, digits, underscores or hyphens.');
    output.diagnostic(
      `Create ${name ?? ''} in ${org?.name ?? 'your default Organization'} (${region.region}).`,
    );
    if (!(await prompts.confirm('Create this project?')))
      throw new InputError('No project was requested.');
    const created = await createProject(
      options,
      { orgId: org?.id, defaultOrg: !org, name: name ?? '', region: region.region },
      output,
    );
    project = created;
    if (!region.is_open && project.status !== 'ACTIVE') {
      throw new InputError(`Project ${project.name} (${project.id}) was created in ${region.region} and is provisioning. Rerun lambdadb init later, choose account-based project setup, and select this existing project. Do not create it again.`);
    }
    const deadline = Date.now() + 10 * 60_000;
    while (project.status !== 'ACTIVE' && Date.now() < deadline) {
      output.diagnostic(
        'Project is provisioning. Waiting; interruption is safe. Rerun init to select this project.',
      );
      await delay(5000, undefined, { signal: options.signal });
      const found = (await projects(options, created.organization_id, output)).find(
        (p) => p.id === created.id,
      );
      if (!found)
        throw new InputError('Created project was not listed. Check Console before creating another.');
      project = found;
    }
    if (project.status !== 'ACTIVE')
      throw new InputError(
        'Provisioning is still pending. Rerun init later, choose account-based project setup, and select the existing project.',
      );
    break;
  }
  if (project.status !== 'ACTIVE') {
    throw new InputError(`Project ${project.name} (${project.id}) is ${project.status} and is not ready to connect. Check Console and rerun init to select this existing project once it is ACTIVE. No project key was requested.`);
  }
  const a = await loadAccount(options),
    cache = await connections(options);
  const saved = cache.items.find(
    (c) =>
      c.account === `${a.apiUrl}/${a.memberId}` &&
      c.projectId === project.id &&
      c.org === project.organization_id,
  );
  let issue = !saved?.settings;
  if (saved?.settings) {
    try {
      await new CredentialVault().read({
        ...saved.settings,
        ...credentialReference(saved.settings.credentialStore, saved.settings.credentialId),
      });
    } catch {
      output.diagnostic(
        'The saved project credential is unavailable. Review its named key in Console before replacement.',
      );
      issue = true;
    }
  }
  if (issue) {
    if (org?.role === 'member')
      throw new InputError(
        'An owner or admin must issue this project key. Obtain a key from your admin for environment setup.',
      );
    if (saved?.pendingKeyName)
      output.diagnostic(
        `Inspect/revoke ${saved.pendingKeyName} in Console before replacing the uncertain connection.`,
      );
    if (
      !(await prompts.confirm('Create a project key with write access?'))
    )
      throw new InputError('No project key was requested.');
  }
  return useProject(options, project.organization_id, project.id, issue, output);
}
