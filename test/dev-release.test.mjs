import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { developmentVersion, compareDevelopmentVersions, npmJson, publicationPlan, publishDevelopment } from '../scripts/dev-release.mjs';

const name = '@functional-systems/lambdadb-cli';
const version = '0.1.0-dev.12';
const sha = 'a'.repeat(40);
const integrity = 'sha512-test-artifact';
const artifact = { name, version, sha, integrity, tarball: '/tmp/tested-package.tgz' };
const manifest = { name, version, gitHead: sha, dist: { integrity } };
const state = { version, sha, integrity, branchHead: sha, taggedVersion: '0.1.0-dev.11' };

test('development numbering is deterministic and compares counters and release bases numerically', () => {
  assert.equal(developmentVersion('0.1.0-dev.1', '12'), version);
  assert.equal(developmentVersion(version, '12'), version);
  assert.equal(developmentVersion('0.2.0-dev.1', '13'), '0.2.0-dev.13');
  for (const bad of ['0.1.0', '0.1.0-rc.1', '0.1.0-dev.01']) assert.throws(() => developmentVersion(bad, 12));
  for (const bad of ['0', '-1', '01', '1.5', 'NaN']) assert.throws(() => developmentVersion(version, bad));
  assert.equal(compareDevelopmentVersions('0.1.0-dev.10', '0.1.0-dev.2'), 1);
  assert.equal(compareDevelopmentVersions('0.2.0-dev.1', '0.1.0-dev.999'), 1);
  assert.equal(compareDevelopmentVersions(version, version), 0);
  assert.throws(() => compareDevelopmentVersions('0.1.0', version));
});

test('only a structured npm E404 can be treated as an unpublished version', () => {
  const run = (status, value) => () => ({ status, stdout: JSON.stringify(value) });
  assert.equal(npmJson([], { allowMissing: true, run: run(1, { error: { code: 'E404' } }) }), undefined);
  assert.throws(() => npmJson([], { run: run(1, { error: { code: 'E404' } }) }));
  for (const code of ['E401', 'E403', 'E500', 'ENOTFOUND']) {
    assert.throws(() => npmJson([], { allowMissing: true, run: run(1, { error: { code } }) }));
  }
  assert.throws(() => npmJson([], { run: () => ({ status: 1, stdout: 'timeout' }) }));
  for (const bad of [null, [], 'unexpected', { error: { code: 'E404' } }]) {
    assert.throws(() => npmJson([], { run: run(0, bad) }));
  }
});

test('stale jobs cannot publish or move dev backward, and reruns verify commit and artifact', () => {
  assert.equal(publicationPlan({ ...state, branchHead: 'b'.repeat(40) }), 'stale');
  assert.equal(publicationPlan({ ...state, taggedVersion: '0.2.0-dev.1' }), 'superseded');
  assert.equal(publicationPlan(state), 'publish');
  assert.equal(publicationPlan({ ...state, existing: manifest, taggedVersion: version }), 'already-published');
  for (const different of [{ gitHead: 'b'.repeat(40) }, { dist: { integrity: 'different' } }, { version: '0.1.0-dev.1' }, { name: 'other' }]) {
    assert.throws(() => publicationPlan({ ...state, taggedVersion: version, existing: { ...manifest, ...different } }), /differs/);
  }
  assert.throws(() => publicationPlan({ ...state, taggedVersion: version }), /disagreement/);
  assert.throws(() => publicationPlan({ ...state, existing: manifest }), /points elsewhere/);
});

function registry({ publishFailure = false, lag = false, manifestDelayMs = 0, tagDelayMs = 0 } = {}) {
  let published = false;
  let elapsed = 0;
  const calls = [];
  const pauses = [], reports = [], timeouts = [];
  const run = (args, options) => {
    calls.push(args);
    timeouts.push(options?.timeoutMs);
    if (args[0] === 'publish') {
      published = true;
      return { status: publishFailure ? 1 : 0, stdout: '' };
    }
    const visible = published && !lag;
    if (args[2] === 'dist-tags') return { status: 0, stdout: JSON.stringify({ dev: visible && elapsed >= tagDelayMs ? version : '0.1.0-dev.11', latest: '0.0.1' }) };
    return visible && elapsed >= manifestDelayMs
      ? { status: 0, stdout: JSON.stringify(manifest) }
      : { status: 1, stdout: JSON.stringify({ error: { code: 'E404' } }) };
  };
  return { calls, run, timeouts, pauses, reports, head: () => sha, now: () => elapsed,
    advance: ms => { elapsed += ms; },
    pause: async ms => { pauses.push(ms); elapsed += ms; },
    report: message => reports.push(message),
  };
}

