# Releasing LambdaDB CLI

## Current status

Publication is prepared, not enabled: `package.json` remains `private: true`.
The CLI is licensed under [Apache-2.0](LICENSE), with matching package metadata.
The first public version and package ownership must be confirmed in a release
preparation PR.
The public npm lookup for `@functional-systems/lambdadb-cli` returned E404 on
2026-09-18; this is not proof that the name is available or that ownership exists.

The workflow rejects private packages, missing license metadata, mismatched
versions/tags, wrong prerelease flags and missing dated changelog entries.
Adding this workflow does not authorize merging, tagging or publishing.

## Branch and version policy

Follow [CONTRIBUTING.md](CONTRIBUTING.md): feature/fix PRs target `develop`,
promotion PRs target `main`. All published channels come from reviewed `main`
history, including development and release-candidate versions. Main is a reviewed
release baseline; npm `latest`, not the main branch tip, identifies stable npm.

| Package version | Git tag | npm dist-tag | GitHub prerelease |
| --- | --- | --- | --- |
| `X.Y.Z-dev.N` | `vX.Y.Z-dev.N` | `dev` | true |
| `X.Y.Z-rc.N` | `vX.Y.Z-rc.N` | `rc` | true |
| `X.Y.Z` | `vX.Y.Z` | `latest` | false |

Only these canonical version forms are supported. No leading zeroes or build
suffixes. Update package.json and both root version entries in package-lock.json
together; `npm version VERSION --no-git-tag-version` prepares this without a tag.
Move release notes from Unreleased to a dated `## [VERSION] - YYYY-MM-DD` section.
The executable reads package.json, so it has no independently maintained version.

Treat command/flag changes, required target changes, JSON envelope changes and
exit-code reinterpretations as compatibility changes. Describe migrations before
shipping them. Additive optional fields can remain schemaVersion 1; incompatible
JSON envelope changes require a new schemaVersion. During 0.x, put incompatible
changes in a minor release; after 1.0, use a major release. Keep patch releases
compatible. Human summaries are not a scripting interface.

## Preflight and release procedure

1. Prepare and review the release version, license file/metadata, changelog,
   dependency changes and package inventory. Set `private: false` only in this
   explicitly approved preparation. Preserve the exact repository URL.
2. Run the following in a clean checkout of the candidate commit with Node
   22.14+ (CI tests current Node 22 and 24). Do not load production credentials.

   ```sh
   npm ci
   npm run lint
   npm run check:version
   npm run typecheck
   npm test
   npm run test:package
   ```

3. Run the live smoke below against an explicitly designated development project.
   Record commit, SDK version, endpoint/project, command, outcome and cleanup
   without keys or signed URLs. Missing credentials are a blocked release
   prerequisite, not a skipped success. PR CI deliberately has no service keys.
4. Promote to main by reviewed PR with required CI checks. Re-run checks/live
   smoke if release contents changed. Record the verified commit in release notes.
5. Obtain explicit authorization for the immutable tag and publication. Tag the
   verified main commit with `vVERSION`, push that tag, and publish a GitHub
   Release using the table's prerelease flag. Draft releases do not publish npm.
6. `.github/workflows/publish.yaml` validates main ancestry and metadata, runs
   lint/types/local tests, packs once, installs and tests that exact tarball, then
   publishes it with the selected dist-tag and provenance. The release workflow
   does not rerun the credentialed live prerequisite; release owners must retain
   that evidence before publishing the GitHub Release.
7. Verify the workflow, npm version/dist-tag, provenance's repository/commit and
   a clean consumer install of the exact version. Test the installed binary's
   version/help and basic JSON behavior. Confirm a dev/rc release did not move
   `latest`. Synchronize release-only main changes back to develop by PR.

Useful read-only checks after publication:

```sh
npm view @functional-systems/lambdadb-cli@VERSION version dist.integrity dist.attestations --json
npm view @functional-systems/lambdadb-cli dist-tags --json
```

