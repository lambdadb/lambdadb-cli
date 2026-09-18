# Releasing LambdaDB CLI

## Current status

The first public development candidate is `0.1.0-dev.1`, targeting npm's `dev`
channel. Release preparation sets `private: false`; metadata now permits
publication, but no package has been published by this project workflow.
The CLI is licensed under [Apache-2.0](LICENSE), with matching package metadata.
The development-project smoke is recorded in [VALIDATION.md](VALIDATION.md).
npm organization permission verification and an authorized first bootstrap from
reviewed `develop` remain required. Main promotion is required for rc/stable
releases, not for development publication. Automatic dev publication is disabled
until the repository variable `NPM_DEV_PUBLISH_ENABLED` is set to `true` after
bootstrap and Trusted Publishing setup.
The public npm lookup for `@functional-systems/lambdadb-cli` returned E404 on
2026-09-18; this is not proof that the name is available or that ownership exists.

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
successful write, bounded registry reads verify the manifest and dev tag. If
propagation is delayed, retry reads before rerunning the job. Newer dev versions
and stale commits are skipped without changing tags.

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
window per stage. It reports elapsed time and matched-document counts; a timeout
is a failed smoke, not proof that accepted writes were rejected or lost.
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
