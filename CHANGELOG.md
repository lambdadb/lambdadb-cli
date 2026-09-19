# Changelog

## [Unreleased]

### Added

- A Homebrew formula for the published stable CLI, with a managed Node 24 runtime,
  checksummed npm/lockfile inputs and isolated production dependencies.
- Local Homebrew installation checks, installed CLI contracts and macOS/Linux PR
  validation. Public tap publication remains a separate pending step.

### Maintenance

- Synchronize the 0.1.0 release history into develop and start the 0.1.1 development
  line. Stable installs use npm's default channel; dev builds remain opt-in.

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
bootstrap until a reviewed stable release replaces it. Publication, provenance,
installation and development-project smoke evidence are recorded in VALIDATION.md.
Main promotion is required only for rc/stable.
