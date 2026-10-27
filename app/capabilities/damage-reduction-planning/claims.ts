import { type Artifact, type ArtifactRef } from '../../contracts/artifacts.js';
import {
  reductionAssessmentSchema,
  reductionClaimEligibilitySchema,
  reductionClaimQuerySchema,
  reductionInputSelectionSchema,
  reductionReviewSchema,
  reductionSelectionRequestSchema,
  type ReductionClaimEligibility,
  type ReductionClaimQuery,
} from '../../contracts/damage-reduction.js';
import { canonicalJson, contractHash } from '../../contracts/json.js';
import type {
  ExecutionMode,
  ReadonlyEvidenceStore,
  StatefulToolStore,
  ToolContext,
  ToolDefinition,
} from '../../orchestration/ports.js';
import { independentlyCheckReduction } from './checker.js';
import { reductionSelectionFromScope } from './request.js';
import { resolveReductionSelectionRequest } from './inputs.js';

const refKey = (ref: ArtifactRef) => `${ref.id}:${ref.version}:${ref.sha256}`;
const same = (left: unknown, right: unknown) =>
  canonicalJson(left) === canonicalJson(right);

/** Historical artifact bytes remain immutable. Eligibility is freshly reconstructed. */
export function readDamageReductionClaim(
  store: ReadonlyEvidenceStore,
  mode: ExecutionMode,
  query: ReductionClaimQuery,
  context: Pick<ToolContext, 'taskId' | 'identity' | 'runId'>,
): ReductionClaimEligibility {
  const result: ReductionClaimEligibility = {
    schema_version: 'haze.reduction.claim-eligibility.v1',
    ...query,
    claim_eligibility: 'none',
    point_estimate_label: 'unavailable',
    origin: 'unknown',
    scientific_qualification: 'unqualified',
    achieved_reduction: false,
    reasons: [],
    checked_at: new Date().toISOString(),
  };
  try {
    const task = store.read(context.taskId, context.identity);
    if (task.mode !== mode || task.current_run_id !== context.runId)
      throw new Error('claim_task_or_mode_changed');
    const scope = { ...context.identity, mode };
    const artifacts = new Map<string, Artifact>();
    const visiting = new Set<string>();
    const load = (ref: ArtifactRef): Artifact => {
      const key = refKey(ref);
      if (visiting.has(key)) throw new Error('claim_dependency_cycle');
      const cached = artifacts.get(key);
      if (cached) return cached;
      if (artifacts.size >= 256)
        throw new Error('claim_dependency_bound_exceeded');
      const artifact = store.artifact(ref.id, context.identity, ref);
      if (
        refKey(artifact) !== key ||
        contractHash(artifact.content) !== ref.sha256 ||
        artifact.identity.principal !== context.identity.principal ||
        artifact.identity.workspace !== context.identity.workspace
      )
        throw new Error('claim_dependency_inaccessible');
      if (
        !task.artifacts.some(
          (entry) =>
            entry.objective_revision === task.objective_revision &&
            entry.current &&
            refKey(entry.artifact) === key,
        )
      )
        throw new Error('claim_dependency_not_current');
      if (
        artifact.required_tools.some(
          (tool) => !task.permissions.tools.includes(tool),
        )
      )
        throw new Error('claim_dependency_permission_revoked');
      if (artifact.task_id && artifact.task_id !== task.id) {
        const owner = store.read(artifact.task_id, context.identity);
        if (
          owner.mode !== mode ||
          !owner.artifacts.some(
            (entry) =>
              entry.objective_revision === owner.objective_revision &&
              entry.current &&
              refKey(entry.artifact) === key,
          )
        )
          throw new Error('claim_originating_task_not_current');
      }
      const worldRecords = store.world.lookup(scope, {
        kind: 'artifact_reference',
        external_id: `artifact:${artifact.id}:${artifact.version}`,
        limit: 2,
      });
      if (
        worldRecords.length > 1 ||
        worldRecords.some(
          (record) => store.world.activeHolds(scope, record.ref.id).length,
        )
      )
        throw new Error('claim_dependency_held_or_withdrawn');
      visiting.add(key);
      artifacts.set(key, artifact);
      for (const dependency of artifact.dependencies) load(dependency);
      visiting.delete(key);
      return artifact;
    };
    const selectionArtifact = load(query.selection_ref);
    const assessmentArtifact = load(query.assessment_ref);
    const reviewArtifact = load(query.review_ref);
    const produced = (
      artifact: Artifact,
      kind: string,
      definition: string,
      role: string,
    ) => {
      const producer = task.assignments.find(
        (assignment) => assignment.id === artifact.assignment_id,
      );
      if (
        artifact.kind !== kind ||
        artifact.task_id !== task.id ||
        artifact.run_id !== task.current_run_id ||
        artifact.objective_revision !== task.objective_revision ||
        artifact.producer.kind !== 'assignment' ||
        !producer ||
        producer.id !== artifact.producer.id ||
        producer.definition_id !== definition ||
        producer.definition_version !== '1' ||
        producer.capability !== 'damage-reduction-planning' ||
        producer.capability_version !== 'damage-reduction-planning.v1' ||
        producer.role !== role ||
        producer.revision !== artifact.assignment_revision ||
        producer.run_id !== task.current_run_id ||
        producer.objective_revision !== task.objective_revision ||
        producer.status !== 'completed' ||
        ['rejected', 'stale'].includes(producer.usability) ||
        !producer.outputs.some((ref) => refKey(ref) === refKey(artifact))
      )
        throw new Error('claim_registered_producer_not_current');
      return producer;
    };
    produced(
      selectionArtifact,
      'reduction.input-selection',
      'reduction.select',
      'HazeOps',
    );
    const producer = produced(
      assessmentArtifact,
      'reduction.assessment',
      'reduction.assess',
      'DamageAccountant',
    );
    const reviewer = produced(
      reviewArtifact,
      'reduction.review',
      'reduction.check',
      'EvidenceCritic',
    );
    const selection = reductionInputSelectionSchema.parse(
      selectionArtifact.content,
    );
    const assessment = reductionAssessmentSchema.parse(
      assessmentArtifact.content,
    );
    const review = reductionReviewSchema.parse(reviewArtifact.content);
    const declared =
      task.corrections.findLast((correction) => correction.scope !== undefined)
        ?.scope ?? task.original_request.scope;
    for (const source of selection.sources) load(source.artifact);
    const declaredInput = reductionSelectionFromScope(declared);
    const reference = reductionSelectionRequestSchema.safeParse(declaredInput);
    if (reference.success) load(reference.data.selection_ref);
    let declaredSelection;
    try {
      declaredSelection = resolveReductionSelectionRequest(declaredInput, [
        ...artifacts.values(),
      ]);
    } catch {
      throw new Error('claim_current_operator_selection_changed');
    }
    if (!same(selection, declaredSelection))
      throw new Error('claim_current_operator_selection_changed');
    if (
      review.reviewer.assignment_id !== reviewer.id ||
      review.reviewer.revision !== reviewer.revision ||
      reviewer.id === producer.id
    )
      throw new Error('claim_independent_reviewer_mismatch');
    const fresh = independentlyCheckReduction(
      selection,
      [...artifacts.values()],
      query.selection_ref,
      assessment,
      query.assessment_ref,
      review.reviewer,
      producer.id,
    );
    if (!same(fresh, review) || fresh.verdict !== 'supported')
      throw new Error('claim_independent_review_not_supported');
    result.claim_eligibility = fresh.claim_eligibility;
    result.origin = assessment.origin;
    result.point_estimate_label =
      fresh.claim_eligibility === 'arithmetic_checked_scenario'
        ? assessment.target_met
          ? 'meets'
          : 'does_not_meet'
        : 'unavailable';
    result.reasons = assessment.reasons;
  } catch (error) {
    // Never return inaccessible payloads, imported prose or internal store errors.
    const message = error instanceof Error ? error.message : '';
    result.reasons = [
      /^claim_[a-z_]+$/.test(message)
        ? message
        : 'claim_inputs_inaccessible_or_invalid',
    ];
  }
  return reductionClaimEligibilitySchema.parse(result);
}

export function createDamageReductionClaimTool(
  store: StatefulToolStore,
  mode: ExecutionMode,
): ToolDefinition<ReductionClaimQuery, ReductionClaimEligibility> {
  return {
    id: 'reduction.read-claim',
    version: '1',
    mode,
    manager_read_only: true,
    description:
      'Read current physical scenario claim eligibility after exact dependency, access, applicability, hold and independent-review checks.',
    inputSchema: reductionClaimQuerySchema,
    outputSchema: reductionClaimEligibilitySchema,
    execute: (query, context) =>
      Promise.resolve(readDamageReductionClaim(store, mode, query, context)),
  };
}
