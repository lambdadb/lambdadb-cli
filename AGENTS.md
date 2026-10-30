# AGENTS.md

Guidance for coding agents working in this repository. CONTRIBUTING.md covers
branches, validation and releases; RELEASING.md covers the release flow.

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
