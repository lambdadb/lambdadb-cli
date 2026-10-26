# LambdaDB CLI

Connect a LambdaDB project, configure coding agents, and import or search data
from your terminal or CI.

- [Quick start](#quick-start)
- [Install and run](#install-and-run)
- [First-use setup](#first-use-setup-with-init)
- [Supported coding agents](#supported-coding-agents)
- [Account and project management](#account-and-project-management)
- [Configuration and authentication](#configuration-and-authentication)
- [Query existing data](#query-existing-data)
- [Command examples](#command-examples)
- [Output and exit codes](#output-deadlines-and-exit-codes)
- [Development](#development-and-boundaries)

## Quick start

Requires Node.js 22.14 or newer and npm. Run from your repository root:

```sh
npx @functional-systems/lambdadb-cli@latest init
```

If the CLI is already installed, run `lambdadb init` instead. Both entry points
use the same package and executable. The command examples below assume an
installed `lambdadb`; with npx, replace that prefix with
`npx @functional-systems/lambdadb-cli@latest`.

1. Choose Console signup/login or connect an existing project with an API-key
   environment variable.
2. For browser setup, sign up or sign in, compare the terminal code, and approve
   **CLI Login**. Return to the terminal to select an Org and project or explicitly
   create a project with a name and region.
3. Choose coding agents, project/user scope, and whether to enable MCP write
   tools. Review the displayed paths before approving the file changes.
4. After the connection check, restart or reload the selected agents and follow
   the generated first-query guidance.

Init checks authentication and collection-list access. It does not create
collections or documents, and success does not establish search readiness.
For an existing collection, try this prompt in your agent:

> List my LambdaDB collections. Inspect the selected collection's index
> configuration, then read up to five documents at branch:main before searching
> an indexed field. Do not create or modify data.

Browser setup requires matching Backend and Console support and an accessible
OS credential store. If either is unavailable, use
[environment-variable setup](#environment-variable-setup). For CI or a
non-interactive shell, use [non-interactive init](#non-interactive-setup).

## Install and run

### Install from npm

Requires Node.js 22.14 or newer and npm.

Install the stable channel:

```sh
npm install --global @functional-systems/lambdadb-cli
lambdadb --version
lambdadb --help
```

For reproducible CI runs, pin an exact published version such as
`@functional-systems/lambdadb-cli@0.1.3`. To try development builds, explicitly use
`@functional-systems/lambdadb-cli@dev`; this moving channel contains prereleases.
Installed CLIs do not update themselves. See
[GitHub Releases](https://github.com/lambdadb/lambdadb-cli/releases) and
[CHANGELOG.md](CHANGELOG.md) for published changes and compatibility notes.

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
[maintainer guide](https://github.com/lambdadb/lambdadb-cli/tree/develop/packaging/homebrew#readme)
for packaging and validation details.

## First-use setup with `init`

### Connect or reuse a project

On a first run, init offers browser setup or an existing environment-held key.
Reruns reuse the saved connection. To select or create a project through account
login, run `lambdadb init --connect`; previously saved project keys are reused.
For SSH or a host without a visible browser, run:

```sh
lambdadb init --connect --no-browser
```

Approve CLI Login in Console after Google/email signup or login. The printed URL
and code also work in a browser on another device. Project selection and creation
continue in the terminal. A default Org is created only on first project
submission. Pending invitations require a Console decision first; the survey is
optional.

### Project limits and manual Console steps

The remaining manual Console steps are signup/login and deliberate CLI approval,
invitation decisions when present, and any billing activation. If the Org has
reached its project limit, init offers existing projects and an Org-specific
billing link. Only the owner can activate billing. After billing, choose retry to
read the server's updated limits; opening the link does not upgrade or charge.
New Orgs normally start at one project, but CLI always uses the backend's actual
limit, including paid/custom limits. A provisioning project can be selected on a
later run; do not create another project to resume. Device approval expires after
15 minutes and provisioning waits up to ten minutes. Remote MCP is outside this
setup; agents use the existing stdio MCP package.

### Non-interactive setup

Inject a project key securely, then explicitly select agents and scope:

```sh
# Inject LAMBDADB_API_KEY securely before running this command.
lambdadb init --non-interactive --agents codex,claude,cursor --scope project \
  --endpoint https://api.lambdadb.ai --project YOUR_PROJECT --json
# Configure only the CLI, without changing agent files:
lambdadb init --non-interactive --agents none --scope project \
  --endpoint https://api.lambdadb.ai --project YOUR_PROJECT --api-key-env MY_PROJECT_KEY
```

`--agents` accepts a comma-separated subset of
`codex,claude,cursor,vscode,gemini,opencode,copilot,kiro,cline` or `none`. For example:

```sh
lambdadb init --non-interactive --agents vscode,gemini,opencode --scope project
lambdadb init --non-interactive --agents copilot,kiro,cline --scope user
```

These two examples reuse existing CLI settings and an OS-stored or
environment-held key. `--scope` accepts `project` or `user`. `--write-tools`
explicitly enables MCP write tools; omission disables them, including on reruns and when the inherited
`LAMBDADB_MCP_ENABLE_WRITE_TOOLS` environment variable is true.

The global `--config`, `--endpoint`, `--project`, `--api-key-env`, and
`--timeout-ms` flags apply to existing-credential setup. `--connect` instead
chooses its target in the terminal after account login. It cannot be combined
with explicit endpoint/project/key-reference flags and requires an interactive
terminal. Non-interactive setup never starts browser authorization or requests
a key. Non-TTY and `--json` runs require `--non-interactive`; missing choices,
target or key fail with exit 2 and instructions, without prompting. This mode authorizes applying
the displayed file plan; it does not silently select detected agents.

Cline's extension supports only user-scope MCP settings. Selecting `cline` with
`--scope project` rejects agent installation; interactive setup offers user scope
when Cline is selected. It never silently broadens the scope. A browser-approved
connection may already be saved before agent choices are validated, as described
under [files and safe reruns](#files-and-safe-reruns). Rerun without `--connect`
to finish setup.

### Files and safe reruns

Before agent installation, init displays exact paths and create/update/unchanged
actions, then uses the same SDK check as `doctor` to verify authentication and
collection-list access. Manual setup leaves files untouched on failed validation.
Browser setup first shows and confirms the CLI settings path and credential store;
once approved, it saves that connection before doctor/agent installation so a
failed check or interrupted agent setup can resume without issuing another key.
Agent files are still untouched until the reviewed plan and check succeed. The CLI's
non-secret settings always use its usual configuration path (or `--config`),
independently of agent scope.

Unrelated configuration and comments are preserved where JSONC is accepted.
Copilot and Cline settings must be strict JSON for init; comments/trailing
commas cause an actionable failure and leave the file untouched. Shared files
(such as Claude/Copilot project MCP and VS Code/Copilot skills) are written only
once when both agents request identical contents; conflicting changes stop
before connection or writes. Symbolic links are preserved: init displays the
resolved write target and updates it once. Links with missing targets fail before
connection or writes; restore their targets before rerunning init.

Reruns update only recognizable init-generated `lambdadb` MCP entries;
existing custom entries or additions inside a generated entry cause an actionable
conflict. Existing skills are preserved, including user edits; remove the skill
file deliberately if you want to reinstall the bundled version. Writes use
atomic replacement per file, not a transaction across files: a disk/permission
failure can leave a partial installation; inspect the displayed paths and rerun.

## Supported coding agents

Init detects agents using PATH and configuration directories, then lets you choose
any subset or `none`. Detection is a hint, not proof that an agent is installed or
connected. Project scope means the current working directory, so run from your
repository root. Cline supports user scope only.

| Agent | `--agents` value | Supported scope |
| --- | --- | --- |
| Codex | `codex` | Project or user |
| Claude Code | `claude` | Project or user |
| Cursor editor/CLI | `cursor` | Project or user |
| VS Code | `vscode` | Project or user |
| Gemini CLI | `gemini` | Project or user |
| OpenCode | `opencode` | Project or user |
| GitHub Copilot CLI | `copilot` | Project or user |
| Kiro IDE/CLI | `kiro` | Project or user |
| Cline VS Code extension | `cline` | User only |

<details>
<summary>MCP and skill paths, agent-specific overrides and reload instructions</summary>

| Agent | Project MCP / skill | User MCP / skill |
| --- | --- | --- |
| Codex | `.codex/config.toml` / `.agents/skills/lambdadb/SKILL.md` | `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) / `~/.agents/skills/lambdadb/SKILL.md` |
| Claude Code | `.mcp.json` / `.claude/skills/lambdadb/SKILL.md` | `~/.claude.json` / `~/.claude/skills/lambdadb/SKILL.md` |
| Cursor | `.cursor/mcp.json` / `.cursor/skills/lambdadb/SKILL.md` | `~/.cursor/mcp.json` / `~/.cursor/skills/lambdadb/SKILL.md` |
| VS Code | `.vscode/mcp.json` / `.github/skills/lambdadb/SKILL.md` | Default profile `mcp.json` (see below) / `~/.copilot/skills/lambdadb/SKILL.md` |
| Gemini CLI | `.gemini/settings.json` / `.gemini/skills/lambdadb/SKILL.md` | `~/.gemini/settings.json` / `~/.gemini/skills/lambdadb/SKILL.md` |
| OpenCode | `opencode.json` or existing `opencode.jsonc` / `.opencode/skills/lambdadb/SKILL.md` | `~/.config/opencode/opencode.json` or existing `.jsonc` / `~/.config/opencode/skills/lambdadb/SKILL.md` |
| GitHub Copilot CLI | `.mcp.json` or existing `.github/mcp.json` / `.github/skills/lambdadb/SKILL.md` | `~/.copilot/mcp-config.json` / `~/.copilot/skills/lambdadb/SKILL.md` |
| Kiro IDE/CLI | `.kiro/settings/mcp.json` / `.kiro/skills/lambdadb/SKILL.md` | `~/.kiro/settings/mcp.json` / `~/.kiro/skills/lambdadb/SKILL.md` |
| Cline VS Code extension | Unsupported; choose user scope | VS Code user profile `globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` / `~/.cline/skills/lambdadb/SKILL.md` |

Cursor detection recognizes both the editor's `cursor` command and the
`cursor-agent` CLI, which reads the same MCP configuration. With Cursor CLI,
check the generated server with `cursor-agent mcp list-tools lambdadb`.

When `CLAUDE_CONFIG_DIR` is set, Claude's user MCP file is
`$CLAUDE_CONFIG_DIR/.claude.json` and its user skill is under
`$CLAUDE_CONFIG_DIR/skills/lambdadb/SKILL.md`.

Gemini's `GEMINI_CLI_HOME` replaces the home directory, with `.gemini` appended;
both user settings and the skill follow it. OpenCode's user config and skill
respect `XDG_CONFIG_HOME` (default `~/.config`). Existing OpenCode JSONC files
are edited in place. If both `opencode.json` and `opencode.jsonc` exist in the
chosen scope, init asks you to consolidate them before proceeding. It preserves
existing V2 `mcp.servers` maps; new files use V1 `mcp` syntax, which V2 also
supports. A mixed V1 LambdaDB entry and V2 server map is rejected for manual
resolution. Custom `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, inline or
higher-priority project settings may override the selected root/user file.

VS Code uses the documented `servers` format for its Local harness, with
project scope at `.vscode/mcp.json`. User scope targets the default stable
profile: `~/Library/Application Support/Code/User/mcp.json` on macOS,
`${XDG_CONFIG_HOME:-$HOME/.config}/Code/User/mcp.json` on Linux, and
`%APPDATA%/Code/User/mcp.json` on Windows (fallback `%USERPROFILE%/AppData/Roaming`).
`VSCODE_PORTABLE` and `VSCODE_APPDATA` overrides are honored. Named profiles,
Insiders, `--user-data-dir`, remote hosts and portable Copilot configuration are
outside this adapter's scope. Reload the window and use **MCP: List Servers**.
In Gemini, restart or use `/mcp refresh` and `/skills reload`; in OpenCode,
restart and use `opencode mcp list`. Preserve normal trust/approval prompts.

Copilot CLI is separate from the VS Code adapter. It reads `mcpServers`, not
VS Code's `servers` map. Project setup reuses `.mcp.json` if present, otherwise
an existing `.github/mcp.json`, otherwise creates `.mcp.json`. Both wrapped
`mcpServers` and existing bare server maps are preserved. `COPILOT_HOME` overrides
the user MCP and skill directory. Restart with the selected key in the launch
environment, trust the repository, check `/mcp`, and run `/skills reload`.

Kiro IDE and CLI share one `kiro` adapter; detection recognizes both `kiro` and
`kiro-cli` executables. Approve the selected key variable in **Mcp Approved Env
Vars** when prompted. For a custom Kiro agent, ensure it includes the MCP JSON
and skill resources; init does not edit agent definitions or grant tool approvals.

The `cline` adapter targets the Cline extension in the default stable VS Code
user profile, using the same platform/portable user directory rules above.
Reload VS Code from an environment containing the selected key and inspect
Cline's MCP Servers and Skills menus. Cline CLI, other editors and named profiles
use different configuration locations and are outside this adapter's scope.

</details>

### MCP launch and credential forwarding

Agent settings launch `npx -y @functional-systems/lambdadb-cli@<installed-version> mcp`,
which runs the existing `@functional-systems/lambdadb-mcp@0.1.5` stdio package.
No npx cache path is saved. The exact CLI version must be published before an
agent can fetch it; a source checkout/unpublished tarball alone does not provide
that registry version. Node/npm and `npx` must be on the agent's PATH; first launch
may download both packages and requires npm registry access.
After upgrading the CLI, rerun init for the same agents and scope to refresh
their exact CLI version pin, then restart/reload the agent with the key available.

The `mcp` bridge reads the selected OS credential reference or environment
variable at startup and maps CLI endpoint/project/key to MCP's `LAMBDADB_BASE_URL`,
`LAMBDADB_PROJECT_NAME`, and `LAMBDADB_PROJECT_API_KEY`. The bridge sets
`LAMBDADB_MCP_ENABLE_WRITE_TOOLS` explicitly. No key value is placed in arguments
or agent configuration. OS references need the same OS user and an accessible
credential store, with no shell key export. Linux Secret Service also needs access
to the desktop/user D-Bus session; Codex forwards its non-secret
`DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` names when supplied. Launch other
agents with that session available, and allow those variables if the agent filters
its environment. For environment-mode connections, Codex uses `env_vars` to forward the selected variable;
Claude, Gemini, Copilot and Kiro use `${VAR}`; Cursor, VS Code and Cline use `${env:VAR}`; and
OpenCode uses `{env:VAR}` environment references. Gemini's explicit `env` entry
also forwards the key through its inherited-environment sanitization. An unresolved
reference fails before starting MCP. Keep the variable in the agent launch
environment: GUI apps may not inherit a terminal export. Restart/reload agents
after setup or credential changes, check `/mcp` in Codex/Claude or Cursor's MCP
settings, and approve/trust project settings if prompted. Higher-priority agent
settings or organization policies may override or block these files.

<details>
<summary>Official agent documentation used for format checks</summary>

Agent formats were checked against official documentation on 2026-10-24:
[Codex MCP](https://developers.openai.com/codex/mcp),
[Codex skills](https://developers.openai.com/codex/skills),
[Claude Code MCP](https://code.claude.com/docs/en/mcp),
[Claude Code skills](https://code.claude.com/docs/en/skills),
[Cursor MCP](https://cursor.com/docs/mcp),
[Cursor CLI MCP](https://cursor.com/docs/cli/mcp),
[Cursor skills](https://cursor.com/docs/skills),
[VS Code MCP](https://code.visualstudio.com/docs/agents/reference/mcp-configuration),
[VS Code skills](https://code.visualstudio.com/docs/agent-customization/agent-skills),
[Gemini MCP](https://geminicli.com/docs/tools/mcp-server/),
[Gemini skills](https://geminicli.com/docs/cli/skills/),
[OpenCode MCP](https://opencode.ai/docs/mcp-servers/),
[OpenCode skills](https://opencode.ai/docs/skills/),
[OpenCode V2 compatibility](https://opencode.ai/v2/docs/migrate-v1/),
[Copilot MCP](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers),
[Copilot skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills),
[Kiro MCP](https://kiro.dev/docs/mcp/configuration/),
[Kiro skills](https://kiro.dev/docs/skills/),
[Cline MCP](https://docs.cline.bot/mcp/mcp-overview),
[Cline skills](https://docs.cline.bot/customization/skills), and
[Cline environment expansion source](https://github.com/cline/cline/blob/main/apps/vscode/src/utils/envExpansion.ts).
Generated settings still require
verification in the actual agent; local contract tests simulate that boundary.

</details>

## Account and project management

These commands use a saved account login, independently of project API-key
configuration. They never prompt for missing arguments. `login` deliberately
waits for browser approval and prints a URL usable on another device; it does not
prompt on stdin. Use the same `--config` path throughout if overriding it.

```sh
lambdadb login --no-browser
lambdadb orgs list --json
lambdadb projects regions --json
lambdadb projects list --org ORG_UUID --json
lambdadb projects create --org ORG_UUID --name my-project --region REGION --json
# For a new account with no Org, choose --default-org instead of --org.
lambdadb projects list --org ORG_UUID --json  # wait until ACTIVE
lambdadb projects use --org ORG_UUID --project-id PROJECT_UUID --issue-key
lambdadb doctor
# Later switches reuse a previously saved key without --issue-key:
lambdadb projects use --org ORG_UUID --project-id PROJECT_UUID
lambdadb logout
```

`create` requires exactly one of `--org UUID` or `--default-org`, plus `--name`
and `--region`. Creation does not select the CLI default or install agents.
`use` requires both IDs; first connection or deliberate key replacement requires
`--issue-key` and owner/admin key-management permission. Saved project keys are
reused without that flag. `projects use` changes only the CLI default: existing
agent entries stay pinned until you rerun `init` and approve their file plan.
Expired, missing or unreadable account credentials fail with login/unlock guidance;
ordinary management commands never start browser login automatically.

### Limits and failures

The API-key environment path remains available without account login. Management
requests have a 30-second timeout, do not follow redirects and never retry writes.
A project-limit error includes `organization.max_projects`, `projects_count`,
`can_upgrade`, and `billing_url` in JSON, plus the link in terminal diagnostics.
A transport failure or uncertain key delivery exits 5; inspect existing projects
or the displayed named key in Console before explicitly retrying.

### Session recovery

Account metadata and the per-project connection cache live beside the resolved
CLI config file as `.account.json` and `.connections.json` suffixes. They contain
no secrets. The `.management.lock` suffix serializes local login/selection work;
if a process was killed, confirm it is no longer running before removing its
stale lock. `logout` needs the saved OS entry and server connectivity to confirm
revocation; otherwise it retains metadata and fails with an actionable error.
Undelivered/unavailable account sessions expire within seven days. Project keys
have their existing lifetime; logout does not revoke them. Explicit replacement
retains older project entries for agents still pinned to them; revoke unused keys
in Console and remove their local reference deliberately.

## Configuration and authentication

### Environment-variable setup

For an existing project or CI, obtain its endpoint, project name and API key from
[LambdaDB Console](https://app.lambdadb.ai). No account login is required for this
path. The endpoint is the API origin, such as `https://api.lambdadb.ai`, without
`/projects/...`. HTTPS is required, except HTTP on localhost/127.0.0.1/::1 for
local testing.

```sh
lambdadb configure --endpoint https://api.lambdadb.ai --project YOUR_DEV_PROJECT
```

Set `LAMBDADB_API_KEY` through your shell's secure input or your CI secret manager.
For example, in Bash, this avoids putting the value into shell history:

```bash
read -r -s -p 'LambdaDB project API key: ' LAMBDADB_API_KEY
printf '\n'
export LAMBDADB_API_KEY
```

`init` never accepts a key value in a prompt or flag and never loads or writes
`.env` files. Keep keys out of chat, shell history and source files.

For development deployments, select the account API origin with
`--api-url https://api-dev.lambdadb.ai`. Later login renewal reuses that saved
origin unless explicitly overridden; the server supplies its configured Console
URL. HTTPS is required except for loopback tests.

### OS credential storage

Account login and project credentials use separate OS credential-store namespaces.
The opaque account session expires after seven days and is valid only for CLI
management routes. It is never sent to MCP or agents, and is not a Console JWT or
refresh token. Run `login` again to renew it; `logout` revokes it immediately and
preserves project keys. Project settings and agent files contain only references.
Use `--credential-store auto` (default),
`keychain`, `windows`, `secret-service`, or `keyutils` to select an available OS
backend. Linux auto selection tries Secret Service, then kernel keyutils for a
new connection. Kernel storage is a cache: reboot/expiry may remove it. Existing
references always use their recorded backend; failure never silently switches
stores or issues another key. There is no plaintext-file fallback.

To remove the current connection's local OS key, run `lambdadb credentials remove`.
It leaves metadata and agent references intact and does **not** revoke the server
key. Revoke unused keys in Console under Project API Keys, using the saved key
name/ID. Explicit reconnection creates a fresh credential slot; it does not revoke
or delete older slots that other agents might still use. If key delivery or local
storage fails after approval, inspect the named `lambdadb-cli-...` key in Console
and revoke it if unused before reconnecting. Requests are never blindly retried
across an uncertain key-issuance response.

The no-plaintext-secret-persistence contract covers CLI and agent configuration
files. Browser setup deliberately persists the project key only in the selected
OS store. Environment mode does not persist a key. Agents
manage their own runtime storage; for example, Codex shell snapshots can capture
the launch environment. Review your agent's environment/snapshot settings and
protect its runtime directory when forwarding a project key.

### Settings and precedence

No command accepts a raw key argument. Environment-mode configuration stores `endpoint`,
`project` and `apiKeyEnv`. Browser setup adds `credentialStore`, `credentialId`,
`credentialKeyId` and `credentialKeyName`, all non-secret metadata. Keys are read
from the selected environment variable or OS store at runtime. Environment variables are still
accessible to the current process and appropriately privileged local processes;
the CLI is not a secret vault. Avoid shell tracing around secret injection.

The default configuration is
`${XDG_CONFIG_HOME:-$HOME/.config}/lambdadb/config.json`. Writes use an atomic
rename and file mode `0600`; newly created directories use `0700` (POSIX).
Configuration is user-local, not discovered from the working repository.
`.env` files are not automatically loaded, and are ignored by this repository.
Use a CI secret manager instead of adding credentials to tracked files.

| Setting | Precedence, highest first |
| --- | --- |
| Endpoint | `--endpoint`, `LAMBDADB_ENDPOINT`, saved `endpoint` |
| Project | `--project`, `LAMBDADB_PROJECT`, saved `project` |
| Key variable name | `--api-key-env`, `LAMBDADB_API_KEY_ENV`, saved `apiKeyEnv`, `LAMBDADB_API_KEY` |
| Key value | Explicit `--api-key-env` / `LAMBDADB_API_KEY_ENV` selects environment mode; otherwise use a saved OS reference when present, else the selected variable. An explicit OS reference from generated agent arguments stays bound to its store. No automatic fallback on read failure. |
| Config path | `--config`, `LAMBDADB_CONFIG`, default user path |
| Network budget | `--timeout-ms`, `LAMBDADB_TIMEOUT_MS`, `30000` milliseconds |

There is no implicit endpoint, project, collection, branch or read ref. Explicit
empty values fail validation instead of silently falling back. An explicitly
selected missing config file fails for existing commands except `configure`,
which can create it. `init` can also create it; the `mcp` bridge allows a missing
file when endpoint/project settings are supplied through flags or environment.

`configure` applies the same precedence and saves the selected non-secret values;
it does not contact the service. To reference a different secret variable:

```sh
lambdadb configure --api-key-env MY_PROJECT_KEY
lambdadb doctor --json
```

### Check the connection with doctor

`doctor` validates configuration and uses `listCollections({size: 1})` to check
authentication and project collection-list access. Success does not prove write
permissions, collection readiness, or search visibility. Failure provides a safe
error category and a recovery hint. SDK debug logging is disabled even when
`LAMBDADB_DEBUG` is set. Error bodies, raw SDK errors and presigned response URLs
are not printed. The active key is redacted if echoed inside returned data.
Other document data remains visible; redirect results to appropriate storage.

## Query existing data

Init does not query documents or create collections/data. Connection success does
not establish search readiness. The setup result includes a read-only agent
prompt. To inspect data directly, list collections and choose an existing
collection:

```sh
lambdadb collections list --json
lambdadb collections describe --collection YOUR_COLLECTION --json
```

Save `{"size":5}` in `first-query.json`, then read up to five documents:

```sh
lambdadb query --collection YOUR_COLLECTION --ref branch:main --file first-query.json --json
```

Omitting `query` reads sample documents. Inspect the index configuration before
searching an actual indexed field.

An empty project needs deliberately supplied data outside init. Empty results
are not evidence of indexing failure or readiness.

## Command examples

The JSON files below are included in the package under `examples/`.

### Try sample data in a development project

Only run the following against a project explicitly designated for development.
Connect to the project first, then replace `cli-demo-docs` with a new, unique
collection name. These commands create a collection and write sample documents;
`init` does neither.

```sh
lambdadb doctor
lambdadb collections list --size 20
lambdadb collections create --collection cli-demo-docs --index-config examples/index-config.json
lambdadb collections describe --collection cli-demo-docs
lambdadb docs import --collection cli-demo-docs --branch main --file examples/documents.jsonl
lambdadb query --collection cli-demo-docs --ref branch:main --file examples/query.json
lambdadb docs fetch --collection cli-demo-docs --ref branch:main --ids doc-1 doc-2 doc-3
```

Collection creation returns `state: "created"`. Import returns accepted counts,
not committed or searchable counts. Both explicitly report
`searchable: "not_verified"`. The sample query uses `consistentRead: false`.
The first query/fetch can therefore be empty or encounter a transient loading
error. Repeat reads after an appropriate delay and inspect expected IDs and
contents; do not recreate the collection or blindly replay the import as a wait
mechanism. There is no CLI readiness endpoint or readiness polling claim.

For eligible ordinary writes, `docs fetch --consistent-read` or a query file
with `"consistentRead": true` can overlay pending writes when reading a direct
branch. This does not establish committed indexing, excludes pending bulk
imports, can return `429`, and is rejected for tag/alias refs.

### Collections

```sh
lambdadb collections list --all --size 100 --json
lambdadb collections list --page-token 'TOKEN_FROM_PREVIOUS_RESULT' --json
lambdadb collections describe --collection cli-demo-docs --json
```

One page is the default; `nextPageToken` is an opaque continuation token.
`--all` uses the SDK page iterator and buffers its result within the total network
budget. No partial list is printed on failure. Collection statistics describe
the committed head of `main`, not the selected read ref or whole-index readiness.
Both create and update take the index map itself through `--index-config`, not a
full request body. Updates are subject to server index-change restrictions and
return `state: "updated"`, `searchable: "not_verified"`; acceptance does not prove
query readiness.

<details>
<summary>Text analyzer presets</summary>

The CLI accepts 49 fixed lowercase text analyzer presets:
`standard`, `english`, `korean`, `japanese`, `chinese`, `cjk`, `arabic`,
`french`, `german`, `hindi`, `indonesian`, `italian`, `portuguese`, `russian`,
`spanish`, `turkish`, `armenian`, `basque`, `bengali`, `brazilian`, `bulgarian`,
`catalan`, `czech`, `danish`, `dutch`, `estonian`, `finnish`, `galician`, `greek`,
`hungarian`, `irish`, `latvian`, `lithuanian`, `norwegian`, `persian`, `romanian`,
`serbian`, `sorani`, `swedish`, `thai`, `simple`, `whitespace`, `stop`, `keyword`,
`pattern`, `fingerprint`, `nepali`, `tamil` and `telugu`.
For example, `{"text":{"type":"text","analyzers":["chinese"]}}` is a valid
index-config file. Omission preserves the `standard` server default; lists are
sent unchanged. The server rejects duplicate names. Custom pipelines/options
are unsupported, and language detection is not automatic. The `keyword` text
analyzer does not confer keyword field sorting/facets. Nepali/Tamil/Telugu are
Lucene extensions, not common Elasticsearch/OpenSearch support. See the
[SDK analyzer contract](https://github.com/lambdadb/lambdadb-typescript-client/blob/v0.7.0/docs/models/analyzer.md).

</details>

### Native embeddings and Bayesian search

```sh
lambdadb collections create --collection native-docs --index-config examples/index-config-native.json --json
lambdadb docs import --collection native-docs --branch main --file examples/documents.jsonl --json
lambdadb query --collection native-docs --ref branch:main --file examples/query-bayesian.json --json
lambdadb query --collection native-docs --ref branch:main --file examples/query-bayesian-rerank.json --json
lambdadb collections update --collection native-docs --index-config examples/index-config-native.json --json
```

A vector configuration with `embedding` enables native embedding without a
`managedEmbedding` flag. Supply `provider`, `model` and `sourceField` explicitly;
no provider or model is chosen for you. Declare the source field as text and omit
the generated vector in imported documents. Use ordinary upsert, since bulk
import does not support embedding fields. Query with `knn.queryText`.
Optional native `dimensions` and `similarity` belong inside `embedding`.
`managedEmbedding: false` with embedding, or native top-level dimensions/similarity,
is rejected before a request. For older servers, explicitly add
`managedEmbedding: true` to the vector configuration. Normalized server metadata
may still contain this flag. Caller-supplied vectors retain top-level dimensions
and use `knn.queryVector`.

Bayesian hybrid search uses `query.bayesian` with exactly two subqueries. Neither
subquery nor any Boolean descendant may have an explicit `boost`, even `1`.
Nested rank-fusion queries are unsupported. No fusion weights are needed.
Without reranking, set top-level `candidateSize` so that
`1 <= size <= candidateSize <= 100`; omitted/null `size` uses the existing default
of 10. The candidate budget is per signal, independently of final result size.
With reranking, omit top-level `candidateSize` and use `rerank.candidateSize`,
whose default remains `max(50, size)`. The CLI does not insert budgets, weights,
or `knn.k`. Ordinary text/KNN/RRF/Min-Max/L2 requests retain their behavior and
must omit top-level `candidateSize`.

The free-form query DSL passes through unchanged; the server validates Bayesian
semantics and invalid requests remain API errors (exit 3). Local JSON/type errors
remain input errors (exit 2). Applied reranking retains the Bayesian score in
`retrievalScore` and the final score in `score`, with full documents and rerank
metadata in both JSON and human output.

These additions require a supporting deployment; their API contract is pinned to
backend `9072a1bc8925954369a887f558f1eaf387b7ea0e`. See the SDK 0.8.0
[Bayesian contract](https://github.com/lambdadb/lambdadb-typescript-client/blob/v0.8.0/docs/bayesian-search.md)
and [native embedding contract](https://github.com/lambdadb/lambdadb-typescript-client/blob/v0.8.0/docs/native-embeddings.md).
Newer servers [raise the candidate limit to 1,000](https://github.com/lambdadb/lambdadb/commit/963d79e8866833f1deb1393ed00a9825d866c853).
The top-level Bayesian `candidateSize` is forwarded unchanged and its upper bound
depends on the deployment. This CLI and its bundled SDK still limit final `size`
and `rerank.candidateSize` to 100; a higher server limit does not raise those local limits.

### Native reranking

```sh
lambdadb query --collection cli-demo-docs --ref branch:main \
  --file examples/query-rerank.json --json
```

Add optional `rerank` to a query file; omission/null keeps existing searches.
This is a per-query setting. The LambdaDB server supplies provider credentials;
you do not supply a Jev key.
Use `provider: "typesafe"`, `model: "jev-1.13.0"`, nonblank `queryText` (also for
raw vectors, up to 8 KiB UTF-8), and 1–8 unique stored scalar text `fields`.
Returned-field projection remains independent of these model inputs.
`candidateSize` defaults on the server to `max(50, size)` and must satisfy
`size <= candidateSize <= 100`. Final `size` is 1–100 (default 10); dense
`knn.k` stays unchanged and must be raised explicitly for more vector candidates.
Optional `criteria` replaces defaults with 2–10 distinct nonblank descriptions
ordered from low to high relevance (2 KiB each, 8 KiB total UTF-8).
Null optional settings use server defaults; the CLI does not insert them.

Reranking requires a scoring query and rejects `sort`, query-less requests and
filter-only queries. Existing lexical facet restrictions still apply; vector
and hybrid facets are not enabled. Facet-only `size: 0` works without reranking.
Selected candidate fields and model availability remain server validations.

Read `data.rerank.status` and its metadata. Applied document envelope `score` is
the final evaluation score, not a probability; `retrievalScore` retains the search
score. Output preserves zero, precision and server order, including `docsUrl`
downloads. Empty results report `skipped`/`noCandidates` with no `maxScore`.
Unused reranking omits metadata and `retrievalScore`. With `onFailure: "returnOriginal"`, eligible provider failures return retained search order/scores,
without `retrievalScore`, and report `fallback`; partial evaluations are discarded.
The default policy is `error`. Validation, authorization, retrieval, quota and
admission failures remain errors. See the
[full reranking contract](https://github.com/lambdadb/lambdadb-typescript-client/blob/v0.7.0/docs/managed-reranking.md).

These features need a supporting server deployment. SDK publication and shared
development checks do not establish production deployment, search quality,
load/failure coverage or billing readiness.

### Import JSONL

```sh
lambdadb docs import --collection cli-demo-docs --branch main \
  --file examples/documents.jsonl --batch-size 1000 --json

lambdadb docs import --collection cli-demo-docs --branch main \
  --file examples/documents.jsonl --mode bulk --timeout-ms 120000 --json
```

Input must be a UTF-8 regular file of at most 64 MiB and 100,000 documents.
Each nonblank line must be a JSON object; blank lines do not count toward the
document limit. Split files that exceed either limit before importing.
If supplied, `id` must be a nonempty string. Omitted IDs are
generated by the service and are not returned in the acceptance response; replay
can create duplicates. Existing IDs are upserted and can replace existing data.

The entire file is parsed and all batch sizes are checked before any network
call. This keeps a malformed later line from causing a partial write, at the
cost of buffering the input. Lines are scanned without allocating a separate
array of every line, and document retention stops at the count limit. This bounds
the overhead of many small documents, not the total process memory: large or
complex documents can still use much more memory than the raw file size. Batches run
sequentially and stop on the first failure. Counts count input records, not unique
IDs. Repeated IDs are sent in input order; server resolution within a batch is
not a CLI guarantee.

Ordinary upsert defaults to 1,000 documents and a 4,000,000-byte serialized
request cap including branch/envelope overhead. Bulk defaults to 1,000 documents
and 16,000,000 bytes; `--batch-bytes` allows up to 64,000,000. These are conservative
CLI limits, not advertised server maxima. The SDK also enforces the bulk limit
returned by the server. `--mode bulk` calls the existing SDK `bulkUpsertDocs`
helper with the selected branch, including signed upload headers and finalization.
Bulk is unsupported for native embedding vector fields; use ordinary upsert.

Import result fields are stable under `schemaVersion: 1`:

- `total`, `accepted`, `failed`, `unknown`, `notAttempted`: input record counts;
  their outcome counts sum to `total`.
- `batches`: attempted batch number, first/last physical JSONL lines, document
  count, state and a sanitized error where applicable.
- `state`: `accepted`, `failed`, `partial` or `unknown`.
- `searchable`: always `not_verified` in this MVP.

A definite HTTP rejection is `failed`. A disconnect, timeout, server error or
invalid success response after dispatch is conservatively `unknown`. An unknown
batch takes precedence over partial success in the exit code. The bulk SDK does
not expose structured failure stages for local/upload exceptions, so those also
use `unknown`; it can overstate uncertainty when upload failed before finalization.
The CLI does not parse SDK error strings to guess the stage. A deadline reached
between batches leaves unsent records `notAttempted`.

There are no durable checkpoints, automatic resume, exactly-once guarantees,
write retries or server mutation receipts. Inspect the selected branch and batch
line ranges before constructing a deliberate retry. Do not treat accepted counts
as a readiness check. A hard process kill may prevent any final report.

### Query and fetch at explicit refs

```sh
lambdadb query --collection cli-demo-docs --ref tag:release-one --file examples/query.json --json
lambdadb docs fetch --collection cli-demo-docs --ref alias:production --ids doc-1 --json
lambdadb docs fetch --collection cli-demo-docs --ref branch:main --ids doc-1 --consistent-read --json
```

These examples require the named ref to exist. Query files use the SDK/API
request body, with optional `query`, `facets`, `size`, `sort`, `fields`,
`partitionFilter`, `consistentRead`, `includeVectors`, `rerank` and Bayesian
`candidateSize`. The query DSL is forwarded
to the API, not reimplemented in the CLI. Unknown top-level fields are rejected.
Omit `query` for match-all. `size` accepts 1–100, `null`, or omission; null is
normalized to SDK omission. `size: 0` is accepted only with at least one facet.
An optional file `ref` must match the mandatory `--ref`; conflicting selectors
are rejected. Fetch accepts up to 100 IDs and reports `missingIds` without
turning a successful missing-document response into an error.

The SDK downloads large query/fetch responses from `docsUrl` automatically using
its separate unauthenticated transfer client. Results are buffered, not streamed
or truncated. The CLI omits the consumed signed URL. No ref is resolved to or
claimed to pin a snapshot by the CLI. Branches and aliases can move between calls.

### Keyword facets

After creating a new collection with `examples/index-config.json` and importing
`examples/documents.jsonl`, run:

```sh
# Match all documents and return only category counts (query is omitted).
lambdadb query --collection cli-demo-docs --ref branch:main --file examples/query-facets-only.json --json
# Return matching documents and category counts together.
lambdadb query --collection cli-demo-docs --ref branch:main --file examples/query-with-facets.json --json
```

Facet-only input: `{"size":0,"facets":{"category":{"size":10}}}`.
Up to five keyword fields can be requested, including keyword arrays and dotted
field paths. Each facet accepts only optional `size` (1–100); omission or `null`
uses the server default of 10. Counts are returned in
`data.facets.category.buckets`, for example
`[{"value":"database","count":2},{"value":"developer-tools","count":1}]`
for the facet-only sample after all three documents are indexed. `data.docs` is
empty for facet-only queries. Facets are retained when the SDK downloads documents
from `docsUrl` as well. Counts use JavaScript numbers and may lose precision above
`Number.MAX_SAFE_INTEGER`.

Facets require a supporting server and newly built keyword indexes. Existing
indexes, partial updates, segment merges and old Tags do not gain support from
this SDK update. If migration is needed, deliberately create a new Collection and
reinsert the source data; the CLI performs no automatic migration. Accepted imports
and `consistentRead` are not proof of committed facet/index readiness.

This source pins SDK 0.8.1. Existing CLI installations keep their packaged SDK
until a new CLI version is published and installed.

## Output, deadlines and exit codes

`--json` emits exactly one JSON object plus a newline on stdout for an executed
command, including failures. It contains `schemaVersion`, `command`, `ok`, optional
`target`, `data` and `error`. Target includes endpoint/project and, where relevant,
collection and explicit ref/branch. Errors use stable categories and safe hints.
API-specific response data may grow as the upstream API evolves. Help/version
remain plain text even with `--json`. Default output adds a readable summary and
pretty-printed data. Progress and diagnostics go only to stderr. No ANSI styling
is used. Only `init` prompts on a terminal; `init --non-interactive` and all
existing commands never prompt. `mcp` reserves stdout for MCP JSON-RPC and sends
startup failures to stderr rather than emitting the CLI JSON envelope.

Credential redaction preserves fixed protocol field names and command, status,
ref-kind and error-code tokens, even when a short credential coincides with one
of them. It redacts variable string values and arbitrary document, index-config
and tag-map keys. Returned data can therefore differ from the stored data when
it contains the selected credential; public protocol tokens remain unchanged.
If redacted map keys collide, unchanged keys keep their names and renamed keys
receive unique `#N` suffixes, skipping existing names. Every entry is retained,
with values still subject to credential redaction. Suffixes are local to each map.

| Exit | Meaning |
| --- | --- |
| `0` | Success, including empty search/fetch results and write acceptance |
| `2` | Invalid CLI input, file, request shape or configuration/missing credentials |
| `3` | Authentication/API/request failure, or import with no accepted/unknown batches |
| `4` | Incomplete import with some accepted records, no unknown outcomes |
| `5` | At least one write outcome is unknown; inspect before retrying |

The shared network deadline defaults to 30 seconds, covers retries, all pages,
batches and signed transfers, and accepts 1–3,600,000 milliseconds. It starts
after import/query input preflight. SIGINT/SIGTERM abort active network work;
imports preserve acknowledged progress where the process can still report it.
File parsing and formatting are outside the network budget. Read calls use the
SDK backoff with a two-second retry budget; its sleep can add up to approximately
500 ms after cancellation. Writes and bulk steps disable automatic retries.

## Development and boundaries

Development changes target the Git `develop` branch; reviewed release promotions
for rc/stable target `main`. Once npm setup is complete and automatic publication
is enabled, successful develop push CI publishes uniquely versioned packages on
the `dev` channel. CI generates the number; developers do not increment it for
every merge. Newer work may supersede pending builds. Stable releases remain
explicit and use `latest`. See [CONTRIBUTING.md](CONTRIBUTING.md) for branch roles, PR checks
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

This CLI uses `@functional-systems/lambdadb@0.8.1` for authentication, HTTP,
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

The CLI supports account login and Org/project setup, plus project-scoped data
commands. Billing, membership management and account deletion stay in Console.
Branch/Tag/Alias management, remote MCP, Git collection, chunking, code-search
workflows, data deletion and plugins are outside this CLI's current scope. Reads
can select existing refs. This change does not modify the SDK or MCP package.

Live verification requires an explicitly designated development project, endpoint
and project key. Do not discover or borrow credentials from another repository.
Use `npm run test:live` with the explicit opt-in settings in
[CONTRIBUTING.md](CONTRIBUTING.md#live-validation). It exercises ordinary/bulk
import, query/fetch, native embeddings and Bayesian reranking in temporary
Collections, then uses the SDK to delete them and verify their absence. The normal
test suite and CI never run it.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
