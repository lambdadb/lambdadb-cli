import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const temp = mkdtempSync(join(tmpdir(), 'lambdadb-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
try {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const supplied = process.argv[2];
  let tarball;
  if (supplied) tarball = resolve(supplied);
  else {
    const packed = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', temp], { encoding: 'utf8' }));
    tarball = join(temp, packed[0].filename);
  }
  // Verify the actual artifact, including when supplied by the publish workflow.
  const inventory = JSON.parse(execFileSync(npm, ['pack', tarball, '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }))[0];
  assert.equal(inventory.name, pkg.name);
  assert.equal(inventory.version, pkg.version);
  assert.ok(inventory.files.some(file => file.path === 'dist/cli.js'));
  for (const file of inventory.files) {
    assert.ok(!/(^|\/)(\.env(?:\..*)?|\.github|test|node_modules|scripts)(\/|$)/.test(file.path), `Unexpected package file: ${file.path}`);
  }
  const consumer = join(temp, 'consumer');
  execFileSync(npm, ['install', '--prefix', consumer, '--no-audit', '--no-fund', tarball], { stdio: 'inherit' });
  const bin = join(consumer, 'node_modules', pkg.name, 'dist/cli.js');
  if (process.platform !== 'win32') {
    const executable = join(consumer, 'node_modules', '.bin', 'lambdadb');
    assert.equal(execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(), pkg.version);
    assert.match(execFileSync(executable, ['--help'], { encoding: 'utf8' }), /Usage: lambdadb/);
  }
  assert.equal(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim(), pkg.version);
  assert.match(execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' }), /Usage: lambdadb/);
  execFileSync(process.execPath, ['--test', 'test/cli.test.mjs'], {
    stdio: 'inherit', env: { ...process.env, LAMBDADB_TEST_CLI: bin },
  });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
