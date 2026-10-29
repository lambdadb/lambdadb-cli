# Releasing LambdaDB CLI

This guide defines release policy and procedures. User-facing changes belong in
[CHANGELOG.md](CHANGELOG.md) and [GitHub Releases](https://github.com/lambdadb/lambdadb-cli/releases).
Record execution results in the relevant PR and release, following
[Recording verification results](CONTRIBUTING.md#recording-verification-results).

## Branch and version policy

Releases are trunk-based: `main` is the only long-lived branch. Follow
[CONTRIBUTING.md](CONTRIBUTING.md): every change reaches `main` through a pull
request that is squash-merged. There are no `develop`, release or hotfix
branches; maintenance releases are cut from `main`, and anything merged into
`main` ships in the next release. npm `latest`, not the main branch tip,
identifies the stable npm version.

| Source | Committed version | Published version | Trigger | Git tag | npm dist-tag |
| --- | --- | --- | --- | --- | --- |
| `main` push | `X.Y.Z-dev.0` | `X.Y.Z-dev.N` (N ≥ 1, assigned by CI) | Push CI succeeds and automatic publication is enabled | None | `dev` |
| `main` push | `X.Y.Z-rc.N` or `X.Y.Z` | None (verification only) | Release PR merge | None yet | None |
| `main` history | `X.Y.Z-rc.N` | `X.Y.Z-rc.N` | GitHub prerelease `vX.Y.Z-rc.N` is published | `vX.Y.Z-rc.N` | `rc` |
| `main` history | `X.Y.Z` | `X.Y.Z` | GitHub release `vX.Y.Z` is published | `vX.Y.Z` | `latest` |

Only these canonical version forms are supported. No leading zeroes or build
suffixes. Between releases, `main` carries the next version with the
development placeholder `X.Y.Z-dev.0`; number 0 is never published. Change
package.json and both root version entries in package-lock.json at once with the
version script, which keeps each file's formatting and fails unless all sources
agree afterwards:

```sh
node scripts/version.mjs get                # print the committed version
node scripts/version.mjs set 0.2.0-rc.1     # release pull request
node scripts/version.mjs set 0.2.0-dev.0    # next development version
```

It accepts only committed forms: `X.Y.Z-dev.0`, `X.Y.Z-rc.N` and `X.Y.Z`.
`npm run check:version` rejects any other committed version. For explicit
releases, move release notes from Unreleased to a dated
`## [VERSION] - YYYY-MM-DD` section. The executable reads package.json, so it has
no independently maintained version.

## Automatic development publication

The `CI` workflow lives in `.github/workflows/publish.yaml`. Its Node 22 and 24
jobs must both succeed for the exact push commit. Only a push to this repository's
`main` whose committed version is `X.Y.Z-dev.0` can enter automatic publication;
PRs and manual CI runs cannot. Only the publishing job receives `id-token: write`.
That job runs the [deployed live smoke](#deployed-live-smoke) against the dev
environment on the packed tarball before any publication step; dev publication
runs only after it passes. The smoke runs on every dev-mode main push that is
still the main head, including while `NPM_DEV_PUBLISH_ENABLED` is unset or the
publish step later skips the version.

The publishing job replaces the placeholder with `X.Y.Z-dev.N`, where N is the
number of first-parent commits on `main` since the newest stable release tag
(`vA.B.C`) reachable from the commit, or since the root commit when there is none.
For example, the second merge after `v0.1.7` with `0.1.8-dev.0` committed publishes
`0.1.8-dev.2`. N is the same on every rerun of a commit, restarts at 1 after each
stable release and keeps increasing across the RCs of one version. The counter
includes commits that were never published; it is not necessarily consecutive in
npm. The job fails unless `X.Y.Z` is newer than that stable tag, so a missed
next-version change cannot publish a lower version. Force pushes and history
rewrites must remain disabled.

Generated package/lock versions and `gitHead` are changed only in the runner;
there are no version-bump commits, Git tags or GitHub Releases for automatic dev
builds. The source changelog remains a reviewed summary rather than generating
a dated entry for every build. npm `gitHead` and provenance identify the source.
The workflow packs once, tests that exact tarball, and publishes it with
`--tag dev --provenance`; `latest` is not changed.

Dev publication jobs are serialized without interrupting an active registry
write. A newer pending job can replace an older pending job. The current remote
main head is checked before preparation and immediately before publishing;
stale jobs are skipped. The existing dev tag is also compared numerically to
prevent an older version from moving it backward. This follows the latest
eligible main head rather than guaranteeing an artifact for every rapid merge.

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

## Release verification on main

A `main` push whose committed version is `X.Y.Z-rc.N` or `X.Y.Z` (a release PR
merge) runs the publishing job in verification mode: release metadata and the
dated changelog entry are checked, the tarball is packed once and its installed
contracts are tested, the [deployed live smoke](#deployed-live-smoke) runs that
tarball against production, and nothing is published. Tag the release only after
this run passes. Do not merge other pull requests until the release is tagged, or tag
the release PR's merge commit explicitly. A committed `X.Y.Z-dev.N` other than
the placeholder fails the run.

## Bootstrap and explicit rc/stable release preflight

1. Open a release PR into `main` that sets the version with
   `node scripts/version.mjs set VERSION`. Prepare and review the license
   file/metadata, changelog, dependency changes and package inventory. Set
   `private: false` only in this explicitly approved preparation. Preserve the
   exact repository URL.
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

3. Optionally run the [deployed live smoke](#deployed-live-smoke) locally against
   the dev environment before merging, and record commit, SDK version,
   endpoint/project, command, outcome and cleanup in the release PR without keys
   or signed URLs. PR CI deliberately has no service keys.
4. Merge the release PR with required CI checks and wait for the verification
   run on `main`, which includes the production live smoke. A failed or missing
   smoke blocks the release; it is never a skipped success. Record the verified
   commit in release notes.
5. Obtain explicit authorization for the immutable tag and publication. Tag the
   verified main commit with `vVERSION`, push that tag, and publish a GitHub
   Release with `prerelease: true` for rc and `false` for stable. Draft releases
   do not publish npm. For the first development bootstrap, use the separate
   procedure below; do not publish a dev GitHub Release.
6. `.github/workflows/publish.yaml` validates main ancestry and metadata, runs
   lint/types/local tests, packs once, installs and tests that exact tarball, runs
   the production live smoke on it, then publishes it with the selected dist-tag
   and provenance. A failed smoke stops publication.
7. Verify the workflow, npm version/dist-tag, provenance's repository/commit and
   a clean consumer install of the exact version. Test the installed binary's
   version/help and basic JSON behavior. Confirm a dev/rc release did not move
   `latest`. Add the verification summary and links to the release PR or GitHub
   Release.
8. When publication succeeds, the "Open next development version" workflow
   (`.github/workflows/next-dev-version.yaml`) opens a PR that restores the
   placeholder: the same `X.Y.Z-dev.0` after an rc, or the next patch
   `X.Y.(Z+1)-dev.0` after a stable release. Change it with
   `node scripts/version.mjs set` if the next release is a minor or major version,
   then merge it. Pull requests opened with `GITHUB_TOKEN` do not trigger
   `pull_request` workflows, so the workflow dispatches CI on the PR branch to
   report the required checks. It needs `actions`, `contents` and
   `pull-requests` write permissions and never publishes.

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
development commit, using interactive `npm login` and the account's MFA, then
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
main pushes. The next eligible main push (or rerun of its existing push workflow)
validates and publishes an automatically numbered version. Keep the variable
unset until bootstrap and trust configuration are complete; without it, main
pushes still prepare, pack and test the dev artifact but do not publish.
`workflow_dispatch` runs validation only.

The workflow uses a GitHub-hosted runner, Node 24, npm >=11.5.1 and
`id-token: write`. No long-lived npm secret is required. If a GitHub Environment
is later added, its exact name must also be configured on npm. Saving settings
does not prove OIDC works; verify the next authorized publication. Current npm
configurations can default to staged publishing only, which is insufficient for
this direct-publish workflow. See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/).

## Deployed live smoke

The publishing job runs every LambdaDB live test (`npm run test:live`, one file at
a time) against a deployed environment before any publication step. The Node 22
and 24 validation jobs and pull requests receive no cloud credentials and never
run it.

| Event | Live target | Publication after a pass |
| --- | --- | --- |
| Pull request | None | None |
| `main` push, committed `X.Y.Z-dev.0` | Dev | `X.Y.Z-dev.N` when enabled |
| `main` push, committed rc/stable version | Production | None (verification only) |
| Published GitHub Release | Production | rc/stable version |

A dev-mode push that is no longer the main head skips packing, the smoke and
publication. The smoke installs the packed tarball in a clean directory and runs
the live suite against that installed CLI (`LAMBDADB_TEST_CLI`).
`scripts/run-live-smoke.mjs` requires the base URL, project name and secret ARN,
reads the project API key from Secrets Manager with the AWS CLI, masks it in
GitHub Actions, and passes it only in the test process environment, never in
command arguments, files, artifacts or GitHub Secrets. It maps the provisioned
values to the names the live test reads (`LAMBDADB_ENDPOINT`, `LAMBDADB_PROJECT`,
`LAMBDADB_LIVE_CONFIRM_PROJECT`, `LAMBDADB_API_KEY`) and sets
`LAMBDADB_RUN_LIVE_TESTS=1`. Missing configuration, a failed secret read, a test
failure, or a run in which any live test was skipped, marked todo or absent fails
the job and prevents publication.

The suite creates its own temporary Collections and verifies their deletion. The
dedicated `cli-ci` projects need `rateLimit` of at least 100 requests per second;
they must allow Collection create/update/delete, ordinary and bulk writes and
query/fetch. Do not grant the workflow the stack admin key, project creation,
deployment or secret write permissions. Key rotation updates the AWS secret
without changing this workflow.

### Repository Variables

The `LAMBDADB_DEV_` Variables serve dev builds; the `LAMBDADB_PROD_` Variables
serve release verification and rc/stable Releases. A missing Variable stays empty
and fails the run; it never falls back to the other environment.

| Variable | Value |
| --- | --- |
| `LAMBDADB_DEV_BASE_URL` | `https://internal-dev-aws-apne2-v3-c05a2b5d492a.lambdadb.ai` |
| `LAMBDADB_DEV_PROJECT_NAME` | `cli-ci` in `dev-aws-apne2-v3` |
| `LAMBDADB_DEV_SMOKE_AWS_ROLE_ARN` | Dev AWS OIDC role `lambdadb-cli-smoke` |
| `LAMBDADB_DEV_SMOKE_SECRET_ARN` | Exact ARN of the dev project's API key secret |
| `LAMBDADB_PROD_BASE_URL` | `https://aws-ap-northeast-2-v3.lambdadb.ai` |
| `LAMBDADB_PROD_PROJECT_NAME` | `cli-ci` in `prod-aws-apne2-v3` |
| `LAMBDADB_PROD_SMOKE_AWS_ROLE_ARN` | Production AWS OIDC role `lambdadb-cli-prod-smoke` |
| `LAMBDADB_PROD_SMOKE_SECRET_ARN` | Exact ARN of the production project's API key secret |

Each project key is a plain SecretString in `ap-northeast-2`.

### AWS OIDC roles

This repository uses GitHub's immutable OIDC subject format, so the subject
names the owner and repository IDs (`lambdadb@209344672`,
`lambdadb-cli@1375598438`) rather than only their names. Each role trusts audience
`sts.amazonaws.com` and only these subjects. The dev role:

```text
repo:lambdadb@209344672/lambdadb-cli@1375598438:ref:refs/heads/main
```

The production role (release verification on `main`, Releases on tags):

```text
repo:lambdadb@209344672/lambdadb-cli@1375598438:ref:refs/heads/main
repo:lambdadb@209344672/lambdadb-cli@1375598438:ref:refs/tags/v*
```

Renaming or transferring the repository or organization keeps these IDs; a role
written with the plain `repo:lambdadb/lambdadb-cli:...` form would not match.
Each permission policy needs `secretsmanager:GetSecretValue` on the exact smoke
secret ARN of its own environment (plus `kms:Decrypt` on the exact key only for a
customer-managed KMS key). Provisioning the roles, projects, keys and Variables is
a separate environment setup step; the workflow alone does not establish working
AWS access.

### Running the live suite locally

Run the same command the workflow uses, with AWS credentials that can read the
selected secret; the key is never printed or written to a file:

```sh
npm ci
AWS_PROFILE=YOUR_PROFILE \
LAMBDADB_BASE_URL=https://internal-dev-aws-apne2-v3-c05a2b5d492a.lambdadb.ai \
LAMBDADB_PROJECT_NAME=cli-ci \
LAMBDADB_SMOKE_SECRET_ARN=DEV_SMOKE_SECRET_ARN \
node scripts/run-live-smoke.mjs
```

Use the `LAMBDADB_PROD_` values to check production. It tests `dist/cli.js`
unless `LAMBDADB_TEST_CLI` names an installed package's `dist/cli.js`. To use
another project and key without Secrets Manager, follow the
[live validation procedure](CONTRIBUTING.md#live-validation). Record the target,
commit, outcome, duration and cleanup result in the PR, without keys or signed
URLs.

## Homebrew handoff

The stable formula is maintained on main in
[`packaging/homebrew/Formula/lambdadb-cli.rb`](https://github.com/lambdadb/lambdadb-cli/blob/main/packaging/homebrew/Formula/lambdadb-cli.rb).
It consumes the verified npm artifact and the lockfile from its immutable release
commit. Development publication does not update Homebrew. After each stable npm
release, follow the [Homebrew maintainer guide](https://github.com/lambdadb/lambdadb-cli/tree/main/packaging/homebrew#readme) to
update checksums, pass installation checks and prepare a tap PR. Tap publication
is separate from this repository's npm workflow; no cross-repository write or
automatic tap update is configured. Record installation and actual upgrade results
in the tap PR, including tested platforms and any unperformed checks. Query the
[public tap](https://github.com/lambdadb/homebrew-tap) for its current formula;
do not maintain a second release-status history here.
