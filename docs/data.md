# Data commands and output

[CLI overview](../README.md) · [Setup](setup.md) · [Agents](agents.md) · [Account and usage](account.md) · [Data commands](data.md)

## Query existing data

Init does not query documents or create collections/data. Connection success does
not establish search readiness. The setup result includes a read-only agent
prompt. To inspect data directly, list collections and choose an existing
collection:

```sh
lambdadb collections list --json
lambdadb collections describe --collection YOUR_COLLECTION --json
```

Save `{"size":5}` in `first-query.json`, then read up to five documents:

```sh
lambdadb query --collection YOUR_COLLECTION --ref branch:main --file first-query.json --json
```

Omitting `query` reads sample documents. Inspect the index configuration before
searching an actual indexed field.

An empty project needs deliberately supplied data outside init. Empty results
are not evidence of indexing failure or readiness.

## Command examples

The JSON files below are included in the package under `examples/`. Copy the
files you need into your working directory before running these examples.

### Try sample data in a development project

Only run the following against a project explicitly designated for development.
Connect to the project first, then replace `cli-demo-docs` with a new, unique
collection name. These commands create a collection and write sample documents;
`init` does neither.

```sh
lambdadb doctor
lambdadb collections list --size 20
lambdadb collections create --collection cli-demo-docs --index-config examples/index-config.json
lambdadb collections describe --collection cli-demo-docs
lambdadb docs import --collection cli-demo-docs --branch main --file examples/documents.jsonl
lambdadb query --collection cli-demo-docs --ref branch:main --file examples/query.json
lambdadb docs fetch --collection cli-demo-docs --ref branch:main --ids doc-1 doc-2 doc-3
```

Collection creation returns `state: "created"`. Import returns accepted counts,
not committed or searchable counts. Both explicitly report
`searchable: "not_verified"`. The sample query uses `consistentRead: false`.
The first query/fetch can therefore be empty or encounter a transient loading
error. Repeat reads after an appropriate delay and inspect expected IDs and
contents; do not recreate the collection or blindly replay the import as a wait
mechanism. There is no CLI readiness endpoint or readiness polling claim.

For eligible ordinary writes, `docs fetch --consistent-read` or a query file
with `"consistentRead": true` can overlay pending writes when reading a direct
branch. This does not establish committed indexing, excludes pending bulk
imports, can return `429`, and is rejected for tag/alias refs.

### Collections

```sh
lambdadb collections list --all --size 100 --json
lambdadb collections list --page-token 'TOKEN_FROM_PREVIOUS_RESULT' --json
lambdadb collections describe --collection cli-demo-docs --json
```

One page is the default; `nextPageToken` is an opaque continuation token.
`--all` uses the SDK page iterator and buffers its result within the total network
budget. No partial list is printed on failure. Collection statistics describe
the committed head of `main`, not the selected read ref or whole-index readiness.
Both create and update take the index map itself through `--index-config`, not a
full request body. Updates are subject to server index-change restrictions and
return `state: "updated"`, `searchable: "not_verified"`; acceptance does not prove
query readiness.

<details>
<summary>Text analyzer presets</summary>