Do not move published tags or republish a used version. If registry metadata is
slow to propagate, retry reads; do not initiate another publication. For a bad
release, stop promotion, document the impact and prepare a new patch version.
Deprecation or dist-tag changes are explicit maintainer actions, not automatic
rollback. Never silently downgrade consumers.

## First publication and npm Trusted Publishing

Trusted Publishers are package-specific. The SDK's configuration does not cover
this CLI. npm requires an existing package before configuring its trust policy.
See the official [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

For a new package, first complete the reviewed release preparation and preflight.
An authorized npm organization owner performs the bootstrap from the verified
main commit, using interactive `npm login` and the account's MFA, then publishing
the tested tarball with an explicit channel. Prefer a real `dev` prerelease for
the first bootstrap; do not reserve the name with an empty placeholder. This
one-time local publication does not provide GitHub Actions provenance. Do not
also trigger the publish workflow for that same already-published version.

After bootstrap, open the CLI package's npm **Settings → Trusted Publisher** and
select GitHub Actions. Use these values for the workflow in this repository:

| npm setting | Value |
| --- | --- |
| Package | `@functional-systems/lambdadb-cli` |
| Organization or user | `lambdadb` |
| Repository | `lambdadb-cli` |
| Workflow filename | `publish.yaml` (filename only) |
| Environment name | Leave empty; the job currently declares no environment |
| Allowed actions | Enable direct `npm publish` |

The workflow uses a GitHub-hosted runner, Node 24, npm >=11.5.1 and
`id-token: write`. No long-lived npm secret is required. If a GitHub Environment
is later added, its exact name must also be configured on npm. Saving settings
does not prove OIDC works; verify the next authorized publication. Current npm
configurations can default to staged publishing only, which is insufficient for
this direct-publish workflow. See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/).

## Explicit live smoke

Provision a disposable development project/key outside this tool, with create,
ordinary and bulk write, query/fetch and temporary-collection delete access.
Supply the key through secure shell input or a secret manager, never in history.

```sh
export LAMBDADB_ENDPOINT=https://YOUR_DEV_API_ORIGIN
export LAMBDADB_PROJECT=YOUR_DEV_PROJECT
# Inject LAMBDADB_API_KEY securely; no .env file is loaded automatically.
export LAMBDADB_RUN_LIVE_TESTS=1
export LAMBDADB_LIVE_CONFIRM_PROJECT="$LAMBDADB_PROJECT"
npm run test:live
```

The test fails before API calls when required settings are absent. It creates a
random temporary collection, imports two 3 MiB documents plus a bulk document,
and checks committed query/fetch contents with bounded observation windows.
Collection cleanup uses the SDK because deletion is outside the public CLI MVP.
Only the test's own collection is eligible for cleanup. An interrupted process
or failed cleanup may leave that named collection; inspect it manually.

This sample does not prove global index readiness, ranking quality, every ref's
live behavior, or exactly-once writes. A large result alone does not prove the
service selected docsUrl; mock tests explicitly exercise that transport path.
Use existing known development tag/alias refs for additional live ref evidence.

## Design references

- LambdaDB TypeScript client `RELEASING.md` and `publish.yaml`: reviewed main
  history, canonical channels, separate live evidence, same tested artifact and
  OIDC. CLI tests invoke an executable rather than SDK ESM/CJS imports.
- LambdaDB migration `.goreleaser.yml`/release workflow and `install.sh`: verify
  installed artifacts and explicit versions. Go binaries, GoReleaser and Docker
  distribution are unnecessary for this npm CLI's first release.
- [Command Line Interface Guidelines](https://clig.dev/): preserve machine output,
  separate diagnostics, avoid interactive CI requirements, protect secrets and
  test cancellation. The CLI contract suite exercises these boundaries.

External documentation checked on 2026-09-18. Consult current npm documentation
when configuring the package; registry requirements can change independently.
