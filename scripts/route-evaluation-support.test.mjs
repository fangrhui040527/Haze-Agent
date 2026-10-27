import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseContractJson } from '../dist/contracts/json.js';
import { agentActionSchema } from '../dist/orchestration/contracts.js';
import {
  assessRouteOutput,
  prepareRouteEvaluation,
  safeEvaluationRoute,
} from './route-evaluation-support.mjs';

const schema = z.strictObject({
  type: z.literal('tool'),
  tool: z.string(),
  input: z.strictObject({
    artifact: z.strictObject({
      id: z.string(),
      version: z.number(),
      sha256: z.string(),
    }),
  }),
});
const artifact = { id: 'source-1', version: 2, sha256: 'hash-2' };
const action = { type: 'tool', tool: 'registered.check', input: { artifact } };
const criteria = {
  equals: { tool: 'registered.check' },
  exact_references: { 'input.artifact': artifact },
};

test('invalid actions remain rejected rather than being stripped or repaired', () => {
  for (const text of [
    '```json\n{}\n```',
    JSON.stringify({ ...action, extra: true }),
    JSON.stringify(action).slice(0, -1),
  ]) {
    assert.equal(
      assessRouteOutput(text, schema, criteria, parseContractJson)
        .strict_action,
      false,
    );
  }
});
test('schema success does not accept an ungranted method or stale artifact', () => {
  const result = assessRouteOutput(
    JSON.stringify({
      ...action,
      tool: 'arbitrary.sql',
      input: { artifact: { ...artifact, version: 1 } },
    }),
    schema,
    criteria,
    parseContractJson,
  );
  assert.equal(result.strict_action, true);
  assert.equal(result.outcome, false);
  assert.equal(result.reference_integrity, false);
  assert.deepEqual(result.failures, [
    'exact:tool',
    'references:input.artifact',
  ]);
});
test('correct strict action and exact revision pass separately', () => {
  assert.deepEqual(
    assessRouteOutput(
      JSON.stringify(action),
      schema,
      criteria,
      parseContractJson,
    ),
    {
      strict_action: true,
      outcome: true,
      reference_integrity: true,
      failures: [],
    },
  );
});
test('duplicate keys at every depth and overflow numbers fail the production parser', () => {
  for (const text of [
    '{"type":"wait","type":"tool","tool":"registered.check","input":{"artifact":{"id":"source-1","version":2,"sha256":"hash-2"}}}',
    '{"type":"tool","tool":"registered.check","input":{"artifact":{"id":"source-1","version":1,"version":2,"sha256":"hash-2"}}}',
    '{"type":"tool","tool":"registered.check","input":{"artifact":{"id":"source-1","version":1e999,"sha256":"hash-2"}}}',
  ])
    assert.equal(
      assessRouteOutput(text, schema, criteria, parseContractJson)
        .strict_action,
      false,
    );
});
test('evaluation route readback excludes endpoint and credential reference', () => {
  const result = safeEvaluationRoute({
    route_id: 'route-1',
    profile: 'candidate',
    provider: 'nightshift',
    requested_model: 'alias',
    base_url: 'http://sensitive-host',
    credential_ref: 'PRIVATE_TOKEN',
    capability_contract: { id: 'contract-v1' },
    policy: 'provider-default',
  });
  assert.equal(JSON.stringify(result).includes('PRIVATE_TOKEN'), false);
  assert.equal(JSON.stringify(result).includes('sensitive-host'), false);
  assert.match(result.model_identity, /not attested/);
});

const specialist = {
  id: 'HazeOps',
  instructions: 'Obtain only authorized evidence and return one action.',
  schemas: { specialist: agentActionSchema },
};
const exactArtifact = {
  id: '11111111-1111-4111-8111-111111111111',
  version: 2,
  sha256: 'a'.repeat(64),
};
const emptyContext = () => ({
  brief: 'Report the missing evidence.',
  input: {},
  artifacts: [],
  tools: [],
  peers: [],
  tool_results: [],
});
const assessPrepared = (text, prepared) =>
  assessRouteOutput(text, prepared.schema, {}, parseContractJson);

test('evaluation derives legal actions from permissions without mutating the scenario', () => {
  const context = emptyContext();
  const original = structuredClone(context);
  const prepared = prepareRouteEvaluation(specialist, context, 2400);
  assert.deepEqual(context, original);
  assert.equal(prepared.input.max_output_tokens, 2400);
  assert.equal(prepared.input.json_mode, true);
  assert.equal(
    prepared.input.context.action_contract.version,
    prepared.action_contract_version,
  );
  const allowed = prepared.input.context.action_contract.allowed_actions;
  for (const type of ['tool', 'message', 'wait', 'external_wait'])
    assert.equal(allowed.includes(type), false, type);
  assert.equal(allowed.includes('finish'), true);
  for (const action of [
    {
      id: 'invented-peer',
      type: 'message',
      recipient: 'planner',
      purpose: 'evidence_gap',
      text: 'No authorized method exists.',
    },
    {
      id: 'invented-job',
      type: 'external_wait',
      schema_version: 'haze.external.wait.action.v1',
      dependencies: [{ job_id: exactArtifact.id, required: true }],
    },
  ]) {
    const text = JSON.stringify(action);
    const result = assessPrepared(text, prepared);
    assert.equal(result.strict_action, false);
    assert.deepEqual(result.failures, ['strict-schema-rejection']);
    assert.equal(JSON.stringify(action), text);
  }
});

