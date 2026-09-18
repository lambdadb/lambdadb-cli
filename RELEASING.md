# Releasing LambdaDB CLI

## Current status

The `release/0.1.0` candidate prepares the first stable version from reviewed
`develop` commit `c8947e9`. It changes package/lock versions and release documents;
CLI runtime, dependencies, tests and workflows match the verified development build.
The promotion PR targets `main` directly so `develop` keeps its automatic dev base.
Merge with a merge commit, then obtain authorization for `v0.1.0` and a non-prerelease
GitHub Release. Main promotion alone does not publish npm. After publication,
verify `latest=0.1.0`, provenance and a clean consumer installation. Synchronize
main back to develop through a PR that also sets the next development base.
Stable publication has not yet been performed.

The ordinary develop merge published `0.1.0-dev.5` through OIDC in
[one successful workflow attempt](https://github.com/lambdadb/lambdadb-cli/actions/runs/35344153978).
The new verification logic handled approximately three minutes of registry
propagation without repeating the write or rerunning the workflow. A fresh npm
installation passed 35 CLI contracts, integrity and provenance/signature checks.

Bootstrap and initial OIDC publication were completed on 2026-09-18:

- `0.1.0-dev.1` was published publicly from reviewed develop as the manual bootstrap.
- `0.1.0-dev.4` was published by GitHub Actions with verified provenance for
  commit `f2397ba`. Its registry installation passed all 35 CLI contract tests.
- The repository variable `NPM_DEV_PUBLISH_ENABLED=true` enables eligible develop
  pushes after Node 22/24 CI. Main promotion is required only for rc/stable.

These are recorded validation milestones, not a continuously updated list of
versions. Check npm for current dist-tags. At verification, `dev` pointed to
`0.1.0-dev.4` and `latest` remained at the bootstrap `0.1.0-dev.1`: the first
publication created both tags despite `--tag dev`, and removing `latest` returned
HTTP 400. The next dev publication preserved `latest`. No stable version has been
published; explicitly select `@dev` or an exact development version until a
reviewed rc/stable release is available. Do not repeatedly delete the bootstrap
tag or publish a placeholder to work around it.

The CLI is licensed under [Apache-2.0](LICENSE), with matching package metadata.
Publication, provenance and development-project smoke evidence are recorded in
[VALIDATION.md](VALIDATION.md). Local bootstrap has no GitHub Actions provenance;
the automated development artifact does.

The workflow rejects private packages and missing license metadata. Explicit
rc/stable releases also require matching tags, prerelease flags and dated
changelog entries. Passing metadata validation does not establish live-service
verification. Enabling automatic dev publication authorizes eligible develop
pushes to publish after CI; rc/stable publication remains an explicit action.

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
exceeds the budget, it emits `result=published-verification-pending` and exits
nonzero. This means the write succeeded but verification is incomplete; it does
not authorize another publish. Retry registry reads first. Once the manifest and
dev tag agree, rerun the failed job: an identical artifact reports
`result=already-published` without another write. Newer dev versions and stale
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
   without keys or signed URLs. Missing credentials are a blocked release
   prerequisite, not a skipped success. PR CI deliberately has no service keys.
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
   `latest`. Synchronize release-only main changes back to develop by PR.

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

This one-time bootstrap was completed for this package on 2026-09-18. The steps
below document setup and recovery; do not repeat the bootstrap for normal dev builds.
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

Provision a disposable development project/key outside this tool, with create,
ordinary and bulk write, query/fetch and temporary-collection delete access.
Supply the key through secure shell input or a secret manager, never in history.

```sh
export LAMBDADB_ENDPOINT=https://YOUR_DEV_API_ORIGIN
export LAMBDADB_PROJECT=YOUR_DEV_PROJECT
# Inject LAMBDADB_API_KEY securely; no .env file is loaded automatically.
export LAMBDADB_RUN_LIVE_TESTS=1
export LAMBDADB_LIVE_CONFIRM_PROJECT="$LAMBDADB_PROJECT"
npm run test:live
```

The test fails before API calls when required settings are absent. It creates a
random temporary collection, imports two 3 MiB documents plus a bulk document,
and checks committed query/fetch contents with a maximum 300-second observation
window per stage. Request timeouts and polling sleeps are capped to the remaining
budget, and responses at or after the deadline cannot pass. Process termination
and event-loop scheduling may delay reporting. It reports elapsed time and
matched-document counts; a timeout is a failed smoke, not proof that accepted
writes were rejected or lost.
Collection cleanup uses the SDK because deletion is outside the public CLI MVP.
Only the test's own collection is eligible for cleanup. An interrupted process
or failed cleanup may leave that named collection; inspect it manually.

This sample does not prove global index readiness, ranking quality, every ref's
live behavior, or exactly-once writes. A large result alone does not prove the
service selected docsUrl; mock tests explicitly exercise that transport path.
Use existing known development tag/alias refs for additional live ref evidence.

## Design references

- LambdaDB TypeScript client `RELEASING.md` and `publish.yaml`: canonical channels,
  separate live evidence, same tested artifact and OIDC. This CLI intentionally
  publishes dev from develop, while rc/stable releases require main history.
- LambdaDB migration `.goreleaser.yml`/release workflow and `install.sh`: verify
  installed artifacts and explicit versions. Go binaries, GoReleaser and Docker
  distribution are unnecessary for this npm CLI's first release.
- [Command Line Interface Guidelines](https://clig.dev/): preserve machine output,
  separate diagnostics, avoid interactive CI requirements, protect secrets and
  test cancellation. The CLI contract suite exercises these boundaries.

External documentation checked on 2026-09-18. Consult current npm documentation
when configuring the package; registry requirements can change independently.
