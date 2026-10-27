import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { validateSampleOutput } from './sample-output-validation.mjs';

const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
const hash = (value) =>
  createHash('sha256').update(stable(value)).digest('hex');
const ref = ({ id, version, sha256 }) => ({ id, version, sha256 });

/** Test-only records; no fixture answers or action sequences enter sample inputs. */
function recordedOutput(scenarioId, { gap = false } = {}) {
  const task = {
    id: randomUUID(),
    current_run_id: randomUUID(),
    objective_revision: 1,
    status: 'completed',
    mode: 'live',
    usage: { model_calls: 1, tool_calls: 1 },
    original_request: {
      schema_version: 'haze.task.request.v3',
      objective: 'Test input',
      context_refs: [],
    },
    assignments: [],
    artifacts: [],
    result: {
      completion: 'partial',
      work_products: [],
      sources: [],
      review: { status: 'supported', checks: [] },
      provenance: { mode: 'live' },
    },
  };
  const manager = {
    id: randomUUID(),
    role: 'Manager',
    revision: 1,
    run_id: task.current_run_id,
    objective_revision: 1,
    status: 'completed',
    usability: 'usable',
    outputs: [],
  };
  task.assignments.push(manager);
  const artifacts = [];
  const add = (kind, content, dependencies = []) => {
    const assignment = {
      id: randomUUID(),
      revision: 1,
      run_id: task.current_run_id,
      objective_revision: 1,
      status: 'completed',
      usability: 'usable',
      outputs: [],
    };
    const artifact = {
      id: randomUUID(),
      version: 1,
      sha256: hash(content),
      kind,
      task_id: task.id,
      run_id: task.current_run_id,
      objective_revision: 1,
      assignment_id: assignment.id,
      assignment_revision: 1,
      producer: { kind: 'assignment', id: assignment.id },
      dependencies: dependencies.map(ref),
      content,
    };
    assignment.outputs.push(ref(artifact));
    task.assignments.push(assignment);
    task.artifacts.push({
      current: true,
      objective_revision: 1,
      artifact: ref(artifact),
    });
    artifacts.push(artifact);
    return artifact;
  };
  const review = (product, kind = 'review') => {
    const artifact = add(
      kind,
      {
        verdict: 'supported',
        reviewed_artifacts: [ref(product)],
      },
      [product],
    );
    task.result.review.checks.push({
      artifact: ref(product),
      verdict: 'supported',
      producer_assignment_id: product.assignment_id,
      producer_revision: product.assignment_revision,
      reviewer_assignment_id: artifact.assignment_id,
      reviewer_revision: artifact.assignment_revision,
      review_artifact: ref(artifact),
    });
    return artifact;
  };
  const select = (artifact) => task.result.work_products.push(ref(artifact));
  switch (scenarioId) {
    case 'evidence-investigation': {
      const capture = add('pm25.capture', {
        evidence_origin: 'synthetic_fixture',
        selection: { backend: 'sample-file' },
        raw: '{"data":[]}',
      });
      const analysis = add(
        'pm25.analysis',
        {
          coverage: { status: 'partial' },
        },
        [capture],
      );
      select(analysis);
      review(analysis);
      break;
    }
    case 'damage-account': {
      const components = [
        'damage.scope',
        'damage.inputs',
        'damage.coverage',
        'damage.physical',
        'damage.incidence',
        'damage.welfare',
        'damage.overlap',
        'damage.source-fire-extension',
        'damage.methods',
        'damage.scenarios',
      ].map((kind) => add(kind, { source: 'synthetic' }));
      const account = add(
        'damage.account',
        {
          status: 'partial',
          evidence_origin: 'synthetic',
          component_refs: components.map((artifact) => ({
            kind: artifact.kind,
            artifact: ref(artifact),
          })),
        },
        components,
      );
      select(account);
      for (const artifact of [...components, account].filter(({ kind }) =>
        [
          'damage.physical',
          'damage.incidence',
          'damage.welfare',
          'damage.scenarios',
          'damage.account',
        ].includes(kind),
      ))
        review(artifact, 'damage.review');
      break;
    }
    case 'damage-reduction': {
      const selection = add('reduction.input-selection', {
        target: { target_fraction: '0.1' },
      });
      const assessment = add(
        'reduction.assessment',
        {
          selection_ref: ref(selection),
          origin: 'synthetic',
          status: gap ? 'gap' : 'supported',
          scientific_qualification: 'unqualified',
        },
        [selection],
      );
      const arithmetic = review(assessment, 'reduction.review');
      const plan = add(
        'reduction.conditional-plan',
        {
          selection_ref: ref(selection),
          assessment_ref: ref(assessment),
          arithmetic_review_ref: ref(arithmetic),
          state: gap ? 'evidence_gap' : 'conditional',
          origin: 'synthetic',
          scientific_qualification: 'unqualified',
          delivery_status: 'not_delivered',
          achieved_reduction: false,
        },
        [selection, assessment, arithmetic],
      );
      select(assessment);
      select(plan);
      review(plan, 'reduction.plan-review');
      break;
    }
  }
  return {
    schema_version: 'haze.sample.output.v1',
    sample_mode: true,
    synthetic_evidence: true,
    scenario_id: scenarioId,
    request: task.original_request,
    task,
    result: task.result,
    artifacts,
    execution: {
      passed: true,
      model_attempts: [
        {
          id: randomUUID(),
          task_id: task.id,
          run_id: task.current_run_id,
          objective_revision: 1,
          assignment_id: manager.id,
          assignment_revision: 1,
          kind: 'model',
          status: 'completed',
          accepted: true,
          details: { requested_route: { provider: 'nightshift' } },
          receipt: {
            response_model: 'configured-model',
            response_id: 'provider-response-id',
            http_status: 200,
            response_status: 'stop',
          },
        },
      ],
    },
  };
}

