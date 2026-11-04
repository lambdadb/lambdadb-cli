import { cancel, intro, log, outro } from '@clack/prompts';
import { styleText } from 'node:util';
import type { Account, Organization } from './account.js';
import { cli } from './command.js';
import { defaultConfigPath, type SelectedSettings } from './config.js';
import { describeError, unknownOutcome, unknownOutcomeSummary } from './errors.js';
import { listing, plain, storeName } from './human.js';
import { wrapInfo } from './init-ui.js';
import type { Output } from './output.js';
import type { Project } from './projects.js';

/** Failures already reported inside an interactive frame; the CLI skips its plain report for them. */
export const reported = new WeakSet<object>();


/** The framed layout is for a person at a terminal; JSON and redirected output stay plain. */
export const interactiveAccount = (output: Output) => !output.json && !!process.stderr.isTTY;

/** Runs an account step in the same frame as guided init and closes it with the outcome. */
export async function framed<T>(output: Output, action: (output: Output) => Promise<T>, done: (value: T) => string): Promise<T> {
  const options = { output: process.stderr };
  intro(styleText(['bold', 'cyan'], 'LambdaDB'), options);
  try {
    const value = await action(output.withDiagnostics(message => log.info(wrapInfo(message), options)));
    outro(output.safeDiagnostic(done(value)), options);
    return value;
  } catch (error) {
    const safe = describeError(error);
    const cause = output.safeDiagnostic([safe.message, safe.hint].filter(Boolean).join(' '));
    cancel(unknownOutcome(error) ? `${unknownOutcomeSummary}\n${cause}` : cause, options);
    if (error && typeof error === 'object') reported.add(error);
    throw error;
  }
}

export function formatLogin(account: Account, config: string, interactive: boolean) {
  const store = storeName(account.credentialStore);
  const customConfig = config !== defaultConfigPath();
  if (interactive) {
    const row = (label: string, value: string) => `  ${styleText('dim', label.padEnd(8))} ${plain(value)}`;
    return [
      row('Server', account.apiUrl),
      row('Session', `${store}, ends after 7 idle days`),
      ...(customConfig ? [row('Config', `${config} (pass --config to later commands)`)] : []),
      '',
      `  ${styleText('bold', 'Next')}`,
      `    ${cli} init        ${styleText('dim', 'Connect a project and set up coding agents')}`,
      `    ${cli} orgs list   ${styleText('dim', 'Manage organizations and projects')}`,
    ].join('\n');
  }
  return [
    `Signed in as ${plain(account.email)} (${account.apiUrl}).`,
    `Session saved in ${store}; it ends after seven idle days.`,
    ...(customConfig ? [`Config: ${plain(config)} (pass --config to later commands).`] : []),
    `Next: ${cli} init to connect a project and set up coding agents, or ${cli} orgs list to manage projects.`,
  ].join('\n');
}

export function formatLogout(outcome: { remoteRevoked: boolean; email?: string; apiUrl: string } | undefined) {
  const unchanged = 'Project keys and agent connections are unchanged.';
  if (!outcome) return `Not signed in. ${unchanged}`;
  const who = outcome.email ? `${plain(outcome.email)} (${outcome.apiUrl})` : outcome.apiUrl;
  return outcome.remoteRevoked
    ? `Signed out of ${who}.\n${unchanged}`
    : `Signed out of ${who} on this computer. The server did not confirm revocation, so the login ends after seven idle days.\n${unchanged}`;
}

export function formatOrganizations(organizations: Organization[]) {
  const next = organizations.length === 1 ? `${cli} projects list`
    : organizations.length ? `${cli} projects list --org-id <ID>` : undefined;
  return listing('Organizations', ['NAME', 'ROLE', 'PLAN', 'PROJECTS', 'ID'],
    organizations.map(o => [o.name, o.role, o.plan, `${o.projects_count} / ${o.max_projects}`, o.id]),
    'No active Organizations.', next);
}

export function formatProjects(projects: Project[], orgId: string | undefined) {
  const org = orgId ? `--org-id ${orgId} ` : '';
  return listing('Projects', ['NAME', 'STATUS', 'ID'], projects.map(p => [p.name, p.status, p.id]),
    'No projects yet.',
    projects.length ? `${cli} projects use ${org}--project-id <ID> --issue-key` : `${cli} projects regions, then ${cli} projects create`);
}

export function formatRegions(regions: { cloud_provider: string; region: string; name: string; is_open: boolean }[]) {
  return listing('Regions', ['REGION', 'NAME', 'CLOUD', 'AVAILABLE'],
    regions.map(r => [r.region, r.name, r.cloud_provider, r.is_open ? 'yes' : 'no']),
    'No regions are available.', `${cli} projects create --org-id <ID> --name <NAME> --region <REGION>`);
}

export function formatCreated(project: { id: string; organization_id: string; name: string; status: string }) {
  return [
    `Project ${plain(project.name)} requested (${plain(project.status)}). Creation does not establish search readiness.`,
    `Next: ${cli} projects list --org-id ${project.organization_id} until it is ACTIVE, then ${cli} projects use --org-id ${project.organization_id} --project-id ${project.id} --issue-key`,
  ].join('\n');
}

export function formatUse(selected: SelectedSettings, interactive: boolean) {
  const key = selected.credentialStore
    ? `${selected.credentialKeyName ? `${plain(selected.credentialKeyName)} in ` : ''}${storeName(selected.credentialStore)}`
    : `$${plain(selected.apiKeyEnv ?? 'LAMBDADB_API_KEY')}`;
  const agents = `Agents set up earlier keep their previous project; run ${cli} init to switch them.`;
  if (interactive) {
    const row = (label: string, value: string) => `  ${styleText('dim', label.padEnd(9))} ${value}`;
    return [
      row('Endpoint', plain(selected.endpoint)),
      row('Key', key),
      '',
      `  ${agents}`,
      '',
      `  ${styleText('bold', 'Next')}`,
      `    ${cli} doctor   ${styleText('dim', 'Check the connection')}`,
    ].join('\n');
  }
  return [`Using project ${plain(selected.project)} (${plain(selected.endpoint)}).`, `Key: ${key}.`, agents, `Next: ${cli} doctor to check the connection.`].join('\n');
}
