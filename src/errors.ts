import { LambdaDBError, ResponseValidationError, SDKValidationError } from '@functional-systems/lambdadb/models/errors';

export class InputError extends Error {}

export type SafeError = { code: string; message: string; hint: string; httpStatus?: number };

// Never serialize SDK errors: they can contain credentials, response bodies and signed URLs.
export function describeError(error: unknown): SafeError {
  if (error instanceof InputError) {
    return { code: 'INPUT_ERROR', message: error.message, hint: 'Check --help and the input file or configuration.' };
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

export function isInputError(error: unknown): boolean {
  // SDKValidationError uses Symbol.hasInstance and also matches response validation errors.
  return error instanceof InputError || (error instanceof SDKValidationError && !(error instanceof ResponseValidationError));
}

export function definitelyRejected(error: unknown): boolean {
  return isInputError(error) || (error instanceof LambdaDBError
    && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 408);
}
