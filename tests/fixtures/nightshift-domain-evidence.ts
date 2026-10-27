import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createExecutionRegistry } from '../../app/composition.js';
import { canonicalJson, contractHash } from '../../app/contracts/json.js';
import { damageAccountSchema } from '../../app/contracts/damage-account.js';
import type {
  Artifact,
  ArtifactRef,
  JsonValue,
} from '../../app/contracts/artifacts.js';
import type { ArtifactReviewCheck } from '../../app/contracts/manager.js';
import {
  assignmentSchema,
  taskRecordSchema,
  taskRequestSchema,
  type Assignment,
  type TaskRecord,
} from '../../app/contracts/tasks.js';
import type { ReleaseBindings } from '../../app/release/nightshift-release.js';
import { TaskStore } from '../../app/tasks/store.js';
import { renderFinalAnswer } from '../../app/orchestration/final-answer.js';
import { createFixtureCapture } from '../../app/capabilities/pm25/fixtures.js';
import {
  analyzePm25,
  independentlyCheckPm25,
} from '../../app/capabilities/pm25/methods.js';
import { createSyntheticDamageImport } from '../../app/capabilities/damage-appraisal/fixtures.js';
import { normalizeDamageInputs } from '../../app/capabilities/damage-appraisal/inputs.js';
import {
  assembleDamageAccount,
  compileDamageAccount,
  DAMAGE_COMPONENT_KINDS,
} from '../../app/capabilities/damage-appraisal/methods.js';
import { independentlyCheckDamageAccount } from '../../app/capabilities/damage-appraisal/checker.js';
import {
  syntheticResidualImport,
  SYNTHETIC_REDUCTION_TARGET,
} from '../../app/capabilities/damage-reduction-planning/fixtures.js';
import { syntheticReductionCandidate } from '../../app/capabilities/damage-reduction-planning/planning-fixtures.js';
import { createReductionSelection } from '../../app/capabilities/damage-reduction-planning/inputs.js';
import { assessReduction } from '../../app/capabilities/damage-reduction-planning/methods.js';
import { independentlyCheckReduction } from '../../app/capabilities/damage-reduction-planning/checker.js';
import { draftConditionalPlan } from '../../app/capabilities/damage-reduction-planning/planning.js';
import { independentlyCheckConditionalPlan } from '../../app/capabilities/damage-reduction-planning/planning-checker.js';

type Workflow = 'pm25' | 'damage-accounting' | 'damage-reduction';
const identity = {
  principal: 'release-test-only',
  workspace: 'release-test-only',
};
const at = '2026-10-28T00:00:00Z';
const exact = ({ id, version, sha256 }: ArtifactRef): ArtifactRef => ({
  id,
  version,
  sha256,
});
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const registry = createExecutionRegistry({ mode: 'live' });
let template: TaskRecord | undefined;

