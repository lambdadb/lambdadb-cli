# LambdaDB CLI

Set up LambdaDB from your terminal, manage Orgs and projects, check usage,
and import or search data. Configure coding agents to use the same project
through the CLI or MCP.

- [Quick start](#quick-start)
- [Install and run](#install-and-run)
- [Choose a command](#choose-a-command)
- [Authentication and targets](#authentication-and-targets)
- [Coding agents](#coding-agents)
- [Guides](#guides)
- [Development](#development-and-boundaries)

## Quick start

Requires Node.js 22.14 or newer and npm. Install the CLI, then initialize from
your repository root:

```sh
npm install --global @functional-systems/lambdadb-cli
lambdadb init
```

If already installed, run `lambdadb init`. The examples below use the installed
`lambdadb` command. To try the CLI without a global install, use
[npx](#run-without-a-global-install); for a bundled Node runtime on macOS or Linux,
use [Homebrew](#homebrew). For development testing, use
`@functional-systems/lambdadb-cli@dev` instead.

1. Sign up or sign in through Console, compare the terminal code, and approve
   **CLI Login**. You can also connect an existing project using an API-key
   environment variable.
2. For browser setup, return to the terminal to select an Org and project, or
   explicitly create a project with a name and region.
3. Choose coding agents and where to install their settings. Review the paths
   and MCP write-tool choice before approving the changes.
4. Restart or reload the selected agents and follow the first-query guidance.

Use arrow keys and Enter in menus, and Space to toggle agents. Nothing is
preselected in the agent list. Enter with nothing checked offers a return to
selection or an explicit skip; focus alone does not select an agent. File review
offers **Change options** for scope and MCP write tools; **Show all files** expands unchanged paths.

For SSH or a host without a visible browser:

```sh
lambdadb init --no-browser
```

This prints an approval URL to open on another device; browser authentication
is still required. Signup/login, CLI approval, pending invitation decisions and
billing activation happen in Console. Project selection and creation continue
in the terminal. See [setup and reruns](docs/setup.md).

Init verifies authentication and collection-list access. It creates no collections
or documents, and a successful check does not establish search readiness.
For existing data, try this agent prompt:

> Use the LambdaDB CLI with JSON output and my selected configuration file.
> List collections, inspect the chosen collection's index, and read a small sample
> at my selected ref before searching an indexed field. Do not create or modify data.

For CI or an existing key, use [environment-variable setup](docs/setup.md#environment-variable-setup)
and [non-interactive init](docs/setup.md#non-interactive-setup).

## Install and run

### Install from npm

Requires Node.js 22.14 or newer and npm.

Install the CLI and check that `lambdadb` is available:

```sh
npm install --global @functional-systems/lambdadb-cli
lambdadb --version
lambdadb --help
```

npm links the executable into its global bin directory, which must be on your
`PATH` to use `lambdadb` directly.

For reproducible CI runs, pin an exact published version such as
`@functional-systems/lambdadb-cli@0.1.3`. To try development builds, explicitly use
`@functional-systems/lambdadb-cli@dev` in the installation or npx command; this
moving channel contains prereleases.
Installed CLIs do not update themselves. See
[GitHub Releases](https://github.com/lambdadb/lambdadb-cli/releases) and
[CHANGELOG.md](CHANGELOG.md) for published changes and compatibility notes.

### Run without a global install

Use npx to initialize and run subsequent commands without installing globally:

```sh
npx @functional-systems/lambdadb-cli init
npx @functional-systems/lambdadb-cli collections list --json
```

This runs the same CLI package and executable, but does not add a persistent
`lambdadb` command to your shell. In every example in this guide, replace
`lambdadb` with `npx @functional-systems/lambdadb-cli`. Init's next steps
also use an npx command when setup runs through npx.

### Homebrew

On macOS or Linux with [Homebrew](https://brew.sh/) installed:

```sh
brew install lambdadb/tap/lambdadb-cli
lambdadb --version
lambdadb --help
```

The [LambdaDB tap](https://github.com/lambdadb/homebrew-tap) installs the stable CLI
and its Node 24 runtime. No separate Node/npm setup is needed. Update with
`brew update` followed by `brew upgrade lambdadb/tap/lambdadb-cli`; remove with
`brew uninstall lambdadb/tap/lambdadb-cli`.

If another installation provides `lambdadb`, check `command -v lambdadb` before
switching package managers. Follow Homebrew's formula trust prompts without
disabling trust checks. See the
[maintainer guide](https://github.com/lambdadb/lambdadb-cli/tree/main/packaging/homebrew#readme)
for packaging and validation details.

## Choose a command

Only `init` prompts for choices. All other commands require explicit arguments;
`login` waits for browser approval without prompting on stdin.

| Task | Command | Details |
| --- | --- | --- |
| Guided project and agent setup | `lambdadb init` | [Setup](docs/setup.md) |
| Sign in for account management | `lambdadb login` | [Account access](docs/account.md) |
| List Orgs | `lambdadb orgs list --json` | [Org/project management](docs/account.md) |
| List or create projects | `lambdadb projects list` / `create` | [Required IDs and options](docs/account.md) |
| Select a project connection | `lambdadb projects use` | [Key issuance and reuse](docs/account.md) |
| Read usage and estimates | `lambdadb usage` | [Free quotas / Pay-As-You-Go](docs/account.md#usage-and-cost-estimates) |
| Save connection settings | `lambdadb configure` | [Configuration](docs/setup.md#settings-and-precedence) |
| Verify project access | `lambdadb doctor` | [What doctor checks](docs/setup.md#check-the-connection-with-doctor) |
| List, inspect or configure collections | `lambdadb collections list` / `describe` / `create` / `update` | [Collections](docs/data.md#collections) |
| Import documents | `lambdadb docs import` | [JSONL imports and outcomes](docs/data.md#import-jsonl) |
| Search or fetch documents | `lambdadb query` / `docs fetch` | [Queries and explicit refs](docs/data.md#query-and-fetch-at-explicit-refs) |

Use `lambdadb --help` or `lambdadb <command> --help` for exact flags. For automation,
use `--json`; see [output, deadlines and exit codes](docs/data.md#output-deadlines-and-exit-codes).

## Authentication and targets

Account access, data access and agent file locations are separate choices:

| Choice | What it controls |
| --- | --- |
| Account login | Org/project management and usage, using a separate OS-stored session. Login alone does not select a project or install agents. |
| Project connection | Data commands use the selected endpoint, project name and project API key. Browser setup stores keys in the OS credential store; manual/CI setup reads a named environment variable. |
| `init --scope project` / `--scope user` | Installs agent settings in the current repository or the agent's user configuration. It does not select a LambdaDB project or change the CLI configuration path. |

`--org-id` and `--project-id` accept UUIDs for management/usage commands.
`--project` accepts a **name** for data commands. CLI configuration is user-local
by default; use `--config` to select a different file. No secret values are stored
in CLI or agent configuration, and `.env` files are never loaded automatically.

Switching with `projects use` changes the CLI connection. Existing agent entries
remain pinned until you rerun `init` and approve the updated file plan.
[Credential stores, precedence and recovery](docs/setup.md#configuration-and-authentication).

## Coding agents

Init can configure MCP and install a LambdaDB usage skill for:

| Agent | `--agents` value | Agent settings location (`--scope`) |
| --- | --- | --- |
| Codex | `codex` | Repository (`project`) or user |
| Claude Code | `claude` | Repository (`project`) or user |
| Cursor editor/CLI | `cursor` | Repository (`project`) or user |
| VS Code | `vscode` | Repository (`project`) or user |
| Gemini CLI | `gemini` | Repository (`project`) or user |
| OpenCode | `opencode` | Repository (`project`) or user |
| GitHub Copilot CLI | `copilot` | Repository (`project`) or user |
| Kiro IDE/CLI | `kiro` | Repository (`project`) or user |
| Cline VS Code extension | `cline` | User only |

Detection is a hint; select any subset or `none`. The skill prefers an available,
authenticated CLI, with MCP when terminal execution is unavailable or requested.
Guided init enables MCP write tools and user scope by default; `--non-interactive`
runs enable write tools only with `--write-tools`. Existing unrelated agent configuration
and edited skills are preserved; an unmodified bundled skill follows CLI upgrades on
rerun, and reruns show the files being changed.

See [agent paths, credential forwarding and restart instructions](docs/agents.md).
Generated settings and simulated contract tests do not establish live agent
verification.

## Guides

| Guide | Contents |
| --- | --- |
| [Setup and configuration](docs/setup.md) | First use, project limits, non-interactive setup, safe reruns, OS stores, environment variables and precedence |
| [Coding agent setup](docs/agents.md) | MCP/skill paths, agent overrides, credential forwarding and reload steps |
| [Account, projects and usage](docs/account.md) | Explicit management commands, Free quotas, paid estimates, timeouts and session recovery |
| [Data commands and output](docs/data.md) | First reads, sample writes, collections, embeddings, reranking, imports, facets, JSON and exit codes |

## Development and boundaries

Changes reach the Git `main` branch through squash-merged pull requests; there
is no `develop` branch. While the version on `main` is already released,
successful main push CI publishes uniquely versioned packages on the `dev`
channel, derived from that version. CI generates the number; developers do not
change the version for every merge. Newer work
may supersede pending builds. RC and stable releases remain explicit and use
`rc` and `latest`. See [CONTRIBUTING.md](CONTRIBUTING.md) for branch roles, PR checks
and the release boundary. [RELEASING.md](RELEASING.md) covers version channels,
npm bootstrap, Trusted Publishing and release checks. CI validates Node.js 22
and 24 using local contracts and the same CLI contracts against an installed
tarball.

### Build from source

Requires Node.js 22.14 or newer and npm. From a checkout of this repository:

```sh
npm ci
npm run build
node dist/cli.js --help
```

Run commands with `node dist/cli.js`, or install the built directory into a local
prefix to use the `lambdadb` executable:

```sh
npm install --prefix "$HOME/.local" /absolute/path/to/lambdadb-cli
export PATH="$HOME/.local/node_modules/.bin:$PATH"
lambdadb --help
```

`npm start -- ...` also works for human use. For machine-readable stdout, invoke
`node dist/cli.js ... --json` or the executable directly; npm may print banners.

### Run checks

This CLI uses `@functional-systems/lambdadb@0.11.0` for authentication, HTTP,
read retries, pagination, bulk transfers and large response downloads.

```sh
npm run lint
npm run check:version
npm run typecheck
npm test
npm run test:package
```

Tests execute the real CLI and installed SDK against loopback HTTP servers. They
cover the complete first-use flow, ref forwarding, signed transfers, pagination,
partial and unknown writes, validation, output, credentials and exit codes.
They do not contact a LambdaDB service. See [DESIGN.md](DESIGN.md) for contract
decisions and [CONTRIBUTING.md](CONTRIBUTING.md#validation-scope) for validation
methods and their limits.

### Scope and live validation

The CLI supports account login and Org/project setup, plus collection and document
commands for the selected LambdaDB project. Billing, membership management and
account deletion stay in Console.
Branch/Tag/Alias management, remote MCP, Git collection, chunking, code-search
workflows, data deletion and plugins are outside this CLI's current scope. Reads
can select existing refs. This change does not modify the SDK or MCP package.

Live verification requires an explicitly designated development project, endpoint
and project key. Do not discover or borrow credentials from another repository.
Use `npm run test:live` with the explicit opt-in settings in
[CONTRIBUTING.md](CONTRIBUTING.md#live-validation). It exercises ordinary/bulk
import, query/fetch up to 1000 results/IDs, the server-managed `id` round trip,
OpenAI and Cohere native embeddings, Bayesian search, and TypeSafe and Cohere
reranking in temporary Collections, then uses the SDK to delete them and verify
their absence. The normal test suite and PR CI never run it; the publishing
workflow runs it against dedicated smoke projects before every publication and
release verification
([RELEASING.md](RELEASING.md#deployed-live-smoke)).

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
