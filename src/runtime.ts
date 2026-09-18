import { LambdaDBClient, type ClientRequestOptions } from '@functional-systems/lambdadb';
import type { Config } from './config.js';

export function runtime(config: Config) {
  // A no-op logger still makes SDK 0.5.1 clone and drain request/response bodies.
  // Disable its environment-controlled logger before construction instead.
  delete process.env.LAMBDADB_DEBUG;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.timeoutMs)]);
  const options: ClientRequestOptions = {
    signal, timeoutMs: config.timeoutMs,
    retries: {
      strategy: 'backoff', retryConnectionErrors: true,
      backoff: { initialInterval: 200, maxInterval: 500, exponent: 1.5, maxElapsedTime: Math.min(2000, config.timeoutMs) },
    },
  };
  const client = new LambdaDBClient({
    baseUrl: config.endpoint, projectName: config.project, projectApiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
  });
  return {
    client, options,
    close() {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    },
  };
}
