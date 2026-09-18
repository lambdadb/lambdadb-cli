# Contributing

## Branches and pull requests

`main` is the default branch and the reviewed rc/stable release baseline.
`develop` integrates changes and supplies automatic npm development builds.
Branch names here refer to Git branches,
not LambdaDB collection branches or refs.

1. Create a short-lived `feat/*` or `fix/*` branch from current `develop`.
2. Implement and validate one coherent change.
3. Open a pull request targeting `develop`. GitHub defaults new pull requests to
   `main`, so select the base explicitly.
4. Address review feedback and pass both required CI checks before merging.
5. Delete the short-lived branch after verifying the merge.

For the initial MVP, `feat/cli-mvp` targets the initial `develop` commit. The
review includes the CLI implementation, tests, documentation and CI setup.

## Local and CI validation

```sh
npm ci
npm run lint
npm run check:version
npm run typecheck
npm test
npm run test:package
```

The `CI` workflow in `.github/workflows/publish.yaml` runs on pull requests
targeting `develop` or `main` and on
pushes to those branches. Its required check names are `Node.js 22` and
`Node.js 24`. Both install the lockfile, lint, validate version metadata, check
types, build, run the mock/local contract suite, and repeat the CLI contract
tests against a separately installed tarball. Use Node.js 22.14 or newer locally.
Validation jobs use a read-only GitHub token and no LambdaDB credentials. They
do not publish packages or contact a LambdaDB service. After both jobs succeed,
an eligible develop push can publish a dev package using a separate OIDC-enabled
job. PRs, main pushes and manual CI runs cannot publish development packages.
Automatic publication requires `NPM_DEV_PUBLISH_ENABLED=true`; enabling it after
npm bootstrap and trust setup authorizes this ongoing behavior.

Both long-lived branches require pull requests, one approving review, resolved
review conversations, and both CI checks against an up-to-date base. New commits
dismiss prior approvals. Force pushes and branch deletion are disabled. Repository
administrators are also subject to the repository's branch protection.

The organization additionally applies its `protect-main` ruleset to the default
branch. Its update restriction allows designated team members to merge through
the organization's PR-only bypass; passing repository CI alone does not grant
permission to update `main`. Repository rules do not weaken organization rules.

## Promoting a release

Development builds do not require main promotion or manual version increments.
CI derives a unique version from the reviewed development base and first-parent
commit count. Keep the base in `X.Y.Z-dev.N` form; when moving to the next release
line, update it and the lockfile through a PR. Generated build versions are not
committed back. Stale queued builds can be skipped as newer work arrives.

For an rc/stable release, once changes and validation are complete on `develop`, open a
`develop` → `main` pull request. Record the version, changes, local/CI evidence,
and whether live verification was performed. Merge this promotion using a merge
commit so the shared branch ancestry is preserved. After promotion, synchronize
`main` back into `develop` through a PR when it contains commits absent from
`develop`, especially release-only changes or hotfixes. Include the next intended
development base in that synchronization PR so develop retains a dev version.

A separate `release/*` branch is optional when stabilization must proceed while
new work continues on `develop`. It is not required for the initial release.

The first npm bootstrap, rc/stable tags and GitHub Releases remain explicit
release actions. Subsequent dev publication is automatic once enabled.
Bootstrap `0.1.0-dev.1` and the first OIDC development publication `0.1.0-dev.4`
were verified on 2026-09-18; automatic dev publication is enabled. Publication,
provenance and development-project smoke evidence are recorded in
[VALIDATION.md](VALIDATION.md). Follow
[RELEASING.md](RELEASING.md) for package preparation, version/channel rules,
credentialed live evidence, initial npm bootstrap and Trusted Publishing.
Local tests and PR validation alone never trigger publication.

For an urgent released-version fix, branch from `main`, review a PR back to
`main`, then synchronize the fix into `develop`. Preserve the same checks and
review requirements.

## Credentials and scope

Never commit project keys, `.env` files or signed URLs. Runtime tests use loopback
servers with synthetic credentials. Live tests require an explicitly designated
development project and credential set; local or CI success is not proof of
live-service readiness. See [README.md](README.md) and
[VALIDATION.md](VALIDATION.md) for the current contract and evidence boundaries.

## Compatibility and maintenance

Treat documented flags, JSON schema, exit codes, explicit target selection and
failure semantics as public contracts. Add regression coverage for changes to
these behaviors; do not script against human summaries. Update the changelog
and document a migration when changing a contract. Preserve `--help` and
noninteractive operation in the installed artifact, not only the source tree.

Review dependency updates through the same PR checks, including the actual SDK
contract and installed-package tests. Keep workflow actions pinned to commit
SHAs and document version updates in their comments. Do not copy another
repository's runtime matrix or release tooling without checking this CLI's needs.
