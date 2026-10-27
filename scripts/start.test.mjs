import assert from 'node:assert/strict';
import test from 'node:test';
import { runStart, selectStartTarget } from './start.mjs';

test('sample mode without arguments starts all real sample workflows', async () => {
  assert.deepEqual(await selectStartTarget([], { SAMPLE_MODE: 'true' }), {
    entry: 'run-samples.mjs',
    args: ['--all'],
  });
});

test('sample mode forwards a custom input path to the real runner', async () => {
  assert.deepEqual(
    await selectStartTarget(['judge/custom.json'], { SAMPLE_MODE: '1' }),
    { entry: 'run-samples.mjs', args: ['judge/custom.json'] },
  );
});

test('a sample wrapper is recognized by contract even with sample mode off', async () => {
  const reads = [];
  assert.deepEqual(
    await selectStartTarget(
      ['judge/custom.json'],
      { SAMPLE_MODE: 'false' },
      async (path) => {
        reads.push(path);
        return { schema_version: 'haze.sample.request.v1' };
      },
    ),
    { entry: 'run-samples.mjs', args: ['judge/custom.json'] },
  );
  assert.deepEqual(reads, ['judge/custom.json']);
});

test('a native v3 request cannot accidentally enter the metadata scaffold', async () => {
  assert.equal(
    (
      await selectStartTarget(['judge/native.json'], {}, async () => ({
        schema_version: 'haze.task.request.v3',
      }))
    ).entry,
    'run-samples.mjs',
  );
});

test('legacy numeric metadata examples retain their entry point when sample mode is off', async () => {
  assert.deepEqual(
    await selectStartTarget(
      ['input_examples/01-minimal.json'],
      { SAMPLE_MODE: 'false' },
      async () => ({ schemaVersion: 1 }),
    ),
    { entry: 'run-example.mjs', args: ['input_examples/01-minimal.json'] },
  );
  assert.deepEqual(await selectStartTarget([], {}), {
    entry: 'run-example.mjs',
    args: [],
  });
});

test('dispatch preserves configured model environment, forwards arguments and propagates failure', async () => {
  const env = {
    SAMPLE_MODE: 'true',
    HAZE_PROVIDER: 'nightshift',
    HAZE_MODEL: 'configured-model',
  };
  const calls = [];
  const code = await runStart(['judge/changed.json'], env, {
    launch: async (target, environment) => {
      calls.push({ target, environment });
      return 2;
    },
  });
  assert.equal(code, 2);
  assert.deepEqual(calls, [
    {
      target: { entry: 'run-samples.mjs', args: ['judge/changed.json'] },
      environment: env,
    },
  ]);
});
