# Changelog

## [Unreleased]

### Maintenance

- The release live smoke reads its project API key from the `dev` or `prod`
  GitHub Environment secret `LAMBDADB_PROJECT_API_KEY`, selected with the run
  mode in a new `mode` job, instead of assuming an AWS OIDC role and reading
  Secrets Manager. The runner still fails before starting when the base URL,
  project name or key is missing, or the key spans several lines.
- The release live smoke sends `onFailure: "returnOriginal"` on its TypeSafe and
  Cohere rerank queries. A `timeout`, `rateLimit` or `unavailable` fallback is
  retried up to three attempts in total with a 5 s / 10 s backoff. Any other
  fallback, or a third one, fails the smoke, and every fallback must match the
  documented shape. A fallback never counts as applied reranking. The query that
  sets `onFailure: "error"` itself is still sent unchanged, once.
- Update the Homebrew formula to verified stable 0.1.7, which contains the MCP
  bridge API key fix.
- The Homebrew harness supplies the terminal input helper and the packaged agent
  skills that the 0.1.7 init contract tests read.

## [0.1.7] - 2026-10-30

### Security

- Stop enabling SDK debug logging in the MCP child. `lambdadb mcp` passed
  `LAMBDADB_DEBUG=false`, which the SDK coerces to true, so the MCP server wrote
  every request, including the project API key header, to stdout, the MCP
  transport, since 0.1.5. The bridge now removes `LAMBDADB_DEBUG`, including an
  inherited value, as the CLI's own commands already do. Rerun `init` for the same
  agents to move their exact CLI pin to this version.

### Added

- Name unreleased management selectors `--org-id` and `--project-id` consistently;
  both take UUIDs. Keep the data API `--project <name>` selector unchanged.
- Add read-only `usage` for the saved project or an explicit Org/project: current
  Free quotas without price conversion, or exact Backend-computed Pay-As-You-Go
  usage and list-rate cost estimates. Support UTC month selection and JSON output.

- Browser-approved `init`, including another-device URLs for SSH, shared
  Console signup/login, terminal project setup, bounded polling and explicit key issuance.
- Separate OS-stored account login with seven-day expiry, immediate logout, and
  reusable `orgs list` / `projects list|regions|create|use` commands. Org-specific
  billing guidance uses current backend limits. Project switching reuses saved
  keys and keeps existing agent connections pinned.
- OS credential references for macOS Keychain, Windows Credential Manager and
  Linux Secret Service with a new-connection keyutils fallback. Plaintext files
  and agent arguments never contain keys. Preserve the existing environment/CI path.
- Resume agent setup with the saved connection, and remove local OS credentials
  with `credentials remove` without revoking server keys.

### Changed

- Upgrade `@functional-systems/lambdadb` from 0.8.1 to 0.11.0. `collections
  create|update` accept the `cohere` embedding provider and ordered
  `embedding.sources` (1–16 text/image mappings; exactly one non-null
  `sourceField` or `sources`). Query files accept Cohere reranking
  (`rerank-v5.0-pro`, `rerank-v5.0-fast`, without `criteria`), and output keeps
  `cohere`, its model names and `cohere-relevance-v1` readable like the TypeSafe tokens.
- Raise the local query `size` limit and the SDK `rerank.candidateSize` limit from
  100 to 1000, and `docs fetch` from 100 to 1000 IDs, matching the server contract.
- Breaking: vector `dimensions` outside 64–4096 and `similarity` other than
  `cosine`/`euclidean` (the removed `dot_product` and `max_inner_product`) are
  rejected before a request with exit 2. A describe/list response containing them
  fails with `INVALID_RESPONSE` (exit 3).
- Document the server-managed `id` field in described `indexConfigs` (send it back
  unchanged or omit it), `knn.queryInputs`, and bulk imports of precomputed
  vectors into native embedding Collections.

### Fixed

- Name the failed account-management request and its outcome in the error
  message, such as `write_outcome_unknown (HTTP 503) during POST projects`,
  `no HTTP response: the request timed out or the connection failed`, an
  unreadable response body, or a response that did not match the expected
  contract. Add the non-secret `request` and `response` fields to `error.details`.
