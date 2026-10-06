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

## SDK 0.6.0 contract update (2026-09-29)

The published dependency is pinned to `@functional-systems/lambdadb@0.6.0`.
The [release tag](https://github.com/lambdadb/lambdadb-typescript-client/releases/tag/v0.6.0)
resolves to `491d01e0eb54bd135823fab79cbe32396ec03691`; npm `latest` was 0.6.0
when checked. The historical MVP baseline above remains a dated record.

Inspected the installed package's `src/models/operations/querycollection.ts`,
`src/models/indexconfigsunion.ts` and `src/client.ts`; all three matched the release
tag byte-for-byte. The query serializer accepts
omitted `query`, validates up to five strict facet requests with nullable 1–100
bucket sizes, and requires nonempty facets for `size: 0`. It enforces integer
query size but lacks document-size bounds, so the CLI retains only the 0–100
range check and null-to-omission adapter. Ref conflicts remain CLI-owned;
Branch-only `consistentRead` validation stays with the SDK. The create serializer
accepts all 16 analyzer names without a CLI allowlist. Omission, empty lists,
duplicates and ordering pass through unchanged; duplicate rejection is server-owned.

The query facade spreads response metadata when downloading `docsUrl`; CLI JSON
preserves `facets` while removing the consumed signed URL. Facet field names join
other user-defined maps in credential redaction, including collision preservation;
fixed facet result/bucket keys retain their SDK schema even for short credentials.
Loopback subprocess tests cover serialization and output through the published SDK,
and the installed-tarball suite repeats these contracts. Live evidence is separate
in [VALIDATION.md](VALIDATION.md).

## SDK 0.7.0 contract update (2026-10-04)

The native dependency and npm lockfile now pin
`@functional-systems/lambdadb@0.7.0`. Reviewed the
[release](https://github.com/lambdadb/lambdadb-typescript-client/releases/tag/v0.7.0),
[reranking](https://github.com/lambdadb/lambdadb-typescript-client/blob/v0.7.0/docs/managed-reranking.md),
[analyzer](https://github.com/lambdadb/lambdadb-typescript-client/blob/v0.7.0/docs/models/analyzer.md)
and [Qdrant](https://github.com/lambdadb/lambdadb-typescript-client/blob/v0.7.0/docs/compatibility/qdrant.md)
contracts and installed request/response schemas. Earlier sections describe
historical versions, rather than the current dependency.

There are no copied SDK models, analyzer allowlists, migration mappings or UI
components here. Create/query preflight delegates to SDK serializers. The CLI
retains its existing null-size adapter, 0–100 size bound and ref-conflict check.
The SDK owns rerank validation; CLI diagnostics now mention it. Analyzer omission,
ordering and lowercase selection remain unchanged. No collection rerank setting,
provider key, custom analyzer configuration or vector-k rewrite was introduced.

The query command forwards the SDK result except the consumed signed URL. Output
redaction preserves numeric values and array order. Regression tests exercise
applied, skipped, fallback and unused responses, zero/precision, metadata and
inline/downloaded results. Request cases cover raw-vector query text, independent
sizes, custom criteria, null/omitted settings and validation before HTTP. The
installed-package suite repeats the same CLI tests against a clean consumer.
Facet query compatibility and stored candidate field validation remain server-owned.

This repository does not import the Qdrant compatibility client or accept Qdrant
payload schemas. No local migration change applies. SDK consumers of that adapter
must now explicitly reject or resolve extra schema options: only a supported
`type` is mapped, and options such as `analyzers`, `tokenizer` and `lowercase`
raise `UnsupportedQdrantFeatureError`. Type-only mapping is unchanged; use native
index configurations for LambdaDB presets rather than silently dropping options.

No model/code generation command exists in this repository. TypeScript build
output is ignored and generated by `npm run build`/`prepack`; verify reproducible
output and the installed tarball, without checking generated files into Git.
Server deployment and live readiness are separate dependencies, not consequences
of upgrading this CLI.

## SDK 0.8.0 contract update (2026-10-06)

The runtime and lockfile pin stable `@functional-systems/lambdadb@0.8.0`.
The [release](https://github.com/lambdadb/lambdadb-typescript-client/releases/tag/v0.8.0),
[Bayesian contract](https://github.com/lambdadb/lambdadb-typescript-client/blob/v0.8.0/docs/bayesian-search.md)
and [native embedding contract](https://github.com/lambdadb/lambdadb-typescript-client/blob/v0.8.0/docs/native-embeddings.md)
are pinned to backend `9072a1bc8925954369a887f558f1eaf387b7ea0e`.

Query files can now carry top-level Bayesian `candidateSize`. No query flags,
DSL parsing, fusion weights, defaults or result projections were introduced.
SDK serializers still own request shape validation; Bayesian semantics remain
server-owned, preserving HTTP status classification and exit codes. The CLI
retains null-size normalization, its existing size bound and explicit ref checks
in the same order. JSON and human output retain full document envelopes,
`retrievalScore` and rerank metadata, including SDK-downloaded results.

Create accepts embedding-only vector settings through the SDK union. The new
`collections update --collection NAME --index-config FILE` uses the same map
input convention and the SDK update serializer/facade. It has the same preflight,
no-retry mutation policy and unknown-write classification as create. It exposes
index configuration only; other Collection management is outside this change.
The server owns permissible index transitions. Neither command infers the legacy
flag, embedding provider/model, dimensions or similarity. Explicit legacy true
remains available for older servers.

Adjacent describe/list commands already pass through SDK Collection metadata;
fetch/query already delegate docsUrl to the SDK and preserve full results. Import
retains its existing bounded preflight and ordinary/bulk behavior; native
embeddings use ordinary upsert. No changes to those flows were needed.

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
| 64 MiB / 100,000-document input caps, 4 MB ordinary batches, configurable bulk batches | Bound file size and retained row overhead without building streaming/checkpoint infrastructure; scan lines without a full split array. |
| SDK request serializers for validation | Keep create/query shapes aligned; query DSL semantics remain server-owned. |
| Versioned JSON envelope and documented exits | Stable automation contract with explicit target and partial progress. |
| Preserve fixed output keys/tokens during redaction | Short credentials must not corrupt the CLI protocol; redact variable values and arbitrary document/index/tag map keys. |
| Conservative unknown state for untyped bulk helper failures | Error strings are not a reliable upload/finalization stage contract. |
| No readiness wait or version-management commands | First use works through main; reads can target existing refs, without assuming lifecycle or indexing guarantees. |

The public API documents ordinary upsert at 6 MB and bulk at 200 MB; CLI limits
are deliberately smaller. Bulk is unsupported for managed embedding vector
fields. `consistentRead` only supports direct branches and excludes pending bulk
imports. Collection statistics describe committed main, not selected ref readiness.

## SDK compatibility findings

No upstream edit was required. Local regressions cover these adaptation points:

1. Public query `size: null` means default size, but SDK 0.6.0's serializer accepts
   only number/undefined. Normalize null to omission and enforce 0–100 bounds;
   SDK validation requires facets when size is zero.
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
