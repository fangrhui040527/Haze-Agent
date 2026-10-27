import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { analyzePm25 } from '../dist/capabilities/pm25/methods.js';
import { loadSampleScenario } from '../dist/sample-data/index.js';
import { resolveSampleInputs, sampleRequestSchema } from './run-samples.mjs';

test('all three example files are native requests with a sample input format', async () => {
  const ids = [];
  for (const number of [1, 2, 3]) {
    const wrapper = sampleRequestSchema.parse(
      JSON.parse(
        await readFile(
          new URL(`../input_examples/example_${number}.json`, import.meta.url),
          'utf8',
        ),
      ),
    );
    ids.push(wrapper.scenario_id);
    assert.equal(wrapper.request.schema_version, 'haze.task.request.v3');
  }
  assert.equal(new Set(ids).size, 3);
});

test('changed raw PM2.5 inputs reach native computation and produce different results', async () => {
  const defaults = await loadSampleScenario('evidence-investigation');
  const capture = structuredClone(defaults.capture);
  const original = analyzePm25(defaults.capture, defaults.manifest.scope);
  const value = original.range.max + 20;
  capture.rows[0].value = value;
  const raw = JSON.parse(capture.raw);
  raw.data[capture.selection.selected_raw_row_indices[0]].pm25 = value;
  capture.raw = JSON.stringify(raw);
  const wrapper = sampleRequestSchema.parse({
    schema_version: 'haze.sample.request.v1',
    scenario_id: 'evidence-investigation',
    request: {
      schema_version: 'haze.task.request.v3',
      objective: 'Investigate my changed sample inputs.',
      scope: defaults.manifest.scope,
    },
    inputs: { pm25_capture: capture, notes: 'Judge-supplied synthetic case.' },
  });
  const selected = await resolveSampleInputs(wrapper, defaults);
  const result = analyzePm25(selected.capture, wrapper.request.scope);
  assert.equal(selected.capture.rows[0].value, value);
  assert.equal(result.range.max, value);
  assert.notDeepEqual(result.range, original.range);
  assert.equal(selected.notes, 'Judge-supplied synthetic case.');
  assert.notEqual(defaults.capture.rows[0].value, value);
});

test('custom PM2.5 geography is validated from its capture, without requiring default manifest geography', async () => {
  const defaults = await loadSampleScenario('evidence-investigation');
  const capture = structuredClone(defaults.capture);
  const location = 'Judge Harbour';
  capture.location = location;
  for (const row of capture.rows) row.location = location;
  const raw = JSON.parse(capture.raw);
  for (const row of raw.data) row.town = location;
  capture.raw = JSON.stringify(raw);
  const wrapper = sampleRequestSchema.parse({
    schema_version: 'haze.sample.request.v1',
    scenario_id: 'evidence-investigation',
    request: {
      schema_version: 'haze.task.request.v3',
      objective: 'Investigate the supplied harbour evidence.',
      scope: { ...defaults.manifest.scope, location },
    },
    inputs: { pm25_capture: capture },
  });
  const selected = await resolveSampleInputs(wrapper, defaults);
  assert.equal(selected.capture.location, location);
  assert.equal(
    analyzePm25(selected.capture, wrapper.request.scope).scope.location,
    location,
  );
});

test('sample requests cannot inject a saved answer or switch capability input formats', async () => {
  const defaults = await loadSampleScenario('evidence-investigation');
  const wrapper = {
    schema_version: 'haze.sample.request.v1',
    scenario_id: 'evidence-investigation',
    request: {
      schema_version: 'haze.task.request.v3',
      objective: 'Investigate my supplied evidence.',
    },
  };
  assert.equal(
    sampleRequestSchema.safeParse({ ...wrapper, answer: 'A saved answer.' })
      .success,
    false,
  );
  await assert.rejects(
    resolveSampleInputs(
      sampleRequestSchema.parse({ ...wrapper, inputs: { damage: {} } }),
      defaults,
    ),
    /different capability format/,
  );
});