test('accepts all three independently reviewed workflows with honest partial/conditional status', () => {
  for (const id of [
    'evidence-investigation',
    'damage-account',
    'damage-reduction',
  ]) {
    const outcome = validateSampleOutput(recordedOutput(id));
    assert.equal(outcome.valid, true, JSON.stringify(outcome.errors));
    assert(Object.values(outcome.checks).every(Boolean));
  }
  assert.equal(
    validateSampleOutput(recordedOutput('damage-reduction', { gap: true }))
      .valid,
    true,
  );
});

test('does not mistake a completed direct reply and nonzero call count for workflow execution', () => {
  const output = recordedOutput('evidence-investigation');
  output.task.result.work_products = [];
  const outcome = validateSampleOutput(output);
  assert.equal(outcome.valid, false);
  assert.equal(outcome.checks.selected_current_product, false);
});

test('retains successful inference evidence when a later workflow stage fails', () => {
  const output = recordedOutput('evidence-investigation');
  output.task.status = 'failed';
  delete output.task.result;
  output.result = null;
  const outcome = validateSampleOutput(output);
  assert.equal(outcome.valid, false);
  assert.equal(outcome.checks.configured_model_receipt, true);
  assert.equal(outcome.checks.selected_current_product, false);
});

test('rejects model fixtures, failed calls, wrong-run receipts and unavailable receipts', () => {
  const variants = [
    (attempt) => {
      attempt.receipt.synthetic = true;
    },
    (attempt) => {
      attempt.status = 'failed';
    },
    (attempt) => {
      attempt.accepted = false;
    },
    (attempt) => {
      attempt.run_id = randomUUID();
    },
    (attempt) => {
      attempt.details.requested_route.provider = 'injected';
    },
    (attempt) => {
      attempt.receipt.http_status = 500;
    },
    (attempt) => {
      attempt.receipt.response_status = 'length';
    },
  ];
  for (const alter of variants) {
    const output = recordedOutput('evidence-investigation');
    alter(output.execution.model_attempts[0]);
    const outcome = validateSampleOutput(output);
    assert.equal(outcome.valid, false);
    assert.equal(outcome.checks.configured_model_receipt, false);
  }
  const output = recordedOutput('evidence-investigation');
  output.execution.model_attempts = [];
  assert.equal(validateSampleOutput(output).valid, false);
});

