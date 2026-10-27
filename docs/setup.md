# Setup and configuration

[CLI overview](../README.md) · [Setup](setup.md) · [Agents](agents.md) · [Account and usage](account.md) · [Data commands](data.md)

## First-use setup with `init`

Browser setup requires matching Backend and Console support and an accessible
OS credential store. If either is unavailable, use
[environment-variable setup](#environment-variable-setup). For CI or a
non-interactive shell, use [non-interactive init](#non-interactive-setup).

### Connect or reuse a project

Run `lambdadb init` to start. On a first run, choose account login and terminal
project setup (recommended), or an existing project API key supplied through an
environment variable. A valid account login is reused.

Reruns show the current project and offer to continue with that connection or
select/create another project through account login. Saved project keys are
reused; selecting another project does not silently replace a key.
For SSH or a host without a visible browser, run:

```sh
lambdadb init --no-browser
```

`--no-browser` only skips opening a browser on the CLI host; it does not skip
authentication. When login is needed, open the printed URL in a browser on this
or another device and approve CLI Login after Google/email signup or login.
Compare the displayed code before approval. Project selection and creation
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
```

To configure only the CLI, use `--agents none`. This example expects the key in
`MY_PROJECT_KEY` instead of `LAMBDADB_API_KEY`; inject that variable securely
before running it:

```sh
lambdadb init --non-interactive --agents none --scope project \
  --endpoint https://api.lambdadb.ai --project YOUR_PROJECT --api-key-env MY_PROJECT_KEY
```

`--agents` accepts comma-separated values from the
[supported agents](agents.md) table, or `none`. Once connection
settings are saved, you can reuse them:

```sh
lambdadb init --non-interactive --agents vscode,gemini,opencode --scope project
lambdadb init --non-interactive --agents copilot,kiro,cline --scope user
```

These two examples reuse existing CLI settings and an OS-stored or
environment-held key. `--scope project` installs agent files in the current working directory;
`--scope user` installs them in the agent's user configuration. Neither changes
the selected LambdaDB project or CLI configuration path. `--write-tools`
explicitly enables MCP write tools; omission disables them, including on reruns and when the inherited
`LAMBDADB_MCP_ENABLE_WRITE_TOOLS` environment variable is true.

The global `--config`, `--endpoint`, `--project`, `--api-key-env`, and
`--timeout-ms` flags apply to existing-credential setup. Explicit endpoint,
project, API-key environment name or credential-reference flags bypass the
interactive connection-method picker and use that configuration. Without those
flags, interactive init offers account-based project selection. Account setup
requires an interactive terminal. Non-interactive setup never starts browser
authorization or requests a key. Non-TTY and `--json` runs require
`--non-interactive`; missing choices, target or key fail with exit 2 and
instructions, without prompting. This mode authorizes applying the displayed
file plan; it does not silently select detected agents.

Cline's extension supports only user-scope MCP settings. Selecting `cline` with
`--scope project` rejects agent installation; interactive setup offers user scope
when Cline is selected. It never silently broadens the scope. A browser-approved
connection may already be saved before agent choices are validated, as described
under [files and safe reruns](#files-and-safe-reruns). Rerun `init` and choose to
continue with the saved connection to finish setup.

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
conflict. Existing skills and reference files are preserved, including user edits.
New skills include `references/usage.md`; an unchanged current bundled skill can
also have its missing reference restored on rerun. Custom or older skill bodies
are left intact. To reinstall the bundled version, back up the skill directory
and remove only the files you want init to reinstall. Writes use
atomic replacement per file, not a transaction across files: a disk/permission
failure can leave a partial installation; inspect the displayed paths and rerun.

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
| Network timeout ([management](account.md#limits-and-failures) / [data commands](data.md#output-deadlines-and-exit-codes)) | `--timeout-ms`, `LAMBDADB_TIMEOUT_MS`, `30000` milliseconds |

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
