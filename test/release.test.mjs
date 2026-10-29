import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkMetadata } from '../scripts/check-release.mjs';
import { latestStableTag, nextDevVersion, readVersion, setVersion } from '../scripts/version.mjs';

function fixture(version) {
  const pkg = { name: '@functional-systems/lambdadb-cli', version, private: false, license: 'MIT', repository: { url: 'git+https://github.com/lambdadb/lambdadb-cli.git' } };
  const lock = { name: pkg.name, version, packages: { '': { name: pkg.name, version } } };
  return { pkg, lock };
}

test('release validation maps canonical stable, dev and rc versions to separate channels', () => {
  for (const [version, channel] of [['1.2.3', 'latest'], ['0.1.0-dev.0', 'dev'], ['0.1.0-rc.2', 'rc']]) {
    const { pkg, lock } = fixture(version);
    assert.deepEqual(checkMetadata(pkg, lock, { tag: `v${version}`, prerelease: channel !== 'latest' }), { version, channel });
  }
});

test('release validation blocks drift, malformed versions, wrong tags, prerelease promotion and unprepared publication', () => {
  for (const version of ['01.2.3', '1.2', '1.2.3-beta.1', '1.2.3-dev.01', '1.2.3-rc.0', '1.2.3+build']) {
    const { pkg, lock } = fixture(version);
    assert.throws(() => checkMetadata(pkg, lock), /Version/);
  }
  for (const mutate of [
    f => { f.lock.version = '1.2.4'; },
    f => { f.lock.packages[''].version = '1.2.4'; },
    f => { f.pkg.repository.url = 'git+https://github.com/lambdadb/other.git'; },
    f => { f.pkg.private = true; },
    f => { delete f.pkg.license; },
  ]) {
    const f = fixture('1.2.3');
    mutate(f);
    assert.throws(() => checkMetadata(f.pkg, f.lock, { tag: 'v1.2.3', prerelease: false }));
  }
  const { pkg, lock } = fixture('1.2.3-rc.1');
  assert.throws(() => checkMetadata(pkg, lock, { tag: 'v1.2.3-rc.1', prerelease: false }), /prerelease/);
  assert.throws(() => checkMetadata(pkg, lock, { tag: 'v1.2.3', prerelease: true }), /tag/);
  pkg.private = true;
  assert.equal(checkMetadata(pkg, lock).channel, 'rc', 'private development remains valid');
});

function sources(t, version) {
  const root = mkdtempSync(join(tmpdir(), 'cli-version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = { ...JSON.parse(readFileSync('package.json', 'utf8')), version };
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  // Keep an npm-style lock with a dependency version that equals the package version.
  writeFileSync(join(root, 'package-lock.json'), `{\n  "name": "${pkg.name}",\n  "version": "${version}",\n  "lockfileVersion": 3,\n` +
    `  "packages": {\n    "": {\n      "name": "${pkg.name}",\n      "version": "${version}"\n    },\n` +
    `    "node_modules/example": {\n      "version": "${version}"\n    }\n  }\n}\n`);
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n');
  const read = () => ['package.json', 'package-lock.json'].map(path => readFileSync(join(root, path), 'utf8'));
  return { root, read };
}

test('the version script sets every source at once, preserving formatting and accepting only committed forms', t => {
  const f = sources(t, '0.1.7-dev.0');
  const [pkgBefore, lockBefore] = f.read();
  assert.equal(setVersion(f.root, '0.1.7-rc.1'), '0.1.7-rc.1');
  const [pkg, lock] = f.read();
  assert.equal(pkg, pkgBefore.replace('"version": "0.1.7-dev.0"', '"version": "0.1.7-rc.1"'));
  assert.equal(lock, lockBefore.replace('"version": "0.1.7-dev.0"', '"version": "0.1.7-rc.1"')
    .replace('"version": "0.1.7-dev.0"', '"version": "0.1.7-rc.1"'), 'Only the two root lock entries change.');
  assert.equal(readVersion(f.root), '0.1.7-rc.1');
  assert.equal(setVersion(f.root, '1.0.0'), '1.0.0');
  for (const version of ['0.1.7-dev.3', '0.1.7-dev', '0.1.7-beta.1', 'v0.1.7', '0.1.7-rc.0', '01.1.7']) {
    assert.throws(() => setVersion(f.root, version), /Unsupported version/);
  }
  assert.equal(readVersion(f.root), '1.0.0');
  writeFileSync(join(f.root, 'package.json'), f.read()[0].replace('"1.0.0"', '"1.0.1"'));
  assert.throws(() => readVersion(f.root), /must agree/);
  assert.throws(() => setVersion(f.root, '1.0.2'), /must agree/);

  const script = resolve('scripts/version.mjs');
  const cli = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: f.root, encoding: 'utf8' });
  assert.equal(cli('next-dev', '0.1.7-rc.2').stdout.trim(), '0.1.7-dev.0');
  assert.equal(cli('next-dev', '0.1.7').stdout.trim(), '0.1.8-dev.0');
  assert.equal(cli('next-dev', '0.1.7-dev.4').status, 1);
  assert.equal(cli('get').status, 1, 'Disagreeing sources fail the CLI.');
  assert.equal(cli('unknown').status, 1);
  assert.equal(nextDevVersion('1.9.9'), '1.9.10-dev.0');
  assert.equal(latestStableTag(['v0.1.10', 'v0.1.9', 'v0.2.0-rc.1', 'v0.1.11-dev.1', 'latest']), 'v0.1.10');
  assert.equal(latestStableTag(['v0.1.0-rc.1']), undefined);
});

test('the metadata check accepts only committed forms and verifies rc/stable commits as releases', t => {
  const run = (version, args = [], env = {}) => {
    const f = sources(t, version);
    const result = spawnSync(process.execPath, [resolve('scripts/check-release.mjs'), ...args], { cwd: f.root, encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: '', ...env } });
    return { root: f.root, status: result.status, stderr: result.stderr.trim() };
  };
  for (const version of ['0.1.7-dev.0', '0.1.7-rc.1', '0.1.7']) assert.equal(run(version).status, 0, version);
  assert.match(run('0.1.7-dev.3').stderr, /Committed version must be/);

  // Verification and Release runs require a dated changelog entry and reject dev versions.
  assert.match(run('0.1.7', ['--verify']).stderr, /dated changelog entry/);
  assert.match(run('0.1.7-dev.0', ['--verify']).stderr, /publish automatically from main pushes/);
  const dated = version => {
    const f = sources(t, version);
    writeFileSync(join(f.root, 'CHANGELOG.md'), `# Changelog\n\n## [${version}] - 2026-10-29\n`);
    return args => spawnSync(process.execPath, [resolve('scripts/check-release.mjs'), ...args], { cwd: f.root, encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: '', RELEASE_TAG: `v${version}`, RELEASE_PRERELEASE: String(version.includes('-')) } }).status;
  };
  for (const version of ['0.1.7-rc.1', '0.1.7']) {
    assert.equal(dated(version)(['--verify']), 0, version);
    assert.equal(dated(version)(['--release']), 0, version);
  }
  assert.equal(dated('0.1.7')(['--release', '--verify']), 1);
  assert.match(run('0.1.7', ['--release'], { RELEASE_TAG: 'v0.1.7', RELEASE_PRERELEASE: 'true' }).stderr, /prerelease/);
});
