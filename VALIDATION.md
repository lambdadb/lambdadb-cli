# Validation record

Date: 2026-09-18. All test requests used loopback servers and synthetic credentials.
No LambdaDB service was contacted for runtime validation.

## Completed local validation

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed with TypeScript 5.8.3. |
| `npm run lint` and `npm run check:version` | Passed; package and lockfile metadata agree. |
| `npm test` on Node.js 24.15.0 | 38 tests passed, zero failed or skipped. |
| Same test suite on Node.js 22.23.2 via `npm exec --yes --package=node@22 -- node --test test/*.test.mjs` | 38 tests passed, zero failed or skipped. |
| Fresh temporary source directory: `npm ci`, `npm run build`, CLI version | Passed without the development checkout's node_modules or dist. |
| `npm run test:package`: pack, inspect inventory, install in a temporary consumer, invoke executable version/help and repeat CLI contracts | 33 installed-CLI tests passed on Node 24. Package was never published. |
| `actionlint` on CI and publish workflows | Passed. This is static validation, not an OIDC publication. |
| Live command without opt-in | Expected nonzero exit before network calls; not counted as a live test pass. |
| npm install dependency audit | Zero vulnerabilities reported at installation time. |
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

- No authenticated live-service validation: the task did not designate a
  development project and credential set. Credentials were not searched for in
  other repositories.
- No proof of live query/index readiness, search ranking, managed embedding
  behavior, real signed-storage policies, or production-scale performance.
- No proof of exactly-once delivery, durable resume, or a committed-through write
  receipt. Those capabilities are not implemented.
- No Windows-specific permission or signal validation. POSIX modes and injected
  SIGINT/SIGTERM were checked on macOS; CI targets Linux.
- No npm publication, Trusted Publisher configuration, registry provenance or
  release-workflow execution. Private-package preflight intentionally blocks
  publication. Package ownership and licensing remain first-release decisions.
- Large response tests cover SDK routing/credential separation at 1 MiB, not an
  exhaustive memory/size stress test. Imports buffer a maximum 64 MiB source file
  and retain at most 100,000 documents. Complex documents can still use much more
  memory than their serialized size; the count limit is not a process memory cap.

## Requirements for live verification

Follow the explicit settings and `npm run test:live` procedure in
[RELEASING.md](RELEASING.md#explicit-live-smoke). The new live harness has only had
its missing-opt-in failure exercised locally; its authenticated flow and cleanup
remain unverified. For non-main refs, supply existing development branch/tag/alias
targets whose expected contents are known. Record evidence without keys or signed
URLs. Temporary collection deletion is performed by the harness through the SDK,
not exposed as a CLI command.

During expanded validation, a second-write timeout hung repeatedly in the source
and installed package. An explicit timer alone was insufficient; binding the
command signal through SDK HTTPClient fetch dispatch resolved the observed local
regressions. See [DESIGN.md](DESIGN.md) for the compatibility boundary; the exact
upstream cause is not claimed. Commits, pushes and CI runs are recorded in Git
and the pull request; local checks do not imply service or publication success.