- Report the exact command-line problem instead of a generic message: the
  missing required option, missing option argument, invalid choice, or unknown
  command/option with a close-match suggestion. An unknown `--flag=value` never
  echoes its value.
- Print help when `lambdadb` runs without a command, and print the group help
  with exit 2 when a command group such as `collections` lacks a subcommand.
- Omit the generic `Check --help` hint from cancellation and login-required
  messages that already state the next step; `error.hint` may then be empty.
- Stop redacting values shorter than eight characters, which no issued key uses,
  so a placeholder key no longer rewrites ordinary words in output.
- Suggest `npx -y @functional-systems/lambdadb-cli@<version>` instead of
  `lambdadb` in init next steps, agent next steps and login/init hints when the
  CLI runs through npx/npm exec without a global install. The bundled skill
  explains the same substitution.

### Maintenance

- Confirm an empty interactive agent selection before skipping installation.
  Default to returning to selection, and clarify Space versus Enter controls.
  Explicit `--agents none` and non-interactive behavior stay unchanged.

- Unify interactive init with Clack: arrow-key menus, inline validation, explicit
  confirmations, an optional agent multiselect, boxed file review, progress and
  aligned completion rows. Replace mixed numbered/readline and checkbox styles.
  Skip file review when no agents are selected and no settings need saving; keep
  advanced details in menu actions and finish with a short next step. New settings
  and selected agents retain review; non-interactive and JSON contracts stay intact.
  Preserve whitespace-only defaults, copyable approval URLs, selected-agent reload
  and credential guidance, and environment-selected config paths. Name the project
  before key issuance; cancellation during file saves stops further files and
  reports possible partial setup instead of success.

- Simplify interactive init into connection, agent selection and file review.
  Label detected agents without preselecting them; use a keyboard checkbox list.
  Select a sole Org automatically and combine existing-project/creation choices.
  Keep explicit key issuance and file approval, with scope/write-tool changes
  available from review. Replace the ordinary JSON dump with a concise result;
  preserve non-interactive flags and the structured JSON contract.
  Skip the redundant first-project action menu and summarize unchanged files,
  with an option to expand the full plan. Keep
  explicit region selection and include public AWS regions requiring deployment,
  with guidance to resume pending projects without creating them again.
  Preserve the current write-tool choice when accepting settings defaults and
  make cancellation/empty-selection guidance match the actual setup state.
  Keep account/project response-body timeouts effective after garbage collection
  on Node.js 22, preserving uncertain issuance and definite rejection semantics.

- Remove the pre-release `init --connect` flag: plain `init` guides account setup
  and offers connection reuse or another project on reruns. Clarify browser approval,
  login next steps, agent scope and advanced connection options in help.

- Pin stable MCP `0.2.0` (LambdaDB SDK 0.11.0: Cohere native embedding and
  reranking, ordered embedding `sources`, `queryInputs`, 1000-result limits), which
  includes the recent-write and agent guidance first pinned from `0.1.6-dev.21`.
  Keep credential forwarding and explicit write-tool opt-in unchanged.
- Prevent inherited npm exec package/command selectors from changing the nested
  MCP launch, including when the CLI is invoked through `npx --package`.

- Update the Homebrew formula to verified stable 0.1.6.
- Move releases to trunk-based development on `main`; `develop` is retired.
  Each main push publishes `X.Y.Z-dev.N` on the `dev` channel, where N counts
  first-parent commits since the newest stable tag and restarts after
  each stable release. A merge that sets an rc/stable version is verified without
  publication, and its GitHub Release publishes it. `scripts/version.mjs`
  updates every version source.
- Derive development versions from release tags. The version files hold the last
  released version (now `0.1.6`) or the next rc/stable version set by a release
  PR; a development version is never committed, and `scripts/version.mjs set`
  rejects it. A main push whose version is already tagged on `origin` publishes
  `X.Y.(Z+1)-dev.N` after a stable release or `X.Y.Z-dev.N` after an rc; an
  untagged version is verified against production without publication. A
  computed version below the current `dev` dist-tag is skipped with a notice.
  The `X.Y.Z-dev.0` placeholder and the "Open next development version" workflow
  are removed.

