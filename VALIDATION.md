# Validation record

Date: 2026-09-18. Local contract tests use loopback servers and synthetic
credentials. A separate authenticated development-project smoke is recorded below.

## Automatic development-release validation

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
Actual OIDC authentication, registry writes, provenance and GitHub job ordering
remain unverified until the first authorized automated publication.

## Authenticated development-project smoke

Tested the CLI from develop commit `a040f53` (version `0.1.0-dev.1`, SDK `0.5.1`)
with Node.js 24.15.0 against the development target supplied by the maintainer in
the primary checkout's ignored `.env.local`. Target values and credentials are
not copied into this public record. The file used `LAMBDADB_BASE_URL`,
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
- No npm publication, Trusted Publisher configuration, registry provenance or
  release-workflow execution. The `0.1.0-dev.1` candidate sets `private: false`
  and targets the `dev` channel. npm organization permissions, authorized
  bootstrap publication, trust setup and automatic-dev activation remain pending.
  Main promotion is required for explicit rc/stable releases;
  Apache-2.0 is recorded in LICENSE and package metadata.
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
