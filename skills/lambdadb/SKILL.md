---
name: lambdadb
description: Inspect and search an existing LambdaDB project through LambdaDB MCP or the LambdaDB CLI.
---

# LambdaDB

Use the configured `lambdadb` MCP server for the selected existing project.
Start with `lambdadb_list_collections`, then `lambdadb_get_collection` to inspect
the chosen collection's index configuration. Ask the user to choose if the
intended collection or ref is unclear.

For a first read, call `lambdadb_query_collection` with the chosen
`collectionName`, `ref: {kind: "branch", name: "main"}`, and `size: 5`, omitting
`query` for match-all. Inspect returned documents before constructing a search
against actual indexed fields. Use an existing explicit ref when the user
specifies one. Empty results, a successful collection listing, and accepted
writes do not prove search/index readiness or relevance.

For CLI access, run `lambdadb --help` and the relevant command's `--help`.
Reads require an explicit `--ref`. For example, put `{"size":5}` in a query
file and run `lambdadb query --collection NAME --ref branch:main --file FILE --json`.
The query body follows the LambdaDB API, not SQL. Consult
https://docs.lambdadb.ai for field-specific query syntax.

Credentials come from a saved OS credential reference or the selected environment
variable in the agent's launch environment. Never print keys or put them in files,
arguments, generated examples or chat. If MCP cannot start, check whether its
configured OS store is unlocked and accessible to the same user, or whether the
selected environment variable is available. Do not silently reconnect or issue a
new key. Kernel keyutils credentials can disappear after reboot/expiry without
revoking the server key. `lambdadb doctor` verifies authentication and
collection-list access only. The user can explicitly run `lambdadb init --connect`
for Console signup/login, project selection and approval of a new connection.

MCP exposes read tools by default. Write tools require explicit setup opt-in;
their availability does not authorize creating collections or changing data.
Perform writes only when requested, using the user's collection and branch.
