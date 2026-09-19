#!/usr/bin/env bash
set -euo pipefail

# Test the checked-in formula in a disposable local tap, never an existing CLI install.
repo_dir=$(cd "$(dirname "$0")/.." && pwd -P)
if ! command -v brew >/dev/null; then
  echo "Homebrew is required; install it before running this test." >&2
  exit 1
fi
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_INSTALL_UPGRADE=1
export HOMEBREW_NO_INSTALL_CLEANUP=1
export HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1
export HOMEBREW_NO_ANALYTICS=1
export HOMEBREW_NO_AUTOREMOVE=1
export HOMEBREW_DEVELOPER=1

brew_prefix=$(brew --prefix)
if brew list --versions lambdadb-cli >/dev/null 2>&1 || [[ -e "$brew_prefix/bin/lambdadb" || -L "$brew_prefix/bin/lambdadb" ]]; then
  echo "An existing Homebrew CLI or prefix executable must be preserved; use a clean runner for this test." >&2
  exit 1
fi
test_dir=$(mktemp -d)
test_dir=$(cd "$test_dir" && pwd -P)
tap="lambdadb/cli-test-$$"
formula="$tap/lambdadb-cli"
tap_added=0
install_attempted=0
cleanup() {
  status=$?
  trap - EXIT
  if [[ "$install_attempted" == 1 ]] && brew list --versions "$formula" >/dev/null 2>&1; then
    brew uninstall --formula "$formula" || status=1
  fi
  if [[ "$tap_added" == 1 ]]; then
    brew untap "$tap" || status=1
  fi
  rm -rf "$test_dir"
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$test_dir/tap/Formula"
cp "$repo_dir/packaging/homebrew/Formula/lambdadb-cli.rb" "$test_dir/tap/Formula/"
git -C "$test_dir/tap" init -q
git -C "$test_dir/tap" add Formula
git -C "$test_dir/tap" -c user.name='CLI installation test' -c user.email='cli-test@example.invalid' \
  -c commit.gpgsign=false commit -qm 'Local formula fixture'
brew tap "$tap" "$test_dir/tap"
tap_added=1
brew style --formula "$formula"
install_attempted=1
brew install --formula --build-from-source "$formula"
brew test "$formula"

cli_prefix=$(brew --prefix "$formula")
runtime="$(brew --prefix node@24)/bin/node"
mkdir -p "$test_dir/fake-bin"
printf '#!/bin/sh\necho "Unexpected ambient Node executable" >&2\nexit 97\n' > "$test_dir/fake-bin/node"
chmod +x "$test_dir/fake-bin/node"
env PATH="$test_dir/fake-bin:/usr/bin:/bin" "$cli_prefix/bin/lambdadb" --version

# Use contracts from the same stable commit as the lockfile. New develop-only
# features must not make tests of an older stable Homebrew package fail.
"$runtime" --input-type=module - "$repo_dir" "$cli_prefix" "$test_dir" <<'NODE'
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const [repo, prefix, temp] = process.argv.slice(2);
const harness = join(temp, 'harness');
const formula = readFileSync(join(repo, 'packaging/homebrew/Formula/lambdadb-cli.rb'), 'utf8');
const commit = /https:\/\/raw\.githubusercontent\.com\/lambdadb\/lambdadb-cli\/([0-9a-f]{40})\/package-lock\.json/.exec(formula)?.[1];
assert.ok(commit, 'The formula must select an immutable release lockfile.');
const released = JSON.parse(execFileSync('git', ['show', `${commit}:package.json`], { cwd: repo, encoding: 'utf8' }));
const installed = JSON.parse(readFileSync(join(prefix, 'libexec/package.json'), 'utf8'));
assert.equal(installed.name, released.name);
assert.equal(installed.version, released.version);
mkdirSync(harness);
const archive = execFileSync('git', ['archive', commit, 'test/cli.test.mjs', 'examples'], { cwd: repo });
execFileSync('tar', ['-x', '-C', harness], { input: archive });
cpSync(join(prefix, 'libexec/package.json'), join(harness, 'package.json'));
NODE
cd "$test_dir/harness"
LAMBDADB_TEST_CLI="$cli_prefix/libexec/dist/cli.js" "$runtime" --test test/cli.test.mjs
