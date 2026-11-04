import { cancel, intro, log, outro } from '@clack/prompts';
import { styleText } from 'node:util';
import type { Account } from './account.js';
import { cli } from './command.js';
import { defaultConfigPath } from './config.js';
import { describeError } from './errors.js';
import { wrapInfo } from './init-ui.js';
import type { Output } from './output.js';

/** Failures already reported inside an interactive frame; the CLI skips its plain report for them. */
export const reported = new WeakSet<object>();

const storeNames: Record<string, string> = {
  keychain: 'macOS Keychain',
  windows: 'Windows Credential Manager',
  'secret-service': 'Secret Service',
  keyutils: 'kernel keyring',
};

// Server-provided values can contain terminal control characters.
const text = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, ' '); // eslint-disable-line no-control-regex

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
    cancel(output.safeDiagnostic([safe.message, safe.hint].filter(Boolean).join(' ')), options);
    if (error && typeof error === 'object') reported.add(error);
    throw error;
  }
}

export function formatLogin(account: Account, config: string, interactive: boolean) {
  const store = storeNames[account.credentialStore] ?? account.credentialStore;
  const customConfig = config !== defaultConfigPath();
  if (interactive) {
    const row = (label: string, value: string) => `  ${styleText('dim', label.padEnd(8))} ${text(value)}`;
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
    `Signed in as ${text(account.email)} (${account.apiUrl}).`,
    `Session saved in ${store}; it ends after seven idle days.`,
    ...(customConfig ? [`Config: ${text(config)} (pass --config to later commands).`] : []),
    `Next: ${cli} init to connect a project and set up coding agents, or ${cli} orgs list to manage projects.`,
  ].join('\n');
}

export function formatLogout(outcome: { remoteRevoked: boolean; email?: string; apiUrl: string } | undefined) {
  const unchanged = 'Project keys and agent connections are unchanged.';
  if (!outcome) return `Not signed in. ${unchanged}`;
  const who = outcome.email ? `${text(outcome.email)} (${outcome.apiUrl})` : outcome.apiUrl;
  return outcome.remoteRevoked
    ? `Signed out of ${who}.\n${unchanged}`
    : `Signed out of ${who} on this computer. The server did not confirm revocation, so the login ends after seven idle days.\n${unchanged}`;
}
