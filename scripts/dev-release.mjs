import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { checkMetadata } from './check-release.mjs';

const packageName = '@functional-systems/lambdadb-cli';
const registry = 'https://registry.npmjs.org';
const devPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev\.(0|[1-9]\d*)$/;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const npm = (args, { timeoutMs = 120000 } = {}) => spawnSync('npm', [...args, `--registry=${registry}`], { encoding: 'utf8', timeout: timeoutMs });
const verificationTimeoutMs = 300000;

function lookupError(code) {
  const error = new Error('npm registry lookup failed; check registry availability and access.');
  error.retryable = ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)
    || (typeof code === 'string' && /^E(?:429|5\d\d)$/.test(code));
  return error;
}

export function developmentVersion(version, count) {
  const match = devPattern.exec(version);
  if (!match || !/^[1-9]\d*$/.test(String(count))) throw new Error('Develop requires X.Y.Z-dev.N and a positive first-parent commit count.');
  return `${match[1]}.${match[2]}.${match[3]}-dev.${count}`;
}

export function compareDevelopmentVersions(left, right) {
  const parts = version => {
    const match = devPattern.exec(version);
    if (!match) throw new Error('Invalid development version.');
    return match.slice(1).map(BigInt);
  };
  const a = parts(left), b = parts(right);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

// Only a structured npm E404 may mean that a version has not been published.
// Fail closed before publishing; only post-publication reads retry transient errors.
export function npmJson(args, { allowMissing = false, run = npm, timeoutMs = 120000 } = {}) {
  const result = run([...args, '--json'], { timeoutMs });
  if (result.error) throw lookupError(result.error.code);
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error('npm returned invalid JSON.'); }
  if (result.status !== 0) {
    if (allowMissing && value?.error?.code === 'E404') return undefined;
    throw lookupError(value?.error?.code);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.error) throw new Error('Unexpected npm registry response.');
  return value;
}

export function publicationPlan({ version, sha, branchHead, existing, taggedVersion, integrity }) {
  if (sha !== branchHead) return 'stale';
  if (taggedVersion && compareDevelopmentVersions(taggedVersion, version) > 0) return 'superseded';
  if (!existing) {
    if (taggedVersion === version) throw new Error('Registry tag/version disagreement; retry registry reads later.');
    return 'publish';
  }
  if (existing.name !== packageName || existing.version !== version || existing.gitHead !== sha || existing.dist?.integrity !== integrity) {
    throw new Error('Published version differs from this source/artifact; never overwrite it.');
  }
  if (taggedVersion !== version) throw new Error('Existing artifact is verified but dev points elsewhere; inspect registry state before changing tags.');
  return 'already-published';
}

function developHead() {
  const result = git('ls-remote', 'origin', 'refs/heads/develop');
  const match = /^([a-f0-9]{40})\s+refs\/heads\/develop$/.exec(result);
  if (!match) throw new Error('Cannot resolve origin/develop.');
  return match[1];
}

function context() {
  if (process.env.GITHUB_REPOSITORY !== 'lambdadb/lambdadb-cli' || process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/develop') {
    throw new Error('Automatic development publication only runs on this repository’s develop push.');
  }
  const sha = git('rev-parse', 'HEAD');
  if (sha !== process.env.GITHUB_SHA) throw new Error('Checkout does not match the triggering commit.');
  return sha;
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(`${name}=${value}`);
}

function prepare() {
  const sha = context();
  if (sha !== developHead()) { output('ready', 'false'); return; }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  checkMetadata(pkg, lock);
  if (pkg.name !== packageName) throw new Error('Unexpected package name.');
  const version = developmentVersion(pkg.version, git('rev-list', '--first-parent', '--count', 'HEAD'));
  pkg.version = lock.version = lock.packages[''].version = version;
  pkg.gitHead = sha;
  checkMetadata(pkg, lock, { tag: `v${version}`, prerelease: true });
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
  output('version', version);
  output('ready', 'true');
}

