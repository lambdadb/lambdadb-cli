# Changelog

## [Unreleased]

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

### Fixed

- Command deadlines are bound at SDK fetch dispatch to avoid a reproduced stalled
  second write; signal cancellation preserves acknowledged and unknown outcomes.

### Release status

No version has been published by this project workflow. `0.1.0` is the current
local development version, not a release announcement. The package remains
private pending a separately reviewed and authorized first release.
