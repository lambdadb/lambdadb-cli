# Validation record

## CLI 0.1.3 publication (2026-10-06)

With explicit release authorization, annotated tag `v0.1.3` was created on main
commit `90628ed3648aea0ae381c061a95aebbbf48e9259` and the stable
[GitHub Release](https://github.com/lambdadb/lambdadb-cli/releases/tag/v0.1.3)
triggered [OIDC publication](https://github.com/lambdadb/lambdadb-cli/actions/runs/37466450036).
The workflow succeeded on attempt 1, repeating Node 22/24 validation and
installed-tarball tests before publishing the exact tested artifact.

- Registry reads confirmed `latest=0.1.3`, `dev=0.1.3-dev.15`.
- `node /tmp/lambdadb-cli-release013/main/verify-publication.mjs` fetched registry
  metadata, downloaded the tarball and verified its SHA-512 integrity. Its bytes
  exactly match the final reviewed main candidate described below.
- A clean, unqualified `npm install --prefer-online --cache <isolated-cache>
  --no-audit --no-fund @functional-systems/lambdadb-cli` selected CLI 0.1.3 and
  SDK 0.8.0. Version and query/update help passed. All 54 CLI contract tests
  executed against this registry-installed binary, with no failures or skips.
- `npm audit signatures --prefer-online --cache <isolated-cache>` verified four
  registry signatures and three attestations. The isolated cache avoids stale
  local npm metadata; the user's global installation was not changed.
- Decoded [SLSA provenance](https://registry.npmjs.org/-/npm/v1/attestations/@functional-systems%2flambdadb-cli@0.1.3)
  matches the downloaded artifact's digest, release commit, `refs/tags/v0.1.3`,
  repository and `.github/workflows/publish.yaml` run 37466450036.
- The registry's full metadata, npm installation metadata and signature lookup
  became visible at different times. Initial reads returned 404, selected the
  older latest package or returned ETARGET during audit. Only reads and isolated
  installation were retried; publication was not repeated and no tag was moved.

Published tarball SHA-256:
`ef98f935c5274ee6b4c7991669e46648fee4070a1105b1a265df6a6faf791b07`.
Its SHA-512 integrity is
`sha512-vgS5U+dVBVpjpi1KVhHr6XL/VPj6gJ3nHxWg8osGwK2ZiDP8CzZ4o3ebMzEP13Pg+G98akZKTiitiM2prvCWsw==`.
The matching immutable release `package-lock.json` has SHA-256
`4e1a5028be3b610e3c55f2e91954270ae767e1d958810a3ac469f056f82d1c81`.
These values prepare the 0.1.3 Homebrew formula; they do not publish the public tap.
`bash scripts/test-homebrew.sh` passed locally on macOS arm64: formula style,
installation, brew test, wrapper isolation from ambient Node and all 54 released
CLI contracts. The test uninstalled its CLI and removed its disposable tap.
This was a fresh local installation, not an existing-user upgrade.

The post-release PR brings main history into develop, starts `0.1.4-dev.1`, and
updates publication records and the local Homebrew formula. Source/query behavior
is unchanged. Homebrew CI results are recorded in that PR; the public tap still
serves 0.1.2 pending its separate reviewed update. No production validation,
server deployment, billing verification or new search-default promotion occurred.
The installed-candidate live smoke and verified Collection cleanup below remain
applicable because the published runtime is byte-identical.

Sanitized original logs, registry metadata, provenance, the publication tarball
and the isolated consumer are retained under `/tmp/lambdadb-cli-release013/main/`.
No scratch artifacts or credentials are committed.


## CLI 0.1.3 release preparation (2026-10-06)

Prepared from reviewed develop `caee1bcb6ce864c33647673b54a48f7cc06dcf84`
([PR #18](https://github.com/lambdadb/lambdadb-cli/pull/18)); its tree matches
feature head `9589c7a`, whose Node 22/24 CI and automatic review completed with
no findings. The release branch changes only version/changelog and release
evidence relative to develop. Runtime source, examples, tests and workflow
remain identical. Stable publication is not authorized or claimed here.

On Node 24.15.0, these commands passed:

```sh
npm ci
npm run lint
npm run check:version
RELEASE_TAG=v0.1.3 RELEASE_PRERELEASE=false node scripts/check-release.mjs --release
npm run typecheck
npm test
npm pack --json --pack-destination /tmp/lambdadb-cli-release013
npm run test:package -- /tmp/lambdadb-cli-release013/functional-systems-lambdadb-cli-0.1.3.tgz
```

The metadata check validates release settings without creating a tag. All 79
source tests and 54 separately installed CLI tests passed, with zero failures
or skips. The candidate inventory contains 45 files, including the new examples
and no credentials, scratch files or test harnesses.

An isolated installation of the packed 0.1.3 candidate, with SDK 0.8.0, then ran
the actual CLI against authorized development project `bench-recall` at
`https://internal-dev-aws-apne2-v3-c05a2b5d492a.lambdadb.ai`:

```sh
npm install --prefix /tmp/lambdadb-cli-release013/consumer --no-audit --no-fund /tmp/lambdadb-cli-release013/functional-systems-lambdadb-cli-0.1.3.tgz
LAMBDADB_TEST_CLI=/tmp/lambdadb-cli-release013/consumer/node_modules/@functional-systems/lambdadb-cli/dist/cli.js node --env-file=.env.local /tmp/lambdadb-cli-sdk080/run-live.mjs
```

The launcher used the existing private environment only in memory and ran
`npm run test:live`; the harness selected the installed binary through
LAMBDADB_TEST_CLI. The complete suite passed in 113.4 seconds: 1 test, zero
failures/skips. It exercised analyzer metadata, ordinary/bulk imports, committed
query/fetch contents, facets, native/legacy create/update and actual embeddings,
Bayesian budgets and reranking, retrieval scores and all 30 server rejection
checks described in the SDK 0.8.0 record below.

Deletion and subsequent HTTP 404 verified cleanup of all three Collections:

- `cli-smoke-29074d17-7e21-460a-9823-a6e49f30d067`
- `cli-native-3c9bcae9-1b91-424f-8504-ac755078ac13`
- `cli-native-3b18c438-83d7-44eb-8c8d-bfc7949f35c5`

The live-tested tarball has integrity
`sha512-GzQVy1ZJgtT8O2q5wXDV+mhegYk6MBzZ6hSNMOjKq1BGUu6dW1P0F69dHDFJC3Q8o6gvUYQGv41DZMvfMXxaIQ==`.
It and its manifest remain under `/tmp/lambdadb-cli-release013/live-tested/`;
logs and the installed consumer remain in the parent directory. This evidence
section changes packaged documentation after the live run. The final package is
repacked and checked by the installed CLI suite; its runtime and examples are
compared byte-for-byte to the live-tested installation. Its final integrity and
remote CI/review results are recorded in the release PR.

The earlier same-day deployment provenance record below identifies backend
`9072a1bc8925954369a887f558f1eaf387b7ea0e`. This bounded test does not establish
production availability, ranking quality, load or billing behavior. No new
Homebrew installation or older-server tests were run. The checked-in/public tap
still points to published 0.1.2; its 0.1.3 update follows a separately authorized
stable publication. No server deployment, npm latest change, tag or GitHub
Release was performed by this preparation.


## SDK 0.8.0 CLI compatibility (2026-10-06)

Candidate: `feat/sdk-0.8.0`, based on develop `8e76422`; CLI development version
`0.1.3-dev.1`, exact SDK `0.8.0`, Node `24.15.0`. This change does not publish
or promote a package. Repository instructions contain no local AGENTS.md;
CONTRIBUTING.md, RELEASING.md, CI, runtime/input/output and adjacent commands
were inspected before implementation.

### Local and installed validation

The following commands passed:

```sh
npm ci
npm run lint
npm run check:version
npm run typecheck
npm test
npm run test:package
git diff --check
```

`npm test` executed 79 tests, with no failures/skips. `npm run test:package`
packed and separately installed the CLI, checked inventory/version/help, and
executed all 54 CLI contract tests with no failures/skips. This is executed
subprocess coverage, not merely compilation. New coverage includes Bayesian
JSON mapping and budgets, omitted/null defaults, ref/input precedence, unchanged
ordinary fusion requests, local versus server errors, native/legacy create and
update, contradictory embedding inputs, uncertain mutations without retries,
and full JSON/human results with rerank metadata through inline and docsUrl
responses. No SDK query DSL validator was added.

### Current deployment provenance

Read-only AWS inspection used profile `dev`, region `ap-northeast-2`:
`aws ecs list-services`, `describe-services`, `list-tasks`, `describe-tasks`,
and `aws ecr describe-images --image-ids imageTag=dev-v3-9072a1b` for the
Gateway and Query Executor repositories. Both services had desired/running
counts 1/1, task definition revision 16 and rollout `COMPLETED`.
Running digest and the ECR `dev-v3-9072a1b` tag agreed:

- Gateway: `sha256:300f65269579fcff327366490505327a549e38249c371e93df07f2ae0669bfef`.
- Query Executor: `sha256:bf87b32fdcbaf1b17f5cacb3ec8e9f1af1eb7ef51566d06cfb74273e3f857a54`.

`gh run view 37422611173 --repo lambdadb/lambdadb --json headSha,conclusion,url`
confirmed the [successful deployment](https://github.com/lambdadb/lambdadb/actions/runs/37422611173)
for pinned backend `9072a1bc8925954369a887f558f1eaf387b7ea0e`. The deployment
run, image tag and running digests were compared together; no deployment or
infrastructure configuration was changed.

### Actual CLI on the authorized development target

Target: `bench-recall` at
`https://internal-dev-aws-apne2-v3-c05a2b5d492a.lambdadb.ai`, following the
existing repository test-environment workflow. The repository's private
`.env.local` supplied its existing opt-in and credential; nothing was borrowed
from another repository. The command was:

```sh
node --env-file=.env.local /tmp/lambdadb-cli-sdk080/run-live.mjs
```

This uncommitted launcher verified the exact endpoint/project and opt-in,
mapped `LAMBDADB_BASE_URL`, `LAMBDADB_PROJECT_NAME`, and
`LAMBDADB_PROJECT_API_KEY` in memory to the CLI variables, set
`LAMBDADB_LIVE_CONFIRM_PROJECT`, and ran `npm run test:live` (build followed by
`node --test test/live/*.test.mjs`). Credentials never entered command arguments,
logs or committed files. The suite passed in 94.8 seconds: one test, zero
failures/skips, using the actual CLI for all creation, updates, imports and reads.

- Doctor, all 49 analyzer presets, ordinary/bulk imports, exact committed
  query/fetch document contents, facets, and default/null/custom reranking passed.
- Both native embedding-only and explicit legacy true configurations passed
  create/update and normalized metadata checks with explicit 256 dimensions and
  cosine similarity inside embedding. Actual OpenAI document/query embeddings
  worked through ordinary upsert and KNN queryText.
- Bayesian retrieval returned all expected documents. Holding candidateSize=30
  while changing size from 3 to 1 preserved the result prefix. Ordinary
  text/KNN/RRF/Min-Max/L2 worked without a top-level candidate budget.
- Default and explicit rerank budgets both produced `applied`, three candidates,
  three scored candidates and two final results. Finite final scores were in
  [0,1], and retrievalScore exactly matched the baseline Bayesian scores. Null
  rerank preserved the baseline documents/scores without rerank metadata.
- For each native/legacy Collection, 15 invalid requests retained API_ERROR,
  HTTP 400 and exit 3: missing/invalid/conflicting candidate budgets, wrong signal
  counts, boosts including Boolean descendants, nested fusion and a Bayesian
  budget on an ordinary query.
- Cleanup deleted and verified HTTP 404 for all temporary Collections:
  `cli-smoke-61877546-2601-4df9-aeeb-91d87f44c2a5`,
  `cli-native-4e72c926-fe9e-4bbd-822e-1667be3e619f`, and
  `cli-native-2892e6ab-af3c-4a23-aff7-bb5793f7f31e`.

Sanitized logs and deployment evidence are retained outside the repository in
`/tmp/lambdadb-cli-sdk080/`. No temporary test data remains in those Collections.
The live run used the built source CLI; installed-artifact validation used
loopback servers. Full downloaded documents are covered by local transport tests;
large live results alone do not prove that the server selected docsUrl.
Older-server deployment, production behavior, search quality, load, billing,
and Homebrew installation were not tested. Older servers may require explicit
`managedEmbedding: true` and may reject Bayesian search. Existing flag precedence,
ordinary query behavior, output schema and SDK transfer handling are preserved.


Updated: 2026-10-04. Local contract tests use loopback servers and synthetic
credentials. Authenticated development-project evidence is recorded separately.

## CLI 0.1.2 publication (2026-10-04)

[PR #15](https://github.com/lambdadb/lambdadb-cli/pull/15) merged as
`6628fe0ed1f405c88fbd91d591e5223d3250dd73`. The annotated v0.1.2 tag points to
that commit. [GitHub Release v0.1.2](https://github.com/lambdadb/lambdadb-cli/releases/tag/v0.1.2)
triggered [OIDC publication](https://github.com/lambdadb/lambdadb-cli/actions/runs/37191188846),
which passed Node 22/24 validation and exact-artifact tests on attempt 1.

- Registry latest=0.1.2; dev=0.1.2-dev.12 remained unchanged.
- Downloaded npm tarball is byte-identical to the reviewed final candidate and
  merged-main pack. SHA-256:
  `e63c2c0fd624e1d81c45c5ba24d641a11ee0ecdc60f063aba4268e06547761ea`.
  Registry SHA-512 integrity:
  `sha512-9l1WPN2vrX+JXRjuOh7Uz5DCVcaiV/YLpYKgZb7ORU1jphaAIx38VSWeiQitz0V2Nw/b1vTxfcXzvra6EAkaFg==`.
- An isolated registry consumer passed all 46 installed CLI contracts and
  version/help. Its lockfile integrity matched npm and SDK resolves to 0.7.0.
  npm audit signatures verified four registry signatures and three attestations.
- Decoded [provenance](https://registry.npmjs.org/-/npm/v1/attestations/@functional-systems%2flambdadb-cli@0.1.2)
  matched the artifact digest, repository, release commit, refs/tags/v0.1.2,
  publish.yaml and workflow run 37191188846. Verification retried registry reads
  during propagation without another publication. Temporary consumer, archive
  and cache were removed.
- The candidate live evidence below applies to the identical published artifact;
  no additional live run was performed. The earlier failed sample remains recorded.
- Formula handoff pins this npm tarball and release lockfile SHA-256
  `e2d12af262d13c3a23073d1313b183766bb40b5360abeb0d773b5100819dac65`.
  The completed tap handoff and bounded upgrade evidence are recorded below.

These checks establish artifact publication and the recorded development sample;
production deployment, search quality, load/failure coverage and billing readiness
remain separate dependencies.

## CLI 0.1.2 post-release verification (2026-10-04)

[PR #16](https://github.com/lambdadb/lambdadb-cli/pull/16) merged as
`aefbaeed9c799e76dd7a9501ecda6ab80dc6e958`, preserving release commit `6628fe0`
as an ancestor of develop and starting the 0.1.3-dev.1 development base.

- [Automatic publication](https://github.com/lambdadb/lambdadb-cli/actions/runs/37192027479)
  passed Node 22/24 validation and published 0.1.3-dev.13. An independent isolated
  registry consumer passed all 46 CLI contracts, version/help, SDK 0.7.0 and
  integrity checks. npm audit signatures verified four signatures and three
  attestations. Decoded provenance matched the artifact digest, merge commit,
  repository, develop ref and workflow run. At verification, dev=0.1.3-dev.13
  and latest=0.1.2. Temporary consumer, source archive and cache were removed.
- [Homebrew PR #6](https://github.com/lambdadb/homebrew-tap/pull/6) merged as
  `ae9a7456acd10015d51b9ea8d58aee76afe3da28`. The public formula matches the
  CLI-side formula and pins the verified npm 0.1.2 artifact and release lockfile.
- [Public-tap CI](https://github.com/lambdadb/homebrew-tap/actions/runs/37192619208)
  passed on macOS arm64 and Linux x86_64. It installed from the remote public tap
  and checked formula equality, style, version, JSON configuration, file
  permissions and Node runtime selection. Existing migration checks also passed;
  no migration formula was changed. Hosted test installations and taps were removed.
- A separate local macOS arm64 test installed 0.1.1 into a disposable tap, replaced
  its formula with the exact merged public 0.1.2 formula, ran brew upgrade and
  verified version 0.1.2 and brew test. Both test-owned versions and the temporary
  tap were removed; the original user taps were preserved. This establishes the
  formula version transition, not an existing user's public-tap upgrade or Linux
  upgrade coverage. No LambdaDB service resources or credentials were used.
- Merged feature branches were removed and both primary checkouts were clean.
  The candidate and development-service evidence below remain historical samples;
  this post-release verification did not run another live service smoke.

## CLI 0.1.2 stable candidate (2026-10-04)

This section records the pre-publication candidate milestone. Publication and
post-release results are recorded above.

Prepared release/0.1.2 from reviewed develop merge `aef74a3`, retaining SDK 0.7.0
and all reviewed runtime/test changes. The release branch changes only version
metadata, the dated changelog and release/validation documentation. Stable npm
0.1.2 was absent when checked; latest remains 0.1.1. No stable tag, GitHub Release,
package publication or main merge was performed during preparation.

- npm ci, lint, typecheck, version checks and the explicit
  RELEASE_TAG=v0.1.2 / RELEASE_PRERELEASE=false preflight passed on Node 24.15.0
  with npm 11.12.1. All 71 source tests and 46 separately installed CLI tests passed.
  The executable and lockfile agree on 0.1.2, and the installed SDK is 0.7.0.
- A candidate tarball was installed into an isolated consumer with its own npm
  cache. Its executable was selected via LAMBDADB_TEST_CLI for the authorized
  development smoke using the existing .env.local target and in-memory mapping.
  The successful run took 54.4 seconds: accepted writes at about 3 seconds,
  committed query/fetch contents at about 52 seconds, exact facets and managed
  reranking default/null/custom by about 54 seconds. All 49 preset metadata
  checks passed. Cleanup returned HTTP 404 for
  `cli-smoke-14b21fee-59e1-4898-9ef2-8a57db823de0`.
- The first candidate live attempt failed after 53.2 seconds during query
  observation with exit 3 and no HTTP status. The log does not distinguish a
  transport timeout from another request failure; this is not a passing sample
  or proof of a candidate defect. No runtime code was changed for the retry.
  Cleanup was not confirmed by that run. An independent SDK get found its
  test-owned collection still present; delete was accepted and a subsequent
  get returned HTTP 404 for `cli-smoke-c42a987e-592a-4611-a8d7-04cf5b90ad15`.
- Every live launcher checked .env.local's SHA-256 before/after execution. It
  remained byte-for-byte unchanged. Temporary consumers, caches and initial
  candidate tarballs were removed.
- Only documentation was updated after the successful live run. The final
  review tarball is rebuilt and checked again through the installed-package
  suite; generated dist remains ignored. Candidate publication will be verified
  independently after approval, rather than assuming dev provenance applies.
- The public Homebrew tap was read and matches the verified 0.1.1 formula. Its
  0.1.2 update waits for the stable npm artifact and immutable release lockfile.

The live checks are bounded development evidence. Provider failure/load behavior,
dense vector reranking, new-preset language quality, production deployment and
billing readiness remain outside this verification. The PR must pass Node 22/24
CI and receive review before main promotion. Tagging and publication are separate
approved actions; synchronize main back into develop with 0.1.3-dev.1 afterward.

## Published SDK 0.7.0 development consumer (2026-10-04)

The [develop merge workflow](https://github.com/lambdadb/lambdadb-cli/actions/runs/37188862636)
completed successfully and published
[`0.1.2-dev.12`](https://www.npmjs.com/package/@functional-systems/lambdadb-cli/v/0.1.2-dev.12)
from `aef74a3deeacb1e5d3f50856301562b58739fcdd` on attempt 1. Required Node
22/24 validation and the exact publication artifact tests passed. Registry
visibility was checked with reads while the automatic job completed; no second
publication was attempted. At verification, dev=0.1.2-dev.12 and latest=0.1.1.

- Downloaded tarball SHA-512 matched registry integrity and the clean consumer
  lockfile. SDK dependency and the installed SDK both resolve exactly to 0.7.0.
  Integrity: `sha512-AyGfP2ibeu/unYj5RvkkBO2WICkCMk6dp+4TauH0Da2xBsN6g3Nub7MmM/ZeiRE93wwV9r05IhXV2DyS28WY1A==`.
- Registry/installed gitHead and decoded
  [provenance](https://registry.npmjs.org/-/npm/v1/attestations/@functional-systems%2flambdadb-cli@0.1.2-dev.12)
  agree on the merge commit, repository, develop ref, publish.yaml workflow and
  run 37188862636; the provenance subject digest matches the downloaded artifact.
- A fresh tarball consumer passed version/help and all 46 CLI contracts. Tests
  came from an archived merge-source snapshot, with its expected package version
  set to the generated published version. A separate registry-version consumer
  with an isolated cache verified matching lockfile integrity and SDK version;
  npm audit signatures verified four registry signatures and three attestations,
  including the published CLI. The preliminary local-tarball audit verified only
  the three registry dependencies, so the registry consumer verified the CLI too.
- The published CLI's executable was selected through LAMBDADB_TEST_CLI for the
  expanded authorized development smoke. All 49 preset metadata, ordinary/bulk
  writes, full committed query/fetch contents, exact facets and managed reranking
  default/null/custom checks passed in 81.9 seconds. Query contents appeared at
  about 78 seconds; acceptance at about 2 seconds did not imply search readiness.
- Cleanup was accepted and HTTP 404 confirmed for
  `cli-smoke-5028c4c7-535c-4b29-8978-b3b805054d7d`. Temporary consumers, caches,
  source snapshots and tarballs were removed. .env.local remained byte-for-byte
  unchanged. The designated target and in-memory environment mapping are recorded
  in the authenticated follow-up below.

This establishes the published development artifact and a bounded sample on one
development target. It does not establish stable publication, production feature
deployment, language-specific search quality, load/failure coverage or billing
readiness.

## SDK 0.7.0 local compatibility (2026-10-04)

The checkout began clean on develop at `3903531`. npm now pins the released
SDK 0.7.0 in both package.json and package-lock.json. Existing 0.1.1 publication
and live evidence below remain historical; no new CLI package was published.

- `npm ci`, lint, typecheck and version/lockfile checks passed with Node 24.15.0
  and npm 11.12.1. npm reported zero dependency vulnerabilities.
- Source suite: 69 tests passed on Node 24.15.0 and Node 22.23.3, with no failures
  or skips. Installed tarballs: 44 CLI tests passed on each runtime in temporary
  consumers; package inventory and executable version/help checks passed.
- Expanded analyzer forwarding covers all 49 names, existing omitted/default
  serialization and lowercase rejection. Rerank cases check custom criteria,
  null/omission, separate size/candidate cap/vector k, local validation, final and
  retrieval scores (including zero/precision), tie order, metadata and facets.
  Applied/empty/fallback/unused results are checked inline and through docsUrl;
  API failures remain errors with returnOriginal. These are synthetic transport
  contracts, not induced provider failures or language-quality measurements.
- Repeated TypeScript builds produced identical hashes for all 21 generated
  files. No separate schema/model generator exists; generated dist stays ignored.
- No local Qdrant mapping exists. The upstream stricter schema-option behavior
  and unchanged type-only mapping are documented in DESIGN.md.

The initial update did not inspect the existing ignored `.env.local` and therefore
ran only local tests. Steven subsequently explicitly authorized using that file;
the development-service follow-up below supersedes the initial live-test omission.
Supporting production deployment, search quality, load/failure coverage and billing
readiness remain unverified. No merge, deployment or publication was performed.

## SDK 0.7.0 review follow-up: rerank token redaction (2026-10-04)

The PR review identified a valid protocol regression: a credential equal to
`applied` rewrote `data.rerank.status` to `[REDACTED]`. The new CLI regression
failed before the fix, while the negative test for arbitrary metadata passed.
The output sanitizer now preserves exact known status/provider/model/criteria
version/reason tokens only at their contract paths. Unknown server values,
resolvedModel and document content retain credential redaction; whole metadata
paths are not exempted because the SDK accepts open strings for several fields.

On Node 24.15.0, lint, typecheck, version checks, all 71 source tests and all 46
separately installed CLI tests passed with no failures or skips. The two new
cases cover every fixed token and a one-character credential, JSON and human
output, docsUrl results, nested document maps and unknown provider/model/reason
values. Repeated builds remain identical for all 21 generated files. This is a
local redaction fix; the prior development-service evidence remains applicable
to SDK API behavior and was not rerun with synthetic colliding credentials.

## SDK 0.7.0 authenticated development follow-up (2026-10-04)

Tested the built CLI runtime from `b6b9cbc` (CLI `0.1.2-dev.1`, SDK `0.7.0`) on
Node 24.15.0 with the expanded live harness in this PR. Target:
`bench-recall` at `https://internal-dev-aws-apne2-v3-c05a2b5d492a.lambdadb.ai`.
The existing `.env.local` supplied the API key and `LAMBDADB_RUN_LIVE_TESTS=1`.
A `node --env-file=.env.local` launcher mapped `LAMBDADB_BASE_URL`,
`LAMBDADB_PROJECT_NAME` and `LAMBDADB_PROJECT_API_KEY` in memory to the CLI's
`LAMBDADB_ENDPOINT`, `LAMBDADB_PROJECT` and `LAMBDADB_API_KEY`, and set
`LAMBDADB_LIVE_CONFIRM_PROJECT` to the same authorized project. It ran
`node --test --test-reporter=tap test/live/cli.test.mjs` without printing credentials.

- Doctor and temporary collection creation passed. All 49 fixed presets were
  accepted as individual text field configurations, and describe metadata
  preserved each requested configuration. The keyword analyzer and keyword field
  type remained distinct. Unpopulated preset fields test acceptance/metadata,
  not language-specific indexing or search quality.
- Two ordinary documents with 3 MiB payloads each and one bulk document were
  accepted at about 4 seconds. Committed query and fetch contents for all three
  passed at about 100 seconds, without a pending-write overlay.
- Match-all facet-only and document-plus-facet queries returned exact expected
  document counts and category buckets.
- Default reranking and custom criteria returned `applied`, candidate/scored
  counts of three, expected provider/model and criteria-version markers, finite
  final evaluation and retrieval scores, descending final-score order and matching
  maxScore. Null rerank retained ordinary results with no rerank metadata or
  retrievalScore. All three expected IDs were preserved. These checks exercised
  the CLI, its published SDK and the designated development service, with no Jev key.
- The final run passed in 102.4 seconds. Cleanup was accepted and get returned
  HTTP 404 for `cli-smoke-571da4e7-2402-4652-aa81-c44824964fdc`.
- Two earlier attempts failed only in newly added test metadata assertions:
  first the response's collection wrapper was missed, then the server-added
  default id index was compared as an unexpected field. The harness now compares
  every requested index configuration while allowing server-added fields.
  Both temporary collections were deleted and HTTP 404 confirmed:
  `cli-smoke-ec8b9c3f-c94f-4c4a-bfff-3dad2a24516b` and
  `cli-smoke-7fed413e-cbe5-4e15-a7dc-e334a3fac537`.
- Every attempt verified `.env.local` remained byte-for-byte unchanged using
  SHA-256. Temporary local files were removed by the harness. Lint, typecheck
  and diff checks passed after the harness changes.

This is bounded development evidence. The live harness does not inspect wire
responses to prove docsUrl selection, induce provider fallback or load failures,
measure ranking quality, test dense vector reranking, or establish production
feature deployment or billing readiness. Local transport regressions cover
zero/precision/ties, docsUrl metadata, independent vector k and failure handling.

## CLI 0.1.1 publication

On 2026-09-29, [release v0.1.1](https://github.com/lambdadb/lambdadb-cli/releases/tag/v0.1.1)
was published from tag/main commit `80a4c10628ad2ad4ebf8d90a01924d27dcb4a790`,
whose tree equals candidate `0291970`. The
[release workflow](https://github.com/lambdadb/lambdadb-cli/actions/runs/36557578359)
passed on attempt 1, including Node 22/24 and exact publication-artifact tests.

- Registry reads confirmed `latest=0.1.1`, `dev=0.1.1-dev.10`. The stable tarball
  matches the final tested candidate byte-for-byte. SHA-512 integrity:
  `sha512-5eYw4NSCDPQrJZVDwfAg9cPtdSuipPy6/FzTj08EDn94/rRJEFLb0Meih2hzbzOSqvNLOn+MJD8Ij0a+nXe99A==`.
- Decoded provenance identifies the same release commit, `refs/tags/v0.1.1`,
  `.github/workflows/publish.yaml`, run `36557578359`, attempt 1; its subject digest
  matches the downloaded tarball. Stable metadata does not expose `gitHead`, so
  source identity is established by provenance and the artifact comparison.
- A clean unqualified consumer install selected CLI 0.1.1 and SDK 0.6.0 and passed
  all 40 CLI contracts. `npm audit signatures` verified all four packages' registry
  signatures and three packages' attestations. No publication was retried.
- Credentialed live evidence remains the installed-candidate smoke below; no new
  live call was needed for byte-identical published runtime/package contents.
- The prepared Homebrew formula pins the verified 0.1.1 tarball and lockfile from
  `80a4c10628ad2ad4ebf8d90a01924d27dcb4a790`. Local macOS checks passed formula
  style, installation, `brew test`, managed Node selection and all 40 installed
  CLI contracts. The harness removed its temporary installation and tap. Remote
  tap publication and upgrade behavior await the separate tap PR.

Post-release development changes preserve this release and start `0.1.2-dev.1`.
The registry-verification change passes 13 focused tests, including the real script
entrypoint with a synthetic npm command: successful publication plus timeout exits
0 with an Actions warning/summary, while failed publication exits 1. Transient
read failures remain bounded; authentication, schema and artifact mismatches fail.
No live publication was used to test that change. The full local suite passed 65
tests and the installed-package suite passed 40.

## CLI 0.1.1 release preparation

On 2026-09-29, candidate commit `6f7bb23` prepared stable metadata from develop
`a65a2b198b484d2e4da4ca2ff438779806a87cce`. Runtime source, tests, examples,
SDK dependency and workflows are unchanged from that reviewed integration.
Version 0.1.1 is a release candidate here, not an npm publication claim.

- Clean candidate checkout on Node.js 24.15.0: `npm ci`, lint, version metadata,
  typecheck and all 64 tests passed. Explicit release preflight with
  `RELEASE_TAG=v0.1.1 RELEASE_PRERELEASE=false` passed without creating a tag.
- Packed the candidate once and ran `npm run test:package -- <tarball>`:
  all 40 installed-CLI tests passed. A separate consumer installation verified
  CLI 0.1.1, SDK 0.6.0 and a LICENSE identical to the source.
- Installed-tarball live smoke used the designated `bench-recall` development
  project at `https://internal-dev-aws-apne2-v3-c05a2b5d492a.lambdadb.ai` with
  the existing secure in-memory environment mapping. The candidate tarball had
  SHA-512 integrity
  `sha512-1MRwAbI7kbAPKNUz2L+rd/F2tIF2I3r3wdI4kpsBNE84Y13TUYwTQF+gIDB95tvByyR1RdUi30ncH699rBhu9w==`.
- Doctor, creation with `chinese` and `english`, ordinary/bulk acceptance, exact
  committed query/fetch contents, match-all facet-only and document+facet buckets
  passed in 61.0 seconds. Temporary Collection
  `cli-smoke-a2894dda-50a2-4fa9-b320-fcc142bdf1fb` was deleted and verified by a
  subsequent HTTP 404. No existing Collection or index was changed.
- This evidence-only addition changes packaged documentation after that smoke.
  The final promotion tarball is checked again by the installed-package suite;
  runtime source, compiled JavaScript, examples and package metadata must remain
  identical to the live-tested candidate. The promotion PR records the final
  artifact digest and CI results separately.

Publication remains a separate step after main promotion and authorization.
The release workflow will rebuild and verify its own exact publication tarball.
The current Homebrew formula still selects published 0.1.0; updating it requires
verified 0.1.1 registry metadata and immutable release-commit checksums.

## SDK 0.6.0 integration

Validated on 2026-09-29 from an isolated worktree based on develop
`513af6e4d262edd380013c86d51a20aad16274d7`, with Node.js 24.15.0 and the
published `@functional-systems/lambdadb@0.6.0` dependency. npm `latest` was 0.6.0.
The release tag resolves to `491d01e0eb54bd135823fab79cbe32396ec03691`;
installed query schema, analyzer schema and client facade source files matched
that tag byte-for-byte. The lockfile records the published package integrity.

- `npm ci`, `npm run lint`, `npm run check:version`, `npm run typecheck`: passed.
- `npm test`: 64 tests passed, including subprocess requests through the actual
  SDK for facet-only success, zero without facets rejection, omitted query,
  malformed facets, bounds, null/default preservation and ref consistency.
- `npm run test:package`: 40 installed-tarball CLI tests passed. Facet metadata,
  inline documents and `docsUrl` downloads survive JSON output; signed URLs and
  credentials remain excluded. Arbitrary facet-name redaction preserves collisions;
  short credentials do not change fixed bucket/result schema keys.
- All 16 analyzer names passed create serialization and reached the loopback API;
  unknown/case-mismatched names failed before HTTP. Omitted, empty and duplicate
  analyzer lists were forwarded unchanged. This does not mean the live server
  accepts duplicate names.
- `git diff --check`: passed. GitHub Node 22/24 CI results are reported on the PR;
  the local run above used Node 24 only.

The credentialed live harness (`node --test test/live/cli.test.mjs`, after build)
used the previously designated development endpoint
`https://internal-dev-aws-apne2-v3-c05a2b5d492a.lambdadb.ai`, project `bench-recall`.
An in-memory launcher used the existing ignored `.env.local` mapping documented
below; no credential file was changed or copied into the worktree.

- Doctor and temporary Collection creation with `english` and new `chinese`
  analyzers succeeded. Two ordinary 3 MiB writes and one bulk write were accepted
  at about 2 seconds in the final run.
- Committed query/fetch contents for all three documents were verified at about
  87 seconds in the final run, without a pending-write overlay.
- Both checked-in facet examples passed: omitted-query `size: 0` returned no
  documents; document+facet returned three. Both returned exact category buckets
  `database: 2` and `developer-tools: 1` through CLI JSON output.
- The final test passed in 87.8 seconds after the short-credential output fix.
  Temporary Collection `cli-smoke-dcd3b60a-b65d-4126-b6e4-ad78904f4eb3` was deleted
  and a subsequent SDK get returned HTTP 404. The earlier integration smoke also
  passed in 53.6 seconds; its temporary Collection
  `cli-smoke-e9f9a7c8-babf-4a62-a8d8-48bfa4683f66` was likewise deleted with 404
  verification.

This proves the bounded sample against one supporting development deployment,
not production availability, all analyzer language behavior or old-index support.
No existing Collection/index was migrated. No CLI merge, tag, GitHub Release or
npm publication was performed as part of this integration.

## Development publication after Homebrew documentation

On 2026-09-19, the [develop push workflow](https://github.com/lambdadb/lambdadb-cli/actions/runs/35434313586)
completed successfully for `225dec37f48dd5603af7fe777c1eb24d9041188c`, the merge of
PR #8. Node 22/24 validation and tests of the exact publication tarball passed.
The publish job accepted `0.1.1-dev.8`, retried registry reads during propagation,
and finished with `result=published` without repeating the write.

Subsequent read-only registry checks confirmed `dev=0.1.1-dev.8`,
`latest=0.1.0`, and the package's `gitHead` matching the merge commit. Decoded
provenance metadata identifies that same commit, `refs/heads/develop`,
`.github/workflows/publish.yaml` and workflow attempt 1; its subject digest matches
registry integrity. This metadata inspection did not repeat signature verification,
a consumer installation or the LambdaDB live smoke.

## Homebrew publication

On 2026-09-19, the public
[lambdadb/homebrew-tap](https://github.com/lambdadb/homebrew-tap) was initialized at
`ca84485149d7915131df686b4c68868d47c00cd5`. Its CLI formula is byte-for-byte equal
to the formula merged in CLI PR #7 (`3eefaaa`), selecting stable `0.1.0` and the
release lockfile at `c8d389f`.

- Local macOS 26.4 arm64 / Homebrew 6.0.17 verification used the tap's new harness
  in both local and remote modes. Remote mode invoked
  `brew install --formula lambdadb/tap/lambdadb-cli` with no existing tap or CLI,
  exercising automatic public tap discovery and formula-specific trust.
- Installation, downloaded formula equality, Homebrew style, `brew test`, version
  `0.1.0`, JSON configuration with mode 0600, and the wrapper with an unusable
  ambient Node all passed. No trust checks were disabled.
- Test installations and taps were removed; existing taps, fnm Node and CLI
  `.env.local` were preserved. Dependencies and caches remain installed.
- [Tap CI](https://github.com/lambdadb/homebrew-tap/actions/runs/35433096180)
  passed remote installation, style, smoke, runtime selection and cleanup on both
  macOS 15 and Ubuntu 24.04 at the published tap commit.
- Simulated existing CLI, broken prefix executable symlink and existing remote
  tap cases stopped the new harness before mutations; invalid mode returned 2
  without invoking Homebrew.
- Tap main protection requires both installation checks, one approving review,
  resolved conversations and an up-to-date base; force pushes and deletion are
  disabled. Organization-level default-branch rules also apply.

This publishes an installation path for the existing stable artifact, without a
new npm release or another LambdaDB live-service smoke. Upgrade behavior between
two distinct stable versions remains unverified until the next formula update.
The earlier 35-contract Homebrew verification below used the same stable artifact;
this tap publication ran the installation smoke checks rather than repeating it.

## Homebrew preparation

On 2026-09-19, macOS 26.4 arm64 / Homebrew 6.0.17 installed stable `0.1.0`
from `packaging/homebrew/Formula/lambdadb-cli.rb` through a disposable local tap.
The npm tarball SHA-256 was checked against the downloaded bytes, whose SHA-512
matched registry integrity. The release lockfile resource is fixed to `c8d389f`.

- Homebrew formula style, installation and `brew test` passed. The formula checks
  CLI version, JSON configuration and mode 0600 without contacting a service.
- A deliberately unusable `node` placed first on ambient PATH did not prevent
  the installed wrapper from running; it selected Homebrew's Node 24.21.0.
- All 35 CLI contracts from the stable release commit passed against the installed
  Homebrew package. The harness uses the release commit's tests/examples so future
  development-only features do not create false failures for an older stable CLI.
- Simulated existing-formula and broken-executable-symlink cases both stopped the
  harness before any installation or tap mutation.
- The temporary CLI installation and tap were removed. The final harness disables
  automatic dependency removal and cleanup, and does not persist developer mode.
  Homebrew dependencies/caches remain: installing Node also upgraded the required
  ca-certificates, openssl@3, readline, sqlite and xz packages during initial setup.
  The existing fnm-managed Node and global npm CLI were not replaced.
- Normal clean-install, lint, version/type checks, 59 source tests and 35 npm
  installed-package contracts also passed. CLI runtime and SDK dependencies did
  not change.

macOS/Linux Homebrew CI is configured separately from runtime CI; current PR job
results are the authority for hosted-runner coverage. This initial preparation
did not create the public tap; publication evidence is recorded above. No new npm
version was published by the preparation. LambdaDB service smoke was not repeated for
this packaging-only change; the stable candidate evidence below remains separate.

## Stable 0.1.0 publication

On 2026-09-19, [GitHub Release v0.1.0](https://github.com/lambdadb/lambdadb-cli/releases/tag/v0.1.0)
and its annotated tag identified main commit
`c8d389f3264d641ae6eafc7737fedd5ea046ddf1`. Its tree exactly matches the reviewed
candidate `658ea7ccdce535bbd4f2e29ae06813e2f2e716e2` from PR #5, including the
runtime verified by the installed-candidate development smoke below. That smoke
was not repeated because release contents were unchanged.

The [release-event workflow](https://github.com/lambdadb/lambdadb-cli/actions/runs/35421226854)
passed on attempt 1. Node 22/24 validation and exact-tarball contracts passed;
Trusted Publishing published `0.1.0` on `latest` at 04:27:06 UTC. Version/tag
metadata and attestation metadata propagated separately. Verification retried
reads only; no second publication or workflow rerun was needed.

A clean, unqualified npm install with an isolated cache resolved to `0.1.0` and
passed version/help plus all 35 CLI contract tests. The downloaded tarball digest,
installed lockfile integrity and provenance subject matched. The decoded SLSA
provenance identified this repository, `.github/workflows/publish.yaml`,
`refs/tags/v0.1.0`, release commit `c8d389f` and workflow attempt 1.
`npm audit signatures` reported no invalid or missing signatures.
At verification, `latest=0.1.0` and `dev=0.1.0-dev.5`; the stable release replaced
the initial bootstrap latest tag without changing the dev channel.

The subsequent main-to-develop synchronization sets `0.1.1-dev.1` as the next
base. Its local clean install, lint, types, version checks, 59 source tests and
35 installed-package contracts passed. This maintenance change updates versions
and documentation only; CLI runtime, dependencies, tests and workflows match
`v0.1.0`. Its PR validation does not itself publish a new dev version.

## Stable 0.1.0 candidate

Prepared `release/0.1.0` from reviewed develop commit
`c8947e96308283ac593e712716f0732121bb1958`. Relative to that commit, only package
versions and release documents change. Runtime source, dependencies, tests,
examples and workflows are unchanged. This records the pre-publication candidate.

On Node.js 24.15.0 / npm 11.12.1, a new worktree passed `npm ci`, lint, type
checking, all 59 source tests, and 35 installed-package contract tests.
`RELEASE_TAG=v0.1.0 RELEASE_PRERELEASE=false npm run check:version -- --release`
passed and selected `latest`. CI results for the final commit belong to the
promotion PR; local success is not a substitute for those required checks.

A newly packed `0.1.0` tarball was installed into an isolated temporary consumer.
Its executable reported `0.1.0` and was selected with `LAMBDADB_TEST_CLI` while
running `node --test --test-reporter=tap test/live/cli.test.mjs`. The launcher used
the maintainer's existing opt-in development settings and the in-memory variable
mapping described below; it did not change or copy `.env.local` into the worktree.
Target: `bench-recall` at
`https://internal-dev-aws-apne2-v3-c05a2b5d492a.lambdadb.ai`.

- Doctor and temporary collection creation passed within the first second.
- Two ordinary documents with 3 MiB payloads each and one bulk document were
  accepted at approximately 3 seconds. Acceptance did not imply search visibility.
- Query and ID fetch on `branch:main` returned all three documents with exact
  contents at approximately 69 seconds, without a pending-write overlay.
- The live test passed in 69.6 seconds. Cleanup was accepted, then an independent
  SDK get returned `ResourceNotFoundError` for
  `cli-smoke-b854ef72-1448-42ae-8c9a-ce5c0441f104`, confirming its absence.
- The source `.env.local` was byte-for-byte unchanged, and the temporary consumer
  and tarball were removed. No key or signed URL is recorded here.

Only documentation was updated after this live run; the final package is checked
again with the installed-package contracts. This is development-service evidence
for a bounded sample, not a latency/readiness guarantee or live tag/alias coverage.
The stable npm artifact and release-event workflow were not verified at candidate
preparation time; the subsequent publication evidence is recorded above.

## Public bootstrap and OIDC publication

On 2026-09-18, the maintainer authorized the public bootstrap
[`0.1.0-dev.1`](https://www.npmjs.com/package/@functional-systems/lambdadb-cli/v/0.1.0-dev.1)
from reviewed develop commit `f2397ba`. Clean installation, lint, types and
53 source tests passed; the exact tarball passed 35 installed-CLI tests and its
published integrity matched. This local publication has no GitHub provenance.

After npm Trusted Publisher setup and repository variable activation, the
[develop push workflow, attempt 2](https://github.com/lambdadb/lambdadb-cli/actions/runs/35340278724/attempts/2)
passed Node 22/24 validation, prepared `0.1.0-dev.4`, tested its exact tarball,
and published with OIDC and provenance. The old six-attempt verification loop
exhausted its five 5-second sleeps before npm metadata propagation completed, so
the job failed after a successful publication. Read-only checks subsequently
confirmed the artifact. The
[protected rerun, attempt 3](https://github.com/lambdadb/lambdadb-cli/actions/runs/35340278724/attempts/3)
completed with `result=already-published`, proving the same source/artifact was
recognized without a second registry write.

The public [`0.1.0-dev.4` provenance](https://registry.npmjs.org/-/npm/v1/attestations/@functional-systems%2flambdadb-cli@0.1.0-dev.4)
identifies `lambdadb/lambdadb-cli`, `.github/workflows/publish.yaml`,
`refs/heads/develop`, source commit `f2397ba102c67f1af9ed5ae0b8b8d47c06da7d4b`,
and workflow attempt 2. Registry `gitHead`, downloaded tarball digest, installed
lockfile integrity and provenance subject agreed. A clean `@dev` installation
using an isolated npm cache passed version/help and all 35 CLI contract tests
with the generated package metadata. `npm audit signatures` verified four package
signatures and three attestations, including the CLI. No credentials were added
to GitHub validation jobs or repository files.

At this verification, `dev=0.1.0-dev.4` and `latest=0.1.0-dev.1`. Bootstrap had
created both tags despite `--tag dev`; a removal attempt for `latest` returned
HTTP 400. The automated dev publication left `latest` unchanged. This observation
does not establish a general version-count rule for npm. Bootstrap and OIDC setup
were complete at that stage; main promotion and stable publication followed as
recorded above.

## Publication verification hardening

The follow-up script uses a five-minute monotonic verification budget, 15-second
maximum read subprocesses and 10-second maximum polling sleeps. It retries only
missing/lagging metadata and transient post-publication reads. It reports an
accepted write separately from `published-verification-pending`, which still exits
nonzero. Authentication, malformed responses and source/artifact mismatches fail
closed. No late response can satisfy the deadline, and no verification path
repeats the registry write.

Deterministic tests exercise 150/180-second metadata/tag propagation, five-minute
expiration, read time consuming the budget, capped final I/O/sleep, late success,
temporary HTTP/transport failures and permanent errors. The changed publication
logic passed all 59 source tests (12 release-automation tests), lint, type checks
and version checks on Node 24.15.0; the installed tarball passed 35 CLI contracts.
A read-only probe used the actual npm CLI and new bounded-read flags to verify
the existing `0.1.0-dev.4` manifest/tag. Only its preflight and accepted write were
simulated; the probe performed no registry mutation.

The [ordinary develop merge workflow](https://github.com/lambdadb/lambdadb-cli/actions/runs/35344153978)
published `0.1.0-dev.5` from `c8947e96308283ac593e712716f0732121bb1958`
on attempt 1. Node 22/24 validation and exact-artifact tests passed. Publication
succeeded at 12:22:09 UTC; registry verification completed at 12:25:10 UTC with
`result=published`. The approximately 181-second propagation delay required only
read retries, with no manual rerun or repeated publication.

A fresh npm `@dev` install with an isolated cache passed all 35 CLI contract tests,
version/help, tarball/lockfile integrity checks and npm signature verification.
Provenance identified the expected repository, develop ref, workflow, source
commit and attempt 1. `dev=0.1.0-dev.5`; `latest` remained `0.1.0-dev.1`.
These registry checks are separate from the development-service smoke below.

## Initial local automation validation (before publication)

On Node.js 24.15.0, lint, type checking and all 46 source tests passed, including
six release-automation tests. The tests cover deterministic first-parent version
numbers, numeric channel ordering, stale commits, registry lookup failures,
artifact/commit conflicts, identical reruns and uncertain publication outcomes.
Registry writes use an injected fake npm runner; no package was published.
A real read-only npm lookup also confirmed the structured E404 handling.

A temporary local Git repository and bare remote exercised the actual prepare
command, including rejected PR/wrong-commit contexts and stale remote heads.
A separate clean source copy generated `0.1.0-dev.2`, installed locked
dependencies, packed and installed the generated artifact, and passed all 35
installed-CLI contracts. Its source `gitHead` and license metadata were preserved
and its Git HEAD did not change. The normal `0.1.0-dev.1` artifact also passed
all 35 installed-CLI contracts.

`actionlint` 1.7.12 accepted the combined CI/publishing workflow. The existing
`Node.js 22` and `Node.js 24` check names are retained. Publishing needs both jobs
and is restricted to explicit releases or opted-in develop pushes. The repository
variable enabling automatic dev publication was not set during this validation.
At that stage, OIDC authentication, registry writes, provenance and GitHub job
ordering were unverified. The later publication evidence above supersedes that
limitation; it does not turn these original local tests into live registry writes.

## Authenticated development-project smoke

Tested the CLI from develop commit `a040f53` (version `0.1.0-dev.1`, SDK `0.5.1`)
with Node.js 24.15.0 against the development target supplied by the maintainer in
the primary checkout's ignored `.env.local`. The designated development target is:

- Endpoint: `https://internal-dev-aws-apne2-v3-c05a2b5d492a.lambdadb.ai`
- Project: `bench-recall`

The API key is excluded from this record. The file used `LAMBDADB_BASE_URL`,
`LAMBDADB_PROJECT_NAME`, `LAMBDADB_PROJECT_API_KEY` and an explicit
`LAMBDADB_RUN_LIVE_TESTS=1`. An in-memory launcher mapped the first three to
`LAMBDADB_ENDPOINT`, `LAMBDADB_PROJECT`, `LAMBDADB_API_KEY`, and supplied the
confirmed development project as `LAMBDADB_LIVE_CONFIRM_PROJECT` for this run.
Neither the file nor the CLI's environment-variable contract was changed.

After `npm run build`, the launcher ran `node --test test/live/cli.test.mjs`:

- The original 75-second query observation window failed after writes were
  accepted. This was a failed smoke, not proof of a service or CLI defect.
- The follow-up harness allows up to 300 seconds per read stage, matching the
  SDK live smoke's committed-document observation window. It reports elapsed
  time and matched-document counts without printing responses or credentials.
- The follow-up run passed: doctor and creation completed within the first
  second; two ordinary writes (3 MiB payload each) and one bulk write were
  accepted at about 2 seconds. Query returned all three expected documents with
  exact contents at about 65 seconds, and ID fetch verified them at about 66
  seconds. Both reads selected `branch:main` without a pending-write overlay.
- Cleanup was accepted for both temporary collections. Subsequent SDK get calls
  returned `ResourceNotFoundError` for
  `cli-smoke-9797d164-abb3-4a7e-ae26-f5ae251ad72c` and
  `cli-smoke-b926fd65-c371-462f-9727-9d5d9edecc1c`, confirming their absence.

The two runs demonstrate variable observation time; 300 seconds is a test budget,
not a readiness or latency guarantee. Full content was verified for a combined
response above 6 MiB, but the CLI harness did not inspect the service's wire
response to prove selection of `docsUrl`. Live tag/alias reads remain unverified.

### Review follow-up: enforce the observation budget

The harness now uses a monotonic deadline, caps CLI and child-process timeouts
to the remaining budget, and limits the final polling sleep. It checks the
deadline after each observation, including content comparison, before accepting
success. Process termination and event-loop scheduling can delay reporting, but
a response at or after the deadline cannot pass the stage.

On Node.js 24.15.0, lint, type checking and all 53 source tests passed. Seven new
deterministic tests cover timely success, late success/failure, success exactly
at the deadline, a capped final sleep, an in-flight timeout and an earlier fatal
error. The regression reproduces a response arriving at 318 seconds and rejects
it; the final request receives only the remaining 2-second budget.
The packed and separately installed CLI also passed all 35 contract tests.

Re-ran `node --test test/live/cli.test.mjs` with this review fix in the working
tree based on `6642eeb`, using the same designated endpoint/project and launcher
above. The CLI runtime source remained identical to `a040f53`; SDK version was
`0.5.1`. Doctor and collection creation passed within the first second, ordinary
and bulk writes were accepted at about 3 seconds, and exact query/fetch contents
passed at about 91 seconds (test duration: 91.231 seconds). Both reads used
`branch:main`. Cleanup was accepted for
`cli-smoke-3cb15833-414d-4265-9b57-70df164b28ef`; a subsequent SDK get returned
`ResourceNotFoundError`, confirming absence. Deadline boundary cases were
verified deterministically above, not by inducing a live service timeout.

## 0.1.0-dev.1 release preparation

Revalidated on 2026-09-18 in a fresh worktree based on develop commit `52e7aa2`
with Node.js 24.15.0 and npm 11.12.1. `npm ci`, lint, type checking and version
checks passed. Source tests passed (40), and the separately installed tarball's
CLI tests passed (35), with no failures or skips. The version assertion now
compares the executable against package metadata instead of a fixed version.

`RELEASE_TAG=v0.1.0-dev.1 RELEASE_PRERELEASE=true npm run check:version -- --release`
passed and selected the `dev` channel. This checks release metadata only; it does
not publish or establish main ancestry, npm permissions or live-service behavior.
At the initial release-preparation stage no development connection settings were
supplied, so live validation was not attempted then. See the later smoke above.

## Completed local validation

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed with TypeScript 5.8.3. |
| `npm run lint` and `npm run check:version` | Passed; package and lockfile metadata agree. |
| `npm test` on Node.js 24.15.0 | 40 tests passed, zero failed or skipped. |
| Prior CLI MVP suite on Node.js 22.23.2 via `npm exec --yes --package=node@22 -- node --test test/*.test.mjs` | 40 tests passed, zero failed or skipped; new automation tests are recorded separately above. |
| Fresh temporary source directory: `npm ci`, `npm run build`, CLI version | Passed without the development checkout's node_modules or dist. |
| `npm run test:package`: pack, inspect inventory, install in a temporary consumer, invoke executable version/help and repeat CLI contracts | 35 installed-CLI tests passed on Node 24. Package was never published. |
| `actionlint` on CI and publish workflows | Passed. This is static validation, not an OIDC publication. |
| Live command without opt-in | Expected nonzero exit before network calls; not counted as a live test pass. |
| npm install dependency audit | Zero vulnerabilities reported at installation time. |
| Apache-2.0 license packaging | Official license text from apache.org is included byte-for-byte as `package/LICENSE` in the built tarball; package.json and lockfile license metadata agree. |
| Reference SDK status and specified sbrain file status | Unchanged. |

Tests use the actual published SDK and CLI subprocesses; they do not replace the
SDK with a fake client for transport tests. The workflow unit tests separately
cover byte accounting and cancellation between batches.

## Behavior exercised

- Configure, doctor, create (HTTP 201), JSONL upsert (HTTP 202), query, fetch,
  describe and paginated collection listing.
- Exact branch/tag/alias request bodies and result targets on query and fetch;
  write branch forwarded on ordinary and bulk requests.
- SDK pagination with an opaque continuation token.
- SDK bulk metadata, signed headers, upload body and finalization; no project
  credential sent to object storage.
- SDK offloaded query/fetch downloads for each ref kind, including 1 MiB returned
  document bodies; consumed signed URLs omitted from CLI output.
- Complete-file preflight rejects malformed later JSONL lines, invalid IDs,
  empty files and oversized individual batch entries before any request.
- Invalid query fields, conflicting file/flag refs, invalid query size and
  branch-only consistency constraints rejected before requests.
- Query `size: null` normalized to SDK omission and branch consistency forwarded.
- Accepted/rejected/not-attempted batch counts and physical line ranges.
- Disconnect, HTTP 503, malformed 202 and timeout classified as unknown writes
  without mutation retries, preserving previously accepted batches.
- Failed bulk upload not retried or finalized; reported conservatively as unknown
  because the SDK helper has no structured error stage.
- Shared deadline applies to API calls, signed downloads and signed uploads;
  cancellation between batches leaves unsent rows not attempted.
- Actual SIGINT/SIGTERM during an active second write preserve the accepted first
  batch, mark the active batch unknown and leave the third batch unattempted.
- Release channels and rejection of version drift, invalid tags/flags, private
  publication and missing license metadata.
- Empty results succeed; 401/403 authentication failures, other API failures and
  invalid response schemas fail; creation conflicts differ from uncertain writes.
- All documented exit codes, JSON parseability, stdout/stderr separation, human
  summaries, help and version.
- Flag/environment/saved-config precedence, explicit missing config, missing
  selected key, custom key-variable names and POSIX config file mode 0600.
- SDK debug suppression and credential redaction in errors and returned documents,
  including secret strings containing JSON structural characters.
- Short keys preserve JSON envelope fields, CLI command/state/check tokens,
  ref kinds and error codes. Arbitrary document/index/tag keys and variable
  values remain redacted; human output retains its structured data section.
- Redacted map-key collisions preserve all entries and unchanged field names.
  Query/fetch regressions cover both input orders, multiple colliding renamed
  keys, preexisting suffixes and nested maps; collection metadata covers tag and
  index-config collisions. Generated suffixes cannot overwrite reserved names.
- Exactly 100,000 documents are accepted by input preflight; excess rows are
  rejected with their physical line number, excluding blank lines from the count.
  CRLF and a final line without a newline are covered.
- A 3 MB file of one million small documents exits 2 before any API request under
  a 128 MiB V8 heap limit. The pre-fix reader reproduced heap exhaustion with
  that input. Ten million blank lines followed by invalid JSON also exit 2 within
  that heap limit, preserving the final line number without a split array.

## Source and public-contract inspection

Verified npm latest and installed SDK 0.5.1; checked current local SDK source and
published OpenAPI/quickstart. Evidence revisions and compatibility findings are
in [DESIGN.md](DESIGN.md). These checks establish the chosen contract, not the
deployment state of an individual LambdaDB endpoint.

## Not performed / not established

- The live smoke verifies one designated development target and a bounded sample;
  it does not establish general query/index readiness, search ranking, managed
  embedding behavior, exhaustive signed-storage policies or production-scale
  performance. Credentials were not searched for in other repositories.
- No proof of exactly-once delivery, durable resume, or a committed-through write
  receipt. Those capabilities are not implemented.
- No Windows-specific permission or signal validation. POSIX modes and injected
  SIGINT/SIGTERM were checked on macOS; CI targets Linux.
- Mock large-response tests cover SDK routing/credential separation at 1 MiB;
  the live sample verifies combined content above 6 MiB. Neither is an exhaustive
  memory/size stress test. Imports buffer a maximum 64 MiB source file
  and retain at most 100,000 documents. Complex documents can still use much more
  memory than their serialized size; the count limit is not a process memory cap.

## Requirements for live verification

Follow the explicit settings and `npm run test:live` procedure in
[RELEASING.md](RELEASING.md#explicit-live-smoke). The authenticated main-branch
flow and cleanup have been exercised as recorded above. For non-main refs,
supply existing development branch/tag/alias
targets whose expected contents are known. Record evidence without keys or signed
URLs. Temporary collection deletion is performed by the harness through the SDK,
not exposed as a CLI command.

During expanded validation, a second-write timeout hung repeatedly in the source
and installed package. An explicit timer alone was insufficient; binding the
command signal through SDK HTTPClient fetch dispatch resolved the observed local
regressions. See [DESIGN.md](DESIGN.md) for the compatibility boundary; the exact
upstream cause is not claimed. Commits, pushes and CI runs are recorded in Git
and the pull request; local checks do not imply service or publication success.
