import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = readFileSync(new URL('../.github/workflows/publish.yaml', import.meta.url), 'utf8');
const homebrew = readFileSync(new URL('../.github/workflows/homebrew.yaml', import.meta.url), 'utf8');
const nextDev = readFileSync(new URL('../.github/workflows/next-dev-version.yaml', import.meta.url), 'utf8');
const step = name => workflow.match(new RegExp(`- name: ${name}\\n([\\s\\S]*?)\\n {6}- name:`))?.[1] ?? '';
const modeScript = step('Select the run mode').match(/run: \|\n([\s\S]*)$/)[1].replace(/^ {10}/gm, '');
const nextDevScript = nextDev.match(/run: \|\n([\s\S]*)$/)[1].replace(/^ {10}/gm, '');

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
  assert.doesNotMatch(workflow + homebrew + nextDev, /\bdevelop\b/);
  assert.ok(workflow.includes("(github.event_name == 'push' && github.ref == 'refs/heads/main'))"));
  assert.ok(workflow.includes("group: npm-${{ github.event_name == 'release' && github.event.release.tag_name || 'main' }}"));
});

test('the run mode follows the committed version on main pushes', t => {
  const { directory, bin } = stubs(t, { node: 'echo "$COMMITTED_VERSION"' });
  const run = (event, version) => {
    const output = join(directory, 'output');
    rmSync(output, { force: true });
    const result = spawnSync('bash', ['-e', '-c', modeScript], { encoding: 'utf8', env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output, PUBLISH_EVENT: event, COMMITTED_VERSION: version,
    } });
    return result.status === 0 ? readFileSync(output, 'utf8').trim() : `failed: ${result.stderr.trim()}`;
  };
  assert.equal(run('push', '0.1.7-dev.0'), 'mode=dev');
  assert.equal(run('push', '0.1.7-rc.1'), 'mode=verify');
  assert.equal(run('push', '0.1.7'), 'mode=verify');
  for (const version of ['0.1.7-dev.3', '0.1.7-dev.10']) assert.match(run('push', version), /failed: .*-dev\.0 placeholder/);
  assert.equal(run('release', '0.1.7'), 'mode=release');
});

test('each mode runs its own checks, and only dev and release modes publish', () => {
  assert.match(step('Prepare deterministic development version'), /if: steps\.mode\.outputs\.mode == 'dev'\n.*\n\s+run: node scripts\/dev-release\.mjs prepare/);
  assert.match(step('Verify committed release metadata without publishing'), /if: steps\.mode\.outputs\.mode == 'verify'\n\s+run: node scripts\/check-release\.mjs --verify$/);
  const release = step('Verify explicit release metadata and main ancestry');
  assert.match(release, /if: steps\.mode\.outputs\.mode == 'release'/);
  assert.match(release, /git merge-base --is-ancestor HEAD origin\/main\n\s+node scripts\/check-release\.mjs --release/);
  assert.match(step('Pack once and test the exact publication artifact'),
    /if: steps\.mode\.outputs\.mode != 'dev' \|\| steps\.dev\.outputs\.ready == 'true'[\s\S]*npm run test:package -- "\$CLI_TARBALL"/);
  assert.match(step('Publish development version and verify registry state'),
    /steps\.mode\.outputs\.mode == 'dev' && steps\.dev\.outputs\.ready == 'true' &&\n\s+vars\.NPM_DEV_PUBLISH_ENABLED == 'true'\n[\s\S]*run: node scripts\/dev-release\.mjs publish$/);
  const releasePublish = workflow.match(/- name: Publish explicit release using npm Trusted Publishing\n([\s\S]*)$/)[1];
  assert.match(releasePublish, /if: steps\.mode\.outputs\.mode == 'release'\n[\s\S]*npm publish "\$CLI_TARBALL" --access public --tag "\$NPM_CHANNEL" --provenance/);
  assert.equal(workflow.match(/npm publish|dev-release\.mjs publish/g).length, 2, 'No other step publishes.');
});

test('the next development version workflow runs only after a successful Release publication', () => {
  assert.match(nextDev, /workflow_run:\n\s+workflows: \["CI"\]\n\s+types: \[completed\]/);
  assert.ok(nextDev.includes("github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'release'"));
  assert.match(nextDev, /node scripts\/version\.mjs next-dev "\$RELEASED"/);
  assert.match(nextDev, /node scripts\/version\.mjs set "\$NEXT"/);
  assert.match(nextDev, /gh pr create --base main/);
  assert.match(nextDev, /gh workflow run publish\.yaml --ref "\$BRANCH"/);
  assert.match(workflow, /^name: CI$/m);
});

test('the next development version workflow completes a partial setup on rerun', t => {
  const { directory, bin } = stubs(t, {
    node: 'case "$2" in get) echo "$CURRENT";; next-dev) echo "$NEXT_VERSION";; set) echo "set $3" >> "$CALLS";; esac',
    git: 'if [ "$1" = ls-remote ]; then [ "$5" = "$EXISTING_BRANCH" ]; exit; fi\necho "git $*" | sed "s/ -c [^ ]*//g" >> "$CALLS"',
    gh: 'if [ "$2" = list ]; then [ "$4" = "$PR_BRANCH" ] && echo "$PR_STATE"; exit 0; fi\necho "gh $1 $2" >> "$CALLS"',
  });
  const calls = join(directory, 'calls');
  const run = ({ tag = 'v0.1.7', current = tag.slice(1), next = '0.1.8-dev.0', branch = '', pr = '', prBranch = branch } = {}) => {
    rmSync(calls, { force: true });
    const result = spawnSync('bash', ['-e', '-c', nextDevScript], { encoding: 'utf8', env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, RELEASE_TAG: tag, CURRENT: current, NEXT_VERSION: next,
      EXISTING_BRANCH: branch, PR_BRANCH: prBranch, PR_STATE: pr,
    } });
    assert.equal(result.status, 0, result.stderr);
    let log = '';
    try { log = readFileSync(calls, 'utf8'); } catch { /* no calls */ }
    return log.trim().split('\n').filter(Boolean).map(line => line.split(' ').slice(0, 2).join(' ') +
      (line.startsWith('git push') ? ` ${line.split(' ').at(-1)}` : ''));
  };
  const branch = 'chore/next-dev-after-v0.1.7';
  assert.deepEqual(run(), ['set 0.1.8-dev.0', 'git switch', 'git commit', `git push ${branch}`, 'gh pr', 'gh workflow']);
  assert.deepEqual(run({ branch }), ['gh pr', 'gh workflow'], 'An existing branch without a PR gets one.');
  assert.deepEqual(run({ branch, pr: 'OPEN' }), ['gh workflow'], 'An open PR gets its CI dispatched again.');
  assert.deepEqual(run({ branch, pr: 'MERGED' }), []);
  assert.deepEqual(run({ current: '0.1.8-dev.0' }), [], 'Nothing happens once main has moved on.');

  // Consecutive RCs restore the same version; the earlier RC's merged PR must not stop the next one.
  const rc2 = run({ tag: 'v0.2.0-rc.2', next: '0.2.0-dev.0', branch: 'chore/next-dev-after-v0.2.0-rc.1',
    pr: 'MERGED' });
  assert.deepEqual(rc2, ['set 0.2.0-dev.0', 'git switch', 'git commit', 'git push chore/next-dev-after-v0.2.0-rc.2', 'gh pr', 'gh workflow']);
  assert.match(nextDev, /BRANCH="chore\/next-dev-after-\$RELEASE_TAG"/);
});