test('publishes the tested artifact once on dev and skips an identical rerun', async () => {
  const api = registry();
  assert.equal(await publishDevelopment(artifact, api), 'published');
  assert.equal(await publishDevelopment(artifact, api), 'already-published');
  assert.deepEqual(api.calls[0], ['view', `${name}@dev`, 'dist-tags', '--json'], 'Lookup must not require a latest release.');
  assert.deepEqual(api.calls.filter(args => args[0] === 'publish'), [
    ['publish', artifact.tarball, '--access', 'public', '--tag', 'dev', '--provenance'],
  ]);
});

test('publish failures and verification lag never retry the registry write', async () => {
  for (const options of [{ publishFailure: true }, { lag: true }]) {
    const api = registry(options);
    await assert.rejects(publishDevelopment(artifact, api));
    assert.equal(api.calls.filter(args => args[0] === 'publish').length, 1);
  }
  const stale = registry();
  stale.head = () => 'b'.repeat(40);
  assert.equal(await publishDevelopment(artifact, stale), 'stale');
  assert.equal(stale.calls.filter(args => args[0] === 'publish').length, 0);
  const missingPackage = registry();
  missingPackage.run = () => ({ status: 1, stdout: JSON.stringify({ error: { code: 'E404' } }) });
  await assert.rejects(publishDevelopment(artifact, missingPackage), /lookup failed/);
});

test('publication verification tolerates independently delayed metadata and dev tags beyond 25 seconds', async () => {
  for (const options of [{ manifestDelayMs: 150000 }, { tagDelayMs: 180000 }]) {
    const api = registry(options);
    assert.equal(await publishDevelopment(artifact, api), 'published');
    assert.ok(api.now() >= 150000);
    assert.equal(api.calls.filter(args => args[0] === 'publish').length, 1);
    const reads = api.calls.slice(3);
    assert.ok(reads.every(args => args.includes('--prefer-online') && args.includes('--fetch-retries=0') && args.includes('--fetch-timeout=15000')));
    assert.match(api.reports[0], /npm publish succeeded/);
  }
});

test('publication verification distinguishes five-minute propagation timeout from a failed write', async () => {
  const api = registry({ lag: true });
  await assert.rejects(publishDevelopment(artifact, api), error => {
    assert.equal(error.code, 'REGISTRY_VERIFICATION_PENDING');
    assert.match(error.message, /npm publish succeeded.*pending after 300 seconds/);
    return true;
  });
  assert.equal(api.now(), 300000);
  assert.equal(api.pauses.length, 30);
  assert.equal(api.calls.filter(args => args[0] === 'publish').length, 1);
});

test('publication verification includes read time, caps remaining I/O and sleep, and rejects a late success', async () => {
  const api = registry({ lag: true });
  const run = api.run;
  api.run = (args, options) => {
    const result = run(args, options);
    if (args.includes('--prefer-online')) api.advance(args[2] === 'dist-tags' ? 1000 : 294000);
    return result;
  };
  await assert.rejects(publishDevelopment(artifact, api), { code: 'REGISTRY_VERIFICATION_PENDING' });
  assert.equal(api.now(), 300000);
  assert.deepEqual(api.pauses, [5000]);
  assert.equal(api.timeouts.at(-1), 6000);
  assert.ok(api.calls.at(-1).includes('--fetch-timeout=6000'));

  const late = registry();
  const lateRun = late.run;
  late.run = (args, options) => {
    const result = lateRun(args, options);
    if (args.includes('--prefer-online')) late.advance(300000);
    return result;
  };
  await assert.rejects(publishDevelopment(artifact, late), { code: 'REGISTRY_VERIFICATION_PENDING' });
  assert.equal(late.calls.length, 4, 'A late manifest must not start a tag lookup.');
  assert.deepEqual(late.pauses, []);
});

test('only post-publication reads retry transient registry and subprocess failures', async () => {
  for (const failure of [
    { status: 1, stdout: JSON.stringify({ error: { code: 'E503' } }) },
    { status: 1, stdout: JSON.stringify({ error: { code: 'E429' } }) },
    { status: 1, stdout: JSON.stringify({ error: { code: 'ECONNRESET' } }) },
    { status: null, stdout: '', error: { code: 'ETIMEDOUT' } },
  ]) {
    const api = registry();
    const run = api.run;
    let failures = 0;
    api.run = (args, options) => {
      const result = run(args, options);
      if (args.includes('--prefer-online') && failures++ === 0) return failure;
      return result;
    };
    assert.equal(await publishDevelopment(artifact, api), 'published');
    assert.equal(api.now(), 10000);
    assert.equal(api.calls.filter(args => args[0] === 'publish').length, 1);
    const before = registry();
    before.run = args => { before.calls.push(args); return failure; };
    await assert.rejects(publishDevelopment(artifact, before), /lookup failed/);
    assert.equal(before.calls.filter(args => args[0] === 'publish').length, 0);
  }
});

