import { z } from 'zod';
import type { Artifact, ArtifactRef } from '../../contracts/artifacts.js';
import {
  reductionAssessmentSchema,
  reductionInputSelectionSchema,
  reductionReviewSchema,
} from '../../contracts/damage-reduction.js';
import {
  conditionalPlanReviewSchema,
  conditionalReductionPlanSchema,
  reductionPreviewRequestSchema,
} from '../../contracts/damage-reduction-plan.js';
import {
  reductionPreviewViewSchema,
  type ReductionPreviewView,
} from '../../contracts/damage-reduction-view.js';
import { canonicalJson, contractHash } from '../../contracts/json.js';
import type { TaskIdentity } from '../../contracts/tasks.js';
import type {
  ExecutionMode,
  StatefulToolStore,
} from '../../orchestration/ports.js';
import { exactReductionRef } from './inputs.js';
import { readDamageReductionClaim } from './claims.js';
import { independentlyCheckConditionalPlan } from './planning-checker.js';

const key = (ref: ArtifactRef) => `${ref.id}:${ref.version}:${ref.sha256}`;

export function readDamageReductionPreview(
  store: StatefulToolStore,
  mode: ExecutionMode,
  taskId: string,
  identity: TaskIdentity,
): ReductionPreviewView {
  const task = store.read(taskId, identity);
  const result: ReductionPreviewView = {
    schema_version: 'haze.reduction.preview-view.v1',
    task_id: task.id,
    run_id: task.current_run_id,
    objective_revision: task.objective_revision,
    state: ['queued', 'running', 'waiting', 'paused'].includes(task.status)
      ? 'pending'
      : 'unavailable',
    selection: null,
    assessment: null,
    arithmetic_review: null,
    plan: null,
    plan_review: null,
    claims: null,
    plan_eligibility: 'none',
    source_refs: [],
    reasons: [],
  };
  const reasons = new Set<string>();
  const current = task.artifacts.filter(
    (entry) =>
      entry.objective_revision === task.objective_revision && entry.current,
  );
  const loaded = new Map<string, Artifact>();
  const load = (ref: ArtifactRef, visiting = new Set<string>()): Artifact => {
    const token = key(ref);
    if (visiting.has(token)) throw new Error('preview_dependency_cycle');
    const saved = loaded.get(token);
    if (saved) return saved;
    if (loaded.size >= 256)
      throw new Error('preview_dependency_bound_exceeded');
    if (!current.some((entry) => key(entry.artifact) === token))
      throw new Error('preview_source_not_current');
    const artifact = store.artifact(ref.id, identity, ref);
    if (
      key(artifact) !== token ||
      contractHash(artifact.content) !== ref.sha256
    )
      throw new Error('preview_source_invalid');
    if (
      artifact.required_tools.some(
        (tool) => !task.permissions.tools.includes(tool),
      )
    )
      throw new Error('preview_source_permission_revoked');
    const scope = { ...identity, mode };
    const records = store.world.lookup(scope, {
      kind: 'artifact_reference',
      external_id: `artifact:${artifact.id}:${artifact.version}`,
      limit: 2,
    });
    if (
      records.length > 1 ||
      records.some(
        (record) => store.world.activeHolds(scope, record.ref.id).length,
      )
    )
      throw new Error('preview_source_held_or_withdrawn');
    if (artifact.task_id && artifact.task_id !== task.id) {
      const owner = store.read(artifact.task_id, identity);
      if (
        owner.mode !== mode ||
        !owner.artifacts.some(
          (entry) =>
            entry.objective_revision === owner.objective_revision &&
            entry.current &&
            key(entry.artifact) === token,
        )
      )
        throw new Error('preview_original_task_not_current');
    }
    visiting.add(token);
    loaded.set(token, artifact);
    try {
      for (const dependency of artifact.dependencies)
        load(dependency, visiting);
    } catch (error) {
      loaded.delete(token);
      throw error;
    } finally {
      visiting.delete(token);
    }
    return artifact;
  };
  const artifacts: Artifact[] = [];
  for (const entry of current) {
    try {
      const artifact = store.artifact(
        entry.artifact.id,
        identity,
        entry.artifact,
      );
      if (
        artifact.run_id === task.current_run_id &&
        artifact.objective_revision === task.objective_revision
      )
        artifacts.push(artifact);
    } catch {
      /* Unrelated context is not material support for this projection. */
    }
  }
  const product = <T>(
    kind: string,
    definition: string,
    role: string,
    schema: z.ZodType<T>,
  ) => {
    const matches = artifacts.filter(
      (artifact) =>
        artifact.kind === kind &&
        task.assignments.some(
          (assignment) =>
            assignment.id === artifact.assignment_id &&
            artifact.producer.kind === 'assignment' &&
            artifact.producer.id === assignment.id &&
            assignment.definition_id === definition &&
            assignment.definition_version === '1' &&
            assignment.role === role &&
            assignment.revision === artifact.assignment_revision &&
            assignment.run_id === task.current_run_id &&
            assignment.objective_revision === task.objective_revision &&
            assignment.status === 'completed' &&
            !['stale', 'rejected'].includes(assignment.usability) &&
            assignment.outputs.some((ref) => key(ref) === key(artifact)),
        ),
    );
    if (matches.length > 1) {
      reasons.add('preview_ambiguous_product');
      return null;
    }
    if (!matches.length) return null;
    try {
      const artifact = load(exactReductionRef(matches[0]!));
      return {
        artifact: exactReductionRef(artifact),
        value: schema.parse(artifact.content),
      };
    } catch (error) {
      reasons.add(
        error instanceof Error && /^preview_[a-z_]+$/.test(error.message)
          ? error.message
          : 'preview_source_inaccessible_or_invalid',
      );
      return null;
    }
  };
  result.selection = product(
    'reduction.input-selection',
    'reduction.select',
    'HazeOps',
    reductionInputSelectionSchema,
  );
  result.assessment = product(
    'reduction.assessment',
    'reduction.assess',
    'DamageAccountant',
    reductionAssessmentSchema,
  );
  result.arithmetic_review = product(
    'reduction.review',
    'reduction.check',
    'EvidenceCritic',
    reductionReviewSchema,
  );
  result.plan = product(
    'reduction.conditional-plan',
    'reduction.plan',
    'WorkerShield',
    conditionalReductionPlanSchema,
  );
  result.plan_review = product(
    'reduction.plan-review',
    'reduction.plan-check',
    'EvidenceCritic',
    conditionalPlanReviewSchema,
  );
  if (result.selection)
    result.source_refs = result.selection.value.sources.map(
      (source) => source.artifact,
    );
  if (result.plan) result.source_refs = result.plan.value.source_refs;
  if (result.selection && result.assessment && result.arithmetic_review) {
    result.claims = readDamageReductionClaim(
      store,
      mode,
      {
        selection_ref: result.selection.artifact,
        assessment_ref: result.assessment.artifact,
        review_ref: result.arithmetic_review.artifact,
      },
      { taskId, identity, runId: task.current_run_id },
    );
  }
  if (
    result.plan &&
    result.plan_review &&
    result.selection &&
    result.assessment &&
    result.arithmetic_review
  ) {
    try {
      const scope =
        task.corrections.findLast(
          (correction) => correction.scope !== undefined,
        )?.scope ?? task.original_request.scope;
      const request = reductionPreviewRequestSchema.parse(scope);
      const planArtifact = loaded.get(key(result.plan.artifact))!;
      const reviewArtifact = loaded.get(key(result.plan_review.artifact))!;
      if (
        result.plan_review.value.reviewer.assignment_id !==
          reviewArtifact.assignment_id ||
        result.plan_review.value.reviewer.revision !==
          reviewArtifact.assignment_revision
      )
        throw new Error('preview_reviewer_mismatch');
      const fresh = independentlyCheckConditionalPlan({
        request,
        selection: loaded.get(key(result.selection.artifact))!,
        assessment: loaded.get(key(result.assessment.artifact))!,
        arithmeticReview: loaded.get(key(result.arithmetic_review.artifact))!,
        plan: planArtifact,
        sources: [...loaded.values()],
        reviewer: result.plan_review.value.reviewer,
      });
      if (
        fresh.verdict !== 'supported' ||
        canonicalJson(fresh) !== canonicalJson(result.plan_review.value)
      )
        throw new Error('preview_plan_review_not_current');
      if (result.claims?.reasons.some((reason) => reason.startsWith('claim_')))
        throw new Error('preview_arithmetic_review_not_current');
      result.plan_eligibility =
        fresh.planning_state === 'conditional'
          ? 'conditional'
          : fresh.planning_state === 'blocked'
            ? 'blocked'
            : 'none';
      result.state = 'current';
    } catch (error) {
      reasons.add(
        error instanceof Error && /^preview_[a-z_]+$/.test(error.message)
          ? error.message
          : 'preview_plan_review_unavailable',
      );
    }
  }
  const declaredScope =
    task.corrections.findLast((correction) => correction.scope !== undefined)
      ?.scope ?? task.original_request.scope;
  const planningRequested =
    !!declaredScope &&
    typeof declaredScope === 'object' &&
    !Array.isArray(declaredScope) &&
    declaredScope.schema_version === 'haze.reduction.preview-request.v1';
  if (
    !planningRequested &&
    task.status === 'completed' &&
    task.result?.currency === 'current' &&
    result.selection &&
    result.assessment &&
    result.arithmetic_review?.value.verdict === 'supported' &&
    result.claims &&
    !result.claims.reasons.some((reason) => reason.startsWith('claim_'))
  )
    result.state = 'current';
  for (const artifact of artifacts.filter((item) =>
    ['reduction.input-gap', 'reduction.planning-gap'].includes(item.kind),
  )) {
    const gap = z
      .object({ reasons: z.array(z.string().min(1).max(4096)).max(64) })
      .safeParse(artifact.content);
    if (gap.success) for (const reason of gap.data.reasons) reasons.add(reason);
  }
  if (
    !result.plan &&
    !result.plan_review &&
    task.artifacts.some(
      (entry) => entry.objective_revision < task.objective_revision,
    )
  ) {
    result.state = 'stale';
    reasons.add(
      'Previous preview results belong to an earlier objective; their history is retained.',
    );
  }
  if (reasons.size && result.state === 'current') {
    result.state = 'stale';
    result.plan_eligibility = 'none';
  }
  if (
    [...reasons].some((reason) =>
      [
        'preview_source_not_current',
        'preview_source_held_or_withdrawn',
        'preview_original_task_not_current',
      ].includes(reason),
    )
  ) {
    result.state = 'stale';
    result.plan_eligibility = 'none';
  }
  if (result.assessment)
    for (const reason of result.assessment.value.reasons) reasons.add(reason);
  if (result.plan)
    for (const objection of result.plan.value.objections)
      reasons.add(objection.description);
  result.reasons = [...reasons].slice(0, 96);
  return reductionPreviewViewSchema.parse(result);
}