test('evaluation rejects an ungranted method and stale reference without target criteria', () => {
  const context = {
    ...emptyContext(),
    input: { artifact: exactArtifact },
    artifacts: [{ artifact: exactArtifact }],
    tools: [
      { id: 'registered.check', description: 'Check the exact artifact.' },
    ],
  };
  const prepared = prepareRouteEvaluation(specialist, context, 2400);
  const valid = {
    id: 'check-1',
    type: 'tool',
    tool: 'registered.check',
    input: { artifact: exactArtifact },
  };
  assert.equal(
    assessPrepared(JSON.stringify(valid), prepared).strict_action,
    true,
  );
  for (const action of [
    { ...valid, tool: 'arbitrary.sql' },
    {
      ...valid,
      input: { artifact: { ...exactArtifact, version: 1 } },
    },
  ])
    assert.equal(
      assessPrepared(JSON.stringify(action), prepared).strict_action,
      false,
    );
});

test('evaluation persists only an exact acknowledged tool result and permitted kind', () => {
  const prepared = prepareRouteEvaluation(
    specialist,
    {
      ...emptyContext(),
      tool_results: [
        {
          action_id: 'capture-1',
          tool: 'registered.capture',
          status: 'completed',
          artifact_kind: 'evaluation.capture',
        },
      ],
    },
    2400,
  );
  const valid = {
    id: 'save-1',
    type: 'save_tool_result',
    kind: 'evaluation.capture',
    tool_action_id: 'capture-1',
  };
  assert.equal(
    assessPrepared(JSON.stringify(valid), prepared).strict_action,
    true,
  );
  for (const action of [
    { ...valid, tool_action_id: 'invented-capture' },
    { ...valid, kind: 'review' },
  ])
    assert.equal(
      assessPrepared(JSON.stringify(action), prepared).strict_action,
      false,
    );
});

test('evaluation retains the original Manager schema and context', () => {
  const context = {
    purpose: 'manager',
    request: { objective: 'Explain a gap.' },
  };
  const managerSchema = z.strictObject({ type: z.literal('wait') });
  const prepared = prepareRouteEvaluation(
    {
      id: 'Manager',
      instructions: 'Coordinate admitted work.',
      schemas: { decision: managerSchema },
    },
    context,
    2400,
  );
  assert.equal(prepared.schema, managerSchema);
  assert.equal(prepared.input.context, context);
  assert.equal(prepared.action_contract_version, undefined);
  assert.deepEqual(prepared.input.output_schema, z.toJSONSchema(managerSchema));
});

test('preparing every frozen specialist probe preserves its context, criteria and limits', () => {
  const path = new URL(
    '../docs/Testing/route-evaluation-cases.json',
    import.meta.url,
  );
  const bytes = readFileSync(path);
  const suite = JSON.parse(bytes);
  const original = structuredClone(suite);
  const cases = suite.cases.filter((entry) => entry.role !== 'Manager');
  assert.equal(cases.length, 12);
  for (const entry of cases) {
    const prepared = prepareRouteEvaluation(
      { ...specialist, id: entry.role },
      entry.context,
      suite.limits.max_output_tokens,
    );
    const { action_contract, ...context } = prepared.input.context;
    assert.ok(action_contract.version);
    assert.deepEqual(context, entry.context, entry.id);
    assert.equal(
      prepared.input.max_output_tokens,
      suite.limits.max_output_tokens,
    );
    assert.equal(Object.hasOwn(prepared.input, 'criteria'), false);
  }
  assert.deepEqual(suite, original);
  assert.deepEqual(readFileSync(path), bytes);
});

test('production input schemas and retained output references constrain evaluation actions', () => {
  const prepared = prepareRouteEvaluation(
    specialist,
    {
      ...emptyContext(),
      artifacts: [{ artifact: exactArtifact }],
      tools: [
        {
          id: 'registered.read',
          input_schema: {
            type: 'object',
            properties: { revision: { type: 'integer', minimum: 1 } },
            required: ['revision'],
            additionalProperties: false,
          },
        },
      ],
    },
    2400,
  );
  const tool = {
    id: 'read-1',
    type: 'tool',
    tool: 'registered.read',
    input: { revision: 2 },
  };
  assert.equal(
    assessPrepared(JSON.stringify(tool), prepared).strict_action,
    true,
  );
  assert.equal(
    assessPrepared(
      JSON.stringify({ ...tool, input: { revision: '2' } }),
      prepared,
    ).strict_action,
    false,
  );
  const finish = {
    id: 'partial-1',
    type: 'finish',
    summary: 'Retained account awaits independent review.',
    support: 'partial',
    uncertainty: ['Independent review is unavailable.'],
    outputs: [exactArtifact],
  };
  assert.equal(
    assessPrepared(JSON.stringify(finish), prepared).strict_action,
    true,
  );
  for (const action of [
    { ...finish, uncertainty: [] },
    { ...finish, outputs: [{ ...exactArtifact, version: 1 }] },
  ])
    assert.equal(
      assessPrepared(JSON.stringify(action), prepared).strict_action,
      false,
    );
});
