# Changelog

## [Unreleased]

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
- Colliding redacted document/metadata keys receive unique suffixes instead of
  silently overwriting values; unchanged field names remain intact.
- Credential redaction preserves fixed JSON fields, command/status tokens and
  error categories when a credential is short or matches a protocol token.
- JSONL preflight caps imports at 100,000 documents and scans physical lines
  without a split array, rejecting excess small documents before any API call.
- Command deadlines are bound at SDK fetch dispatch to avoid a reproduced stalled
  second write; signal cancellation preserves acknowledged and unknown outcomes.

### Release status

Prepared for the first public development release on npm's `dev` channel. This
entry records the candidate contents and preparation date, not a publication.
The development-project smoke is recorded in VALIDATION.md. npm organization
permission verification, authorized bootstrap publication and Trusted Publishing
setup remain pending. Automatic dev publication is disabled until maintainers
enable `NPM_DEV_PUBLISH_ENABLED`; main promotion is required only for rc/stable.
