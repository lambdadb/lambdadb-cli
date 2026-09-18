# Validation record

Date: 2026-09-18. All test requests used loopback servers and synthetic credentials.
No LambdaDB service was contacted for runtime validation.

## Completed local validation

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed with TypeScript 5.8.3. |
| `npm test` on Node.js 24.15.0 | 28 tests passed, zero failed or skipped. |
| Same test suite on Node.js 22.23.2 via `npm exec --yes --package=node@22 -- node --test test/*.test.mjs` | 28 tests passed, zero failed or skipped. |
| Fresh temporary source directory: `npm ci`, `npm run build`, CLI version | Passed without the development checkout's node_modules or dist. |
| Local `npm pack`, install tarball in a separate temporary consumer, invoke installed `lambdadb --version` and `--help` | Passed. Package was never published. |
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
- Empty results succeed; 401/403 authentication failures, other API failures and
  invalid response schemas fail; creation conflicts differ from uncertain writes.
- All documented exit codes, JSON parseability, stdout/stderr separation, human
  summaries, help and version.
- Flag/environment/saved-config precedence, explicit missing config, missing
  selected key, custom key-variable names and POSIX config file mode 0600.
- SDK debug suppression and credential redaction in errors and returned documents,
  including secret strings containing JSON structural characters.

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
- No Windows-specific permission or signal validation. POSIX modes were checked
  on macOS. SIGINT/SIGTERM share the abort path; the process-signal path itself was
  not separately injected in this suite.
- Large response tests cover SDK routing/credential separation at 1 MiB, not an
  exhaustive memory/size stress test. Imports buffer a maximum 64 MiB source file,
  and parsed/serialized memory can exceed that size.

## Requirements for live verification

Supply an explicitly designated development `LAMBDADB_ENDPOINT`,
`LAMBDADB_PROJECT` and `LAMBDADB_API_KEY` (or configured key-variable name).
Use a new development collection and execute the README first-use flow. Query and
fetch expected IDs and contents with `consistentRead: false` after acceptance.
For non-main ref validation, supply existing development branch/tag/alias targets
whose expected contents are known. Record actual request/result evidence without
keys or signed URLs. Collection deletion is not part of this CLI MVP.

The working branch is `feat/cli-mvp`. At the time of the local MVP validation,
no commit, push, publication, deployment or remote repository creation had been
performed. Subsequent commits and pushes are recorded in Git history.
