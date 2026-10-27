import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  artifactSchema,
  type Artifact,
  type ArtifactRef,
} from '../contracts/artifacts.js';
import { agentRoleSchema } from '../contracts/capabilities.js';
import {
  canonicalJson,
  contractHash,
  parseContractJson,
} from '../contracts/json.js';
import { taskRecordSchema, type TaskRecord } from '../contracts/tasks.js';
import {
  damageAccountSchema,
  damageInputsSchema,
  damageComponentSchemas,
  type DamageComponents,
  type DamageComponentKind,
} from '../contracts/damage-account.js';
import {
  reductionAssessmentSchema,
  reductionInputSelectionSchema,
} from '../contracts/damage-reduction.js';
import { conditionalReductionPlanSchema } from '../contracts/damage-reduction-plan.js';
import {
  captureSchema,
  pm25AnalysisSchema,
  independentlyCheckPm25,
} from '../capabilities/pm25/methods.js';
import { independentlyCheckDamageAccount } from '../capabilities/damage-appraisal/checker.js';
import { independentlyCheckReduction } from '../capabilities/damage-reduction-planning/checker.js';
import { independentlyCheckConditionalPlan } from '../capabilities/damage-reduction-planning/planning-checker.js';
import { resolveReductionPreviewRequest } from '../capabilities/damage-reduction-planning/request.js';
import { pm25FinalRenderer } from '../capabilities/pm25/final-answer.js';
import { damageAccountFinalRenderer } from '../capabilities/damage-appraisal/final-answer.js';
import { reductionFinalRenderer } from '../capabilities/damage-reduction-planning/final-answer.js';
import {
  ExecutionRegistry,
  type ReadonlyEvidenceStore,
} from '../orchestration/ports.js';
import { renderFinalAnswer } from '../orchestration/final-answer.js';

const MAX_REPORT_BYTES = 4_194_304;
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
/** Retain the report itself, rather than assertions or hashes of missing files. */
export const retainedDomainEvidenceSchema = z.strictObject({
  bytes: z.string().min(1).max(MAX_REPORT_BYTES),
  sha256,
});
type Workflow = 'pm25' | 'damage-accounting' | 'damage-reduction';
interface Demonstration {
  task_id: string;
  model_calls_by_role: Partial<Record<z.infer<typeof agentRoleSchema>, number>>;
  artifacts: string[];
  retained_report: z.infer<typeof retainedDomainEvidenceSchema>;
}
interface Bindings {
  routes: Partial<
    Record<
      string,
      {
        route_id: string;
        provider: string;
        requested_model: string | null;
      }
    >
  >;
}
const refKey = (ref: ArtifactRef) => `${ref.id}:${ref.version}:${ref.sha256}`;
const expectedProducts: Record<
  string,
  { producer: string; reviewer: string; capability: string }