## [0.1.6] - 2026-10-25

### Maintenance

- Pin MCP 0.1.5 for Kiro/Claude-compatible query schemas and patched MCP
  dependencies; preserve credential forwarding and explicit write-tool opt-in.

- Synchronize the 0.1.5 release history and start the 0.1.6 development line.
- Update the Homebrew formula to verified stable 0.1.5 and run the installed
  init contracts alongside the existing CLI contracts.

## [0.1.5] - 2026-10-25

### Added

- First-use `init` for existing projects, with interactive guidance and an explicit
  non-interactive path. Verify collection-list access and optionally configure
  Codex, Claude Code, Cursor, VS Code, Gemini CLI, OpenCode, GitHub Copilot CLI,
  Kiro IDE/CLI or the Cline VS Code extension (user scope) and a bundled LambdaDB
  usage skill. Agent adapters preserve existing configuration and keep
  environment forwarding specific to each tool.
- Deduplicate identical shared MCP/skill file updates across selected agents;
  reject conflicting plans and unsupported agent scopes before connection or writes.
- Runtime-only credential forwarding to the existing read-only-by-default stdio
  MCP package through `lambdadb mcp`; no key values are persisted. Existing CLI
  commands remain non-interactive. Search readiness is not inferred from setup.

### Maintenance

- Synchronize the 0.1.4 release history and start the 0.1.5 development line.
- Update the Homebrew formula to verified stable 0.1.4.
- Correct the release live smoke for servers with a 1,000-candidate Bayesian
  limit and compare document results across independent native embedding calls
  without requiring bit-identical scores; retain the CLI's existing limits.
- Refresh the locked transitive Zod dependency to 4.6.7, addressing
  [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).

## [0.1.4] - 2026-10-07

### Maintenance

- Standardize feature descriptions to native embedding and native reranking;
  preserve legacy wire fields, CLI behavior and historical references.
- Synchronize the 0.1.3 release history and start the 0.1.4 development line.
- Prepare the Homebrew formula for verified stable 0.1.3 and record publication evidence.

### Dependencies

- Pin `@functional-systems/lambdadb` and the npm lockfile to stable 0.8.1.

## [0.1.3] - 2026-10-06

### Added

- SDK 0.8.0 Bayesian hybrid search through query JSON files, including separate
  candidate budgets and optional reranking. Preserve free-form DSL and server
  error classification; existing search defaults remain unchanged.
- Native embedding-only index configuration and `collections update --index-config`.
  Preserve explicit `managedEmbedding: true` for older servers. Include copyable
  examples, help, and local/installed/live CLI coverage.

### Dependencies

- Pin `@functional-systems/lambdadb` and the npm lockfile to stable 0.8.0.

### Maintenance

- Synchronize the 0.1.2 release history and start the 0.1.3 development line.
- Prepare the Homebrew formula for verified stable 0.1.2 and record npm publication evidence.

## [0.1.2] - 2026-10-04

### Fixed

- Preserve fixed rerank status/provider/model/criteria/reason tokens when they
  overlap with a credential. Continue redacting document content, resolved model
  strings and unknown server metadata values in JSON and human output.

- A successful development publication no longer fails CI solely because registry
  visibility exceeds the verification budget. Report a warning and explicit
  `published-verification-pending` result; retain failures for publish errors,
  invalid responses, authentication and artifact mismatches. Never retry writes.

### Added

- SDK 0.7.0: 49 fixed text analyzer presets and optional per-query managed
  reranking through query JSON files. Preserve final/retrieval scores and status
  metadata in inline and downloaded results; keep vector k unchanged.
- Reranking example, contract documentation and installed-CLI regression coverage.
  These features require a supporting server deployment.

### Maintenance

- Pin the TypeScript SDK and npm lockfile to 0.7.0. This CLI uses the native SDK;
  Qdrant payload-schema mapping is not part of its surface.
- Synchronize the 0.1.1 release history and start the 0.1.2 development line.
- Prepare the Homebrew formula for verified stable 0.1.1 and record npm publication evidence.

## [0.1.1] - 2026-09-29

### Added

