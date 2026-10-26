# Unified onboarding plan

Discussion recorded on 2026-10-26. This is a cross-repository implementation plan,
not a description of released behavior. Agreed product direction is separated
from the implementation contract below. The work is not deployed or published.

The next scope connects signup, Organization selection or creation, project setup,
and CLI authorization. Console and CLI users share the same account and project
onboarding; their completion steps differ. The existing CLI package, executable,
agent adapters, skill, and stdio MCP integration remain the foundation.

## Expanded scope: terminal project management

This scope extends the original project-only browser handoff with a separate
CLI account session. Browser signup/login and deliberate CLI
approval return an account session; Org/project selection and creation happen in
the terminal. `login`, `logout`, `orgs list`, `projects list`, `projects create`,
`projects regions`, and `projects use` are maintained commands reused by `init`.

Account sessions are stored separately in the OS credential store, never in
project configuration or MCP arguments/environment. The initial session lifetime
is seven days, matching the existing Console session horizon; explicit login
renews authorization. Server-side hashed sessions are checked on each management
request and logout revokes them immediately. These credentials authenticate only
new CLI management routes; existing member-JWT routes and project APIs retain
their authentication boundaries. Project keys remain independently usable after
account logout. Account deletion/inactivation disables CLI management access.

The server's actual Org project count/limit governs creation. At the limit,
interactive init offers an existing project first, an Org-specific Console
billing link, or cancel. Only an Org owner can activate billing. Paid/custom
limits are not hard-coded. After billing, re-read server state before retrying;
non-interactive commands return a structured limit error and actionable link.
Billing remains entirely in Console. The billing entry page validates membership
and explicitly confirms the target Org before switching browser context.

Project selection reuses saved per-project credentials. New key issuance requires
an explicit choice, uses a unique request identity, and never retries an uncertain
write. `projects use` changes the CLI default only: existing agent entries stay
pinned until the user reruns agent setup. Ordinary management commands do not
prompt; only explicit login waits for browser authorization and init asks setup
questions. No deletion, billing mutation, or member management is added to CLI.

## Agreed product direction

- Apply the simplified onboarding to both direct Console signup and entry through
  `lambdadb init`, including `npx @functional-systems/lambdadb-cli@latest init`.
  Keep the existing npm package and executable.
- Use **Organization** or **Org** consistently. Do not introduce Workspace as a
  second name for the same product concept.
- For a user without an existing Org or a pending invitation, create a default
  Org when they submit their first project creation. Signing in alone does not
  create an Org. Existing users select an accessible Org; preserve invitation
  handling before offering a default Org.
- Generate the default Org display name from the signup display name, for
  example `Steven's Organization`, with `My Organization` as the fallback.
  Do not use the full email address as the default name. Allow renaming later;
  the display name must not become the authorization identity.
- Show the destination Org in the project creation screen. Remove the separate
  required Org naming step, while retaining project name and region selection.
- Make the role, team size, and industry survey optional and move it after
  successful setup. An unanswered survey must not block either entry path or
  cause a redirect loop. Preserve existing signup verification and required
  consent; survey completion is a separate concern.
- Defer new server-enforced read-only key permissions and key-expiration features.
  Preserve the existing MCP tool defaults and explicit write-tool opt-in. Tool
  visibility is not a server-side restriction on the project API key.
- Defer remote MCP. Use the existing stdio MCP package for this scope.

## Shared user flow

| Step | Shared behavior | Direct Console entry | CLI entry |
| --- | --- | --- | --- |
| Entry | Retain a validated continuation through signup and login. | Start from the website or Console. | Start from the existing init command. |
| Identity | Reuse Google or email verification and existing required consent. | Continue in Console. | Authorize using a browser, including a browser on another device. |
| Org | Handle invitations and accessible Orgs before creating a default Org. | Show the same Org choices and defaults. | Show the same Org choices and defaults. |
| Project | Select an accessible project or explicitly create one with a name and region. Enforce existing roles, billing, and quotas. | Finish on the selected project's Console page. | Select/create in the terminal after account login, then explicitly issue or reuse a project key. |
| Connection | Use the selected project's endpoint and identity. | Keep normal Console navigation. | Store separate account/project credentials in the OS store, then configure agents with only project references. |
| Completion | Offer the optional survey without blocking use. | Show project setup guidance. | Verify authentication and collection-list access, show reload instructions, and provide an actionable next step. |

