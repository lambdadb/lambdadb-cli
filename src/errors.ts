import { CommanderError } from 'commander';
import { LambdaDBError, ResponseValidationError, SDKValidationError } from '@functional-systems/lambdadb/models/errors';
import { cli } from './command.js';

export class InputError extends Error {
  // An empty hint means the message already states the next step.
  constructor(message: string, public hint = 'Check --help and the input file or configuration.') { super(message); }
}
export class ManagementError extends Error {
  constructor(
    public code: string,
    public status: number | undefined,
    public details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

export type SafeError = { code: string; message: string; hint: string; httpStatus?: number; details?: Record<string, unknown> };

// Never serialize SDK errors: they can contain credentials, response bodies and signed URLs.
export function describeError(error: unknown): SafeError {
  if (error instanceof ManagementError) {
    let hint = 'Check Console before retrying a write. No automatic retry was made; inspect the named key if issuance was uncertain.';
    if (error.code === 'project_limit_reached' && error.details?.organization) {
      const organization = error.details.organization as { billing_url: string };
      hint = `Use an existing project, or review ${organization.billing_url}. Only the owner can activate billing. Recheck server limits afterwards.`;
    } else if (error.status === 401) {
      hint = `Run ${cli} login again. Project keys are unaffected.`;
    } else if (error.code === 'usage_request_failed') {
      hint = error.status === 404 ? 'This Backend does not support CLI usage yet; deploy the matching Backend version.'
        : error.status === 403 ? 'Verify Org/project membership. Pay-As-You-Go cost estimates require an owner or admin.'
        : 'Check Backend availability, the UTC month and Org/project IDs. Free exposes only the current quota window. No writes or automatic retries were made.';
    } else if (error.code === 'project_limit_reached') {
      hint = 'Use an existing project, or review the indicated Organization billing link. Only the owner can activate billing. Recheck server limits afterwards.';
    } else if (error.details?.invitation_id) {
      hint = `Respond to the pending invitation at ${error.details.invitation_url}, then rerun setup.`;
    }
    return {
      code: error.code.toUpperCase(),
      message: `Account management request failed: ${error.code}.`,
      httpStatus: error.status,
      details: error.details,
      hint,
    };
  }
  if (error instanceof InputError) {
    return { code: 'INPUT_ERROR', message: error.message, hint: error.hint };
  }
  if (error instanceof ResponseValidationError) {
    return { code: 'INVALID_RESPONSE', message: 'The API response does not match the SDK contract.', hint: 'Check SDK/API compatibility. A malformed write response does not prove the write failed.', httpStatus: error.statusCode };
  }
  if (error instanceof SDKValidationError) {
    return { code: 'INPUT_ERROR', message: 'The request does not match the SDK contract.', hint: 'Check field names, types, index settings and ref selection.' };
  }
  if (error instanceof LambdaDBError) {
    const status = error.statusCode;
    const hint = status === 401 || status === 403
      ? 'Verify the selected API-key environment variable and its access to this project.'
      : status === 404 ? 'Verify endpoint, project, collection and ref names.'
      : status === 409 ? 'Inspect the existing resource before choosing a different name.'
      : status === 429 ? 'Reduce load or retry later; a consistent-read overlay may exceed its limit.'
      : status === 413 ? 'Reduce the batch size or use bulk mode where supported.'
      : status >= 500 ? 'Check service availability. Inspect writes before retrying an uncertain mutation.'
      : 'Check the request against the public API contract and collection schema.';
    return { code: status === 401 || status === 403 ? 'AUTH_ERROR' : 'API_ERROR', message: `LambdaDB returned HTTP ${status}.`, httpStatus: status, hint };
  }
  return {
    code: 'REQUEST_FAILED',
    message: 'The operation could not be completed or its response could not be verified.',
    hint: 'Check endpoint, connectivity, timeout and SDK/API compatibility. Inspect writes before retrying.',
  };
}

// Commander names the missing flag or unknown word and may suggest a correction.
// Only unknown commands/options and invalid choices echo argv; clip an inline
// `--flag=value` so an unknown option never prints its value.
export function parseError(error: CommanderError, command: string): InputError {
  if (error.code === 'commander.help') return new InputError(`${cli} ${command} needs a subcommand.`, `Run ${cli} ${command} --help to list them.`);
  const detail = error.message.replace(/^error: /, '')
    .replace(/^unknown option '([^'=]*)=[^']*'/, "unknown option '$1'")
    .replace(/\n\(Did you mean (.+)\?\)$/, '. Did you mean $1?').trim();
  const message = detail ? detail.charAt(0).toUpperCase() + detail.slice(1) : 'Invalid or incomplete command';
  return new InputError(/[.?]$/.test(message) ? message : `${message}.`, `Run ${cli} --help or the command-specific --help.`);
}

export function isInputError(error: unknown): boolean {
  // SDKValidationError uses Symbol.hasInstance and also matches response validation errors.
  return error instanceof InputError || (error instanceof SDKValidationError && !(error instanceof ResponseValidationError));
}

export function definitelyRejected(error: unknown): boolean {
  return isInputError(error) || (error instanceof ManagementError && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 408 && error.code !== 'issuance_unconfirmed') || (error instanceof LambdaDBError
    && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 408);
}
