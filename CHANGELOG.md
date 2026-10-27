# Changelog

## [Unreleased]

### Added

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

### Maintenance

- Remove the pre-release `init --connect` flag: plain `init` guides account setup
  and offers connection reuse or another project on reruns. Clarify browser approval,
  login next steps, agent scope and advanced connection options in help.

- Pin published MCP `0.1.6-dev.21` on the development line for recent-write and
  agent guidance, including its SDK 0.10.0 integration. Keep credential forwarding
  and explicit write-tool opt-in unchanged; stable promotion needs a stable MCP pin.
- Prevent inherited npm exec package/command selectors from changing the nested
  MCP launch, including when the CLI is invoked through `npx --package`.

- Synchronize the 0.1.6 release history and start the 0.1.7 development line.
- Update the Homebrew formula to verified stable 0.1.6.

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
