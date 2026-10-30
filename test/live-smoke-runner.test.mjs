import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSummary, runLiveSmoke, runSuite } from '../scripts/run-live-smoke.mjs';

const env = { LAMBDADB_BASE_URL: 'https://test.example', LAMBDADB_PROJECT_NAME: 'cli-ci',
  LAMBDADB_PROJECT_API_KEY: 'synthetic-test-key', PATH: '/bin' };
const passed = (format = 'ℹ') => ['tests 1', 'suites 0', 'pass 1', 'fail 0', 'cancelled 0', 'skipped 0', 'todo 0']
  .map(line => `${format} ${line}`).join('\n') + '\n';

test('the smoke key is passed only to the live test environment', async () => {
  const calls = [];
  await runLiveSmoke(env, async (command, args, options) => {
    calls.push([command, args]);
    assert.ok(!args.join(' ').includes('synthetic'));
    // The provisioned names map to the names the live test reads, with every opt-in set.
    assert.equal(options.env.LAMBDADB_API_KEY, 'synthetic-test-key');
    assert.equal(options.env.LAMBDADB_RUN_LIVE_TESTS, '1');
    assert.equal(options.env.LAMBDADB_ENDPOINT, env.LAMBDADB_BASE_URL);
    assert.equal(options.env.LAMBDADB_PROJECT, env.LAMBDADB_PROJECT_NAME);
    assert.equal(options.env.LAMBDADB_LIVE_CONFIRM_PROJECT, env.LAMBDADB_PROJECT_NAME);
    return { status: 0, output: passed() };
  });
  assert.deepEqual(calls, [['npm', ['run', 'test:live']]]);
  assert.equal(env.LAMBDADB_API_KEY, undefined);
  assert.equal(process.env.LAMBDADB_API_KEY, undefined);
});

test('missing configuration and invalid keys fail before starting a smoke', async () => {
  const unexpected = () => assert.fail('Must not start smoke');
  for (const name of Object.keys(env).filter(name => name.startsWith('LAMBDADB_'))) {
    for (const value of [undefined, '', ' ']) {
      await assert.rejects(runLiveSmoke({ ...env, [name]: value }, unexpected), /Missing smoke configuration/);
    }
  }
  await assert.rejects(runLiveSmoke({ ...env, LAMBDADB_PROJECT_API_KEY: 'key\nother-key' }, unexpected),
    /single project API key/);
});

test('failed, interrupted, or incomplete live suites prevent publication', async () => {
  const smoke = result => runLiveSmoke(env, async () => result);
  for (const result of [{ status: 1, output: passed() }, { status: null, signal: 'SIGTERM' }, { error: new Error('spawn failed') }]) {
    await assert.rejects(smoke(result), /live smoke failed/);
  }
  for (const output of ['', passed().replace('skipped 0', 'skipped 1'), passed().replace('todo 0', 'todo 1'),
    passed().replace('tests 1', 'tests 0').replace('pass 1', 'pass 0'), passed().replace('pass 1', 'pass 0')]) {
    await assert.rejects(smoke({ status: 0, output }), /did not run every live test to a pass/);
  }
  await smoke({ status: 0, output: passed('#') });
});

test('the summary check reads both spec and TAP reporters', () => {
  checkSummary(`[live +1s] Doctor passed.\n${passed()}`);
  checkSummary(passed('#'));
  assert.throws(() => checkSummary(passed('#').replace('cancelled 0', 'cancelled 1')), /every live test/);
});

test('the suite runner reports the child status and captured output', async () => {
  const ok = await runSuite(process.execPath, ['-e', 'console.log("runner output")'], { env: process.env });
  assert.equal(ok.status, 0);
  assert.equal(ok.output, 'runner output\n');
  assert.equal((await runSuite(process.execPath, ['-e', 'process.exit(3)'], { env: process.env })).status, 3);
});