Only create a project after the user submits its creation. Do not create a
collection or insert sample documents during onboarding. A successful connection
or doctor check does not establish search readiness. For an existing collection,
guide the user to inspect its fields before forming a search. For an empty
project, explain the next deliberate data setup step.

Project provisioning may remain pending. Use a bounded wait with a resumable
status and an actionable next step; do not report a project as ready for key
issuance or searches merely because its creation request succeeded.

### CLI authorization flow

Prefer a device authorization flow based on
[RFC 8628](https://www.rfc-editor.org/rfc/rfc8628). Print an HTTPS verification
URL and a user code so SSH and remote development users can approve in a browser
on another device. Opening a browser on the CLI host may be a convenience, but
must not be required. The selected contract is documented below.

The browser shows the code, current account, seven-day lifetime and requested
management access before approval. The terminal subsequently shows the selected
Org, project and key-issuance choice. Legacy project-only grants still display
their specific project and key permissions in the browser. Bind the resulting
grant to the initiating session, enforce expiry and single consumption, and support denial,
cancellation, and bounded polling. Never place project keys or account tokens in
browser URLs. Validate continuation destinations and retain them across Google
callbacks, email verification, invitations, and project creation.

CLI authorization is independent of remote MCP OAuth. Implementing this flow
does not require hosting a new MCP service.

## Agreed credential storage policy

The existing environment mode stores endpoint, project, and the API-key environment
variable name. It reads the secret at runtime; it does not save key values.
See [configuration](src/config.ts), [init](src/init.ts), and the
[stdio bridge](src/mcp.ts).

The following extension was agreed on 2026-10-26 for the browser flow:

- Use an available OS credential store by default for the project API key. Keep
  a non-secret connection reference in CLI and agent configuration.
- Resolve that reference inside the CLI stdio bridge and supply the key only to
  the MCP child process. Continue mapping the CLI's credential source to
  `LAMBDADB_PROJECT_API_KEY`, with the selected endpoint and project mapped to
  `LAMBDADB_BASE_URL` and `LAMBDADB_PROJECT_NAME`.
- Keep account login credentials separate from project API keys. Do not forward
  member access tokens, refresh tokens, or backend administration keys to agents
  or the MCP child. Account login uses a separate opaque seven-day session in the
  OS store; no Console JWT or refresh token is persisted by CLI.
- Preserve the environment-variable path for existing users, CI, and headless
  environments. Define precedence before adding a second credential source.
- For a new Linux connection, prefer Secret Service, then use the kernel keyutils
  store when Secret Service is unavailable. Show the selected store and explain
  that kernel-cached credentials may require reconnection after reboot or expiry.
  If neither OS store is available, provide an actionable environment-based path.
  Do not silently fall back to plaintext storage. A separate file-based secret
  storage mode is outside the first version.
- Keep secrets out of command arguments, logs, JSON output, project files,
  skills, and agent configuration. Document credential removal and distinguish
  local removal from server-side key revocation.

The implemented contract below fixes library selection, credential precedence,
grant lifetime and local removal. Public documentation now distinguishes OS
credential persistence from secret-free CLI and agent configuration. These changes
remain unreleased until the coordinated rollout is approved.

### Operating system targets

| Environment | Credential storage target | Availability requirement |
| --- | --- | --- |
| macOS | Keychain | The CLI and agent-launched bridge can access the user's keychain. |
| Linux desktop | Secret Service first, then kernel keyutils | Secret Service needs a reachable user D-Bus session and an accessible collection; kernel fallback needs working keyring access. |
| Windows | Windows Credential Manager | The credential store is accessible in the user context running the CLI and agent. |
| Linux over SSH, containers, and WSL | Secret Service where available, then kernel keyutils, then environment variables | Do not assume a desktop session, kernel keyring permission, or access to the host OS store. |
| CI | Existing environment-variable path | Non-interactive operation must not require browser approval or an unlocked desktop store. |

These are implementation targets, not a claim of tested LambdaDB support. Native
packaging and real credential operations must be verified on each supported OS
and architecture, including access from an agent-launched process.

The [keyring library documentation](https://docs.rs/keyring/3.6.3/keyring/)
describes the macOS, Windows, and Linux store types.
[`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node#linux-backend-selection)
is the selected Node binding. Linux fallback to kernel keyutils is allowed
for a new connection. Record the selected backend in the non-secret connection
metadata so later reads address the same store instead of silently switching.
The implementation pins optional `@napi-rs/keyring` 2.1.2 and explicitly selects
the Linux backend. The optional dependency is loaded only when OS storage is used.

Kernel keyutils is an OS-managed cache. CLI exit alone does not necessarily clear
it, but reboot or keyring expiry can remove the credential. Explain this in the
setup result. If a saved credential becomes unavailable, keep the connection
metadata and guide the user through explicit reconnection; do not silently issue
another project key. Non-interactive commands return an actionable error.
An unreadable or locked existing store must not be treated as a new connection
eligible for automatic fallback. Cache loss does not revoke the server-side API
key; retain its identity for deliberate replacement or cleanup. See the
[keyutils persistence contract](https://docs.rs/linux-keyutils-keyring-store/1.0.0/linux_keyutils_keyring_store/#persistence).

### Key issuance and recovery

Use the existing project API-key service with its current role checks. A browser
login must not bypass Org membership or key-management permissions. Approval
should identify whether a new project key will be issued and where it will be
kept. Reuse a valid saved connection on reruns instead of minting another key.

Project keys are revealed once and active-key limits apply. Define recovery for
an issued key whose delivery or local save fails. Do not blindly retry key or
project creation after an ambiguous response. Likewise, if default Org creation
succeeds but project creation fails, retain and reuse that Org on retry. Handle
concurrent tabs and repeated submissions without creating duplicate Orgs,
projects, or keys.

## Repository responsibilities

| Repository | Planned responsibility |
| --- | --- |
| `lambdadb-console` | Shared signup routing, optional survey, default Org guidance, project selection or creation, CLI authorization screen, and continuation handling. |
| `lambdadb-backend` | Default Org creation and recovery semantics, CLI authorization lifecycle, project access checks, and controlled delivery of a project credential. Reuse project provisioning and key services. |
| `lambdadb-cli` | Browser authorization entry and polling, credential resolution, resumable init, existing configuration and doctor reuse, stdio credential forwarding, agent previews, skill installation, and completion guidance. |
| `lambdadb-fe` | Adjust signup links or entry copy only where required. Account and project onboarding stays in Console. |
| `lambdadb-mcp` | Reuse the existing stdio package. Change it only if an actual integration gap is established. |
| `lambdadb` | No data-engine change is currently planned. Server-enforced key write restrictions and expiration are deferred. |

The four prepared implementation worktrees use `feat/unified-onboarding`, based
on each repository's `origin/develop`. Keep implementation in those worktrees.
This plan stays in the CLI repository as the shared reference; do not copy it
into the other repositories and maintain divergent versions.

## Implementation order

1. **Finalize contracts.** Define the default Org naming and creation behavior,
   invitation precedence, authorization state machine, credential storage and
   precedence, provisioning timeout, and recovery after an ambiguous write.
   Review the existing authentication surface and the protection and deployment
   exposure of token-generation routes before extending authentication.
2. **Simplify shared onboarding.** Implement the common Org and project flow in
   Backend and Console. Remove survey-based blocking from all login and signup
   paths. Verify direct UI entry and existing-user and invitation behavior first.
3. **Connect an existing project from CLI.** Add the browser approval flow,
   credential resolution, and handoff to the existing init implementation.
   Verify the complete flow using an existing development project before adding
   project creation to the CLI continuation.
4. **Complete new-user setup.** Carry CLI continuation through signup, default
   Org creation, project creation, and provisioning. Add only the necessary FE
   link changes and test recovery and reruns across these boundaries.
5. **Validate and document rollout.** Update CLI help and credential documentation,
   Console guidance, API documentation, and relevant release notes. Keep each PR
   coherent and record cross-repository dependencies and deployment order.

The grant and storage integration details below are implemented locally.
Backend contracts should be available before dependent Console or CLI behavior
is enabled; an unready server must produce an actionable failure rather than a partially successful
setup. Existing manual Console key setup remains supported during rollout.

## Implemented contract and rollout

- `POST /auth/device/start` returns a 256-bit device code, 50-bit displayed user
  code, configured Console verification URL, 15-minute expiry and five-second
  polling interval. The backend stores code hashes only, with a maximum of 1,024
  unexpired grants across replicas. Per-process IP limits complement that bound.
- JWT-only `/auth/device/inspect` and `/auth/device/decision` support explicit
  browser approval/denial. Approval binds the member, Org and project. The
  owner/admin check and project readiness for legacy project-mode grants are
  reused from project key management and rechecked at redemption. New
  `/auth/device/login` grants use `mode: account` and bind only the member;
  their approval never creates an Org, project or project key.
- The grant is marked consumed before external key issuance. Neither the backend
  nor CLI blindly retries uncertain issuance. Account-mode redemption returns an
  opaque CLI session once, not a Console JWT. No raw account token or project key
  is persisted in the database and no secret is sent in a browser URL. The former
  unauthenticated developer `/auth/generate` route is unregistered before enabling this flow.
- New project keys use a fresh OS entry, bound to endpoint/project and a UUID.
  Save/readback must match. Settings retain store, entry UUID, key ID and key name.
  Existing slots are never overwritten or silently migrated. `credentials remove`
  deletes the current local entry without revoking the server key.
- `init --connect` resumes terminal Org/project selection using a saved login
  and reuses per-project keys. Issuing a new or replacement key is explicit.
  On a first run, interactive init offers browser or environment setup. SSH uses `--no-browser`; automation uses
  existing credentials with `--non-interactive --agents ... --scope ...`.
- Browser setup previews the CLI settings path/store and saves a successfully
  delivered connection before doctor/agent installation. This intentionally lets
  a failed doctor or agent install resume without issuing another key. Agent file
  plans are separately displayed and confirmed before applying them. A saved
  connection is not evidence that collection-list access or search is ready.
- CLI management routes under `/auth/cli` accept only a hashed, revocable
  seven-day account session. A member may hold up to 20 live sessions; explicit
  login replaces the selected local session after the new one is durable.
  `/connect` claims a request UUID before issuance and retains the claim for
  seven days, bounded to 1,000 claims per member. These bounds are server abuse
  controls, not plan/project limits. Existing project-key limits still apply.
- `projects create` reuses project validation/provisioning and Org-row quota
  locking. It does not issue a CLI project key, select the CLI default or touch
  agents. `projects use --issue-key` is the explicit issuance command. Project
  selection without that flag reads a saved reference and never mints a key.
- Non-secret `config.json.account.json` and `config.json.connections.json`
  sidecars follow the resolved `--config` destination. Account slots use a
  separate OS service namespace that the MCP bridge cannot resolve. A local
  exclusive management lock prevents overlapping login/selection writes.
  Configuration edits are checked before replacement; completed connections
  remain cached when later settings/doctor/agent work fails.
- Console carries only validated local continuations across signup, verification,
  invitations and project setup. Default Org creation and invitation decisions
  serialize on the member; project creation serializes quota checks on the Org.
  An optional survey never gates access. The old placeholder project page redirects
  to the real shared flow. Existing FE redirects already preserve these paths and
  queries; no FE, engine or MCP package changes are required for this contract.
- Provisioning UI checks for ten minutes, offers manual refresh, and can resume an
  existing project after device expiry. Ambiguous project creation requires
  checking Console and possibly operational reconciliation; distributed project
  creation is not claimed to be an atomic transaction.

Deploy Backend first with `deviceAuthorization.enabled` false, then Console.
Set `deviceAuthorization.consoleURL` to that Console's exact origin and enable
routes for a designated development acceptance run. Only then publish the CLI
through its existing release process with separate authorization. Disabling the
device routes rolls back new authorization without revoking existing project keys.
The grant, CLI-session and key-request tables are additive. Existing environment setup works throughout.

Native implementations target macOS, Linux and Windows. The maintained opt-in
credential test exercises actual OS storage and a fresh-process doctor/bridge;
unit tests alone do not establish native support. Windows and kernel-keyutils
success require environments that actually provide those facilities. Default
Docker restrictions can make keyutils unavailable; the correct result is an
actionable environment-mode fallback, never a plaintext file.

## Acceptance and verification

- Both UI and CLI entry support a new user, an existing user, multiple Orgs,
  pending invitations, and an unanswered survey. Default Org naming is editable;
  reruns and concurrent submissions preserve a single intended Org and project.
- Browser approval supports a separate device and covers denial, expiry,
  cancellation, invalid continuations, consumed grants, and a terminal that
  disconnects. Preserve authentication and key-management role checks.
- Cover project quota rejection, unavailable regions, pending provisioning,
  failed project creation after Org creation, failed key delivery or storage,
  revoked keys, and unavailable credential stores.
- Verify Linux Secret Service preference, kernel fallback with a visible lifetime
  notice, unavailable kernel access, and reconnect behavior after cache loss.
  Existing connections must keep using their recorded backend, and cache loss
  must not cause silent key issuance or server-side revocation.
- Preserve unrelated agent configuration, show every destination file and scope
  before changes, and keep reruns safe. Verify that credentials do not enter
  generated files or diagnostics. Explain agent restart or reload requirements.
- Keep existing commands non-interactive. Document explicit non-interactive init
  inputs and actionable failures. Missing credentials or approval must not open
  a browser, wait indefinitely, silently create resources, or claim success in
  that path.
- Reuse authentication and collection-list verification. Report connection
  success separately from data availability, indexing, and search readiness.

For CLI implementation, use the checks in [CONTRIBUTING.md](CONTRIBUTING.md):
`npm ci`, `npm run lint`, `npm run check:version`, `npm run typecheck`, `npm test`,
and `npm run test:package`. Verify the installed tarball and both invocation
forms, not only execution from source. Follow each sibling repository's current
instructions and CI configuration for its implementation checks.

Record mock and loopback checks separately from actual browser login,
live-service access, OS credential-store behavior, and native agent startup.
Use designated development resources for live verification and track cleanup.
Do not publish packages, deploy services, or merge PRs as a consequence of local
validation; those actions remain separately authorized.

## Reference behavior

Neon provides a useful UX reference, rather than a requirement to copy its
storage policy or remote MCP architecture. Its current
[login documentation](https://neon.com/docs/cli/login) describes local
`credentials.json` storage and an optional `--keyring` mode. Its
[MCP documentation](https://neon.com/docs/cli/mcp) describes API keys written into
agent configuration or OAuth sign-in by the agent. Its
[init documentation](https://neon.com/docs/cli/init) describes project linking
and agent setup. These are separate credential paths; selecting a CLI keyring
does not imply that agent API keys use that store.

### Neon implementation review

Reviewed on 2026-10-26 at
[`7d1a2a7`](https://github.com/neondatabase/neon-pkgs/tree/7d1a2a728329be3e11589360b5ea70e1fc8d5857/packages/cli),
whose CLI package version is 8.11.3. The credential implementation spans
`packages/cli` and `internals/cli-core`.

- **Native binding and packaging.** Neon pins `@napi-rs/keyring` 1.3.0 as an
  optional dependency and loads it lazily. Its adapter returns unavailable when
  the native module cannot load or when running a `pkg` standalone binary.
  Windows values are limited to 1280 UTF-16 code units before writing.
  LambdaDB should keep environment-only commands and help usable without the
  addon, and validate native loading in the installed npm/npx and Homebrew
  artifacts. Store a compact project-key payload and check platform size limits.
  Sources: [package manifest](https://github.com/neondatabase/neon-pkgs/blob/7d1a2a728329be3e11589360b5ea70e1fc8d5857/packages/cli/package.json),
  [keyring adapter](https://github.com/neondatabase/neon-pkgs/blob/7d1a2a728329be3e11589360b5ea70e1fc8d5857/packages/cli/src/keyring.ts).
- **OS selection.** The pinned binding uses macOS Keychain and the Windows
  native credential store. On Linux it tries Secret Service, then kernel
  keyutils if store initialization fails. Neon does not override that selection.
  LambdaDB adopts this fallback order for new connections and adds a visible
  lifetime notice and a recorded backend. The candidate binding's 2.1.2 API
  supports explicitly selecting either store, which allows subsequent reads to
  use the recorded backend. The implementation selects that version.
  Kernel keyutils does not retain credentials across a reboot.
  Sources: [1.3.0 OS setup](https://github.com/Brooooooklyn/keyring-node/blob/e46be75c3ba8d5fde6b88a17c6153b87ffe4b946/src/entry.rs),
  [1.3.0 Linux fallback](https://github.com/Brooooooklyn/keyring-node/blob/e46be75c3ba8d5fde6b88a17c6153b87ffe4b946/src/linux_credential_builder.rs),
  [2.1.2 explicit store selection](https://github.com/Brooooooklyn/keyring-node/blob/52184fbebffeef8a061234f60f313c479b954f9f/README.md#linux-backend-selection).
- **Credential identity and errors.** Neon's shared store isolates entries by
  service, a hash of the resolved configuration directory, and profile name.
  It treats null reads as potentially locked or denied, rather than proving that
  a key is absent. LambdaDB uses a small credential-store interface with a fresh
  UUID for each connection, bound to endpoint/project across CLI and agent
  launches. Copies of the same non-secret reference intentionally address the
  same OS entry. An unreadable entry
  must not trigger automatic replacement or key issuance.
  Source: [credential store](https://github.com/neondatabase/neon-pkgs/blob/7d1a2a728329be3e11589360b5ea70e1fc8d5857/internals/cli-core/src/credential_store.ts).
- **Saving and removing credentials.** Neon reads after writing and can restore
  a readable previous value on failure. Its read-back check tests for a non-null
  result; LambdaDB should also compare the saved value before committing the
  configuration reference. Neon distinguishes confirmed deletion from an
  unreadable or remaining item. Preserve that distinction in user-facing results.
  Local removal and server revocation remain separate outcomes. Its replacement
  logic retires an old credential only after saving the replacement and avoids
  revoking the same key or an imported key without recorded issuance metadata.
  LambdaDB saves a fresh slot on explicit reconnection and retains older entries
  for agents that still reference them. Cleanup and server revocation remain
  explicit; ordinary reruns reuse the working connection.
  Sources: [store write and delete behavior](https://github.com/neondatabase/neon-pkgs/blob/7d1a2a728329be3e11589360b5ea70e1fc8d5857/internals/cli-core/src/credential_store.ts),
  [credential retirement](https://github.com/neondatabase/neon-pkgs/blob/7d1a2a728329be3e11589360b5ea70e1fc8d5857/packages/cli/src/retire_credential.ts).
- **Storage policy.** Neon's login selects file storage by default and remembers
  a profile's explicit keyring selection. Its MCP API-key path writes a bearer
  key into agent configuration. LambdaDB's agreed policy instead uses the OS
  store by default, environment variables when needed, and secret-free agent
  configuration through the stdio bridge. The expanded implementation also
  persists a separate seven-day CLI account session. Neon's refresh machinery
  is not copied; expiry requires explicit browser reauthorization.
  Sources: [login storage selection](https://github.com/neondatabase/neon-pkgs/blob/7d1a2a728329be3e11589360b5ea70e1fc8d5857/packages/cli/src/commands/auth.ts),
  [MCP configuration](https://github.com/neondatabase/neon-pkgs/blob/7d1a2a728329be3e11589360b5ea70e1fc8d5857/packages/cli/src/mcp/install.ts).

The reviewed [credential-store tests](https://github.com/neondatabase/neon-pkgs/blob/7d1a2a728329be3e11589360b5ea70e1fc8d5857/packages/cli/src/credential_store.test.ts)
use an in-memory backend to exercise isolation, size limits, unreadable entries,
failed read-back, deletion outcomes, and redaction. Reuse those distinct test
cases as design inputs, then separately verify actual OS storage, persistence,
fresh-process retrieval, and agent access. This review inspected source and
tests; it did not execute Neon or validate native stores on any OS.
