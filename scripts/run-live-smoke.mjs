import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Stream the suite's output while keeping a copy for the summary check.
export function runSuite(command, args, options) {
  return new Promise(resolve => {
    let output = '';
    const child = spawnProcess(command, args, { ...options, stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
    child.on('error', error => resolve({ error, output }));
    child.on('close', (status, signal) => resolve({ status, signal, output }));
  });
}

// A skipped, todo or missing live test exits 0 under node --test; only a full pass counts.
export function checkSummary(output) {
  const count = name => {
    const match = [...output.matchAll(new RegExp(`^(?:#|ℹ) ${name} (\\d+)$`, 'gm'))].at(-1);
    return match ? Number(match[1]) : undefined;
  };
  const tests = count('tests');
  if (!(tests >= 1) || count('pass') !== tests || ['fail', 'cancelled', 'skipped', 'todo'].some(name => count(name) !== 0)) {
    throw new Error('Deployed live smoke did not run every live test to a pass');
  }
}

export async function runLiveSmoke(env, execute = execFileSync, spawn = runSuite, mask = console.log) {
  for (const name of ['LAMBDADB_BASE_URL', 'LAMBDADB_PROJECT_NAME', 'LAMBDADB_SMOKE_SECRET_ARN']) {
    if (!env[name]?.trim()) throw new Error(`Missing smoke configuration: ${name}`);
  }
  let key;
  try {
    key = execute('aws', ['secretsmanager', 'get-secret-value', '--region', 'ap-northeast-2',
      '--secret-id', env.LAMBDADB_SMOKE_SECRET_ARN, '--query', 'SecretString', '--output', 'text'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
  } catch {
    // Do not include AWS command output or credentials in errors.
    throw new Error('Unable to read the dedicated smoke project key from Secrets Manager');
  }
  if (!key || key === 'None' || /[\r\n]/.test(key)) throw new Error('Expected a single project API key in SecretString');
  // The mask command contains the key, so emit it only where GitHub Actions consumes it.
  if (env.GITHUB_ACTIONS === 'true') mask(`::add-mask::${key.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`);
  // Keep the key out of files, command arguments, and the rest of the publishing job.
  const result = await spawn('npm', ['run', 'test:live'], { env: {
    ...env,
    LAMBDADB_RUN_LIVE_TESTS: '1',
    LAMBDADB_ENDPOINT: env.LAMBDADB_BASE_URL,
    LAMBDADB_PROJECT: env.LAMBDADB_PROJECT_NAME,
    LAMBDADB_LIVE_CONFIRM_PROJECT: env.LAMBDADB_PROJECT_NAME,
    LAMBDADB_API_KEY: key,
  } });
  if (result.error || result.status !== 0) throw new Error('Deployed live smoke failed');
  checkSummary(result.output ?? '');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLiveSmoke(process.env).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