test('accepts provider receipts with genuinely unknown optional finish/HTTP metadata', () => {
  const output = recordedOutput('evidence-investigation');
  delete output.execution.model_attempts[0].receipt.http_status;
  delete output.execution.model_attempts[0].receipt.response_status;
  assert.equal(validateSampleOutput(output).valid, true);
  output.execution.model_attempts[0].receipt.response_status = null;
  assert.equal(validateSampleOutput(output).valid, true);
});

test('accepts a labeled cached model reply but rejects fabricated fresh usage or missing provenance', () => {
  const output = recordedOutput('evidence-investigation');
  const attempt = output.execution.model_attempts[0];
  const original = structuredClone(attempt.receipt);
  attempt.receipt = {
    response_model: original.response_model,
    response_id: null,
    input_tokens: null,
    output_tokens: null,
    response_status: 'cache_hit',
    cache: {
      version: 1,
      key_sha256: 'a'.repeat(64),
      recorded_at: new Date().toISOString(),
      original_route: { provider: 'nvidia' },
      original_receipt: original,
    },
  };
  assert.equal(validateSampleOutput(output).valid, true);
  attempt.receipt.input_tokens = 123;
  assert.equal(validateSampleOutput(output).valid, false);
  attempt.receipt.input_tokens = null;
  delete attempt.receipt.cache.original_receipt.response_id;
  assert.equal(validateSampleOutput(output).valid, false);
});

test('rejects self-review and a review naming a different exact artifact hash', () => {
  for (const alter of [
    (check) => {
      check.reviewer_assignment_id = check.producer_assignment_id;
    },
    (check) => {
      check.artifact.sha256 = '0'.repeat(64);
    },
    (check) => {
      check.reviewer_revision += 1;
    },
  ]) {
    const output = recordedOutput('evidence-investigation');
    alter(output.task.result.review.checks[0]);
    const outcome = validateSampleOutput(output);
    assert.equal(outcome.valid, false);
    assert.equal(outcome.checks.independent_review, false);
  }
});

test('rejects stale products, altered content and incomplete retained reference closure', () => {
  const stale = recordedOutput('evidence-investigation');
  stale.task.artifacts.find(
    ({ artifact }) => artifact.id === stale.result.work_products[0].id,
  ).current = false;
  assert.equal(validateSampleOutput(stale).valid, false);
  const tampered = recordedOutput('evidence-investigation');
  tampered.artifacts[0].content.raw = 'altered';
  assert.equal(validateSampleOutput(tampered).checks.artifact_integrity, false);
  const missing = recordedOutput('evidence-investigation');
  missing.artifacts.shift();
  assert.equal(validateSampleOutput(missing).valid, false);
});

test('requires accounting component reviews rather than a blanket supported flag', () => {
  const output = recordedOutput('damage-account');
  output.task.result.review.checks.shift();
  assert.equal(validateSampleOutput(output).checks.independent_review, false);
});

test('rejects achieved intervention claims and non-synthetic source provenance', () => {
  const output = recordedOutput('damage-reduction');
  output.artifacts.find(
    ({ kind }) => kind === 'reduction.conditional-plan',
  ).content.achieved_reduction = true;
  assert.equal(validateSampleOutput(output).checks.synthetic_evidence, false);
  const evidence = recordedOutput('evidence-investigation');
  evidence.artifacts[0].evidence_origin = 'external_source';
  assert.equal(validateSampleOutput(evidence).valid, false);
});

test('returns structured failure for missing or malformed output', () => {
  for (const value of [undefined, null, {}, { task: {} }])
    assert.equal(validateSampleOutput(value).valid, false);
});
