import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkMetadata } from '../scripts/check-release.mjs';

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
  for (const version of ['01.2.3', '1.2', '1.2.3-beta.1', '1.2.3-dev.01', '1.2.3+build']) {
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
