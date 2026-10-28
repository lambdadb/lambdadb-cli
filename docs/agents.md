# Coding agent setup

[CLI overview](../README.md) · [Setup](setup.md) · [Agents](agents.md) · [Account and usage](account.md) · [Data commands](data.md)

Init detects agents using PATH and configuration directories, then lets you choose
agents with a checkbox list (Space to toggle, Enter to continue). Nothing is
preselected. Enter confirms checked agents, not the focused item. An empty
selection offers **Return to agent selection** (default) or **Skip agent setup**.
Detection is a hint, not proof that an agent is installed or connected. `--scope project` installs files in the current working directory; run from your
repository root. `--scope user` installs files in the agent's user configuration.
These locations do not select a LambdaDB project or change the CLI configuration
path. Cline supports user installation only.

| Agent | `--agents` value | Agent settings location (`--scope`) |
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

| Agent | Repository MCP / skill (`project`) | User MCP / skill (`user`) |
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
the user MCP and skill directory. Restart, trust the repository, check `/mcp`,
and run `/skills reload`. In environment mode, include the selected key variable
in the launch environment. In OS-store mode, run as the same OS user with the
recorded store unlocked and accessible; no key environment variable is required.

Kiro IDE and CLI share one `kiro` adapter; detection recognizes both `kiro` and
`kiro-cli` executables. In environment mode, supply the selected key variable
and approve it in **Mcp Approved Env Vars** when prompted. In OS-store mode,
run as the same OS user with access to the unlocked recorded store; no key
variable approval is needed. For a custom Kiro agent, ensure it includes the
MCP JSON and skill resources; init does not edit agent definitions or grant tool approvals.

The `cline` adapter targets the Cline extension in the default stable VS Code
user profile, using the same platform/portable user directory rules above.
Reload VS Code and inspect Cline's MCP Servers and Skills menus. In environment
mode, launch VS Code with the selected key variable. In OS-store mode, use the
same OS user with access to the unlocked recorded store; no key environment
variable is required. Cline CLI, other editors and named profiles
use different configuration locations and are outside this adapter's scope.

</details>

The installed skill prefers an available, authenticated CLI and keeps the same
target when using MCP instead. Its usage reference covers recent-write visibility,
query examples, pagination, result interpretation and error recovery. CLI defaults
can differ from an existing MCP entry; check the target before switching. A recent
empty read is not by itself an error: eligible ordinary writes can be read with
`consistentRead:true` on a direct branch, separately from committed index checks.

## MCP launch and credential forwarding

Agent settings launch `npx -y @functional-systems/lambdadb-cli@<installed-version> mcp`,
which runs the exact `@functional-systems/lambdadb-mcp@0.1.6-dev.21` stdio package.
This development checkout deliberately pins a published MCP prerelease with the
updated agent guidance and SDK 0.10.0. Stable CLI promotion requires a reviewed
stable MCP pin; this change does not move either package's npm `latest` tag.
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
