import { spawn } from 'node:child_process';
import type { Config } from './config.js';
import { InputError } from './errors.js';

// Exact stdio package; this CLI only adapts credentials and process lifecycle.
export const mcpPackage = '@functional-systems/lambdadb-mcp@0.3.0';

export function mcpEnvironment(config: Config, writeTools: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LAMBDADB_BASE_URL: config.endpoint,
    LAMBDADB_PROJECT_NAME: config.project,
    LAMBDADB_PROJECT_API_KEY: config.apiKey,
    LAMBDADB_MCP_ENABLE_WRITE_TOOLS: String(writeTools),
  };
  // SDK versions before 0.11.1 coerced any non-empty LAMBDADB_DEBUG, including
  // 'false', to true and then logged requests with their API key header to stdout,
  // corrupting the MCP transport. Keep removing it so no pinned MCP can log keys.
  delete env.LAMBDADB_DEBUG;
  // npm exec exports these selectors to its child. They must not override the
  // separate MCP package and command supplied explicitly to the nested npx.
  for (const key of Object.keys(env)) {
    if (/^npm_config_(package|call)$/i.test(key)) delete env[key];
  }
  return env;
}

export async function serveMcp(config: Config, writeTools: boolean): Promise<number> {
  // Never emit CLI results on stdout: it belongs exclusively to the MCP transport.
  const child = spawn('npx', ['-y', mcpPackage], {
    env: mcpEnvironment(config, writeTools), stdio: 'inherit', detached: process.platform !== 'win32',
    // Windows needs the npm-provided .cmd launcher. Arguments contain no secrets.
    ...(process.platform === 'win32' ? { shell: true } : {}),
  });
  const forward = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* The child may already have exited. */ }
  };
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', () => reject(new InputError('Cannot start npx. Install Node.js/npm and make npx available on the agent PATH.')));
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)));
    });
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}
