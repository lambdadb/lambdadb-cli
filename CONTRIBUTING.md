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
4. Address review feedback and pass both required CI checks, then merge with
   **Squash and merge**. Only promotion and synchronization PRs (below) use
   merge commits.
5. Delete the short-lived branch after verifying the merge.

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

Once lambdadb/lambdadb-iac#22 is applied, organization rulesets also block
deletion and force pushes on `develop`, require pull requests for it, and allow
only squash and merge-commit merges there (rebase merge is blocked). `main`
allows only merge commits. These rulesets have no bypass actors and do not
affect tags.

## Promoting a release

Development builds do not require main promotion or manual version increments.
CI derives a unique version from the reviewed development base and first-parent
commit count. Keep the base in `X.Y.Z-dev.N` form; when moving to the next release
line, update it and the lockfile through a PR. Generated build versions are not
committed back. Stale queued builds can be skipped as newer work arrives.

For an rc/stable release, prepare the version, changelog and release notes on a
short-lived branch from `develop` (a `release/*` name is fine) and merge it into
`develop` with **Squash and merge**. Release preparation never targets `main`; do
not add release-only commits directly to `main`. While `develop` carries rc/stable
metadata, no development package is published (see
[RELEASING.md](RELEASING.md#automatic-development-publication)).

Once changes and validation are complete on `develop`, open a `develop` → `main`
pull request. Record the version, changes, local/CI evidence, and whether live
verification was performed. Merge this promotion with **Create a merge commit**
so the shared branch ancestry is preserved, then tag and publish from the
resulting reviewed `main` commit. After the release, set the next intended
development base on `develop` through a PR so automatic development publication
resumes.

Whenever `main` contains commits absent from `develop` (hotfixes, or anything
merged straight into `main`, such as Dependabot security updates), open a `main`
→ `develop` synchronization PR and merge it with **Create a merge commit**. Never
squash or rebase a synchronization PR: that makes the trees equal without shared
ancestry, so later comparisons show already-synchronized commits again and
release tags become unreachable from `develop`. Verify with
`git merge-base --is-ancestor <main-commit> origin/develop`.

The first npm bootstrap, rc/stable tags and GitHub Releases remain explicit
release actions. Subsequent dev publication is automatic once enabled. Follow
[RELEASING.md](RELEASING.md) for package preparation, version/channel rules,
credentialed live evidence, initial npm bootstrap and Trusted Publishing.
Local tests and PR validation alone never trigger publication.

For an urgent released-version fix, branch from `main`, review a PR back to
`main` and merge it with **Create a merge commit**, release from `main`, then
synchronize `main` into `develop` as described above. Preserve the same checks
and review requirements.

## Credentials and scope

Never commit project keys, `.env` files or signed URLs. Runtime tests use loopback
servers with synthetic credentials. Live tests require an explicitly designated
development project and credential set; local or CI success is not proof of
live-service readiness. See [README.md](README.md) for public behavior and the
[validation scope](#validation-scope) below for evidence boundaries.

## Compatibility and maintenance

Agent integrations live in the `agentAdapters` registry in `src/agents.ts`.
Each adapter owns detection directories and executable names, supported scopes, project/user
paths, MCP configuration generation (including environment forwarding), optional
skill path, and restart instructions. Add an adapter there to extend init's
selection, detection and help; keep authentication, file planning and atomic
writes in `src/init.ts`. `src/agent-config.ts` provides shared CLI launch
arguments and JSONC/TOML editors that preserve unrelated settings. MCP
configuration generation receives the key's variable name, never its value.
An MCP-only adapter can omit the skill path.
An adapter that cannot configure project MCP settings declares `scopes: ['user']`;
init rejects unsupported flags and offers only shared supported scopes interactively.
Identical changes to the same canonical path are combined; conflicting contents
or CLI-settings overlaps fail before connection or writes. Copilot/Cline adapters
use the strict JSON editor rather than silently removing comments.

Before adding an agent, verify its documented formats and environment forwarding,
then cover both scopes, unrelated configuration preservation, conflicts, reruns
and secret handling through the CLI tests. Test real agent startup separately;
configuration generation alone is not a successful connection.

Treat documented flags, JSON schema, exit codes, explicit target selection and
failure semantics as public contracts. Add regression coverage for changes to
these behaviors; do not script against human summaries. Update the changelog
and document a migration when changing a contract. Preserve `--help` and
noninteractive operation in the installed artifact, not only the source tree.

Review dependency updates through the same PR checks, including the actual SDK
contract and installed-package tests. Keep workflow actions pinned to commit
SHAs and document version updates in their comments. Do not copy another
repository's runtime matrix or release tooling without checking this CLI's needs.

## Validation scope

- `npm test` builds the CLI and executes unit, subprocess and release-tooling
  contracts. Loopback HTTP servers exercise the installed SDK without contacting
  LambdaDB: input and target precedence, query and Collection mapping, signed
  transfers, pagination, complete results, credential redaction and exit codes.
  Failure cases cover bounded inputs, timeouts, cancellation, partial and unknown
  writes, and the absence of mutation retries.
- `npm run test:package` packs the candidate, checks its inventory and executable,
  installs it into a temporary consumer and repeats the CLI contracts against
  that artifact. To check an existing candidate, use
  `npm run test:package -- /path/to/package.tgz`. Building test sources alone is
  not evidence that tests executed.
- Init contracts run in temporary home/project directories against loopback
  collection-list responses. They cover configuration/comment preservation,
  reruns, conflicts, scope, secret handling and non-interactive failures. An npx
  stub verifies stdio launch, credential mapping and write opt-in without fetching
  or running an agent. The packaged suite repeats these contracts and verifies
  the bundled skill. These checks do not establish actual agent MCP connection,
  live authentication or document search readiness.
- [Homebrew validation](packaging/homebrew/README.md#local-and-ci-verification)
  checks the stable formula's installation and released CLI contracts on macOS
  and Linux. A new installation does not establish an existing-user upgrade;
  verify upgrades separately as part of the tap handoff.
- Local tests and PR CI do not establish backend deployment provenance, live
  search quality, production performance, billing readiness, exactly-once writes
  or durable resume. Check the deployed backend revision separately when a
  feature requires server support. The CI matrix does not validate Windows
  permissions or signals.
- Input byte/document limits bound accepted input, not process memory. Large
  mock responses and a bounded live sample are not exhaustive memory or storage
  policy tests. A successful live sample applies only to its designated target,
  revision, refs and inputs.

## Live validation

Provision a disposable development project/key outside this tool, with Collection
create/update/delete, ordinary and bulk write, and query/fetch access.
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
accepts and verifies metadata for all 49 fixed analyzer presets, checks exact
facet-only and document+facet buckets, and checks committed query/fetch contents
with a maximum 300-second observation window per stage. It also checks native
reranking with default criteria, null and custom criteria, including
final/retrieval scores and status metadata.
It creates two additional temporary Collections for native embedding-only and
legacy true inputs. It exercises actual CLI create/update, normalized metadata,
document/query embedding generation, ordinary retrieval,
Bayesian candidate budgets, default/explicit rerank budgets, null rerank and
server-side rejection of invalid Bayesian requests. All three Collections are
cleaned up with subsequent HTTP 404 verification.

Request timeouts and polling sleeps are capped to the remaining budget, and
responses at or after the deadline cannot pass. Process termination
and event-loop scheduling may delay reporting. It reports elapsed time and
matched-document counts; a timeout is a failed smoke, not proof that accepted
writes were rejected or lost.

Collection cleanup uses the SDK because deletion is outside the public CLI MVP.
Only the test's own Collections are eligible for cleanup. An interrupted process
or failed cleanup may leave those Collections; inspect them manually.

This sample does not prove global index readiness, ranking quality, every ref's
live behavior, or exactly-once writes. A large result alone does not prove the
service selected docsUrl; mock tests explicitly exercise that transport path.
Use existing known development tag/alias refs for additional live ref evidence.

## Recording verification results

Keep repeatable procedures and supported behavior in repository documentation.
Put each change's exact commands, outcomes, source/artifact revision, CI links,
live target and cleanup result, and material unperformed checks in its PR.
For publication, include the verified version, integrity and provenance summary
in the release PR or GitHub Release. User-facing changes and compatibility notes
belong in the changelog and release notes.

Retain sanitized evidence needed for long-term review as release assets or in
an approved durable location; CI logs and artifacts have retention limits, and
local temporary paths are not durable references. Never include credentials or
signed URLs. Historical repository records remain available through Git history.

Do not append per-run logs, release-status snapshots or successful test counts to
maintainer guides. A completed verification does not require another documentation
PR. Update these guides when procedures, requirements or supported behavior change.

### Native credential validation

`npm test` uses synthetic in-memory stores and loopback authorization responses;
it does not claim an actual OS store or account login worked. To exercise the
current OS store with a unique synthetic key, a fresh-process doctor against a
loopback server, a simulated MCP child, and separate account-session retrieval
from a fresh management process:

```sh
npm run build
LAMBDADB_TEST_NATIVE_CREDENTIALS=1 node --test test/native-credentials.test.mjs
# Linux may explicitly select either backend:
LAMBDADB_TEST_NATIVE_CREDENTIALS=1 LAMBDADB_TEST_CREDENTIAL_STORE=secret-service node --test test/native-credentials.test.mjs
```

The opt-in tests remove their credentials in `finally`. The Windows path checks the
store and doctor but skips the POSIX fake-npx child. Run the kernel-keyutils check
on a host that permits keyring syscalls; default Docker isolation may not. A
missing/locked native backend must never make the environment path unavailable.
See [ONBOARDING.md](ONBOARDING.md) for the cross-repository contract and rollout.

Account/project tests use separate synthetic credential namespaces and loopback
management responses. Run `node --test test/account.test.mjs` after building for
focused coverage of secret-free metadata, explicit issuance, saved-key switching,
concurrent edits, symlink aliases, quota guidance and non-interactive failures.
The package check runs these tests against the installed tarball as well. Backend
PostgreSQL tests and Console browser tests are documented in their repositories;
no simulated session is evidence of live signup, provisioning or billing.