test('post-publication authentication, schema and artifact failures remain fatal', async () => {
  for (const failure of [
    { status: 1, stdout: JSON.stringify({ error: { code: 'E401' } }) },
    { status: 1, stdout: JSON.stringify({ error: { code: 'E403' } }) },
    { status: 0, stdout: 'invalid JSON' },
    { status: 0, stdout: '[]' },
    { status: 0, stdout: JSON.stringify({ ...manifest, gitHead: 'other-commit' }) },
    { status: 0, stdout: JSON.stringify({ ...manifest, dist: { integrity: 'different' } }) },
  ]) {
    const api = registry({ tagDelayMs: 100000 });
    const run = api.run;
    api.run = (args, options) => {
      const result = run(args, options);
      return args.includes('--prefer-online') ? failure : result;
    };
    await assert.rejects(publishDevelopment(artifact, api), /npm publish succeeded, but registry verification failed/);
    assert.deepEqual(api.pauses, []);
    assert.equal(api.calls.filter(args => args[0] === 'publish').length, 1);
  }
  for (const dev of [123, 'not-a-development-version']) {
    const api = registry();
    const run = api.run;
    api.run = (args, options) => {
      const result = run(args, options);
      return args.includes('--prefer-online') && args[2] === 'dist-tags'
        ? { status: 0, stdout: JSON.stringify({ dev }) } : result;
    };
    await assert.rejects(publishDevelopment(artifact, api), /verification failed/);
    assert.deepEqual(api.pauses, []);
  }
});

test('missing post-publication tag metadata is retried without treating preflight as optional', async () => {
  const api = registry();
  const run = api.run;
  let missing = true;
  api.run = (args, options) => {
    const result = run(args, options);
    if (missing && args.includes('--prefer-online') && args[2] === 'dist-tags') {
      missing = false;
      return { status: 1, stdout: JSON.stringify({ error: { code: 'E404' } }) };
    }
    return result;
  };
  assert.equal(await publishDevelopment(artifact, api), 'published');
  assert.deepEqual(api.pauses, [10000]);
  assert.equal(api.calls.filter(args => args[0] === 'publish').length, 1);
});

test('preparation uses real Git history, updates both lock versions, and rejects stale or untrusted runs', t => {
  const temp = mkdtempSync(join(tmpdir(), 'cli-dev-release-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const remote = join(temp, 'remote.git'), repo = join(temp, 'repo');
  const runGit = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  runGit(temp, 'init', '--bare', remote);
  runGit(temp, 'clone', remote, repo);
  runGit(repo, 'checkout', '-b', 'develop');
  runGit(repo, 'config', 'user.name', 'Release test');
  runGit(repo, 'config', 'user.email', 'test@example.invalid');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  pkg.version = '0.1.0-dev.1';
  const lock = { name: pkg.name, version: pkg.version, packages: { '': { name: pkg.name, version: pkg.version } } };
  writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(repo, 'package-lock.json'), JSON.stringify(lock));
  runGit(repo, 'add', '.');
  runGit(repo, 'commit', '-m', 'initial');
  runGit(repo, 'commit', '--allow-empty', '-m', 'next');
  runGit(repo, 'push', 'origin', 'develop');
  const head = runGit(repo, 'rev-parse', 'HEAD');
  const script = resolve('scripts/dev-release.mjs');
  const env = { ...process.env, GITHUB_REPOSITORY: 'lambdadb/lambdadb-cli', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/develop', GITHUB_SHA: head, GITHUB_OUTPUT: join(temp, 'output') };
  const prepare = overrides => execFileSync(process.execPath, [script, 'prepare'], { cwd: repo, env: { ...env, ...overrides }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.throws(() => prepare({ GITHUB_EVENT_NAME: 'pull_request' }));
  assert.throws(() => prepare({ GITHUB_SHA: 'b'.repeat(40) }));
  assert.match(prepare(), /ready=true/);
  const prepared = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const preparedLock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8'));
  assert.equal(prepared.version, '0.1.0-dev.2');
  assert.equal(prepared.gitHead, head);
  assert.equal(preparedLock.version, prepared.version);
  assert.equal(preparedLock.packages[''].version, prepared.version);
  assert.equal(runGit(repo, 'rev-parse', 'HEAD'), head, 'preparation must not create commits');
  runGit(repo, 'commit', '--allow-empty', '-m', 'newer remote head');
  runGit(repo, 'push', 'origin', 'develop');
  runGit(repo, 'checkout', '--detach', head);
  const before = readFileSync(join(repo, 'package.json'), 'utf8');
  assert.match(prepare(), /ready=false/);
  assert.equal(readFileSync(join(repo, 'package.json'), 'utf8'), before);
});
