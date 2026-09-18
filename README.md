# LambdaDB CLI

A first, project-scoped CLI for developers, coding agents and CI. It uses
`@functional-systems/lambdadb@0.5.1` for authentication, HTTP, read retries,
pagination, bulk transfers and large response downloads.

## Install and run

Requires Node.js 22.14 or newer and npm.

### Install from npm

After the first development version is published, install the `dev` channel:

```sh
npm install --global @functional-systems/lambdadb-cli@dev
lambdadb --version
lambdadb --help
```

The `dev` channel contains prerelease versions. For reproducible CI runs, pin an
exact published version instead of the moving `dev` tag. See
[RELEASING.md](RELEASING.md#current-status) for release preparation status and
[VALIDATION.md](VALIDATION.md) for verification results and remaining limitations.

### Build from source

From a checkout of this repository:

```sh
npm ci
npm run build
node dist/cli.js --help
```

Run commands with `node dist/cli.js`, or install the built directory into a local
prefix to use the `lambdadb` executable:

```sh
npm install --prefix "$HOME/.local" /absolute/path/to/lambdadb-cli
export PATH="$HOME/.local/node_modules/.bin:$PATH"
lambdadb --help
```

`npm start -- ...` also works for human use. For machine-readable stdout, invoke
`node dist/cli.js ... --json` or the executable directly; npm may print banners.

## Configuration and authentication

Obtain the endpoint, existing project name and project API key from the LambdaDB
Console. This CLI does not create projects or issue keys. Endpoint is the API
origin, such as `https://api.lambdadb.ai`, without `/projects/...`. HTTPS is
required, except HTTP on localhost/127.0.0.1/::1 for local testing.

```sh
lambdadb configure --endpoint https://api.lambdadb.ai --project YOUR_DEV_PROJECT
```

Set `LAMBDADB_API_KEY` through your shell's secure input or your CI secret manager.
For example, in Bash, this avoids putting the value into shell history:

```bash
read -r -s -p 'LambdaDB project API key: ' LAMBDADB_API_KEY
printf '\n'
export LAMBDADB_API_KEY
```

No command accepts a raw key argument. Configuration stores only `endpoint`,
`project` and `apiKeyEnv`. Keys are read from the selected environment variable at
runtime and are never persisted by this CLI. Environment variables are still
accessible to the current process and appropriately privileged local processes;
the CLI is not a secret vault. Avoid shell tracing around secret injection.

The default configuration is
`${XDG_CONFIG_HOME:-$HOME/.config}/lambdadb/config.json`. Writes use an atomic
rename and file mode `0600`; newly created directories use `0700` (POSIX).
Configuration is user-local, not discovered from the working repository.
`.env` files are not automatically loaded, and are ignored by this repository.
Use a CI secret manager instead of adding credentials to tracked files.

| Setting | Precedence, highest first |
| --- | --- |
| Endpoint | `--endpoint`, `LAMBDADB_ENDPOINT`, saved `endpoint` |
| Project | `--project`, `LAMBDADB_PROJECT`, saved `project` |
| Key variable name | `--api-key-env`, `LAMBDADB_API_KEY_ENV`, saved `apiKeyEnv`, `LAMBDADB_API_KEY` |
| Key value | Value of the selected variable only; no fallback to another key |
| Config path | `--config`, `LAMBDADB_CONFIG`, default user path |
| Network budget | `--timeout-ms`, `LAMBDADB_TIMEOUT_MS`, `30000` milliseconds |

There is no implicit endpoint, project, collection, branch or read ref. Explicit
empty values fail validation instead of silently falling back. An explicitly
selected missing config file fails except when `configure` creates it.
`configure` applies the same precedence and saves the selected non-secret values;
it does not contact the service. To reference a different secret variable:

```sh
lambdadb configure --api-key-env MY_PROJECT_KEY
lambdadb doctor --json
```

`doctor` validates configuration and uses `listCollections({size: 1})` to check
authentication and project collection-list access. Success does not prove write
permissions, collection readiness, or search visibility. Failure provides a safe
error category and a recovery hint. SDK debug logging is disabled even when
`LAMBDADB_DEBUG` is set. Error bodies, raw SDK errors and presigned response URLs
are not printed. The active key is redacted if echoed inside returned data.
Other document data remains visible; redirect results to appropriate storage.

## First-use flow

Only run the following against a project explicitly designated for development.
Configuration and the API key must already be supplied as above. Replace
`cli-demo-docs` with a new, unique collection name. Each JSON example is included
in this repository.

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
The create input file is the index map itself, not a full create request body.

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
Bulk is unsupported for managed embedding vector fields; use ordinary upsert.

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
request body, including a `query` object and optional `size`, `sort`, `fields`,
`partitionFilter`, `consistentRead` and `includeVectors`. The query DSL is forwarded
to the API, not reimplemented in the CLI. Unknown top-level fields are rejected.
`size` accepts 1–100, `null`, or omission; null is normalized to SDK omission.
An optional file `ref` must match the mandatory `--ref`; conflicting selectors
are rejected. Fetch accepts up to 100 IDs and reports `missingIds` without
turning a successful missing-document response into an error.

The SDK downloads large query/fetch responses from `docsUrl` automatically using
its separate unauthenticated transfer client. Results are buffered, not streamed
or truncated. The CLI omits the consumed signed URL. No ref is resolved to or
claimed to pin a snapshot by the CLI. Branches and aliases can move between calls.

## Output, deadlines and exit codes

`--json` emits exactly one JSON object plus a newline on stdout for an executed
command, including failures. It contains `schemaVersion`, `command`, `ok`, optional
`target`, `data` and `error`. Target includes endpoint/project and, where relevant,
collection and explicit ref/branch. Errors use stable categories and safe hints.
API-specific response data may grow as the upstream API evolves. Help/version
remain plain text even with `--json`. Default output adds a readable summary and
pretty-printed data. Progress and diagnostics go only to stderr. No ANSI styling
or interactive prompts are used.

Credential redaction preserves fixed protocol field names and command, status,
ref-kind and error-code tokens, even when a short credential coincides with one
of them. It redacts variable string values and arbitrary document, index-config
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

The shared network deadline defaults to 30 seconds, covers retries, all pages,
batches and signed transfers, and accepts 1–3,600,000 milliseconds. It starts
after import/query input preflight. SIGINT/SIGTERM abort active network work;
imports preserve acknowledged progress where the process can still report it.
File parsing and formatting are outside the network budget. Read calls use the
SDK backoff with a two-second retry budget; its sleep can add up to approximately
500 ms after cancellation. Writes and bulk steps disable automatic retries.

## Development and boundaries

Development changes target the Git `develop` branch; reviewed release promotions
target `main`. See [CONTRIBUTING.md](CONTRIBUTING.md) for branch roles, PR checks
and the release boundary. [RELEASING.md](RELEASING.md) covers version channels,
npm bootstrap, Trusted Publishing and release checks. CI validates Node.js 22
and 24 using local contracts and the same CLI contracts against an installed
tarball.

```sh
npm run lint
npm run check:version
npm run typecheck
npm test
npm run test:package
```

Tests execute the real CLI and installed SDK against loopback HTTP servers. They
cover the complete first-use flow, ref forwarding, signed transfers, pagination,
partial and unknown writes, validation, output, credentials and exit codes.
They do not contact a LambdaDB service. See [DESIGN.md](DESIGN.md) for contract
evidence and [VALIDATION.md](VALIDATION.md) for measured verification scope.

This MVP intentionally omits Branch/Tag/Alias management: default `main` supports
first use, while reads can select existing refs. It also omits Console management,
MCP, Git collection, chunking, embedding workflows, code-search logic, delete,
plugins and publication. There are no changes to the SDK or reference repositories.

Live verification requires an explicitly designated development project, endpoint
and project key. Do not discover or borrow credentials from another repository.
Use `npm run test:live` with the explicit opt-in settings in
[RELEASING.md](RELEASING.md#explicit-live-smoke). It exercises ordinary/bulk import
and committed query/fetch contents in a random temporary collection, then uses
the SDK to clean up that collection. The normal test suite and CI never run it.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