- SDK 0.6.0: all 16 text analyzers, match-all queries with omitted `query`, and
  keyword facets with `size: 0` for counts only or documents and facets together.
  Facet results survive JSON output and automatic `docsUrl` downloads.
- Facet examples, query help and transport/installed-package regression coverage.
  Facets require a supporting server and newly built keyword indexes; existing
  collections are not migrated automatically.
- A Homebrew formula for the published stable CLI, with a managed Node 24 runtime,
  checksummed npm/lockfile inputs and isolated production dependencies.
- Local Homebrew installation checks, installed CLI contracts and macOS/Linux PR
  validation.
- Public installation with `brew install lambdadb/tap/lambdadb-cli`, backed by the
  LambdaDB Homebrew tap and remote installation checks.

### Maintenance

- Synchronize the 0.1.0 release history into develop and start the 0.1.1 development
  line. Stable installs use npm's default channel; dev builds remain opt-in.

### Documentation

- Document the published stable npm channel, public Homebrew installation and
  completed release verification on the default branch.

## [0.1.0] - 2026-09-19

### Added

- First stable release of the project-scoped LambdaDB CLI: configure, doctor,
  collection list/describe/create, JSONL ordinary/bulk import, query and ID fetch.
- Explicit branch/tag/alias read targets, noninteractive commands, versioned JSON
  output and documented exit codes, including partial and unknown write outcomes.
- Reuse of TypeScript SDK 0.5.1 for authentication, transport, read retries,
  pagination, bulk transfers and large response downloads.
- Apache-2.0 licensing, installed-package contract tests, opt-in development-project
  smoke tests and provenance-enabled npm publication.

### Fixed

- Development publication verifies registry propagation for up to five minutes,
  including bounded read subprocesses and polling sleeps. Transient read failures
  can recover without repeating the successful publication. Authentication,
  malformed metadata and source/artifact conflicts still fail verification.
- Publication logs distinguish an accepted write from verification still pending;
  a pending result remains nonzero and requires registry reads before a rerun.

### Documentation

- Record the completed bootstrap, initial OIDC publication, provenance/consumer
  checks and the observed bootstrap `latest` tag behavior.

## [0.1.0-dev.1] - 2026-09-18

### Added

- Project-scoped configure, doctor, collection list/describe/create, JSONL import,
  ID fetch and query commands using LambdaDB TypeScript SDK 0.5.1.
- Explicit targets, branch/tag/alias read refs, bounded requests, noninteractive
  operation and versioned JSON output with documented exit codes.
- Sequential ordinary/bulk imports that distinguish acceptance, rejection,
  partial completion and unknown outcomes without promising search readiness.
- Local transport contracts, installed-package contracts, release metadata checks
  and an opt-in development-project live smoke with temporary collection cleanup.
- Development/release procedures and a prepared npm OIDC publishing workflow.
- Opt-in automatic develop publication after Node 22/24 CI, deterministic dev
  build versions, exact-artifact rerun verification and stale-build guards.
  Explicit rc/stable releases continue to require reviewed main history.
- Apache-2.0 license text and package license metadata.

### Fixed

- Live smoke observes committed documents for up to 300 seconds per read stage
  and reports safe progress diagnostics after a 75-second observation failure.
  Requests and polling sleeps respect the remaining budget; late results cannot
  pass. The validation record identifies the designated development target.
- Colliding redacted document/metadata keys receive unique suffixes instead of
  silently overwriting values; unchanged field names remain intact.
- Credential redaction preserves fixed JSON fields, command/status tokens and
  error categories when a credential is short or matches a protocol token.
- JSONL preflight caps imports at 100,000 documents and scans physical lines
  without a split array, rejecting excess small documents before any API call.
- Command deadlines are bound at SDK fetch dispatch to avoid a reproduced stalled
  second write; signal cancellation preserves acknowledged and unknown outcomes.

### Release status

Published publicly on npm's `dev` channel on 2026-09-18 as the manual bootstrap.
The initial OIDC build `0.1.0-dev.4` followed from the same reviewed develop
commit; generated dev versions do not create separate source changelog entries.
Automatic dev publication is enabled. The observed `latest` tag remains at the
bootstrap until a reviewed stable release replaces it.
Main promotion is required only for rc/stable.
