# Validation record

Updated: 2026-09-19. Local contract tests use loopback servers and synthetic
credentials. A separate authenticated development-project smoke is recorded below.

## Homebrew publication

On 2026-09-19, the public
[lambdadb/homebrew-tap](https://github.com/lambdadb/homebrew-tap) was initialized at
`ca84485149d7915131df686b4c68868d47c00cd5`. Its CLI formula is byte-for-byte equal
to the formula merged in CLI PR #7 (`3eefaaa`), selecting stable `0.1.0` and the
release lockfile at `c8d389f`.

- Local macOS 26.4 arm64 / Homebrew 6.0.17 verification used the tap's new harness
  in both local and remote modes. Remote mode invoked
  `brew install --formula lambdadb/tap/lambdadb-cli` with no existing tap or CLI,
  exercising automatic public tap discovery and formula-specific trust.
- Installation, downloaded formula equality, Homebrew style, `brew test`, version
  `0.1.0`, JSON configuration with mode 0600, and the wrapper with an unusable
  ambient Node all passed. No trust checks were disabled.
- Test installations and taps were removed; existing taps, fnm Node and CLI
  `.env.local` were preserved. Dependencies and caches remain installed.
- [Tap CI](https://github.com/lambdadb/homebrew-tap/actions/runs/35433096180)
  passed remote installation, style, smoke, runtime selection and cleanup on both
  macOS 15 and Ubuntu 24.04 at the published tap commit.
- Simulated existing CLI, broken prefix executable symlink and existing remote
  tap cases stopped the new harness before mutations; invalid mode returned 2
  without invoking Homebrew.
- Tap main protection requires both installation checks, one approving review,
  resolved conversations and an up-to-date base; force pushes and deletion are
  disabled. Organization-level default-branch rules also apply.

This publishes an installation path for the existing stable artifact, without a
new npm release or another LambdaDB live-service smoke. Upgrade behavior between
two distinct stable versions remains unverified until the next formula update.
The earlier 35-contract Homebrew verification below used the same stable artifact;
this tap publication ran the installation smoke checks rather than repeating it.

## Homebrew preparation

On 2026-09-19, macOS 26.4 arm64 / Homebrew 6.0.17 installed stable `0.1.0`
from `packaging/homebrew/Formula/lambdadb-cli.rb` through a disposable local tap.
The npm tarball SHA-256 was checked against the downloaded bytes, whose SHA-512
matched registry integrity. The release lockfile resource is fixed to `c8d389f`.

- Homebrew formula style, installation and `brew test` passed. The formula checks
  CLI version, JSON configuration and mode 0600 without contacting a service.
- A deliberately unusable `node` placed first on ambient PATH did not prevent
  the installed wrapper from running; it selected Homebrew's Node 24.21.0.
- All 35 CLI contracts from the stable release commit passed against the installed
  Homebrew package. The harness uses the release commit's tests/examples so future
  development-only features do not create false failures for an older stable CLI.
- Simulated existing-formula and broken-executable-symlink cases both stopped the
  harness before any installation or tap mutation.
- The temporary CLI installation and tap were removed. The final harness disables
  automatic dependency removal and cleanup, and does not persist developer mode.
  Homebrew dependencies/caches remain: installing Node also upgraded the required
  ca-certificates, openssl@3, readline, sqlite and xz packages during initial setup.
  The existing fnm-managed Node and global npm CLI were not replaced.
- Normal clean-install, lint, version/type checks, 59 source tests and 35 npm
  installed-package contracts also passed. CLI runtime and SDK dependencies did
  not change.

macOS/Linux Homebrew CI is configured separately from runtime CI; current PR job
results are the authority for hosted-runner coverage. This initial preparation
did not create the public tap; publication evidence is recorded above. No new npm
version was published by the preparation. LambdaDB service smoke was not repeated for
this packaging-only change; the stable candidate evidence below remains separate.

## Stable 0.1.0 publication

On 2026-09-19, [GitHub Release v0.1.0](https://github.com/lambdadb/lambdadb-cli/releases/tag/v0.1.0)
and its annotated tag identified main commit
`c8d389f3264d641ae6eafc7737fedd5ea046ddf1`. Its tree exactly matches the reviewed
candidate `658ea7ccdce535bbd4f2e29ae06813e2f2e716e2` from PR #5, including the
runtime verified by the installed-candidate development smoke below. That smoke
was not repeated because release contents were unchanged.

The [release-event workflow](https://github.com/lambdadb/lambdadb-cli/actions/runs/35421226854)
passed on attempt 1. Node 22/24 validation and exact-tarball contracts passed;
Trusted Publishing published `0.1.0` on `latest` at 04:27:06 UTC. Version/tag
metadata and attestation metadata propagated separately. Verification retried
reads only; no second publication or workflow rerun was needed.

A clean, unqualified npm install with an isolated cache resolved to `0.1.0` and
passed version/help plus all 35 CLI contract tests. The downloaded tarball digest,
installed lockfile integrity and provenance subject matched. The decoded SLSA
provenance identified this repository, `.github/workflows/publish.yaml`,
`refs/tags/v0.1.0`, release commit `c8d389f` and workflow attempt 1.
`npm audit signatures` reported no invalid or missing signatures.
At verification, `latest=0.1.0` and `dev=0.1.0-dev.5`; the stable release replaced
the initial bootstrap latest tag without changing the dev channel.

The subsequent main-to-develop synchronization sets `0.1.1-dev.1` as the next
base. Its local clean install, lint, types, version checks, 59 source tests and
35 installed-package contracts passed. This maintenance change updates versions
and documentation only; CLI runtime, dependencies, tests and workflows match
`v0.1.0`. Its PR validation does not itself publish a new dev version.

## Stable 0.1.0 candidate

Prepared `release/0.1.0` from reviewed develop commit
`c8947e96308283ac593e712716f0732121bb1958`. Relative to that commit, only package
versions and release documents change. Runtime source, dependencies, tests,
examples and workflows are unchanged. This records the pre-publication candidate.

On Node.js 24.15.0 / npm 11.12.1, a new worktree passed `npm ci`, lint, type
checking, all 59 source tests, and 35 installed-package contract tests.
`RELEASE_TAG=v0.1.0 RELEASE_PRERELEASE=false npm run check:version -- --release`
passed and selected `latest`. CI results for the final commit belong to the
promotion PR; local success is not a substitute for those required checks.

A newly packed `0.1.0` tarball was installed into an isolated temporary consumer.
Its executable reported `0.1.0` and was selected with `LAMBDADB_TEST_CLI` while
running `node --test --test-reporter=tap test/live/cli.test.mjs`. The launcher used
the maintainer's existing opt-in development settings and the in-memory variable
mapping described below; it did not change or copy `.env.local` into the worktree.
Target: `bench-recall` at
`https://internal-dev-aws-apne2-v3-c05a2b5d492a.lambdadb.ai`.

- Doctor and temporary collection creation passed within the first second.
- Two ordinary documents with 3 MiB payloads each and one bulk document were
  accepted at approximately 3 seconds. Acceptance did not imply search visibility.
- Query and ID fetch on `branch:main` returned all three documents with exact
  contents at approximately 69 seconds, without a pending-write overlay.
- The live test passed in 69.6 seconds. Cleanup was accepted, then an independent
  SDK get returned `ResourceNotFoundError` for
  `cli-smoke-b854ef72-1448-42ae-8c9a-ce5c0441f104`, confirming its absence.
- The source `.env.local` was byte-for-byte unchanged, and the temporary consumer
  and tarball were removed. No key or signed URL is recorded here.

Only documentation was updated after this live run; the final package is checked
again with the installed-package contracts. This is development-service evidence
for a bounded sample, not a latency/readiness guarantee or live tag/alias coverage.
The stable npm artifact and release-event workflow were not verified at candidate
preparation time; the subsequent publication evidence is recorded above.

## Public bootstrap and OIDC publication

On 2026-09-18, the maintainer authorized the public bootstrap
[`0.1.0-dev.1`](https://www.npmjs.com/package/@functional-systems/lambdadb-cli/v/0.1.0-dev.1)
from reviewed develop commit `f2397ba`. Clean installation, lint, types and
53 source tests passed; the exact tarball passed 35 installed-CLI tests and its
published integrity matched. This local publication has no GitHub provenance.

After npm Trusted Publisher setup and repository variable activation, the
[develop push workflow, attempt 2](https://github.com/lambdadb/lambdadb-cli/actions/runs/35340278724/attempts/2)
passed Node 22/24 validation, prepared `0.1.0-dev.4`, tested its exact tarball,
and published with OIDC and provenance. The old six-attempt verification loop
exhausted its five 5-second sleeps before npm metadata propagation completed, so
the job failed after a successful publication. Read-only checks subsequently
confirmed the artifact. The
[protected rerun, attempt 3](https://github.com/lambdadb/lambdadb-cli/actions/runs/35340278724/attempts/3)
completed with `result=already-published`, proving the same source/artifact was
recognized without a second registry write.

The public [`0.1.0-dev.4` provenance](https://registry.npmjs.org/-/npm/v1/attestations/@functional-systems%2flambdadb-cli@0.1.0-dev.4)
identifies `lambdadb/lambdadb-cli`, `.github/workflows/publish.yaml`,
`refs/heads/develop`, source commit `f2397ba102c67f1af9ed5ae0b8b8d47c06da7d4b`,
and workflow attempt 2. Registry `gitHead`, downloaded tarball digest, installed
lockfile integrity and provenance subject agreed. A clean `@dev` installation
using an isolated npm cache passed version/help and all 35 CLI contract tests
with the generated package metadata. `npm audit signatures` verified four package
signatures and three attestations, including the CLI. No credentials were added
to GitHub validation jobs or repository files.

At this verification, `dev=0.1.0-dev.4` and `latest=0.1.0-dev.1`. Bootstrap had
created both tags despite `--tag dev`; a removal attempt for `latest` returned
HTTP 400. The automated dev publication left `latest` unchanged. This observation
does not establish a general version-count rule for npm. Bootstrap and OIDC setup
were complete at that stage; main promotion and stable publication followed as
recorded above.

## Publication verification hardening

The follow-up script uses a five-minute monotonic verification budget, 15-second
maximum read subprocesses and 10-second maximum polling sleeps. It retries only
missing/lagging metadata and transient post-publication reads. It reports an
accepted write separately from `published-verification-pending`, which still exits
nonzero. Authentication, malformed responses and source/artifact mismatches fail
closed. No late response can satisfy the deadline, and no verification path
repeats the registry write.

Deterministic tests exercise 150/180-second metadata/tag propagation, five-minute
expiration, read time consuming the budget, capped final I/O/sleep, late success,
temporary HTTP/transport failures and permanent errors. The changed publication
logic passed all 59 source tests (12 release-automation tests), lint, type checks
and version checks on Node 24.15.0; the installed tarball passed 35 CLI contracts.
A read-only probe used the actual npm CLI and new bounded-read flags to verify
the existing `0.1.0-dev.4` manifest/tag. Only its preflight and accepted write were
simulated; the probe performed no registry mutation.

The [ordinary develop merge workflow](https://github.com/lambdadb/lambdadb-cli/actions/runs/35344153978)
published `0.1.0-dev.5` from `c8947e96308283ac593e712716f0732121bb1958`
on attempt 1. Node 22/24 validation and exact-artifact tests passed. Publication
succeeded at 12:22:09 UTC; registry verification completed at 12:25:10 UTC with
`result=published`. The approximately 181-second propagation delay required only
read retries, with no manual rerun or repeated publication.

A fresh npm `@dev` install with an isolated cache passed all 35 CLI contract tests,
version/help, tarball/lockfile integrity checks and npm signature verification.
Provenance identified the expected repository, develop ref, workflow, source
commit and attempt 1. `dev=0.1.0-dev.5`; `latest` remained `0.1.0-dev.1`.
These registry checks are separate from the development-service smoke below.

## Initial local automation validation (before publication)

On Node.js 24.15.0, lint, type checking and all 46 source tests passed, including
six release-automation tests. The tests cover deterministic first-parent version
numbers, numeric channel ordering, stale commits, registry lookup failures,
artifact/commit conflicts, identical reruns and uncertain publication outcomes.
Registry writes use an injected fake npm runner; no package was published.
A real read-only npm lookup also confirmed the structured E404 handling.

A temporary local Git repository and bare remote exercised the actual prepare
command, including rejected PR/wrong-commit contexts and stale remote heads.
A separate clean source copy generated `0.1.0-dev.2`, installed locked
dependencies, packed and installed the generated artifact, and passed all 35
installed-CLI contracts. Its source `gitHead` and license metadata were preserved
and its Git HEAD did not change. The normal `0.1.0-dev.1` artifact also passed
all 35 installed-CLI contracts.

`actionlint` 1.7.12 accepted the combined CI/publishing workflow. The existing
`Node.js 22` and `Node.js 24` check names are retained. Publishing needs both jobs
and is restricted to explicit releases or opted-in develop pushes. The repository
variable enabling automatic dev publication was not set during this validation.
At that stage, OIDC authentication, registry writes, provenance and GitHub job
ordering were unverified. The later publication evidence above supersedes that
limitation; it does not turn these original local tests into live registry writes.

## Authenticated development-project smoke

Tested the CLI from develop commit `a040f53` (version `0.1.0-dev.1`, SDK `0.5.1`)
with Node.js 24.15.0 against the development target supplied by the maintainer in
the primary checkout's ignored `.env.local`. The designated development target is:

- Endpoint: `https://internal-dev-aws-apne2-v3-c05a2b5d492a.lambdadb.ai`
- Project: `bench-recall`

The API key is excluded from this record. The file used `LAMBDADB_BASE_URL`,
`LAMBDADB_PROJECT_NAME`, `LAMBDADB_PROJECT_API_KEY` and an explicit
`LAMBDADB_RUN_LIVE_TESTS=1`. An in-memory launcher mapped the first three to
`LAMBDADB_ENDPOINT`, `LAMBDADB_PROJECT`, `LAMBDADB_API_KEY`, and supplied the
confirmed development project as `LAMBDADB_LIVE_CONFIRM_PROJECT` for this run.
Neither the file nor the CLI's environment-variable contract was changed.

After `npm run build`, the launcher ran `node --test test/live/cli.test.mjs`:

- The original 75-second query observation window failed after writes were
  accepted. This was a failed smoke, not proof of a service or CLI defect.
- The follow-up harness allows up to 300 seconds per read stage, matching the
  SDK live smoke's committed-document observation window. It reports elapsed
  time and matched-document counts without printing responses or credentials.
- The follow-up run passed: doctor and creation completed within the first
  second; two ordinary writes (3 MiB payload each) and one bulk write were
  accepted at about 2 seconds. Query returned all three expected documents with
  exact contents at about 65 seconds, and ID fetch verified them at about 66
  seconds. Both reads selected `branch:main` without a pending-write overlay.
- Cleanup was accepted for both temporary collections. Subsequent SDK get calls
  returned `ResourceNotFoundError` for
  `cli-smoke-9797d164-abb3-4a7e-ae26-f5ae251ad72c` and
  `cli-smoke-b926fd65-c371-462f-9727-9d5d9edecc1c`, confirming their absence.

The two runs demonstrate variable observation time; 300 seconds is a test budget,
not a readiness or latency guarantee. Full content was verified for a combined
response above 6 MiB, but the CLI harness did not inspect the service's wire
response to prove selection of `docsUrl`. Live tag/alias reads remain unverified.

### Review follow-up: enforce the observation budget

The harness now uses a monotonic deadline, caps CLI and child-process timeouts
to the remaining budget, and limits the final polling sleep. It checks the
deadline after each observation, including content comparison, before accepting
success. Process termination and event-loop scheduling can delay reporting, but
a response at or after the deadline cannot pass the stage.

On Node.js 24.15.0, lint, type checking and all 53 source tests passed. Seven new
deterministic tests cover timely success, late success/failure, success exactly
at the deadline, a capped final sleep, an in-flight timeout and an earlier fatal
error. The regression reproduces a response arriving at 318 seconds and rejects
it; the final request receives only the remaining 2-second budget.
The packed and separately installed CLI also passed all 35 contract tests.

Re-ran `node --test test/live/cli.test.mjs` with this review fix in the working
tree based on `6642eeb`, using the same designated endpoint/project and launcher
above. The CLI runtime source remained identical to `a040f53`; SDK version was
`0.5.1`. Doctor and collection creation passed within the first second, ordinary
and bulk writes were accepted at about 3 seconds, and exact query/fetch contents
passed at about 91 seconds (test duration: 91.231 seconds). Both reads used
`branch:main`. Cleanup was accepted for
`cli-smoke-3cb15833-414d-4265-9b57-70df164b28ef`; a subsequent SDK get returned
`ResourceNotFoundError`, confirming absence. Deadline boundary cases were
verified deterministically above, not by inducing a live service timeout.

## 0.1.0-dev.1 release preparation

Revalidated on 2026-09-18 in a fresh worktree based on develop commit `52e7aa2`
with Node.js 24.15.0 and npm 11.12.1. `npm ci`, lint, type checking and version
checks passed. Source tests passed (40), and the separately installed tarball's
CLI tests passed (35), with no failures or skips. The version assertion now
compares the executable against package metadata instead of a fixed version.

`RELEASE_TAG=v0.1.0-dev.1 RELEASE_PRERELEASE=true npm run check:version -- --release`
passed and selected the `dev` channel. This checks release metadata only; it does
not publish or establish main ancestry, npm permissions or live-service behavior.
At the initial release-preparation stage no development connection settings were
supplied, so live validation was not attempted then. See the later smoke above.

## Completed local validation

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed with TypeScript 5.8.3. |
| `npm run lint` and `npm run check:version` | Passed; package and lockfile metadata agree. |
| `npm test` on Node.js 24.15.0 | 40 tests passed, zero failed or skipped. |
| Prior CLI MVP suite on Node.js 22.23.2 via `npm exec --yes --package=node@22 -- node --test test/*.test.mjs` | 40 tests passed, zero failed or skipped; new automation tests are recorded separately above. |
| Fresh temporary source directory: `npm ci`, `npm run build`, CLI version | Passed without the development checkout's node_modules or dist. |
| `npm run test:package`: pack, inspect inventory, install in a temporary consumer, invoke executable version/help and repeat CLI contracts | 35 installed-CLI tests passed on Node 24. Package was never published. |
| `actionlint` on CI and publish workflows | Passed. This is static validation, not an OIDC publication. |
| Live command without opt-in | Expected nonzero exit before network calls; not counted as a live test pass. |
| npm install dependency audit | Zero vulnerabilities reported at installation time. |
| Apache-2.0 license packaging | Official license text from apache.org is included byte-for-byte as `package/LICENSE` in the built tarball; package.json and lockfile license metadata agree. |
| Reference SDK status and specified sbrain file status | Unchanged. |

Tests use the actual published SDK and CLI subprocesses; they do not replace the
SDK with a fake client for transport tests. The workflow unit tests separately
cover byte accounting and cancellation between batches.

## Behavior exercised

- Configure, doctor, create (HTTP 201), JSONL upsert (HTTP 202), query, fetch,
  describe and paginated collection listing.
- Exact branch/tag/alias request bodies and result targets on query and fetch;
  write branch forwarded on ordinary and bulk requests.
- SDK pagination with an opaque continuation token.
- SDK bulk metadata, signed headers, upload body and finalization; no project
  credential sent to object storage.
- SDK offloaded query/fetch downloads for each ref kind, including 1 MiB returned
  document bodies; consumed signed URLs omitted from CLI output.
- Complete-file preflight rejects malformed later JSONL lines, invalid IDs,
  empty files and oversized individual batch entries before any request.
- Invalid query fields, conflicting file/flag refs, invalid query size and
  branch-only consistency constraints rejected before requests.
- Query `size: null` normalized to SDK omission and branch consistency forwarded.
- Accepted/rejected/not-attempted batch counts and physical line ranges.
- Disconnect, HTTP 503, malformed 202 and timeout classified as unknown writes
  without mutation retries, preserving previously accepted batches.
- Failed bulk upload not retried or finalized; reported conservatively as unknown
  because the SDK helper has no structured error stage.
- Shared deadline applies to API calls, signed downloads and signed uploads;
  cancellation between batches leaves unsent rows not attempted.
- Actual SIGINT/SIGTERM during an active second write preserve the accepted first
  batch, mark the active batch unknown and leave the third batch unattempted.
- Release channels and rejection of version drift, invalid tags/flags, private
  publication and missing license metadata.
- Empty results succeed; 401/403 authentication failures, other API failures and
  invalid response schemas fail; creation conflicts differ from uncertain writes.
- All documented exit codes, JSON parseability, stdout/stderr separation, human
  summaries, help and version.
- Flag/environment/saved-config precedence, explicit missing config, missing
  selected key, custom key-variable names and POSIX config file mode 0600.
- SDK debug suppression and credential redaction in errors and returned documents,
  including secret strings containing JSON structural characters.
- Short keys preserve JSON envelope fields, CLI command/state/check tokens,
  ref kinds and error codes. Arbitrary document/index/tag keys and variable
  values remain redacted; human output retains its structured data section.
- Redacted map-key collisions preserve all entries and unchanged field names.
  Query/fetch regressions cover both input orders, multiple colliding renamed
  keys, preexisting suffixes and nested maps; collection metadata covers tag and
  index-config collisions. Generated suffixes cannot overwrite reserved names.
- Exactly 100,000 documents are accepted by input preflight; excess rows are
  rejected with their physical line number, excluding blank lines from the count.
  CRLF and a final line without a newline are covered.
- A 3 MB file of one million small documents exits 2 before any API request under
  a 128 MiB V8 heap limit. The pre-fix reader reproduced heap exhaustion with
  that input. Ten million blank lines followed by invalid JSON also exit 2 within
  that heap limit, preserving the final line number without a split array.

## Source and public-contract inspection

Verified npm latest and installed SDK 0.5.1; checked current local SDK source and
published OpenAPI/quickstart. Evidence revisions and compatibility findings are
in [DESIGN.md](DESIGN.md). These checks establish the chosen contract, not the
deployment state of an individual LambdaDB endpoint.

## Not performed / not established

- The live smoke verifies one designated development target and a bounded sample;
  it does not establish general query/index readiness, search ranking, managed
  embedding behavior, exhaustive signed-storage policies or production-scale
  performance. Credentials were not searched for in other repositories.
- No proof of exactly-once delivery, durable resume, or a committed-through write
  receipt. Those capabilities are not implemented.
- No Windows-specific permission or signal validation. POSIX modes and injected
  SIGINT/SIGTERM were checked on macOS; CI targets Linux.
- Mock large-response tests cover SDK routing/credential separation at 1 MiB;
  the live sample verifies combined content above 6 MiB. Neither is an exhaustive
  memory/size stress test. Imports buffer a maximum 64 MiB source file
  and retain at most 100,000 documents. Complex documents can still use much more
  memory than their serialized size; the count limit is not a process memory cap.

## Requirements for live verification

Follow the explicit settings and `npm run test:live` procedure in
[RELEASING.md](RELEASING.md#explicit-live-smoke). The authenticated main-branch
flow and cleanup have been exercised as recorded above. For non-main refs,
supply existing development branch/tag/alias
targets whose expected contents are known. Record evidence without keys or signed
URLs. Temporary collection deletion is performed by the harness through the SDK,
not exposed as a CLI command.

During expanded validation, a second-write timeout hung repeatedly in the source
and installed package. An explicit timer alone was insufficient; binding the
command signal through SDK HTTPClient fetch dispatch resolved the observed local
regressions. See [DESIGN.md](DESIGN.md) for the compatibility boundary; the exact
upstream cause is not claimed. Commits, pushes and CI runs are recorded in Git
and the pull request; local checks do not imply service or publication success.