function emptyTask(): TaskRecord {
  if (!template) {
    const directory = mkdtempSync(join(tmpdir(), 'haze-domain-fixture-'));
    const local = relative(resolve(tmpdir()), resolve(directory));
    if (!local || local.startsWith('..'))
      throw new Error('Unsafe fixture cleanup.');
    const store = new TaskStore(directory);
    try {
      template = store.admit(
        taskRequestSchema.parse({
          schema_version: 'haze.task.request.v3',
          objective: 'Unit-test domain evidence only.',
        }),
        identity,
        'fixture',
        { mode: 'live' },
      ).task;
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const task = structuredClone(template);
  task.id = randomUUID();
  task.current_run_id = randomUUID();
  task.status = 'completed';
  task.assignments = [];
  task.artifacts = [];
  delete task.manager;
  task.runs = task.runs.map((run) => ({
    ...run,
    id: task.current_run_id,
    task_id: task.id,
    status: 'completed',
  }));
  task.permissions.tools = [
    ...new Set(
      [...registry.definitions.values()].flatMap(
        (definition) => definition.tools,
      ),
    ),
  ];
  return task;
}

/**
 * Deliberately fabricated LIVE-SHAPED bytes for validator unit tests only.
 * These never execute remote models/sources and must never be published as
 * release evidence. Numerical artifacts and peer reviews use real kernels.
 */
export function domainDemonstrationFixture(
  workflow: Workflow,
  bindings: ReleaseBindings,
  exactModel: string,
) {
  const task = emptyTask();
  const artifacts: Artifact[] = [];
  const checks: ArtifactReviewCheck[] = [];
  const attempts: JsonValue[] = [];
  function assignment(definitionId: string): Assignment {
    const definition = registry.definitions.get(definitionId);
    const role = definition?.agent ?? 'Manager';
    const capability = definition?.capability ?? 'core.manager';
    const result = assignmentSchema.parse({
      id: randomUUID(),
      task_id: task.id,
      run_id: task.current_run_id,
      role,
      definition_id: definitionId,
      definition_version: definition?.version ?? '4',
      agent_version: registry.agents.get(role)!.version,
      capability,
      capability_version:
        registry.capabilities.get(capability)?.card.version ?? '1',
      revision: 1,
      objective_revision: task.objective_revision,
      generation: task.generation,
      acknowledged_revision: 1,
      brief: 'Fabricated validator fixture only.',
      dependencies: [],
      inputs: [],
      tools: definition?.tools ?? [],
      status: 'completed',
      deadline: task.limits.deadline,
      max_model_calls: 1,
      usage: { model_calls: 0, tool_calls: 0 },
      outputs: [],
      assumptions: [],
      gaps: [],
      support: 'supported',
      usability: 'usable',
    });
    task.assignments.push(result);
    return result;
  }
  function save(
    kind: string,
    content: unknown,
    producer?: Assignment,
    dependencies: ArtifactRef[] = [],
  ): Artifact {
    const artifact: Artifact = {
      schema_version: 'haze.artifact.v3',
      id: randomUUID(),
      version: 1,
      sha256: contractHash(content),
      identity,
      kind,
      created_at: at,
      producer: producer
        ? { kind: 'assignment', id: producer.id }
        : { kind: 'user', id: 'release-test-only' },
      ...(producer
        ? {
            task_id: task.id,
            run_id: task.current_run_id,
            assignment_id: producer.id,
            assignment_revision: producer.revision,
            objective_revision: task.objective_revision,
            generation: task.generation,
          }
        : {
            media_type: 'application/json' as const,
            original_byte_sha256: digest(
              typeof content === 'string' ? content : JSON.stringify(content),
            ),
          }),
      evidence_origin: producer ? 'derived' : 'user_supplied',
      dependencies,
      required_tools: [],
      content: content as Artifact['content'],
    };
    artifacts.push(artifact);
    producer?.outputs.push(exact(artifact));
    task.artifacts.push({
      artifact: exact(artifact),
      task_id: task.id,
      objective_revision: task.objective_revision,
      current: true,
      reason: 'Unit-test fixture applicability.',
      checked_by: 'User',
      checked_at: at,
    });
    return artifact;
  }
  function support(product: Artifact, review: Artifact) {
    checks.push({
      artifact: exact(product),
      producer_assignment_id: product.assignment_id!,
      producer_revision: product.assignment_revision!,
      reviewer_assignment_id: review.assignment_id!,
      reviewer_revision: review.assignment_revision!,
      review_artifact: exact(review),
      verdict: 'supported',
      limitations: ['Unit-test fixture only.'],
    });
  }
  const manager = assignment('core.manager.coordinator');
  manager.usage.model_calls = 1;
  const route = bindings.routes.Manager!;
  attempts.push({
    id: randomUUID(),
    task_id: task.id,
    run_id: task.current_run_id,
    assignment_id: manager.id,
    assignment_revision: manager.revision,
    objective_revision: task.objective_revision,
    generation: task.generation,
    kind: 'model',
    status: 'completed',
    accepted: true,
    details: {
      requested_route: {
        route_id: route.route_id,
        provider: route.provider,
        requested_model: route.requested_model,
      },
    },
    output: '{"unit_test_only":true}',
    receipt: {
      response_id: `fabricated-test-${randomUUID()}`,
      response_model: exactModel,
      input_tokens: 100,
      output_tokens: 20,
      http_status: 200,
      response_status: 'stop',
    },
  });
  let products: Artifact[];
  let sources: Artifact[];
  if (workflow === 'pm25') {
    const scope = {
      location: 'Fixture Town',
      period: { start: '2026-10-01T00:00:00Z', end: '2026-10-01T03:00:00Z' },
    };
    task.original_request.scope = scope;
    const content = createFixtureCapture(scope);
    content.mode = 'live';
    content.evidence_origin = 'modeled';
    content.selection.query =
      'SELECT town, valid_utc, kind, issued_utc, pm25, source, ingested_utc, lat, lon FROM test_only';
    content.limitations = ['Fabricated source bytes for validator tests only.'];
    const retriever = assignment('pm25.retrieve');
    const capture = save('pm25.capture', content, retriever);
    capture.evidence_origin = 'external_source';
    const producer = assignment('pm25.analyze');
    const analysis = save(
      'pm25.analysis',
      analyzePm25(content, scope),
      producer,
      [exact(capture)],
    );
    const critic = assignment('pm25.check');
    const checked = independentlyCheckPm25(content, analysis.content, scope);
    const review = save(
      'review',
      {
        ...checked,
        verdict: checked.valid ? 'supported' : 'rejected',
        reviewer_role: 'EvidenceCritic',
        reviewed_artifacts: [exact(capture), exact(analysis)],
      },
      critic,
      [exact(capture), exact(analysis)],
    );
    support(analysis, review);
    attempts.push({
      id: randomUUID(),
      task_id: task.id,
      run_id: task.current_run_id,
      assignment_id: retriever.id,
      kind: 'tool',
      status: 'completed',
      accepted: true,
      details: { tool: content.source },
    });
    products = [analysis];
    sources = [capture];
  } else if (workflow === 'damage-accounting') {
    const supplied = createSyntheticDamageImport();
    for (const effect of supplied.effects) effect.origin = 'imported';
    for (const coverage of supplied.coverage) coverage.origin = 'imported';
    const original = save('source.import', JSON.stringify(supplied));
    task.original_request.context_refs = [exact(original)];
    const inputs = normalizeDamageInputs([original]);
    const components = compileDamageAccount(inputs);
    const collector = assignment('damage.collect'),
      scoper = assignment('damage.scope'),
      compiler = assignment('damage.compile');
    const refs = Object.fromEntries(
      DAMAGE_COMPONENT_KINDS.map((kind) => {
        const producer =
          kind === 'damage.inputs'
            ? collector
            : kind === 'damage.scope'
              ? scoper
              : compiler;
        return [
          kind,
          exact(save(kind, components[kind], producer, [exact(original)])),
        ];
      }),
    ) as Parameters<typeof assembleDamageAccount>[2];
    const account = save(
      'damage.account',
      assembleDamageAccount(inputs, components, refs),
      assignment('damage.assemble'),
      Object.values(refs),
    );
    const critic = assignment('damage.check');
    const checked = independentlyCheckDamageAccount(
      inputs,
      components,
      damageAccountSchema.parse(account.content),
      refs,
    );
    const review = save(
      'damage.review',
      {
        schema_version: 'haze.damage.review.v1',
        verdict: checked.valid ? 'supported' : 'rejected',
        reviewed_artifacts: [...Object.values(refs), exact(account)],
        checks: checked.checks,
        findings: checked.findings,
        limitations: checked.limitations,
        applicability: checked.applicability,
        reviewer: { assignment_id: critic.id, revision: critic.revision },
      },
      critic,
      [exact(account)],
    );
    support(account, review);
    products = [account];
    sources = [original];
  } else {
    const residuals = syntheticResidualImport('1000', '880');
    residuals.origin = 'supplied';
    const original = save('source.import', JSON.stringify(residuals));
    const selectionValue = createReductionSelection(
      structuredClone(SYNTHETIC_REDUCTION_TARGET),
      [
        {
          artifact: exact(original),
          row_ids: residuals.records.map((row) => row.row_id),
        },
      ],
    );
    const request = {
      schema_version: 'haze.reduction.preview-request.v1' as const,
      selection: selectionValue,
      candidate: syntheticReductionCandidate(),
    };
    task.original_request.scope = request;
    task.original_request.context_refs = [exact(original)];
    const selection = save(
      'reduction.input-selection',
      selectionValue,
      assignment('reduction.select'),
      [exact(original)],
    );
    const producer = assignment('reduction.assess');
    const assessmentValue = assessReduction(
      selectionValue,
      [original],
      exact(selection),
    );
    const assessment = save('reduction.assessment', assessmentValue, producer, [
      exact(selection),
    ]);
    const critic = assignment('reduction.check');
    const arithmetic = save(
      'reduction.review',
      independentlyCheckReduction(
        selectionValue,
        [original],
        exact(selection),
        assessmentValue,
        exact(assessment),
        { assignment_id: critic.id, revision: critic.revision },
        producer.id,
      ),
      critic,
      [exact(selection), exact(assessment)],
    );
    support(selection, arithmetic);
    support(assessment, arithmetic);
    const input = {
      request,
      selection,
      assessment,
      arithmeticReview: arithmetic,
      sources: [original],
    };
    const plan = save(
      'reduction.conditional-plan',
      draftConditionalPlan(input),
      assignment('reduction.plan'),
      [exact(selection), exact(assessment), exact(arithmetic), exact(original)],
    );
    const planCritic = assignment('reduction.plan-check');
    const review = save(
      'reduction.plan-review',
      independentlyCheckConditionalPlan({
        ...input,
        plan,
        reviewer: {
          assignment_id: planCritic.id,
          revision: planCritic.revision,
        },
      }),
      planCritic,
      [exact(plan)],
    );
    support(plan, review);
    // Deliberately exercise a reviewed assessment in the selected plan's closure.
    products = [plan];
    sources = [original];
  }
  const citations = sources.map((source, index) => ({
    id: `${source.producer.kind === 'user' ? 'S' : 'E'}${index + 1}`,
    artifact: exact(source),
    label: source.kind,
  }));
  const read = (ref: ArtifactRef) =>
    artifacts.find(
      (artifact) =>
        artifact.id === ref.id &&
        artifact.version === ref.version &&
        artifact.sha256 === ref.sha256,
    )!;
  const rendered = renderFinalAnswer({
    task,
    registry,
    selected: products.map(exact),
    closure: artifacts,
    reviews: checks,
    citations,
    mode: 'live',
    read,
    store: {
      read: () => task,
      artifact: (id, _identity, ref) =>
        ref ? read(ref) : artifacts.find((artifact) => artifact.id === id)!,
      world: { lookup: () => [], activeHolds: () => [] },
    },
  });
  task.result = {
    schema_version: 'haze.task.result.v3',
    answer: rendered!.answer,
    completion: 'full',
    work_products: products.map(exact),
    sources: citations,
    covered_scope: task.original_request.scope ?? {},
    uncertainty: ['Fabricated validator fixture; never release evidence.'],
    review: {
      status: 'supported',
      scope: 'Exact unit-test products.',
      limitations: [],
      checks,
    },
    currency: 'current',
    next_requirements: [],
    provenance: {
      mode: 'live',
      model_calls: 1,
      tool_calls: workflow === 'pm25' ? 1 : 0,
      capabilities: [],
      receipts: attempts,
    },
  };
  task.usage.model_calls = 1;
  task.usage.tool_calls = workflow === 'pm25' ? 1 : 0;
  const validated = taskRecordSchema.parse(task);
  const report = {
    bindings_sha256: digest(canonicalJson(bindings)),
    mode: 'live',
    passed: true,
    restart: true,
    attempts,
    ...(workflow === 'pm25'
      ? { investigation: { task: validated, artifacts } }
      : workflow === 'damage-reduction'
        ? { capture: { task: validated, artifacts } }
        : { task: validated, artifacts }),
    restart_task: structuredClone(validated),
  };
  const bytes = JSON.stringify(report);
  return {
    workflow,
    task_id: task.id,
    status: 'completed' as const,
    completion: 'full' as const,
    review_status: 'supported' as const,
    data_origin:
      workflow === 'pm25'
        ? ('external_source' as const)
        : ('supplied' as const),
    answer_rendered: true as const,
    restart_readback: true as const,
    model_calls_by_role: {
      Manager: 1,
      HazeOps: 0,
      WorkerShield: 0,
      EvidenceCritic: 0,
      DamageAccountant: 0,
    },
    artifacts: products.map((product) => product.sha256),
    retained_report: { bytes, sha256: digest(bytes) },
  };
}