export async function publishDevelopment({ name, version, sha, integrity, tarball }, {
  run = npm, head = developHead, pause = delay, now = () => performance.now(), report = message => console.error(message),
} = {}) {
  if (name !== packageName) throw new Error('Unexpected package name.');
  // Select dev explicitly; bootstrap can also create latest without a stable release.
  const tags = () => npmJson(['view', `${name}@dev`, 'dist-tags'], { run });
  const manifest = () => npmJson(['view', `${name}@${version}`], { run, allowMissing: true });
  const taggedVersion = tags().dev; // Missing package is a failed bootstrap prerequisite.
  if (taggedVersion !== undefined && typeof taggedVersion !== 'string') throw new Error('Invalid dev tag.');
  const existing = manifest();
  const plan = publicationPlan({ version, sha, integrity, existing, taggedVersion, branchHead: head() });
  if (plan !== 'publish') return plan;
  const result = run(['publish', tarball, '--access', 'public', '--tag', 'dev', '--provenance']);
  if (result.status !== 0) throw new Error('npm publish did not confirm success. Inspect registry state and rerun; this job never retries the write.');
  // One write, then bounded reads. Include subprocess time in the monotonic budget.
  const deadline = now() + verificationTimeoutMs;
  const remaining = () => Math.floor(deadline - now());
  const read = args => {
    const timeoutMs = Math.min(15000, remaining());
    if (timeoutMs <= 0) return undefined;
    return npmJson([...args, '--prefer-online', '--fetch-retries=0', `--fetch-timeout=${timeoutMs}`], { run, allowMissing: true, timeoutMs });
  };
  report(`npm publish succeeded for ${name}@${version}; verifying registry metadata for up to 300 seconds.`);
  while (remaining() > 0) {
    let observation = 'metadata or dev tag has not propagated';
    try {
      const published = read(['view', `${name}@${version}`]);
      if (remaining() <= 0) break;
      // Validate visible artifacts immediately, even while the tag is still stale.
      if (published) publicationPlan({ version, sha, integrity, existing: published, taggedVersion: version, branchHead: sha });
      const currentTags = read(['view', `${name}@dev`, 'dist-tags']);
      if (remaining() <= 0) break;
      if (currentTags?.dev !== undefined && typeof currentTags.dev !== 'string') throw new Error('Invalid dev tag.');
      if (currentTags?.dev !== undefined) compareDevelopmentVersions(currentTags.dev, version);
      if (published && currentTags?.dev === version && remaining() > 0) return 'published';
    } catch (error) {
      if (!error.retryable) throw new Error(`npm publish succeeded, but registry verification failed: ${error.message}`, { cause: error });
      observation = 'temporary registry lookup failure';
    }
    if (remaining() <= 0) break;
    report(`Publication accepted; ${observation}. Retrying reads (${Math.ceil(remaining() / 1000)} seconds remaining).`);
    const sleepMs = Math.min(10000, remaining());
    if (sleepMs <= 0) break;
    await pause(sleepMs);
  }
  const error = new Error('npm publish succeeded, but registry verification is still pending after 300 seconds. Retry registry reads before rerunning this job; do not republish.');
  error.code = 'REGISTRY_VERIFICATION_PENDING';
  throw error;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/dev-release.mjs prepare|publish');
    if (process.argv[2] === 'prepare') prepare();
    else if (process.argv[2] === 'publish') {
      const sha = context();
      const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
      if (pkg.gitHead !== sha) throw new Error('Development metadata must be prepared for this commit.');
      const tarball = process.env.CLI_TARBALL;
      const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
      const result = await publishDevelopment({ name: pkg.name, version: pkg.version, sha, tarball, integrity });
      output('result', result);
    } else throw new Error('Usage: node scripts/dev-release.mjs prepare|publish');
  } catch (error) {
    if (error.code === 'REGISTRY_VERIFICATION_PENDING') output('result', 'published-verification-pending');
    console.error(error.message);
    process.exitCode = 1;
  }
}
