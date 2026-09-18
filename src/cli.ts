#!/usr/bin/env node
import { Command, CommanderError, Option } from 'commander';
import { readFileSync } from 'node:fs';
import { integer, name, resolveConfig, saveSettings, type Options } from './config.js';
import { createInput, parseRef, queryInput, readJson, readJsonl } from './input.js';
import { importDocuments, planBatches } from './import-workflow.js';
import { definitelyRejected, describeError, InputError, isInputError } from './errors.js';
import { Output, type Envelope } from './output.js';
import { runtime } from './runtime.js';

const output = new Output();
output.protect(process.env.LAMBDADB_API_KEY);
if (process.env.LAMBDADB_API_KEY_ENV) output.protect(process.env[process.env.LAMBDADB_API_KEY_ENV]);
let commandName = 'lambdadb';
let target: Record<string, unknown> | undefined;
let mutationStarted = false;

const program = new Command()
  .name('lambdadb')
  .description('Project-scoped LambdaDB CLI. All commands are non-interactive.')
  .version(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  .option('--json', 'Emit one versioned JSON result on stdout; diagnostics stay on stderr')
  .option('--endpoint <url>', 'API origin (overrides LAMBDADB_ENDPOINT and saved configuration)')
  .option('--project <name>', 'Existing project (overrides LAMBDADB_PROJECT and saved configuration)')
  .option('--api-key-env <name>', 'Environment variable holding the key; never pass a key as an argument')
  .option('--config <path>', 'Configuration path (overrides LAMBDADB_CONFIG)')
  .option('--timeout-ms <ms>', 'Total network budget, 1–3600000 ms (default 30000)')
  .showSuggestionAfterError(false)
  .exitOverride()
  .configureOutput({ writeErr: () => {} })
  .addHelpText('after', '\nExamples:\n  lambdadb configure --endpoint https://api.lambdadb.ai --project my-project\n  lambdadb doctor --json\n  lambdadb query --collection demo-docs --ref branch:main --file examples/query.json --json\n\nExit codes: 0 success, 2 input/config error, 3 API/request failure, 4 partial import, 5 unknown write outcome.');

function result(data: unknown, summary: string, exitCode = 0) {
  const envelope: Envelope = { schemaVersion: 1, command: commandName, ok: exitCode === 0, target, data };
  output.emit(envelope, summary);
  process.exitCode = exitCode;
}

type Context = ReturnType<typeof runtime>;
async function connected(command: Command, action: (ctx: Context) => Promise<void>) {
  const config = await resolveConfig(command.optsWithGlobals());
  output.protect(config.apiKey);
  target = { endpoint: config.endpoint, project: config.project };
  const ctx = runtime(config);
  try { await action(ctx); } finally { ctx.close(); }
}

function scoped(command: Command): string {
  const collection = name(command.opts().collection, 'Collection name');
  target = { ...target, collection };
  return collection;
}

program.hook('preAction', (_parent, command) => {
  output.json = !!command.optsWithGlobals().json;
  commandName = command.name();
  if (command.parent && command.parent !== program) commandName = `${command.parent.name()} ${commandName}`;
});

program.command('configure')
  .description('Save endpoint, project and API-key environment variable name (no secret is saved)')
  .action(async (_opts, cmd: Command) => {
    const saved = await saveSettings(cmd.optsWithGlobals() as Options);
    result(saved, 'Configuration saved. Supply the key in the selected environment variable, then run doctor.');
  });

program.command('doctor')
  .description('Check configuration, authentication and project collection-list access')
  .action(async (_opts, cmd: Command) => connected(cmd, async ({ client, options }) => {
    await client.listCollections({ size: 1 }, options);
    result({ checks: [
      { name: 'configuration', status: 'passed' },
      { name: 'authentication_and_project_collection_list', status: 'passed' },
    ], writesVerified: false, queryReadinessVerified: false }, 'Connection verified using the project collection-list API.');
  }));

const collections = program.command('collections').description('List, describe and create collections');
collections.command('list')
  .description('Fetch one page by default, or use the SDK iterator for all pages')
  .option('--size <count>', 'Page size, 1–100', '20')
  .option('--page-token <token>', 'Opaque continuation token')
  .option('--all', 'Fetch all pages within the total timeout (results are buffered)')
  .action(async (opts, cmd: Command) => {
    const size = integer(opts.size, 'Page size', 1, 100);
    await connected(cmd, async ({ client, options }) => {
      const params = { size, pageToken: opts.pageToken };
      if (!opts.all) {
        const page = await client.listCollections(params, options);
        result(page, `${page.collections.length} collection(s)${page.nextPageToken ? '; more pages available' : ''}.`);
      } else {
        const items = [];
        for await (const page of client.listCollectionsPages(params, options)) items.push(...page.collections);
        result({ collections: items }, `${items.length} collection(s).`);
      }
    });
  });

collections.command('describe')
  .description('Get collection metadata; counts describe the committed main branch')
  .requiredOption('--collection <name>', 'Collection name')
  .action(async (_opts, cmd: Command) => connected(cmd, async ({ client, options }) => {
    const collection = scoped(cmd);
    result(await client.collection(collection).get(options), 'Collection metadata (main-branch counts are not a readiness signal).');
  }));

collections.command('create')
  .description('Create a collection from a JSON field-to-index map')
  .requiredOption('--collection <name>', 'New collection name')
  .requiredOption('--index-config <path>', 'JSON indexConfigs map (see examples/index-config.json)')
  .action(async (opts, cmd: Command) => {
    const input = createInput(name(opts.collection, 'Collection name'), await readJson(opts.indexConfig));
    await connected(cmd, async ({ client, options }) => {
      scoped(cmd);
      mutationStarted = true;
      const created = await client.createCollection(input, { ...options, retries: { strategy: 'none' } });
      result({ ...created, state: 'created', searchable: 'not_verified' }, 'Collection created; query-serving readiness has not been verified.');
    });
  });

const docs = program.command('docs').description('Import JSONL and fetch documents by ID');
docs.command('import')
  .description('Validate JSONL, submit sequential batches, stop on first error; acceptance is not search readiness')
  .requiredOption('--collection <name>', 'Collection name')
  .requiredOption('--branch <name>', 'Explicit writable branch (for example main)')
  .requiredOption('--file <path>', 'UTF-8 JSONL file, at most 64 MiB')
  .addOption(new Option('--mode <mode>', 'SDK write method').choices(['upsert', 'bulk']).default('upsert'))
  .option('--batch-size <count>', 'Maximum documents per batch, 1–10000', '1000')
  .option('--batch-bytes <bytes>', 'Serialized byte cap (default 4000000 upsert, 16000000 bulk)')
  .action(async (opts, cmd: Command) => {
    name(opts.collection, 'Collection name');
    const branch = name(opts.branch, 'Branch name');
    const bulk = opts.mode === 'bulk';
    const batchSize = integer(opts.batchSize, 'Batch size', 1, 10000);
    const maxBytes = integer(opts.batchBytes ?? (bulk ? '16000000' : '4000000'), 'Batch bytes', 64, bulk ? 64000000 : 4000000);
    const rows = await readJsonl(opts.file);
    const batches = planBatches(rows, branch, batchSize, maxBytes, bulk);
    await connected(cmd, async ({ client, options }) => {
      const collection = scoped(cmd);
      target = { ...target, branch };
      output.diagnostic(`Validated ${rows.length} document(s); submitting ${batches.length} batch(es) using ${opts.mode}.`);
      const imported = await importDocuments(client.collection(collection).docs, batches, branch, bulk, options, batch => {
        output.diagnostic(`Batch ${batch.batch}: ${batch.state}, ${batch.documents} document(s), lines ${batch.firstLine}–${batch.lastLine}.`);
      });
      const exitCode = imported.state === 'accepted' ? 0 : imported.state === 'unknown' ? 5 : imported.state === 'partial' ? 4 : 3;
      result(imported, `${imported.accepted}/${imported.total} document(s) accepted; search visibility not verified.`, exitCode);
      if (exitCode) output.diagnostic('Import stopped. Inspect batch outcomes and the selected branch before retrying; automatic resume is not supported.');
    });
  });

docs.command('fetch')
  .description('Fetch up to 100 IDs at an explicit ref; missing IDs are a successful empty/partial result')
  .requiredOption('--collection <name>', 'Collection name')
  .requiredOption('--ref <kind:name>', 'branch:NAME, tag:NAME or alias:NAME')
  .requiredOption('--ids <id...>', 'One or more IDs (separate with spaces)')
  .option('--consistent-read', 'Overlay eligible pending writes; direct branch only, excludes bulk imports')
  .option('--include-vectors', 'Include vector fields in returned documents')
  .action(async (opts, cmd: Command) => {
    const ref = parseRef(opts.ref);
    if (opts.ids.length > 100 || opts.ids.some((id: string) => !id)) throw new InputError('Fetch requires 1–100 nonempty IDs.');
    if (opts.consistentRead && ref.kind !== 'branch') throw new InputError('Consistent reads require a direct branch ref.');
    await connected(cmd, async ({ client, options }) => {
      const collection = scoped(cmd);
      target = { ...target, ref };
      const fetched = await client.collection(collection).docs.fetch({
        ids: opts.ids, includeVectors: opts.includeVectors ?? false,
        ...(ref.kind === 'branch' ? { ref, consistentRead: !!opts.consistentRead } : { ref, consistentRead: false }),
      }, options);
      const found = new Set(fetched.docs.map(item => item.doc.id));
      const { docsUrl: _signedUrl, ...data } = fetched;
      result({ ...data, missingIds: opts.ids.filter((id: string) => !found.has(id)) }, `${fetched.docs.length} document(s) fetched.`);
    });
  });

program.command('query')
  .description('Submit a supported query request JSON file; empty matches are a successful result')
  .requiredOption('--collection <name>', 'Collection name')
  .requiredOption('--ref <kind:name>', 'branch:NAME, tag:NAME or alias:NAME; must match any ref in the file')
  .requiredOption('--file <path>', 'JSON request body including query (see examples/query.json)')
  .action(async (opts, cmd: Command) => {
    const ref = parseRef(opts.ref);
    const input = queryInput(await readJson(opts.file), ref);
    await connected(cmd, async ({ client, options }) => {
      const collection = scoped(cmd);
      target = { ...target, ref };
      const queried = await client.collection(collection).query(input, options);
      const { docsUrl: _signedUrl, ...data } = queried;
      result(data, `${queried.docs.length} match(es).`);
    });
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) {
    process.exitCode = 0;
  } else {
    output.json ||= process.argv.includes('--json');
    const failure = error instanceof CommanderError
      ? new InputError('Invalid or incomplete command. Run lambdadb --help or the command-specific --help.') : error;
    const unknownWrite = mutationStarted && !definitelyRejected(failure);
    const exitCode = isInputError(failure) ? 2 : unknownWrite ? 5 : 3;
    output.emit({
      schemaVersion: 1, command: commandName, ok: false, target,
      ...(unknownWrite ? { data: { state: 'unknown', searchable: 'not_verified' } } : {}),
      error: describeError(failure),
    }, unknownWrite ? 'Write outcome unknown. Inspect the target before retrying.' : 'Command failed.');
    process.exitCode = exitCode;
  }
}
