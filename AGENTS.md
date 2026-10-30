# AGENTS.md

Guidance for coding agents working in this repository: where things live, the
rules that are easy to break, and the bundled skill's design. For depth, read
[CONTRIBUTING.md](CONTRIBUTING.md) (branches, validation, credentials, adapters),
[RELEASING.md](RELEASING.md) (versions, tags, npm dist-tags, live smoke),
[DESIGN.md](DESIGN.md) (SDK contract decisions) and `docs/` (user guides).

## Repository map

- `src/cli.ts` wires commands; `src/command.ts` names the executable for hints.
- `src/init.ts` plans and atomically applies agent setup; `src/agents.ts` is the
  adapter registry (detection, MCP and skill paths, restart text per agent);
  `src/agent-config.ts` edits JSONC/TOML while preserving unrelated settings;
  `src/skill-history.ts` lists every bundled skill hash.
- `src/config.ts`, `src/credentials.ts`, `src/device-auth.ts`, `src/account.ts`,
  `src/projects.ts` cover settings, OS credential stores and account login.
- `src/import-workflow.ts`, `src/runtime.ts`, `src/usage.ts` cover document
  import, data API calls and usage reporting.
- `skills/lambdadb/SKILL.md` is the bundled skill; `examples/` holds the query
  and index-config files the README and help text name.
- `test/*.test.mjs` is the mock/local contract suite CI runs; `test/live/` needs
  a real project key and never runs in CI; `test/fixtures/` holds previously
  released skill bytes.
- `docs/`, `README.md`, `CHANGELOG.md`, `examples/` and `skills/` ship in the
  npm package (`files` in `package.json`), so relative links in them must
  resolve inside the tarball or be absolute URLs.

## Working conventions

- Branch from current `main` (`feat/*`, `fix/*`), one coherent change per PR,
  squash merge. There is no `develop`.
- Add a `CHANGELOG.md` entry under `## [Unreleased]` for every user-visible
  change, in the same PR. Release PRs move that section under a version.
- `npm test` builds first, then runs the contract suite; `npm run lint`,
  `npm run typecheck` and `npm run test:package` are the other CI gates. Run them
  before opening or updating a PR and record the exact outcome in the PR.
- Never put a key in a file, flag, example, test fixture or PR text; tests use
  synthetic values and assert they do not leak. Live validation (`npm run
  test:live`) requires a deliberately exported key and is reported separately.
- Codex reviews every PR. A push does not re-trigger it: comment `@codex review`
  once per new head, wait for the review summary to report the current commit
  as completed, address or rebut each finding in its thread, and resolve the
  thread only after replying.
- Keep an unmodified CLI contract unless the change asks for it: argument
  parsing, validation order, error classification, exit codes and the JSON
  envelope (`ok`, `error.code`, `error.httpStatus`, `error.hint`) are relied on
  by agents and tests.

## Bundled agent skill (`skills/lambdadb/`)

`init` copies `skills/lambdadb/SKILL.md` into each selected coding agent. The
skill is read by agents in other people's sessions, so its shape follows a few
rules that are easy to break while "improving" it:

- **One file.** The skill is `SKILL.md` alone. Content an agent needs on almost
  every LambdaDB task (connection, inspect-before-search, read-after-write,
  recovery) belongs in `SKILL.md`, not in `references/`. Add a `references/`
  file only for material that is optional for most tasks, and update `init` to
  install it; today `init` installs `SKILL.md` only.
- **Route to docs, do not restate the query DSL.** docs.lambdadb.ai is the
  single source of truth for request shapes and limits, and it serves every page
  as agent-ready Markdown (`https://docs.lambdadb.ai/llms.txt` lists them). The
  skill maps each query task to the exact page an agent must read before writing
  that shape. Do not add clause lists, parameter tables or numeric limits to the
  skill: they drift from the server, and an apparently exhaustive list makes
  agents reject or rewrite valid requests. If a docs page is wrong, fix the docs.
- **Keep the verified examples verified.** The JSON blocks in `SKILL.md` are an
  offline safety net. Run any changed example against a real collection with
  `lambdadb query` and keep them LambdaDB-shaped: `bool` is an array of clauses
  with `occur`; there is no `term`, `match` or standalone `filter` clause;
  keyword filters are Lucene syntax inside `queryString`.
- **Network is assumed.** Agents using LambdaDB already need network access, so
  the skill links to docs instead of vendoring copies. Do not add a docs sync or
  vendoring step without a new decision.
- **Record the hash when the skill changes.** `src/skill-history.ts` lists the
  SHA-256 of every bundled `SKILL.md` and former `references/usage.md` version.
  `init` treats an installed file with a listed hash as an unmodified bundled
  copy and upgrades or removes it; anything else is a user edit and is preserved.
  `test/skill.test.mjs` fails with the hash to add. Add it in the same commit
  and never remove old hashes.
- **Say what the agent should do, not what LambdaDB is.** Instructions are
  imperative, name the exact command or page, and keep safety rules (no credential
  printing, no identity switching, writes only when asked) intact.

## Validation before a PR

Run `npm test` and `npm run lint`; `npm run test:package` when `package.json`
`files` or the bundled skill layout changes. Record exact commands and outcomes
in the PR, and distinguish simulated agent contract tests from live agent
verification, which the suite does not perform.
