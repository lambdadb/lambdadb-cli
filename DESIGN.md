# LambdaDB CLI MVP design

## Evidence baseline

Inspected on 2026-09-18. Source/API verification is not live-service validation.

| Evidence | Observed contract |
| --- | --- |
| [TypeScript SDK source](https://github.com/lambdadb/lambdadb-typescript-client/tree/856abf48a014185de54ccc541c2f6ee3871133ee) | Local reference checkout was clean at this commit, version 0.5.1. |
| npm `@functional-systems/lambdadb` registry | `latest=0.5.1`; installed published package exactly at 0.5.1, not a local file dependency. |
| [Public OpenAPI](https://github.com/lambdadb/docs/blob/9a4eaf1e71b7809708a77101751ce2a5c4815fcb/reference/api/openapi.json) | API version 1.1.1; collection create 201, ordinary/bulk write acceptance 202, ref-aware query/fetch, no generic mutation-readiness receipt. |
| [Public quickstart](https://docs.lambdadb.ai/guides/get-started/quickstart) | Existing Console project/key setup, collection creation, writes, reads and eventual visibility. |

Fetched OpenAPI SHA-256:
`ad930a79ab27115a326bde6dff69c472670f8ba0eda65dde1c5f01ff76678563`.
Published SDK integrity:
`sha512-AvchiWlbV9r7ihizmBG+oacwzXAvq9WKHoEmXYCkkHbWVBBvunwlxyzKQBd+0V2q2XjIkNKhHBZ3ytAhj1pArg==`.
Installed `client.ts` and query request schema matched the inspected local source.
The lockfile pins the dependency graph.

Read-only design inputs:

- `/Users/steven/orca/projects/sbrain/AGENTS.md`
- `/Users/steven/orca/projects/sbrain/projects/lambdadb-code-search-demo.md`
- `/Users/steven/orca/projects/sbrain/knowledge/product/lambdadb-mcp-server-design.md`
- `/Users/steven/orca/projects/sbrain/knowledge/product/lambdadb-mcp-implementation-plan.md`
- `/Users/steven/Dev/lambdadb-typescript-client`

The code-search document describes an application proposal, not delivered generic
CLI behavior. The MCP design's hosted authentication, readiness workflows and
workflow SDK additions are proposals. Its September 14 registry baseline
(`latest=0.4.3`, versioning RC) is superseded by the verified 0.5.1 publication.
This CLI reuses currently available SDK capabilities; it does not assume proposed
`ingestDocuments`, `waitForDocuments` or mutation receipts exist.

## Architecture

```text
CLI arguments/configuration → input validation → SDK facade → LambdaDB APIs
                                      ↓              ↓
                              import workflow   signed transfers
                                      ↓
                         structured result / terminal output
```

- `cli.ts`: command tree, target selection, SDK calls and process exit codes.
- `config.ts`: deterministic user-local configuration, environment auth and
  atomic non-secret settings writes.
- `input.ts`: bounded file snapshots, strict request preflight, SDK serializer
  reuse and the small null-size compatibility adjustment.
- `import-workflow.ts`: byte/count batching, sequential submission, honest
  outcome accounting and progress callbacks, independent of terminal I/O.
- `runtime.ts`: SDK construction, shared abort deadline and bounded read retries.
- `errors.ts` and `output.ts`: safe error classification, versioned output and
  credential redaction.

There is no second HTTP implementation, separate workflow package, plugin system
or SDK fork. `listCollectionsPages` owns pagination. `bulkUpsertDocs` owns upload
metadata, signed PUT, server-provided byte limit and finalization. Query/fetch
helpers own presigned response downloads and authentication isolation.

## Contract decisions

| Decision | Reason |
| --- | --- |
| Mandatory endpoint/project resolution, explicit collection, read ref and write branch | Avoid SDK playground/main fallbacks silently choosing a target. |
| Environment-held keys only | Keeps secrets out of argv and repository/user configuration files. |
| Read retry policy bounded through SDK, no mutation retries | No public exactly-once or mutation receipt contract; a missing reply cannot prove rejection. |
| Entire JSONL preflight before writes | A malformed later line must not unexpectedly leave accepted earlier batches. |
| 64 MiB input cap, 4 MB ordinary batches, configurable bulk batches | Bound initial memory/transport use without building streaming/checkpoint infrastructure. |
| SDK request serializers for validation | Keep create/query shapes aligned; query DSL semantics remain server-owned. |
| Versioned JSON envelope and documented exits | Stable automation contract with explicit target and partial progress. |
| Conservative unknown state for untyped bulk helper failures | Error strings are not a reliable upload/finalization stage contract. |
| No readiness wait or version-management commands | First use works through main; reads can target existing refs, without assuming lifecycle or indexing guarantees. |

The public API documents ordinary upsert at 6 MB and bulk at 200 MB; CLI limits
are deliberately smaller. Bulk is unsupported for managed embedding vector
fields. `consistentRead` only supports direct branches and excludes pending bulk
imports. Collection statistics describe committed main, not selected ref readiness.

## SDK compatibility findings

No upstream edit was required. Local regressions cover these adaptation points:

1. Public query `size: null` means default size, but SDK 0.5.1's serializer accepts
   only number/undefined. Normalize null to omission and enforce public 1–100 bounds.
   An upstream schema-alignment change would remove this adapter.
2. `SDKValidationError[Symbol.hasInstance]` intentionally also matches
   `ResponseValidationError`. Check response validation first and exclude it from
   local input errors; otherwise a malformed 202 response is misclassified as a
   definite local failure rather than an unknown write outcome.
3. SDK debug logging is environment-controlled. Supplying a no-op logger still
   clones/drains HTTP bodies. An initial loopback timeout regression left the
   process alive with that logger. The CLI instead removes `LAMBDADB_DEBUG` from
   its own process before SDK construction and supplies no logger. The same
   timeout case now completes and preserves the unknown outcome.
4. The bulk helper throws ordinary unstructured errors for upload and size
   failures. A future typed stage/error contract would enable more precise
   failed-versus-unknown reporting. The current CLI never parses error messages
   or claims a finalize receipt.
5. Expanded installed-package tests reproduced a stalled second upsert despite a
   600 ms command timeout on Node 24.15.0. Retaining an explicit timer alone did
   not eliminate it. The CLI now binds its command signal directly at fetch
   dispatch through the SDK's supported HTTPClient hook, for separate API and
   transfer clients. SDK authentication, request construction, retry and transfer
   logic remain in use. Local source and installed-package regressions verify
   timeout and SIGINT/SIGTERM accounting. The precise upstream/runtime root cause
   has not been established; no reference SDK source was changed.

These findings do not require a new SDK release to use the CLI. SDK updates should
retain contract tests before changing the pinned version.
