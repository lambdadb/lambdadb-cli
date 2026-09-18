# Contributing

## Branches and pull requests

`main` is the default branch and the reviewed release baseline. `develop`
integrates changes for the next version. Branch names here refer to Git branches,
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
npm run typecheck
npm test
```

The `CI` workflow runs on pull requests targeting `develop` or `main` and on
pushes to those branches. Its required check names are `Node.js 22` and
`Node.js 24`. Both install the lockfile, check types, build, run the mock/local
contract suite, pack the CLI, and execute a separately installed package.
CI uses a read-only GitHub token and no LambdaDB credentials. It does not publish
packages or contact a LambdaDB service.

Both long-lived branches require pull requests, one approving review, resolved
review conversations, and both CI checks against an up-to-date base. New commits
dismiss prior approvals. Force pushes and branch deletion are disabled. Repository
administrators are also subject to the repository's branch protection.

The organization additionally applies its `protect-main` ruleset to the default
branch. Its update restriction allows designated team members to merge through
the organization's PR-only bypass; passing repository CI alone does not grant
permission to update `main`. Repository rules do not weaken organization rules.

## Promoting a release

Once the desired changes and validation are complete on `develop`, open a
`develop` → `main` pull request. Record the version, changes, local/CI evidence,
and whether live verification was performed. Merge this promotion using a merge
commit so the shared branch ancestry is preserved. After promotion, synchronize
`main` back into `develop` through a PR when it contains commits absent from
`develop`, especially release-only changes or hotfixes.

A separate `release/*` branch is optional when stabilization must proceed while
new work continues on `develop`. It is not required for the initial release.

Tagging, GitHub Releases and package publication are separate, explicit release
actions. No publishing workflow exists yet, and the package remains
`private: true`. Before enabling publication, define the release procedure,
package metadata and registry credentials independently of development CI.

For an urgent released-version fix, branch from `main`, review a PR back to
`main`, then synchronize the fix into `develop`. Preserve the same checks and
review requirements.

## Credentials and scope

Never commit project keys, `.env` files or signed URLs. Runtime tests use loopback
servers with synthetic credentials. Live tests require an explicitly designated
development project and credential set; local or CI success is not proof of
live-service readiness. See [README.md](README.md) and
[VALIDATION.md](VALIDATION.md) for the current contract and evidence boundaries.
