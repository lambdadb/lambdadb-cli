# Releasing LambdaDB CLI

This guide defines release policy and procedures. User-facing changes belong in
[CHANGELOG.md](CHANGELOG.md) and [GitHub Releases](https://github.com/lambdadb/lambdadb-cli/releases).
Record execution results in the relevant PR and release, following
[Recording verification results](CONTRIBUTING.md#recording-verification-results).

## Branch and version policy

Follow [CONTRIBUTING.md](CONTRIBUTING.md): feature/fix PRs target `develop`,
promotion PRs target `main`. Development versions publish from `develop` after
CI, while rc/stable releases publish from reviewed `main` history. npm `latest`,
not the main branch tip, identifies the stable npm version.

| Source | Package version | Trigger | npm dist-tag |
| --- | --- | --- | --- |
| `develop` | `X.Y.Z-dev.N` | Push CI succeeds and automatic publication is enabled | `dev` |
| `main` history | `X.Y.Z-rc.N` | GitHub prerelease `vX.Y.Z-rc.N` is published | `rc` |
| `main` history | `X.Y.Z` | GitHub release `vX.Y.Z` is published | `latest` |

Only these canonical version forms are supported. No leading zeroes or build
suffixes. For reviewed version changes, update package.json and both root version
entries in package-lock.json together; `npm version VERSION --no-git-tag-version`
prepares this without a tag. For explicit releases, move release notes from
Unreleased to a dated `## [VERSION] - YYYY-MM-DD` section.
The executable reads package.json, so it has no independently maintained version.

## Automatic development publication

The `CI` workflow lives in `.github/workflows/publish.yaml`. Its Node 22 and 24
jobs must both succeed for the exact push commit. Only a push to this repository's
`develop` can enter automatic publication; PRs, main pushes and manual CI runs
cannot. Only the publishing job receives `id-token: write`. No LambdaDB service
keys are available to CI, so automatic dev builds do not imply a fresh live smoke.

Keep a reviewed development base such as `0.1.0-dev.1` in Git. The publishing job
uses the `X.Y.Z` prefix and sets `N` to `git rev-list --first-parent --count HEAD`
from a full checkout. For example, count 12 produces `0.1.0-dev.12`. The counter
includes commits that were never published; it is not necessarily consecutive
in npm. A rerun of the same commit produces the same version. Force pushes and
history rewrites must remain disabled. When starting the next release line,
review a new base such as `0.2.0-dev.1`, including when synchronizing main back.

Generated package/lock versions and `gitHead` are changed only in the runner;
there are no version-bump commits, Git tags or GitHub Releases for automatic dev
builds. The source changelog remains a reviewed summary rather than generating
a dated entry for every build. npm `gitHead` and provenance identify the source.
The workflow packs once, tests that exact tarball, and publishes it with
`--tag dev --provenance`; `latest` is not changed.

Dev publication jobs are serialized without interrupting an active registry
write. A newer pending job can replace an older pending job. The current remote
develop head is checked before preparation and immediately before publishing;
stale jobs are skipped. The existing dev tag is also compared numerically to
prevent an older version from moving it backward. This follows the latest
eligible develop head rather than guaranteeing an artifact for every rapid merge.

If a version already exists, a rerun checks its source commit and tarball integrity
and skips publication only when they agree and the dev tag already points there.
Conflicts fail; missing or older tag state requires maintainer investigation.
Registry authentication, transport and invalid-response failures are not treated
as missing versions. A publish request is never retried automatically. After a
successful write, registry reads get a shared five-minute monotonic budget to
verify the source commit, tarball integrity and dev tag. Each read has at most
15 seconds, capped to the remaining budget; polling sleeps are at most 10 seconds.
Reads prefer fresh metadata and disable npm's nested fetch retries. Missing
metadata, HTTP 429/5xx and recognized temporary connection/timeout errors are
retried only after a successful publish. Authentication, malformed responses and
artifact conflicts remain fatal. Process termination or scheduling can delay
reporting, but responses at or after the deadline cannot pass verification.

The script reports successful publication before waiting. If propagation still
exceeds the budget, it emits `result=published-verification-pending`, a GitHub
warning and a job summary, then exits successfully. This means publication
succeeded but registry visibility is unverified. It does not authorize another
publish or establish that installation/Homebrew updates can proceed. Retry reads
before those downstream actions. Actual publish failures, authentication/schema
errors and artifact mismatches still fail the job. Once the manifest and dev tag
agree, an explicit rerun reports `result=already-published` without another write. Newer dev versions and stale
commits are skipped without changing tags. A failed publish remains an uncertain
write and is never automatically retried.

After setup, an eligible push is sufficient; no manual version increment is
needed. Users update with `npm install -g @functional-systems/lambdadb-cli@dev`,
or pin an exact published version for reproducible CI. Installed CLIs do not
update themselves. Disable `NPM_DEV_PUBLISH_ENABLED` to stop future automatic
publications; do not cancel an active registry write to simulate rollback.

Treat command/flag changes, required target changes, JSON envelope changes and
exit-code reinterpretations as compatibility changes. Describe migrations before
shipping them. Additive optional fields can remain schemaVersion 1; incompatible
JSON envelope changes require a new schemaVersion. During 0.x, put incompatible
changes in a minor release; after 1.0, use a major release. Keep patch releases
compatible. Human summaries are not a scripting interface.

## Bootstrap and explicit rc/stable release preflight

1. Prepare and review the release version, license file/metadata, changelog,
   dependency changes and package inventory. Set `private: false` only in this
   explicitly approved preparation. Preserve the exact repository URL.
2. Run the following in a clean checkout of the candidate commit with Node
   22.14+ (CI tests current Node 22 and 24). Do not load production credentials.

   ```sh
   npm ci
   npm run lint
   npm run check:version
   npm run typecheck
   npm test
   npm run test:package
   ```

3. Run the live smoke below against an explicitly designated development project.
   Record commit, SDK version, endpoint/project, command, outcome and cleanup
   in the release PR without keys or signed URLs. Missing credentials are a blocked
   release prerequisite, not a skipped success. PR CI deliberately has no service keys.
4. For rc/stable releases, promote to main by reviewed PR with required CI
   checks. The first development bootstrap can use reviewed develop directly.
   Re-run checks/live smoke if release contents changed. Record the verified
   commit in release notes.
5. Obtain explicit authorization for the immutable tag and publication. Tag the
   verified main commit with `vVERSION`, push that tag, and publish a GitHub
   Release with `prerelease: true` for rc and `false` for stable. Draft releases
   do not publish npm. For the first development bootstrap, use the separate
   procedure below; do not publish a dev GitHub Release.
6. `.github/workflows/publish.yaml` validates main ancestry and metadata, runs
   lint/types/local tests, packs once, installs and tests that exact tarball, then
   publishes it with the selected dist-tag and provenance. The release workflow
   does not rerun the credentialed live prerequisite; release owners must retain
   that evidence before publishing the GitHub Release.
7. Verify the workflow, npm version/dist-tag, provenance's repository/commit and
   a clean consumer install of the exact version. Test the installed binary's
   version/help and basic JSON behavior. Confirm a dev/rc release did not move
   `latest`. Add the verification summary and links to the release PR or GitHub
   Release. Synchronize release-only main changes back to develop by PR.

Useful read-only checks after publication:

```sh
npm view @functional-systems/lambdadb-cli@VERSION version dist.integrity dist.attestations --json
npm view @functional-systems/lambdadb-cli dist-tags --json
```

Do not move published tags or republish a used version. If registry metadata is
slow to propagate, retry reads; do not initiate another publication. For a bad
release, stop promotion, document the impact and prepare a new patch version.
Deprecation or dist-tag changes are explicit maintainer actions, not automatic
rollback. Never silently downgrade consumers.

## First publication and npm Trusted Publishing

Trusted Publishers are package-specific. The SDK's configuration does not cover
this CLI. npm requires an existing package before configuring its trust policy.
See the official [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

This package is already bootstrapped. The steps below document initial setup;
do not repeat the bootstrap for an existing package or normal dev builds.
For a new package, first complete the reviewed release preparation and preflight.
An authorized npm organization owner performs the bootstrap from the verified
develop commit, using interactive `npm login` and the account's MFA, then
publishing the tested `0.1.0-dev.1` tarball with `--access public --tag dev`.
Verify that the account has publication rights in npm's `functional-systems`
organization; GitHub organization membership does not supply npm permissions.
Use a real prerelease, not an empty placeholder. This
one-time local publication does not provide GitHub Actions provenance. Do not
also trigger the publish workflow for that same already-published version.

After bootstrap, open the CLI package's npm **Settings → Trusted Publisher** and
select GitHub Actions. Use these values for the workflow in this repository:

| npm setting | Value |
| --- | --- |
| Package | `@functional-systems/lambdadb-cli` |
| Organization or user | `lambdadb` |
| Repository | `lambdadb-cli` |
| Workflow filename | `publish.yaml` (filename only) |
| Environment name | Leave empty; the job currently declares no environment |
| Allowed actions | Enable direct `npm publish` |

After those settings are saved, enable automatic publication in GitHub repository
**Settings → Secrets and variables → Actions → Variables** by setting
`NPM_DEV_PUBLISH_ENABLED=true`. This grants ongoing publication to eligible
develop pushes. The next develop push (or rerun of its existing push workflow)
validates and publishes an automatically numbered version. Keep the variable
unset until bootstrap and trust configuration are complete. `workflow_dispatch`
runs validation only. Push-triggered dev publication does not require main to
contain the workflow; explicit GitHub Release handling does require the workflow
on the default branch.

The workflow uses a GitHub-hosted runner, Node 24, npm >=11.5.1 and
`id-token: write`. No long-lived npm secret is required. If a GitHub Environment
is later added, its exact name must also be configured on npm. Saving settings
does not prove OIDC works; verify the next authorized publication. Current npm
configurations can default to staged publishing only, which is insufficient for
this direct-publish workflow. See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/).

## Explicit live smoke

Follow the [live validation procedure](CONTRIBUTING.md#live-validation) and record
its result in the release PR. It is a release prerequisite; ordinary PR CI has
no service credentials and cannot establish live readiness.

## Homebrew handoff

The stable formula is maintained on develop in
[`packaging/homebrew/Formula/lambdadb-cli.rb`](https://github.com/lambdadb/lambdadb-cli/blob/develop/packaging/homebrew/Formula/lambdadb-cli.rb).
It consumes the verified npm artifact and the lockfile from its immutable release
commit. Development publication does not update Homebrew. After each stable npm
release, follow the [Homebrew maintainer guide](https://github.com/lambdadb/lambdadb-cli/tree/develop/packaging/homebrew#readme) to
update checksums, pass installation checks and prepare a tap PR. Tap publication
is separate from this repository's npm workflow; no cross-repository write or
automatic tap update is configured. Record installation and actual upgrade results
in the tap PR, including tested platforms and any unperformed checks. Query the
[public tap](https://github.com/lambdadb/homebrew-tap) for its current formula;
do not maintain a second release-status history here.
