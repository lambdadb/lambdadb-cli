import { HTTPClient, LambdaDBClient, type ClientRequestOptions, type Fetcher } from '@functional-systems/lambdadb';
import type { Config } from './config.js';

export function runtime(config: Config, signal?: AbortSignal) {
  // A no-op logger still makes SDK 0.5.1 clone and drain request/response bodies.
  // Disable its environment-controlled logger before construction instead.
  delete process.env.LAMBDADB_DEBUG;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  if (signal?.aborted) interrupt();
  signal?.addEventListener('abort', interrupt, { once: true });
  // Keep the command deadline alive across sequential SDK requests and transfers.
  const deadline = setTimeout(() => controller.abort(new DOMException('Command deadline exceeded', 'TimeoutError')), config.timeoutMs);
  deadline.unref();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const options: ClientRequestOptions = {
    signal: controller.signal, timeoutMs: config.timeoutMs,
    retries: {
      strategy: 'backoff', retryConnectionErrors: true,
      backoff: { initialInterval: 200, maxInterval: 500, exponent: 1.5, maxElapsedTime: Math.min(2000, config.timeoutMs) },
    },
  };
  // Bind the command signal at fetch dispatch as well as in SDK options, instead
  // of relying only on the SDK's cloned Request signal chain.
  // Keep authenticated API and unauthenticated transfer clients separate.
  const fetcher: Fetcher = (input, init) => fetch(input, { ...init, signal: controller.signal });
  const client = new LambdaDBClient({
    baseUrl: config.endpoint, projectName: config.project, projectApiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    httpClient: new HTTPClient({ fetcher }),
    transferClient: new HTTPClient({ fetcher }),
  });
  return {
    client, options,
    close() {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', interrupt);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    },
  };
}

// Both doctor and init verify access without implying collection/query readiness.
export async function checkConnection(ctx: Pick<ReturnType<typeof runtime>, 'client' | 'options'>) {
  await ctx.client.listCollections({ size: 1 }, ctx.options);
  return { checks: [
    { name: 'configuration', status: 'passed' },
    { name: 'authentication_and_project_collection_list', status: 'passed' },
  ], writesVerified: false, queryReadinessVerified: false };
}
