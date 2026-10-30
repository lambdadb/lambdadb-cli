import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = readFileSync(new URL('../.github/workflows/publish.yaml', import.meta.url), 'utf8');
const homebrew = readFileSync(new URL('../.github/workflows/homebrew.yaml', import.meta.url), 'utf8');
// A step ends at the next step or at the next job.
const step = name => workflow.match(new RegExp(`- name: ${name}\\n([\\s\\S]*?)\\n(?: {6}- name:|\\n {2}\\S)`))?.[1] ?? '';
const modeScript = step('Select the run mode').match(/run: \|\n([\s\S]*)$/)[1].replace(/^ {10}/gm, '');

function stubs(t, scripts) {
  const directory = mkdtempSync(join(tmpdir(), 'cli-release-stub-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return { directory, bin };
}

test('CI and publication run for main only; Homebrew checks run for PRs into main', () => {
  assert.match(workflow, /on:\n {2}pull_request:\n {4}branches: \[main\]\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n {2}release:\n {4}types: \[published\]\n/);
  assert.match(homebrew, /on:\n {2}pull_request:\n {4}branches: \[main\]\n/);
  assert.doesNotMatch(workflow + homebrew, /\bdevelop\b/);
  assert.ok(workflow.includes("(github.event_name == 'push' && github.ref == 'refs/heads/main'))"));
  assert.ok(workflow.includes("group: npm-${{ github.event_name == 'release' && github.event.release.tag_name || 'main' }}"));
});

test('the run mode follows whether origin already has the committed version tag', t => {
  const { directory, bin } = stubs(t, { node: 'echo "$COMMITTED_VERSION"' });
  // A real origin with tags; the checkout itself has none, so only origin can classify the commit.
  const runGit = (cwd, ...args) => execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const remote = join(directory, 'remote.git'), source = join(directory, 'source'), checkout = join(directory, 'checkout');
  runGit(directory, 'init', '--bare', remote);
  runGit(directory, 'init', source);
  runGit(source, '-c', 'user.name=Release test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
  for (const tag of ['v0.1.6', 'v0.2.0-rc.1']) runGit(source, 'tag', tag);
  runGit(source, 'push', remote, 'HEAD:refs/heads/main', '--tags');
  runGit(directory, 'clone', '--no-tags', remote, checkout);
  assert.equal(runGit(checkout, 'tag', '--list').trim(), '');
  const run = (event, version, cwd = checkout) => {
    const output = join(directory, 'output');
    rmSync(output, { force: true });
    const result = spawnSync('bash', ['-e', '-c', modeScript], { cwd, encoding: 'utf8', env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output, PUBLISH_EVENT: event, COMMITTED_VERSION: version,
    } });
    return result.status === 0 ? readFileSync(output, 'utf8').trim() : `failed: ${result.stderr.trim()}`;
  };
  // Tagged versions build dev versions against the dev environment, everything else against production.
  assert.equal(run('push', '0.1.6'), 'mode=dev\nsmoke_prefix=LAMBDADB_DEV_\nenvironment=dev');
  assert.equal(run('push', '0.2.0-rc.1'), 'mode=dev\nsmoke_prefix=LAMBDADB_DEV_\nenvironment=dev');
  assert.equal(run('push', '0.2.0-rc.2'), 'mode=verify\nsmoke_prefix=LAMBDADB_PROD_\nenvironment=prod');
  assert.equal(run('push', '0.2.0'), 'mode=verify\nsmoke_prefix=LAMBDADB_PROD_\nenvironment=prod');
  for (const version of ['0.1.7-dev.0', '0.1.7-dev.3']) assert.match(run('push', version), /failed: .*must be an rc or stable version/);
  const offline = join(directory, 'offline');
  runGit(directory, 'init', offline);
  runGit(offline, 'remote', 'add', 'origin', join(directory, 'missing.git'));
  assert.match(run('push', '0.1.6', offline), /failed: [\s\S]*Could not query origin for tag v0\.1\.6/);
  assert.equal(run('release', '0.2.0-rc.1'), 'mode=release\nsmoke_prefix=LAMBDADB_PROD_\nenvironment=prod');
  assert.equal(run('release', '0.2.0'), 'mode=release\nsmoke_prefix=LAMBDADB_PROD_\nenvironment=prod');
});

test('every publishing mode runs the deployed live smoke on the packed artifact before publication', () => {
  const names = [...workflow.matchAll(/^ {6}- name: (.+)$/gm)].map(match => match[1]);
  const smoke = 'Run deployed live smoke tests against the exact publication artifact';
  assert.deepEqual(names.slice(names.indexOf('Pack once and test the exact publication artifact') + 1),
    [smoke, 'Publish development version and verify registry state', 'Publish explicit release using npm Trusted Publishing']);
  assert.ok(step(smoke).startsWith("        if: needs.mode.outputs.mode != 'dev' || steps.dev.outputs.ready == 'true'\n"));
  // Selected Variables have no fallback; a missing one stays empty and fails the run.
  for (const name of ['BASE_URL', 'PROJECT_NAME']) {
    assert.ok(step(smoke).includes(`LAMBDADB_${name}: \${{ vars[format('{0}${name}', needs.mode.outputs.smoke_prefix)] }}\n`), name);
  }
  assert.match(step(smoke), /npm install --prefix "\$RUNNER_TEMP\/smoke" --no-audit --no-fund "\$CLI_TARBALL"/);
  assert.match(step(smoke), /LAMBDADB_TEST_CLI="\$RUNNER_TEMP\/smoke\/node_modules\/@functional-systems\/lambdadb-cli\/dist\/cli\.js" \\\n\s+node scripts\/run-live-smoke\.mjs$/);
  // Pull requests, the Node matrix and the mode selection get no credentials.
  const unprivileged = workflow.slice(workflow.indexOf('\n  validate:\n'), workflow.indexOf('\n  publish:\n'));
  assert.doesNotMatch(unprivileged, /id-token|vars\.|secrets\.|\n {4}environment:|run-live-smoke/);
});

test('the smoke key comes only from the GitHub Environment the run mode selects', () => {
  assert.match(workflow, /\n {2}mode:\n {4}needs: validate\n/);
  assert.match(workflow, /\n {2}publish:\n {4}needs: \[validate, mode\]\n[\s\S]*?\n {4}environment: \$\{\{ needs\.mode\.outputs\.environment \}\}\n/);
  assert.equal(workflow.match(/\n {4}environment:/g).length, 1);
  assert.equal(workflow.match(/secrets\./g).length, 1);
  assert.ok(step('Run deployed live smoke tests against the exact publication artifact')
    .includes('LAMBDADB_PROJECT_API_KEY: ${{ secrets.LAMBDADB_PROJECT_API_KEY }}\n'));
  assert.doesNotMatch(workflow, /SMOKE_SECRET_ARN|SMOKE_AWS_ROLE_ARN|aws-actions|configure-aws-credentials|LAMBDADB_API_KEY/);
  // Only the publishing job receives an OIDC token, for npm Trusted Publishing.
  assert.equal(workflow.match(/id-token: write/g).length, 1);
  assert.match(workflow, /\n {4}permissions:\n {6}contents: read\n {6}# npm Trusted Publishing and provenance\.\n {6}id-token: write\n/);
});

test('each mode runs its own checks, and only dev and release modes publish', () => {
  assert.match(step('Prepare deterministic development version'), /if: needs\.mode\.outputs\.mode == 'dev'\n.*\n\s+run: node scripts\/dev-release\.mjs prepare/);
  assert.match(step('Verify committed release metadata without publishing'), /if: needs\.mode\.outputs\.mode == 'verify'\n\s+run: node scripts\/check-release\.mjs --verify$/);
  const release = step('Verify explicit release metadata and main ancestry');
  assert.match(release, /if: needs\.mode\.outputs\.mode == 'release'/);
  assert.match(release, /git merge-base --is-ancestor HEAD origin\/main\n\s+node scripts\/check-release\.mjs --release/);
  assert.match(step('Pack once and test the exact publication artifact'),
    /if: needs\.mode\.outputs\.mode != 'dev' \|\| steps\.dev\.outputs\.ready == 'true'[\s\S]*npm run test:package -- "\$CLI_TARBALL"/);
  assert.match(step('Publish development version and verify registry state'),
    /needs\.mode\.outputs\.mode == 'dev' && steps\.dev\.outputs\.ready == 'true' &&\n\s+vars\.NPM_DEV_PUBLISH_ENABLED == 'true'\n[\s\S]*run: node scripts\/dev-release\.mjs publish$/);
  const releasePublish = workflow.match(/- name: Publish explicit release using npm Trusted Publishing\n([\s\S]*)$/)[1];
  assert.match(releasePublish, /if: needs\.mode\.outputs\.mode == 'release'\n[\s\S]*npm publish "\$CLI_TARBALL" --access public --tag "\$NPM_CHANNEL" --provenance/);
  assert.equal(workflow.match(/npm publish|dev-release\.mjs publish/g).length, 2, 'No other step publishes.');
});

test('no workflow writes a development version back to main', () => {
  assert.equal(existsSync(new URL('../.github/workflows/next-dev-version.yaml', import.meta.url)), false);
  assert.match(workflow, /^name: CI$/m);
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write|git push|gh pr/);
});
