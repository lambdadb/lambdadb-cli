# Account, projects and usage

[CLI overview](../README.md) · [Setup](setup.md) · [Agents](agents.md) · [Account and usage](account.md) · [Data commands](data.md)

These commands use a saved account login, independently of project API-key
configuration. They never prompt for missing arguments. `login` deliberately
waits for browser approval and prints a URL usable on another device; it does not
prompt on stdin. It only signs in: project listing, creation and selection require
explicit commands afterwards. Run `lambdadb init` instead for guided project and
agent setup; it reuses a valid login. Use the same `--config` path throughout if
overriding it.

```sh
lambdadb login --no-browser
lambdadb orgs list --json
lambdadb projects regions --json
lambdadb projects list --org-id ORG_UUID --json
lambdadb projects create --org-id ORG_UUID --name my-project --region REGION --json
# For a new account with no Org, choose --default-org instead of --org-id.
lambdadb projects list --org-id ORG_UUID --json  # wait until ACTIVE
lambdadb projects use --org-id ORG_UUID --project-id PROJECT_UUID --issue-key
lambdadb doctor
# Later switches reuse a previously saved key without --issue-key:
lambdadb projects use --org-id ORG_UUID --project-id PROJECT_UUID
lambdadb logout
```

`--org-id` and `--project-id` take UUIDs, not names. Find them with `orgs list`
and `projects list --org-id UUID`. The global `--project <name>` remains a
project-name selector for data API commands.

`create` requires exactly one of `--org-id UUID` or `--default-org`, plus `--name`
and `--region`. Creation does not select the CLI default or install agents.
`use` requires both IDs; first connection or deliberate key replacement requires
`--issue-key` and owner/admin key-management permission. Saved project keys are
reused without that flag. `projects use` changes only the CLI default: existing
agent entries stay pinned until you rerun `init` and approve their file plan.
Expired, missing or unreadable account credentials fail with login/unlock guidance;
ordinary management commands never start browser login automatically.

## Usage and cost estimates

```sh
lambdadb usage                         # current saved project
lambdadb usage --org-id ORG_UUID          # entire Org
lambdadb usage --org-id ORG_UUID --project-id PROJECT_UUID --month 2026-09 --json
```

Usage requires a valid account `login` and matching Backend CLI-usage support.
It never opens a browser, issues keys or changes service data. The default target
comes from the saved project connection for that account. Environment-key setups,
missing connection metadata or overridden targets require explicit `--org-id` and,
for one project, `--project-id`. Org-wide cost usage includes deleted projects
that contributed usage during the selected period.

- **Free:** current per-project read/write/storage bytes and inference LIU,
  reported limits, usage percentages, exceeded state, quota period/window start
  and last update. No price conversion is shown. Backend returns zero for a
  configured counter with no recorded usage history after a successful lookup.
  Other missing counters remain unavailable; the CLI never replaces an absent
  value with zero. Zero recorded usage does not confirm that recent activity has
  been aggregated. Missing update/window timestamps remain unavailable, and
  percentages are omitted for missing or zero limits. The API does not
  supply the next reset instant, so the CLI does not invent it.
- **Pay-As-You-Go:** recorded read/write bytes, storage byte-hours and inference
  LIU, with per-item and total USD list-rate estimates. This view requires an
  Org owner/admin, matching the existing cost API. It uses Backend rate cards,
  not CLI pricing constants. Missing prices remain unavailable; the total is
  explicitly a partial priced subtotal if any metric is unpriced.

Paid usage defaults to the current UTC calendar month. `--month YYYY-MM` selects
one current or past month; the response range has an exclusive end and can
include today's still-filling bucket. It is accumulated recorded usage, not a
month-end forecast or final invoice. Estimates exclude free allowances, credits,
taxes and billing rounding. Historical Free quotas are unavailable: omit
`--month` to read the current quota window. Retrieval time is distinct from the
quota's reported update time; the command does not claim real-time freshness.

Human output is a concise report; `--json` retains the versioned result envelope.
Amounts, LIU and paid raw totals are decimal strings to preserve precision. Free
quota counters must be safe integers; incompatible responses fail instead of
silently rounding them. Both modes respect the account API's per-request
`--timeout-ms` / `LAMBDADB_TIMEOUT_MS` budget.

## Limits and failures

The API-key environment path remains available without account login. Management
requests do not follow redirects and never retry writes. `--timeout-ms` overrides
`LAMBDADB_TIMEOUT_MS` (default `30000`, range 1–3600000 milliseconds). For account
login, logout and project/Organization management, this limits each HTTP request,
including its response body; sequential requests each receive a fresh budget.
It does not limit time spent at prompts, the server-issued browser authorization
window (up to 15 minutes), or project provisioning polling (up to 10 minutes).
For data API commands such as `doctor`, `query` and `docs import`, it remains a
shared command budget across sequential requests, retries and transfers. During
account-based `init`, management uses per-request limits and the subsequent doctor
check receives its own data API budget.
A project-limit error includes `organization.max_projects`, `projects_count`,
`can_upgrade`, and `billing_url` in JSON, plus the link in terminal diagnostics.
A transport failure or HTTP 408/5xx response to a management mutation, or uncertain
key delivery (including an incomplete successful issuance response) exits 5
with `data.state: "unknown"`; inspect existing projects
or the displayed named key in Console before explicitly retrying.

## Session recovery

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
