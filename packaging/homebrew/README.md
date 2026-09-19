# Homebrew distribution

## Availability

This directory prepares a third-party tap for the published stable CLI, currently
`0.1.0`. The formula is tested from a disposable local tap. No public
`lambdadb/homebrew-tap` repository has been created by this change, so the public
Homebrew command below is **not available yet**. npm remains the supported public
installation method until tap publication is completed.

## Packaging contract

- Download the exact published npm tarball and verify its SHA-256 checksum.
- Fetch the matching `package-lock.json` from the immutable stable release commit,
  with its own SHA-256. npm omits lockfiles from published tarballs.
- Install production dependencies with `npm ci --omit=dev --ignore-scripts` inside
  the formula's `libexec`. Use the published JavaScript; do not rebuild TypeScript
  or invoke package lifecycle scripts. Dependencies are fixed by the release lock.
- Depend on Homebrew's `node@24`, matching the LTS major tested by CLI CI. The
  wrapper places that runtime first on PATH, including when fnm/nvm or another Node
  is active. This choice is specific to this tap; it is not a homebrew/core proposal.
- Expose `lambdadb` from Homebrew's bin directory. No global npm install, credentials
  or shell startup-file changes are needed.
- Track stable releases only. npm dev/rc versions do not update this formula.

Homebrew may install or upgrade dependencies needed by Node. Node and npm do not
need to be installed separately by the user. Existing npm installations can expose
another `lambdadb` on PATH; inspect `command -v lambdadb` before switching package
managers. Do not force-overwrite an existing executable during installation.

## Local and CI verification

With Homebrew already installed, run from the CLI checkout:

```sh
bash scripts/test-homebrew.sh
```

The script creates a disposable local tap from the checked-in formula, runs
Homebrew style checks, installs the stable package, and runs `brew test`. The
formula test checks version, noninteractive JSON configuration and file permissions
without API access. The harness also verifies the wrapper with a deliberately
unusable ambient Node and runs the 35 CLI contracts from the formula's stable
release commit against the installed package. A full Git checkout is required;
this avoids testing an older stable package against unreleased develop features.

An existing `lambdadb-cli` installation or executable in Homebrew's prefix stops the
test before mutations. On completion or ordinary failure, the script removes only
its CLI installation and temporary tap. Dependencies and caches remain available;
automatic dependency removal and cleanup are disabled. SIGKILL or machine shutdown
can interrupt cleanup; inspect the printed `lambdadb/cli-test-*` tap before removing
anything manually. Use a fresh CI runner when preserving the entire Homebrew
dependency state is required.

`.github/workflows/homebrew.yaml` exercises this process on macOS 15 and Ubuntu
24.04 for relevant PRs. It performs no LambdaDB service calls, npm publication or
remote tap writes. Full CLI runtime CI remains separate.

## Publishing the tap

Tap creation/publication is a separate repository action. Once authorized:

1. Create the public `lambdadb/homebrew-tap` repository and set up its default
   branch and review protections.
2. Copy the reviewed `Formula/lambdadb-cli.rb` from this directory. Include the
   root Apache-2.0 `LICENSE` and a tap README with installation/update/removal
   instructions. Add formula installation checks before accepting later updates.
3. Publish the reviewed initial contents, then verify installation from the actual
   remote tap on a clean consumer. Local-tap CI does not establish this step.
4. Update the CLI README's availability statement only after remote verification.

After that publication, the intended consumer commands are:

```sh
brew install lambdadb/tap/lambdadb-cli
lambdadb --version
brew upgrade lambdadb/tap/lambdadb-cli
brew uninstall lambdadb/tap/lambdadb-cli
```

Homebrew adds the tap on fully qualified installation. Follow any formula trust
prompt shown by the installed Homebrew version; do not disable trust checks.

## Updating for a stable release

1. Finish the existing npm stable release process first. Verify its Git tag,
   registry version, provenance and installed CLI. A release candidate or moving
   npm tag is not a formula source.
2. Read the exact version's `dist.tarball` and `dist.integrity` with `npm view`.
   Download it, verify its SHA-512 integrity against npm and calculate SHA-256.
3. Update the formula's npm URL and SHA-256. Resolve the stable tag to its commit;
   update the lock resource's commit URL and SHA-256 from that same commit's
   `package-lock.json`. Confirm package/lock name, version and dependencies agree.
4. Run the local Homebrew harness and pass macOS/Linux CI. Review the formula change
   in the CLI repository, then copy the exact reviewed file into a tap PR. Initially
   this is a manual maintainer handoff; no cross-repository token or automatic tap
   write is configured.
5. Merge the reviewed tap update, then verify `brew update` / `brew upgrade` from
   the remote tap and record the installed version. Never rewrite an npm version
   or stable Git tag to repair a packaging issue; use a reviewed formula revision
   when only packaging changes.

## References

- [Homebrew Node.js packaging](https://docs.brew.sh/Language-Specific-Formulae#nodejs)
- [Creating and maintaining a tap](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap)
- [CLI release process](../../RELEASING.md)