The CLI accepts 49 fixed lowercase text analyzer presets:
`standard`, `english`, `korean`, `japanese`, `chinese`, `cjk`, `arabic`,
`french`, `german`, `hindi`, `indonesian`, `italian`, `portuguese`, `russian`,
`spanish`, `turkish`, `armenian`, `basque`, `bengali`, `brazilian`, `bulgarian`,
`catalan`, `czech`, `danish`, `dutch`, `estonian`, `finnish`, `galician`, `greek`,
`hungarian`, `irish`, `latvian`, `lithuanian`, `norwegian`, `persian`, `romanian`,
`serbian`, `sorani`, `swedish`, `thai`, `simple`, `whitespace`, `stop`, `keyword`,
`pattern`, `fingerprint`, `nepali`, `tamil` and `telugu`.
For example, `{"text":{"type":"text","analyzers":["chinese"]}}` is a valid
index-config file. Omission preserves the `standard` server default; lists are
sent unchanged. The server rejects duplicate names. Custom pipelines/options
are unsupported, and language detection is not automatic. The `keyword` text
analyzer does not confer keyword field sorting/facets. Nepali/Tamil/Telugu are
Lucene extensions, not common Elasticsearch/OpenSearch support. See the
[SDK analyzer contract](https://github.com/lambdadb/lambdadb-typescript-client/blob/v0.7.0/docs/models/analyzer.md).

</details>

### Native embeddings and Bayesian search

```sh
lambdadb collections create --collection native-docs --index-config examples/index-config-native.json --json
lambdadb docs import --collection native-docs --branch main --file examples/documents.jsonl --json
lambdadb query --collection native-docs --ref branch:main --file examples/query-bayesian.json --json
lambdadb query --collection native-docs --ref branch:main --file examples/query-bayesian-rerank.json --json
lambdadb collections update --collection native-docs --index-config examples/index-config-native.json --json
```

A vector configuration with `embedding` enables native embedding without a
`managedEmbedding` flag. Supply `provider`, `model` and `sourceField` explicitly;
no provider or model is chosen for you. Declare the source field as text and omit
the generated vector in imported documents. Use ordinary upsert, since bulk
import does not support embedding fields. Query with `knn.queryText`.
Optional native `dimensions` and `similarity` belong inside `embedding`.
`managedEmbedding: false` with embedding, or native top-level dimensions/similarity,
is rejected before a request. For older servers, explicitly add
`managedEmbedding: true` to the vector configuration. Normalized server metadata
may still contain this flag. Caller-supplied vectors retain top-level dimensions
and use `knn.queryVector`.

Bayesian hybrid search uses `query.bayesian` with exactly two subqueries. Neither
subquery nor any Boolean descendant may have an explicit `boost`, even `1`.
Nested rank-fusion queries are unsupported. No fusion weights are needed.
Without reranking, set top-level `candidateSize` so that
`1 <= size <= candidateSize <= 100`; omitted/null `size` uses the existing default
of 10. The candidate budget is per signal, independently of final result size.
With reranking, omit top-level `candidateSize` and use `rerank.candidateSize`,
whose default remains `max(50, size)`. The CLI does not insert budgets, weights,
or `knn.k`. Ordinary text/KNN/RRF/Min-Max/L2 requests retain their behavior and
must omit top-level `candidateSize`.

The free-form query DSL passes through unchanged; the server validates Bayesian
semantics and invalid requests remain API errors (exit 3). Local JSON/type errors
remain input errors (exit 2). Applied reranking retains the Bayesian score in
`retrievalScore` and the final score in `score`, with full documents and rerank
metadata in both JSON and human output.

These additions require a supporting deployment; their API contract is pinned to
backend `9072a1bc8925954369a887f558f1eaf387b7ea0e`. See the SDK 0.8.0
[Bayesian contract](https://github.com/lambdadb/lambdadb-typescript-client/blob/v0.8.0/docs/bayesian-search.md)
and [native embedding contract](https://github.com/lambdadb/lambdadb-typescript-client/blob/v0.8.0/docs/native-embeddings.md).
Newer servers [raise the candidate limit to 1,000](https://github.com/lambdadb/lambdadb/commit/963d79e8866833f1deb1393ed00a9825d866c853).
The top-level Bayesian `candidateSize` is forwarded unchanged and its upper bound
depends on the deployment. This CLI and its bundled SDK still limit final `size`
and `rerank.candidateSize` to 100; a higher server limit does not raise those local limits.

### Native reranking

```sh
lambdadb query --collection cli-demo-docs --ref branch:main \
  --file examples/query-rerank.json --json
```

Add optional `rerank` to a query file; omission/null keeps existing searches.
This is a per-query setting. The LambdaDB server supplies provider credentials;
you do not supply a Jev key.
Use `provider: "typesafe"`, `model: "jev-1.13.0"`, nonblank `queryText` (also for
raw vectors, up to 8 KiB UTF-8), and 1–8 unique stored scalar text `fields`.
Returned-field projection remains independent of these model inputs.
`candidateSize` defaults on the server to `max(50, size)` and must satisfy
`size <= candidateSize <= 100`. Final `size` is 1–100 (default 10); dense
`knn.k` stays unchanged and must be raised explicitly for more vector candidates.
Optional `criteria` replaces defaults with 2–10 distinct nonblank descriptions
ordered from low to high relevance (2 KiB each, 8 KiB total UTF-8).
Null optional settings use server defaults; the CLI does not insert them.

Reranking requires a scoring query and rejects `sort`, query-less requests and
filter-only queries. Existing lexical facet restrictions still apply; vector
and hybrid facets are not enabled. Facet-only `size: 0` works without reranking.
Selected candidate fields and model availability remain server validations.

Read `data.rerank.status` and its metadata. Applied document envelope `score` is
the final evaluation score, not a probability; `retrievalScore` retains the search
score. Output preserves zero, precision and server order, including `docsUrl`
downloads. Empty results report `skipped`/`noCandidates` with no `maxScore`.
Unused reranking omits metadata and `retrievalScore`. With `onFailure: "returnOriginal"`, eligible provider failures return retained search order/scores,
without `retrievalScore`, and report `fallback`; partial evaluations are discarded.
The default policy is `error`. Validation, authorization, retrieval, quota and
admission failures remain errors. See the
[full reranking contract](https://github.com/lambdadb/lambdadb-typescript-client/blob/v0.7.0/docs/managed-reranking.md).

These features need a supporting server deployment. SDK publication and shared
development checks do not establish production deployment, search quality,
load/failure coverage or billing readiness.

### Import JSONL

```sh
lambdadb docs import --collection cli-demo-docs --branch main \
  --file examples/documents.jsonl --batch-size 1000 --json

lambdadb docs import --collection cli-demo-docs --branch main \
  --file examples/documents.jsonl --mode bulk --timeout-ms 120000 --json
```

Input must be a UTF-8 regular file of at most 64 MiB and 100,000 documents.
Each nonblank line must be a JSON object; blank lines do not count toward the
document limit. Split files that exceed either limit before importing.
If supplied, `id` must be a nonempty string. Omitted IDs are
generated by the service and are not returned in the acceptance response; replay
can create duplicates. Existing IDs are upserted and can replace existing data.

The entire file is parsed and all batch sizes are checked before any network
call. This keeps a malformed later line from causing a partial write, at the
cost of buffering the input. Lines are scanned without allocating a separate
array of every line, and document retention stops at the count limit. This bounds
the overhead of many small documents, not the total process memory: large or
complex documents can still use much more memory than the raw file size. Batches run
sequentially and stop on the first failure. Counts count input records, not unique
IDs. Repeated IDs are sent in input order; server resolution within a batch is
not a CLI guarantee.

Ordinary upsert defaults to 1,000 documents and a 4,000,000-byte serialized
request cap including branch/envelope overhead. Bulk defaults to 1,000 documents
and 16,000,000 bytes; `--batch-bytes` allows up to 64,000,000. These are conservative
CLI limits, not advertised server maxima. The SDK also enforces the bulk limit
returned by the server. `--mode bulk` calls the existing SDK `bulkUpsertDocs`
helper with the selected branch, including signed upload headers and finalization.
Bulk is unsupported for native embedding vector fields; use ordinary upsert.

Import result fields are stable under `schemaVersion: 1`:

- `total`, `accepted`, `failed`, `unknown`, `notAttempted`: input record counts;
  their outcome counts sum to `total`.
- `batches`: attempted batch number, first/last physical JSONL lines, document
  count, state and a sanitized error where applicable.
- `state`: `accepted`, `failed`, `partial` or `unknown`.
- `searchable`: always `not_verified` in this MVP.

A definite HTTP rejection is `failed`. A disconnect, timeout, server error or
invalid success response after dispatch is conservatively `unknown`. An unknown
batch takes precedence over partial success in the exit code. The bulk SDK does
not expose structured failure stages for local/upload exceptions, so those also
use `unknown`; it can overstate uncertainty when upload failed before finalization.
The CLI does not parse SDK error strings to guess the stage. A deadline reached
between batches leaves unsent records `notAttempted`.

There are no durable checkpoints, automatic resume, exactly-once guarantees,
write retries or server mutation receipts. Inspect the selected branch and batch
line ranges before constructing a deliberate retry. Do not treat accepted counts
as a readiness check. A hard process kill may prevent any final report.

### Query and fetch at explicit refs

```sh
lambdadb query --collection cli-demo-docs --ref tag:release-one --file examples/query.json --json
lambdadb docs fetch --collection cli-demo-docs --ref alias:production --ids doc-1 --json
lambdadb docs fetch --collection cli-demo-docs --ref branch:main --ids doc-1 --consistent-read --json
```

These examples require the named ref to exist. Query files use the SDK/API
request body, with optional `query`, `facets`, `size`, `sort`, `fields`,
`partitionFilter`, `consistentRead`, `includeVectors`, `rerank` and Bayesian
`candidateSize`. The query DSL is forwarded
to the API, not reimplemented in the CLI. Unknown top-level fields are rejected.
Omit `query` for match-all. `size` accepts 1–100, `null`, or omission; null is
normalized to SDK omission. `size: 0` is accepted only with at least one facet.
An optional file `ref` must match the mandatory `--ref`; conflicting selectors
are rejected. Fetch accepts up to 100 IDs and reports `missingIds` without
turning a successful missing-document response into an error.

The SDK downloads large query/fetch responses from `docsUrl` automatically using
its separate unauthenticated transfer client. Results are buffered, not streamed
or truncated. The CLI omits the consumed signed URL. No ref is resolved to or
claimed to pin a snapshot by the CLI. Branches and aliases can move between calls.

### Keyword facets

After creating a new collection with `examples/index-config.json` and importing
`examples/documents.jsonl`, run:

```sh
# Match all documents and return only category counts (query is omitted).
lambdadb query --collection cli-demo-docs --ref branch:main --file examples/query-facets-only.json --json
# Return matching documents and category counts together.
lambdadb query --collection cli-demo-docs --ref branch:main --file examples/query-with-facets.json --json
```

Facet-only input: `{"size":0,"facets":{"category":{"size":10}}}`.
Up to five keyword fields can be requested, including keyword arrays and dotted
field paths. Each facet accepts only optional `size` (1–100); omission or `null`
uses the server default of 10. Counts are returned in
`data.facets.category.buckets`, for example
`[{"value":"database","count":2},{"value":"developer-tools","count":1}]`
for the facet-only sample after all three documents are indexed. `data.docs` is
empty for facet-only queries. Facets are retained when the SDK downloads documents
from `docsUrl` as well. Counts use JavaScript numbers and may lose precision above
`Number.MAX_SAFE_INTEGER`.

Facets require a supporting server and newly built keyword indexes. Existing
indexes, partial updates, segment merges and old Tags do not gain support from
this SDK update. If migration is needed, deliberately create a new Collection and
reinsert the source data; the CLI performs no automatic migration. Accepted imports
and `consistentRead` are not proof of committed facet/index readiness.

This source pins SDK 0.8.1. Existing CLI installations keep their packaged SDK
until a new CLI version is published and installed.

## Output, deadlines and exit codes

`--json` emits exactly one JSON object plus a newline on stdout for an executed
command, including failures. It contains `schemaVersion`, `command`, `ok`, optional
`target`, `data` and `error`. Target includes endpoint/project and, where relevant,
collection and explicit ref/branch. Errors use stable categories and safe hints.
API-specific response data may grow as the upstream API evolves. Help/version
remain plain text even with `--json`. Default output adds a readable summary and
pretty-printed data. Progress and diagnostics go only to stderr. No ANSI styling
is used. Only `init` prompts on a terminal; `init --non-interactive` and all
existing commands never prompt. `mcp` reserves stdout for MCP JSON-RPC and sends
startup failures to stderr rather than emitting the CLI JSON envelope.

Invalid command lines fail with `INPUT_ERROR` naming the missing required option,
the missing option argument, the invalid choice, or the unknown command or option
with a close-match suggestion. An unknown option written as `--flag=value` is
reported without its value. `lambdadb` alone prints help on stdout; a command
group such as `collections` without a subcommand prints its help on stderr and
exits 2. `error.hint` is empty when the message already states the next step,
such as a cancellation or a required login.

Credential redaction preserves fixed protocol field names and command, status,
ref-kind and error-code tokens, even when a credential coincides with one of
them. Values shorter than eight characters are not treated as credentials: no
issued key is that short, and redacting a placeholder such as `test` would
rewrite ordinary words. It redacts variable string values and arbitrary document, index-config
and tag-map keys. Returned data can therefore differ from the stored data when
it contains the selected credential; public protocol tokens remain unchanged.
If redacted map keys collide, unchanged keys keep their names and renamed keys
receive unique `#N` suffixes, skipping existing names. Every entry is retained,
with values still subject to credential redaction. Suffixes are local to each map.

| Exit | Meaning |
| --- | --- |
| `0` | Success, including empty search/fetch results and write acceptance |
| `2` | Invalid CLI input, file, request shape or configuration/missing credentials |
| `3` | Authentication/API/request failure, or import with no accepted/unknown batches |
| `4` | Incomplete import with some accepted records, no unknown outcomes |
| `5` | At least one write outcome is unknown; inspect before retrying |

For data API commands, the shared network deadline defaults to 30 seconds and
covers retries, all pages, batches and signed transfers. It accepts
1–3,600,000 milliseconds and starts
after import/query input preflight. SIGINT/SIGTERM abort active network work;
imports preserve acknowledged progress where the process can still report it.
File parsing and formatting are outside the network budget. Read calls use the
SDK backoff with a two-second retry budget; its sleep can add up to approximately
500 ms after cancellation. Writes and bulk steps disable automatic retries.

Account/project management and `usage` use the same timeout setting as a
**per HTTP request** limit, including the response body. Each sequential request
receives a new budget; browser approval and provisioning waits have separate
limits. See [management timeouts](account.md#limits-and-failures) for details.
