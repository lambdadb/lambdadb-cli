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
- Apache-2.0 license text and package license metadata.

### Fixed

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
Live development-project verification, promotion to main, npm organization
permission verification and authorized bootstrap publication remain pending.