> = {
  'pm25.analysis': {
    producer: 'pm25.analyze',
    reviewer: 'pm25.check',
    capability: 'pm25-evidence-summary',
  },
  'damage.account': {
    producer: 'damage.assemble',
    reviewer: 'damage.check',
    capability: 'damage-appraisal',
  },
  'reduction.assessment': {
    producer: 'reduction.assess',
    reviewer: 'reduction.check',
    capability: 'damage-reduction-planning',
  },
  'reduction.conditional-plan': {
    producer: 'reduction.plan',
    reviewer: 'reduction.plan-check',
    capability: 'damage-reduction-planning',
  },
};
const fail = (message: string): never => {
  throw new Error(`Retained domain demonstration: ${message}`);
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail('expected a retained object.');
const modelAttemptSchema = z
  .object({
    id: z.uuid(),
    task_id: z.uuid(),
    run_id: z.uuid(),
    assignment_id: z.uuid(),
    assignment_revision: z.number().int().positive(),
    objective_revision: z.number().int().positive(),
    kind: z.literal('model'),
    status: z.enum(['started', 'completed', 'failed', 'unknown']),
    accepted: z.boolean(),
    details: z
      .object({
        requested_route: z
          .object({
            route_id: z.string(),
            provider: z.string(),
            requested_model: z.string().nullable(),
          })
          .passthrough(),
      })
      .passthrough(),
    receipt: z.unknown().optional(),
  })
  .passthrough();
const genuineReceiptSchema = z
  .object({
    response_id: z.string().trim().min(1),
    response_model: z.string().trim().min(1),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    http_status: z.literal(200),
    response_status: z.literal('stop'),
    synthetic: z.never().optional(),
  })
  .passthrough();

/** Verify one retained, current, complete demonstration against its actual bytes. */
export function validateDomainDemonstration(
  demonstration: Demonstration,
  workflow: Workflow,
  bindings: Bindings,
  exactModel: string,
): void {
  const retained = retainedDomainEvidenceSchema.parse(
    demonstration.retained_report,
  );
  if (digest(retained.bytes) !== retained.sha256)
    fail('report bytes do not match their hash.');
  const report = object(parseContractJson(retained.bytes, MAX_REPORT_BYTES));
  if (report.bindings_sha256 !== digest(canonicalJson(bindings)))
    fail('report was not captured under the current frozen release bindings.');
  if (
    report.mode !== 'live' ||
    report.passed !== true ||
    report.restart !== true
  )
    fail('a completed live report and actual restart readback are required.');
  const capture =
    workflow === 'pm25'
      ? object(report.investigation)
      : report.capture
        ? object(report.capture)
        : report;
  const task = taskRecordSchema.parse(capture.task);
  const restartTask = taskRecordSchema.parse(report.restart_task);
  const result = task.result ?? fail('saved result is missing.');
  if (
    task.id !== demonstration.task_id ||
    task.mode !== 'live' ||
    task.status !== 'completed' ||
    result.completion !== 'full' ||
    result.currency !== 'current' ||
    result.review.status !== 'supported' ||
    result.provenance.mode !== 'live'
  )
    fail(
      'task identity, live completion, current result or independent review is missing.',
    );
  if (
    canonicalJson({
      id: task.id,
      identity: task.identity,
      run: task.current_run_id,
      assignments: task.assignments,
      result: task.result,
    }) !==
    canonicalJson({
      id: restartTask.id,
      identity: restartTask.identity,
      run: restartTask.current_run_id,
      assignments: restartTask.assignments,
      result: restartTask.result,
    })
  )
    fail(
      'restart readback changed task identity, assignments or saved result.',
    );
  const artifacts = z
    .array(artifactSchema)
    .min(1)
    .max(512)
    .parse(capture.artifacts);
  const indexed = new Map(
    artifacts.map((artifact) => [refKey(artifact), artifact]),
  );
  if (indexed.size !== artifacts.length)
    fail('duplicate retained artifact identities.');
  for (const artifact of artifacts) {
    if (contractHash(artifact.content, 8_388_608) !== artifact.sha256)
      fail('retained artifact content does not match its hash.');
    if (
      artifact.identity.principal !== task.identity.principal ||
      artifact.identity.workspace !== task.identity.workspace
    )
      fail('retained artifact is outside the demonstrated identity.');
  }
  if (
    !demonstration.artifacts.length ||
    demonstration.artifacts.some(
      (hash) => !artifacts.some((artifact) => artifact.sha256 === hash),
    )
  )
    fail('a declared artifact hash has no retained bytes.');
  const load = (ref: ArtifactRef): Artifact => {
    const artifact = indexed.get(refKey(ref));
    if (!artifact) return fail('an exact referenced artifact is not retained.');
    if (
      !task.artifacts.some(
        (entry) =>
          entry.current &&
          entry.objective_revision === task.objective_revision &&
          refKey(entry.artifact) === refKey(artifact),
      )
    )
      fail('a referenced artifact is stale or inapplicable.');
    if (
      artifact.required_tools.some(
        (tool) => !task.permissions.tools.includes(tool),
      )
    )
      fail('a dependency requires a revoked tool.');
    if (artifact.producer.kind === 'assignment') {
      const producer = task.assignments.find(
        (assignment) => assignment.id === artifact.producer.id,
      );
      if (
        !producer ||
        producer.task_id !== task.id ||
        producer.run_id !== task.current_run_id ||
        producer.status !== 'completed' ||
        ['stale', 'rejected'].includes(producer.usability) ||
        producer.objective_revision !== task.objective_revision ||
        producer.revision !== artifact.assignment_revision ||
        producer.id !== artifact.assignment_id ||
        artifact.run_id !== task.current_run_id ||
        artifact.objective_revision !== task.objective_revision ||
        !producer.outputs.some((output) => refKey(output) === refKey(artifact))
      )
        fail('a producer revision or output is not current and completed.');
    }
    return artifact;
  };
  const closure = new Map<string, Artifact>();
  const visiting = new Set<string>();
  const visit = (ref: ArtifactRef) => {
    const key = refKey(ref);
    if (visiting.has(key)) fail('artifact dependency cycle.');
    if (closure.has(key)) return;
    if (closure.size >= 256) fail('artifact dependency bound exceeded.');
    visiting.add(key);
    const artifact = load(ref);
    for (const dependency of artifact.dependencies) visit(dependency);
    visiting.delete(key);
    closure.set(key, artifact);
  };
  for (const ref of result.work_products) visit(ref);
  for (const source of result.sources) visit(source.artifact);
  // Preserve the runtime's selected dependency order before adding the separate
  // review proof artifacts used only by the release validator below.
  const renderedClosure = [...closure.values()];
  const reviewFor = (artifact: Artifact): Artifact => {
    const expected =
      expectedProducts[artifact.kind] ??
      fail('unregistered quantitative product kind.');
    const producer = task.assignments.find(
      (entry) => entry.id === artifact.assignment_id,
    );
    if (
      artifact.producer.kind !== 'assignment' ||
      !producer ||
      producer.definition_id !== expected.producer ||
      producer.capability !== expected.capability
    )
      fail('quantitative output does not come from its registered producer.');
    const check = result.review.checks?.find(
      (entry) => refKey(entry.artifact) === refKey(artifact),
    );
    if (
      !check ||
      check.verdict !== 'supported' ||
      !check.review_artifact ||
      check.producer_assignment_id !== artifact.assignment_id ||
      check.producer_revision !== artifact.assignment_revision ||
      check.reviewer_assignment_id === check.producer_assignment_id
    )
      return fail('an independent exact supported review check is missing.');
    visit(check.review_artifact);
    const review = load(check.review_artifact);
    const reviewer =
      task.assignments.find(
        (entry) => entry.id === check.reviewer_assignment_id,
      ) ?? fail('reviewer assignment is missing.');
    const content = object(review.content);
    if (
      reviewer.role !== 'EvidenceCritic' ||
      reviewer.revision !== check.reviewer_revision ||
      reviewer.definition_id !== expected.reviewer ||
      reviewer.capability !== expected.capability ||
      review.producer.kind !== 'assignment' ||
      review.producer.id !== reviewer.id ||
      review.assignment_id !== reviewer.id ||
      review.assignment_revision !== reviewer.revision ||
      content.verdict !== 'supported' ||
      !Array.isArray(content.reviewed_artifacts) ||
      !content.reviewed_artifacts.some(
        (ref) => refKey(object(ref) as ArtifactRef) === refKey(artifact),
      )
    )
      fail(
        'the retained review does not support the current product and reviewer.',
      );
    if (content.reviewer) {
      const declared = object(content.reviewer);
      if (
        declared.assignment_id !== reviewer.id ||
        declared.revision !== reviewer.revision
      )
        fail('review content names a different reviewer revision.');
    }
    return review;
  };
  const one = (kind: string): Artifact => {
    const matches = result.work_products
      .map(load)
      .filter((artifact) => artifact.kind === kind);
    if (matches.length !== 1)
      return fail(`exactly one selected ${kind} product is required.`);
    reviewFor(matches[0]!);
    return matches[0]!;
  };
  verifyModelCalls(report, task, demonstration, bindings, exactModel);
  if (workflow === 'pm25') {
    const product = one('pm25.analysis');
    const analysis = pm25AnalysisSchema.parse(product.content);
    const captures = product.dependencies
      .map(load)
      .filter((artifact) => artifact.kind === 'pm25.capture');
    if (captures.length !== 1) fail('the PM2.5 capture is missing.');
    const source = captures[0]!;
    const captureContent = captureSchema.parse(source.content);
    const sourceExecuted = z
      .array(z.unknown())
      .parse(report.attempts)
      .some((value) => {
        const attempt = object(value);
        const details = object(attempt.details);
        return (
          attempt.task_id === task.id &&
          attempt.run_id === task.current_run_id &&
          attempt.assignment_id === source.assignment_id &&
          attempt.kind === 'tool' &&
          attempt.status === 'completed' &&
          attempt.accepted === true &&
          details.tool === captureContent.source
        );
      });
    if (
      !sourceExecuted ||
      source.evidence_origin !== 'external_source' ||
      captureContent.mode !== 'live' ||
      captureContent.evidence_origin === 'synthetic_fixture' ||
      !captureContent.rows.length ||
      !/^\s*SELECT\b/iu.test(captureContent.selection.query) ||
      !independentlyCheckPm25(captureContent, analysis, analysis.scope).valid
    )
      fail(
        'PM2.5 requires genuine retained Zetaris query/raw rows and a reconstructed analysis.',
      );
    if (!result.answer.startsWith('PM2.5 evidence:'))
      fail('the saved PM2.5 answer was not rendered.');
  } else if (workflow === 'damage-accounting') {
    const product = one('damage.account');
    const account = damageAccountSchema.parse(product.content);
    const components = Object.fromEntries(
      account.component_refs.map(({ kind, artifact }) => {
        const loaded = load(artifact);
        if (loaded.kind !== kind) fail('account component kind mismatch.');
        return [kind, damageComponentSchemas[kind].parse(loaded.content)];
      }),
    ) as DamageComponents;
    const inputs = damageInputsSchema.parse(components['damage.inputs']);
    if (
      account.status !== 'complete_for_declared_imported_scope' ||
      account.evidence_origin !== 'imported' ||
      !account.physical_totals.length ||
      !account.financing_totals.length ||
      !account.welfare_totals.length ||
      [...inputs.effects, ...inputs.unit_values, ...inputs.incidence].some(
        (entry) => 'origin' in entry && entry.origin === 'synthetic',
      ) ||
      !independentlyCheckDamageAccount(
        inputs,
        components,
        account,
        Object.fromEntries(
          account.component_refs.map((entry) => [entry.kind, entry.artifact]),
        ) as Record<DamageComponentKind, ArtifactRef>,
      ).valid
    )
      fail(
        'damage accounting requires complete non-synthetic imported outcomes and independent reconstruction.',
      );
    for (const ref of inputs.source_refs) requireOriginal(load(ref));
    if (
      !inputs.source_refs.length ||
      !result.answer.startsWith('Damage account ')
    )
      fail('the supplied accounting originals or rendered answer are missing.');
  } else {
    const planArtifact = one('reduction.conditional-plan');
    const plan = conditionalReductionPlanSchema.parse(planArtifact.content);
    if (!closure.has(refKey(plan.assessment_ref)))
      fail('the selected plan does not retain its assessment dependency.');
    const product = load(plan.assessment_ref);
    if (product.kind !== 'reduction.assessment')
      fail('the plan assessment reference has the wrong kind.');
    const assessment = reductionAssessmentSchema.parse(product.content);
    const selectionArtifact = load(assessment.selection_ref);
    const selection = reductionInputSelectionSchema.parse(
      selectionArtifact.content,
    );
    const review = reviewFor(product);
    const planReview = reviewFor(planArtifact);
    const scope =
      task.corrections.findLast((correction) => correction.scope !== undefined)
        ?.scope ?? task.original_request.scope;
    const request = resolveReductionPreviewRequest(scope, artifacts);
    const freshPlanReview = independentlyCheckConditionalPlan({
      request,
      selection: selectionArtifact,
      assessment: product,
      arithmeticReview: review,
      sources: artifacts,
      plan: planArtifact,
      reviewer: {
        assignment_id: planReview.assignment_id!,
        revision: planReview.assignment_revision!,
      },
    });
    if (
      assessment.status !== 'supported' ||
      assessment.origin !== 'supplied' ||
      plan.origin !== 'supplied' ||
      plan.assessment_status !== 'supported' ||
      refKey(plan.arithmetic_review_ref) !== refKey(review) ||
      freshPlanReview.verdict !== 'supported' ||
      refKey(plan.assessment_ref) !== refKey(product) ||
      refKey(plan.selection_ref) !== refKey(selectionArtifact) ||
      independentlyCheckReduction(
        selection,
        artifacts,
        assessment.selection_ref,
        assessment,
        { id: product.id, version: product.version, sha256: product.sha256 },
        {
          assignment_id: review.assignment_id!,
          revision: review.assignment_revision!,
        },
        product.assignment_id,
      ).verdict !== 'supported'
    )
      fail(
        'planning requires a current supplied residual comparison and independently reviewed conditional plan.',
      );
    for (const source of selection.sources)
      requireOriginal(load(source.artifact));
    if (
      !result.answer.includes('Conditional plan:') ||
      !result.answer.includes('Reduction assessment:')
    )
      fail('the saved planning answer was not rendered.');
  }
  const assertIdentity = (identity: TaskRecord['identity']) => {
    if (
      identity.principal !== task.identity.principal ||
      identity.workspace !== task.identity.workspace
    )
      fail('renderer inspection is outside the demonstrated identity.');
  };
  const store: ReadonlyEvidenceStore = {
    read: (id, identity) => {
      assertIdentity(identity);
      if (id !== task.id)
        fail('renderer inspection requires an unretained task.');
      return task;
    },
    artifact: (id, identity, ref) => {
      assertIdentity(identity);
      const exact =
        ref ??
        task.artifacts.find(
          (entry) => entry.current && entry.artifact.id === id,
        )?.artifact;
      if (!exact || exact.id !== id)
        return fail('renderer inspection requires an unretained artifact.');
      return load(exact);
    },
    // The retained demonstration's factual authority is its current imported
    // artifacts and independent reviews. No World Model acceptance is inferred.
    world: { lookup: () => [], activeHolds: () => [] },
  };
  const registry = new ExecutionRegistry()
    .registerFinalRenderer('pm25-evidence-summary', pm25FinalRenderer)
    .registerFinalRenderer('damage-appraisal', damageAccountFinalRenderer)
    .registerFinalRenderer('damage-reduction-planning', reductionFinalRenderer);
  const rendered = renderFinalAnswer({
    task,
    registry,
    selected: [
      ...result.work_products,
      ...result.sources.map((entry) => entry.artifact),
    ],
    closure: renderedClosure,
    reviews: result.review.checks ?? [],
    citations: result.sources,
    store,
    mode: 'live',
    read: load,
  });
  if (!rendered || rendered.answer !== result.answer)
    fail(
      'the saved answer differs from the exact deterministic reviewed rendering.',
    );
}

function requireOriginal(artifact: Artifact): void {
  if (
    artifact.producer.kind !== 'user' ||
    artifact.evidence_origin !== 'user_supplied' ||
    !artifact.original_byte_sha256 ||
    digest(
      typeof artifact.content === 'string'
        ? artifact.content
        : JSON.stringify(artifact.content),
    ) !== artifact.original_byte_sha256
  )
    fail(
      'supplied original bytes and their exact import provenance are missing.',
    );
}

function verifyModelCalls(
  report: Record<string, unknown>,
  task: TaskRecord,
  demonstration: Demonstration,
  bindings: Bindings,
  exactModel: string,
): void {
  const attempts = z.array(z.unknown()).parse(report.attempts);
  const counts = Object.fromEntries(
    agentRoleSchema.options.map((role) => [role, 0]),
  );
  let acceptedManager = false;
  const seen = new Set<string>();
  for (const value of attempts) {
    const raw = object(value);
    if (raw.task_id !== task.id || raw.kind !== 'model') continue;
    const attempt = modelAttemptSchema.parse(raw);
    if (seen.has(attempt.id)) fail('duplicate raw model attempt.');
    seen.add(attempt.id);
    const assignment =
      task.assignments.find((entry) => entry.id === attempt.assignment_id) ??
      fail('model attempt has no retained assignment.');
    const role = assignment.role;
    counts[role]!++;
    const expected = bindings.routes[role];
    const requested = attempt.details.requested_route;
    if (
      !expected ||
      requested.route_id !== expected.route_id ||
      requested.provider !== expected.provider ||
      requested.requested_model !== expected.requested_model ||
      requested.requested_model !== exactModel ||
      !['nightshift', 'nvidia'].includes(requested.provider)
    )
      fail('model attempt does not match the exact released route.');
    if (attempt.status === 'completed' && attempt.accepted) {
      const receipt = genuineReceiptSchema.parse(attempt.receipt);
      if (receipt.response_model !== exactModel)
        fail('model receipt does not attest the exact Ultra model.');
      if (
        role === 'Manager' &&
        attempt.run_id === task.current_run_id &&
        attempt.objective_revision === task.objective_revision &&
        attempt.assignment_revision === assignment.revision
      )
        acceptedManager = true;
    }
  }
  for (const role of agentRoleSchema.options)
    if ((demonstration.model_calls_by_role[role] ?? 0) !== counts[role])
      fail('declared per-role model calls differ from charged raw attempts.');
  if (!acceptedManager)
    fail(
      'a genuine current Manager call is required. Deterministic specialists may make zero calls.',
    );
}
