import { describe, expect, it } from 'vitest';
import type { Artifact, ArtifactRef } from '../../app/contracts/artifacts.js';
import type { PilotDraftContext } from '../../app/contracts/damage-reduction-pilot.js';
import type {
  ReductionProgrammeAttemptView,
  ReductionProgrammeRecord,
  ReductionProgrammeSnapshot,
  ReductionProgrammeView,
} from '../../app/contracts/damage-reduction-programme.js';
import type { EvaluationTaskView } from '../../app/contracts/damage-reduction-evaluation.js';
import { contractHash } from '../../app/contracts/json.js';
import { SYNTHETIC_REDUCTION_TARGET } from '../../app/capabilities/damage-reduction-planning/fixtures.js';
import { syntheticReductionCandidate } from '../../app/capabilities/damage-reduction-planning/planning-fixtures.js';
import { createReductionSelection } from '../../app/capabilities/damage-reduction-planning/inputs.js';
import {
  draftPilot,
  independentlyReviewPilot,
} from '../../app/capabilities/damage-reduction-programmes/pilot-methods.js';
import {
  suppliedCompletePilotInput,
  syntheticPilotRegistration,
  syntheticDigitalActionRecord,
  syntheticActionReceipt,
} from '../../app/capabilities/damage-reduction-programmes/pilot-fixtures.js';
import { projectPilotRecords } from '../../app/capabilities/damage-reduction-programmes/pilot-records.js';
import { buildPilotRecordContext } from '../../app/capabilities/damage-reduction-programmes/projection.js';
import {
  syntheticExternalEvaluationInput,
  syntheticEvaluationExpectedOutput,
  syntheticQualificationDossier,
} from '../../app/capabilities/damage-reduction-programmes/evaluation-fixtures.js';
import {
  draftExternalEvaluation,
  independentlyReviewExternalEvaluation,
} from '../../app/capabilities/damage-reduction-programmes/evaluation-methods.js';
import {
  deriveEvaluationMethodContext,
  projectEvaluationRecords,
} from '../../app/capabilities/damage-reduction-programmes/evaluation-records.js';
import type { ProgrammeHost } from '../../app/capabilities/damage-reduction-programmes/ports.js';

const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const ref = ({ id, version, sha256 }: ArtifactRef): ArtifactRef => ({
  id,
  version,
  sha256,
});
const identity = {
  principal: 'hypothetical-predicate-test',
  workspace: 'hypothetical-predicate-test',
};
const now = '2026-10-04T12:00:00Z';

/** These are hypothetical supplied metadata, not a non-synthetic scientific reference trace.
 * The host boundary stands for already-governed upstream task projections; the
 * real protocol, receipts, external comparison and human records are reconstructed below.
 */
function hypotheticalPackage(intervention: '880' | '950' = '880') {
  let sequence = 20;
  const artifacts = new Map<string, Artifact>(),
    held = new Set<string>();
  const save = (
    content: Artifact['content'],
    kind = 'source.import',
    assignment?: string,
    createdAt = now,
  ): Artifact => {
    const artifact: Artifact = {
      schema_version: 'haze.artifact.v3',
      id: id(sequence++),
      version: 1,
      sha256: contractHash(content),
      identity,
      kind,
      producer: assignment
        ? { kind: 'assignment', id: assignment }
        : { kind: 'user', id: identity.principal },
      ...(assignment
        ? { assignment_id: assignment, assignment_revision: 1 }
        : {}),
      created_at: createdAt,
      dependencies: [],
      required_tools: [],
      content,
      evidence_origin: 'user_supplied',
    };
    artifacts.set(artifact.id, artifact);
    return artifact;
  };
  const designEvidence = save(
    {
      origin: 'supplied',
      description: 'Hypothetical preregistration design and rule proof.',
    },
    'source.import',
    undefined,
    '2026-08-01T00:00:00Z',
  );
  const report = save({
    origin: 'supplied',
    description:
      'Hypothetical domain-predicate package. No empirical reference trace is claimed.',
  });
  const data = save({
    origin: 'supplied',
    description: 'Hypothetical comparative data metadata.',
  });
  const scientificReview = save({
    origin: 'supplied',
    description: 'Hypothetical independently supplied review attestation.',
  });
  const target = structuredClone(SYNTHETIC_REDUCTION_TARGET);
  target.scope.period = { start: '2026-09-01', end: '2026-09-30' };
  const pilotInput = suppliedCompletePilotInput(ref(designEvidence));
  pilotInput.protocol_spec.observation_window = target.scope.period;
  pilotInput.protocol_spec.baseline_window = {
    start: '2026-08-01',
    end: '2026-08-31',
  };
  pilotInput.protocol_spec.digital_rule!.scope.period = target.scope.period;
  pilotInput.protocol_spec.digital_rule!.approval.approved_at =
    '2026-08-15T00:00:00Z';
  pilotInput.design_review!.reviewed_at = '2026-08-15T00:00:00Z';
  const pilotOriginal = save(
    pilotInput,
    'source.import',
    undefined,
    '2026-08-16T00:00:00Z',
  );
  const pilotContext: PilotDraftContext = {
    programme_id: id(1),
    input_ref: ref(pilotOriginal),
    selection_ref: ref(designEvidence),
    assessment_ref: ref(designEvidence),
    plan_ref: ref(designEvidence),
    plan_review_ref: ref(designEvidence),
    target,
    target_sha256: contractHash(target),
    scope_sha256: contractHash(target.scope),
    evidence: [...artifacts.values()],
  };
  const draftedPilot = draftPilot(pilotInput, pilotContext);
  const feasibility = save(
    draftedPilot.feasibility,
    'reduction.pilot-feasibility',
    id(3),
    '2026-08-16T00:00:00Z',
  );
  const protocol = save(
    draftedPilot.protocol,
    'reduction.pilot-protocol',
    id(3),
    '2026-08-16T00:00:00Z',
  );
  const pilotReviewValue = independentlyReviewPilot(
    pilotInput,
    pilotContext,
    feasibility,
    protocol,
    { assignment_id: id(4), revision: 1 },
  );
  expect(pilotReviewValue.verdict).toBe('supported');
  const pilotReview = save(
    pilotReviewValue,
    'reduction.pilot-review',
    id(4),
    '2026-08-16T00:00:00Z',
  );
  const draft = {
    attempt_id: id(5),
    feasibility: {
      artifact: ref(feasibility),
      value: draftedPilot.feasibility,
    },
    protocol: { artifact: ref(protocol), value: draftedPilot.protocol },
    review: { artifact: ref(pilotReview), value: pilotReviewValue },
  };
  const snapshot: ReductionProgrammeSnapshot = {
    schema_version: 'haze.reduction.programme.v1',
    id: id(1),
    revision: 1,
    mode: 'fixture',
    title: 'Hypothetical domain predicate test only',
    accountable_owner: 'Test operator',
    scientific_owner: pilotInput.scientific_owner,
    pilot_input_ref: ref(pilotOriginal),
    preview: {
      schema_version: 'haze.reduction.preview-request.v1',
      candidate: syntheticReductionCandidate(),
      selection: createReductionSelection(target, [
        {
          artifact: ref(designEvidence),
          row_ids: ['baseline-1', 'intervention-1'],
        },
      ]),
    },
    budget: {
      max_model_calls: 400,
      max_tool_calls: 400,
      max_runs: 12,
      max_attempts_per_phase: 3,
    },
    created_at: '2026-08-01T00:00:00Z',
    updated_at: now,
  };
  const record = (
    value: ReductionProgrammeRecord['record'],
    createdAt = now,
  ): ReductionProgrammeRecord => ({
    id: id(sequence++),
    programme_id: snapshot.id,
    programme_revision: 1,
    created_at: createdAt,
    record: value,
    task_binding: null,
    applicability: 'programme_record',
  });
  const registration = record(
    syntheticPilotRegistration(draft, '2026-08-30T01:00:00Z'),
    '2026-08-30T01:00:00Z',
  );
  const actionBody = {
    ...syntheticDigitalActionRecord(registration.id),
    mode: 'imported_live' as const,
    status: 'confirmed' as const,
    occurred_at: '2026-09-15T12:00:00Z',
    scope: pilotInput.protocol_spec.digital_rule!.scope,
    trigger_refs: [ref(designEvidence)],
  };
  const receipt = save(
    {
      ...syntheticActionReceipt(actionBody),
      origin: 'imported_service',
      service: 'Hypothetical external service metadata',
    },
    'source.import',
    undefined,
    '2026-09-15T12:00:00Z',
  );
  const action = record(
    { ...actionBody, receipt_ref: ref(receipt) },
    '2026-09-16T00:00:00Z',
  );
  const records = [registration, action];
  // Deliberately implement only the read boundary consumed by these pure
  // predicates. This is not a complete executable programme/runtime host.
  const host = {
    mode: 'fixture',
    readArtifact(reference: ArtifactRef) {
      const value = artifacts.get(reference.id);
      if (!value) throw new Error('Evidence unavailable.');
      return value;
    },
    assertEvidenceCurrent(reference: ArtifactRef) {
      if (held.has(reference.id) || !artifacts.has(reference.id))
        throw new Error('Evidence held or stale.');
    },
  } as unknown as ProgrammeHost;
  // Only exact upstream lineage fields are consumed by buildPilotRecordContext.
  // This boundary fixture deliberately does not pretend to execute Manager/tasks.
  const assessmentView = {
    attempt: { id: id(6), phase: 'assessment' },
    currency: 'current',
    preview: {
      state: 'current',
      selection: { artifact: ref(designEvidence) },
      assessment: { artifact: ref(designEvidence) },
    },
  } as ReductionProgrammeAttemptView;
  const planningView = {
    attempt: { id: id(7), phase: 'planning', assessment_attempt_id: id(6) },
    currency: 'current',
    preview: {
      state: 'current',
      plan: { artifact: ref(designEvidence) },
      plan_review: { artifact: ref(designEvidence) },
    },
  } as ReductionProgrammeAttemptView;
  const base = {
    attempts: [assessmentView, planningView],
  } as ReductionProgrammeView;
  base.pilot = projectPilotRecords(
    snapshot,
    records,
    buildPilotRecordContext(host, identity, base.attempts, now),
  );
  expect(base.pilot.actions[0]?.recorded_delivery).toBe(true);
  const input = syntheticExternalEvaluationInput({
    programme_id: snapshot.id,
    target_sha256: contractHash(target),
    scope_sha256: contractHash(target.scope),
    scope: target.scope,
    registration_id: registration.id,
    protocol_ref: ref(protocol),
    action_record_ids: [action.id],
    rules: [actionBody.rule],
    report_ref: ref(report),
    data_ref: ref(data),
    review_ref: ref(scientificReview),
    expected_output_ref: ref(report),
  });
  input.origin = 'supplied';
  input.comparative_estimates.intervention = intervention;
  input.design.requires_independent_delivery_verification = false;
  const expected = save({
    ...syntheticEvaluationExpectedOutput(input),
    origin: 'supplied',
    ...(intervention === '950'
      ? {
          intervention_damage: '950',
          absolute_reduction: '50',
          relative_reduction: { numerator: '50', denominator: '1000' },
          target_met: false,
        }
      : {}),
  });
  input.expected_output_refs = [ref(expected)];
  const original = save(input);
  snapshot.evaluation_input_ref = ref(original);
  const dossier = syntheticQualificationDossier(input, ref(original));
  dossier.origin = 'supplied';
  dossier.decision = 'qualified';
  dossier.scientific_owner = snapshot.scientific_owner!;
  dossier.reference_case = {
    name: 'Hypothetical positive metadata package',
    description: 'Unit test only; no real non-synthetic reference case exists.',
    evidence: [ref(report)],
  };
  dossier.applicability = {
    decision: 'applicable',
    statement: 'Hypothetical externally reviewed applicability attestation.',
    prerequisites: [],
    unresolved_material_objections: [],
  };
  const dossierArtifact = save(dossier);
  snapshot.evaluation_dossier_ref = ref(dossierArtifact);
  const methodContext = deriveEvaluationMethodContext(
    snapshot,
    records,
    base,
    host,
    identity,
    ref(original),
    ref(dossierArtifact),
    registration.id,
  );
  expect(methodContext.gate_reasons).toEqual([]);
  const products = draftExternalEvaluation(input, methodContext);
  expect(products.result.status, products.result.reasons.join(' ')).toBe(
    'supported',
  );
  const result = save(products.result, 'reduction.external-evaluation', id(8));
  const learning = save(
    products.learning,
    'reduction.evaluation-learning',
    id(8),
  );
  const reviewValue = independentlyReviewExternalEvaluation(
    input,
    methodContext,
    result,
    learning,
    { assignment_id: id(9), revision: 1 },
  );
  expect(reviewValue).toMatchObject({
    verdict: 'supported',
    qualification_check: { status: 'complete' },
  });
  const review = save(reviewValue, 'reduction.evaluation-review', id(9));
  const evaluation: EvaluationTaskView = {
    task_id: id(10),
    run_id: id(11),
    objective_revision: 1,
    state: 'current',
    result: { artifact: ref(result), value: products.result },
    learning: { artifact: ref(learning), value: products.learning },
    review: { artifact: ref(review), value: reviewValue },
    reasons: [],
    scientific_qualification: 'unqualified',
    achieved_reduction: false,
  };
  base.attempts.push({
    attempt: { phase: 'evaluation' },
    currency: 'current',
    evaluation,
    historical_artifact_refs: [ref(result), ref(learning), ref(review)],
  } as ReductionProgrammeAttemptView);
  const adoption = record({
    kind: 'evaluation_qualification',
    decision: 'qualified',
    result_ref: ref(result),
    technical_review_ref: ref(review),
    dossier_ref: ref(dossierArtifact),
    adopted_by: 'Hypothetical local human operator',
    attested_at: now,
    reason: 'Unit-test attestation; not a real operational trace.',
    supersedes_record_id: null,
  });
  records.push(adoption);
  const project = () =>
    projectEvaluationRecords(snapshot, records, base, host, identity);
  return {
    snapshot,
    project,
    save,
    held,
    report,
    records,
    record,
    adoption,
    result,
    review,
    dossierArtifact,
    evaluation,
  };
}

describe('hypothetical evaluation claim predicate (no real reference trace)', () => {
  it('admits a fully aligned hypothetical supplied package only after separate local adoption', () => {
    const fixture = hypotheticalPackage();
    const adoption = fixture.records.pop()!;
    expect(fixture.project().claim.eligible).toBe(false);
    fixture.records.push(adoption);
    expect(
      fixture.project(),
      JSON.stringify(fixture.project().qualification),
    ).toMatchObject({
      qualification: { status: 'qualified' },
      claim: {
        eligible: true,
        label: 'external_evaluation_supports_registered_target',
      },
    });
    expect(fixture.evaluation.result!.value.scientific_qualification).toBe(
      'unqualified',
    );
  });

  it('revokes current eligibility when an original required report becomes held', () => {
    const fixture = hypotheticalPackage();
    expect(fixture.project().claim.eligible).toBe(true);
    fixture.held.add(fixture.report.id);
    expect(fixture.project().claim.eligible).toBe(false);
    expect(fixture.project().qualification.status).not.toBe('qualified');
    fixture.held.clear();
    expect(fixture.project().claim.eligible).toBe(true);
  });

  it('retains qualified below-target completion without an achieved-target claim', () => {
    const fixture = hypotheticalPackage('950');
    expect(fixture.project()).toMatchObject({
      qualification: { status: 'qualified' },
      claim: {
        eligible: false,
        label: 'point_estimate_below_target',
        point_estimate: 'below',
      },
      achieved_reduction: false,
    });
  });

  it('keeps explicit withdrawal effective while the source dossier is inaccessible', () => {
    const fixture = hypotheticalPackage();
    if (fixture.adoption.record.kind !== 'evaluation_qualification')
      throw new Error('Expected adoption');
    fixture.records.push(
      fixture.record({
        ...fixture.adoption.record,
        decision: 'withdrawn',
        supersedes_record_id: fixture.adoption.id,
        reason: 'Explicit withdrawal of hypothetical attestation.',
      }),
    );
    fixture.held.add(fixture.dossierArtifact.id);
    expect(fixture.project()).toMatchObject({
      qualification: { status: 'withdrawn' },
      claim: { eligible: false },
    });
  });

  it('blocks the hypothetical positive claim immediately when a material objection is retained', () => {
    const fixture = hypotheticalPackage();
    fixture.records.push(
      fixture.record({
        kind: 'evaluation_objection',
        result_ref: ref(fixture.result),
        severity: 'material',
        status: 'open',
        description: 'Hypothetical unresolved source-alignment objection.',
        evidence: [],
        resolves_record_id: null,
      }),
    );
    expect(fixture.project().claim.eligible).toBe(false);
    expect(fixture.project().qualification.status).toBe('conditional');
  });

  it('cannot promote a future observation window to an achieved programme result', () => {
    const fixture = hypotheticalPackage();
    fixture.snapshot.preview.selection.target.scope.period = {
      start: '2099-01-01',
      end: '2099-12-31',
    };
    const result = fixture.project();
    expect(result.claim.eligible).toBe(false);
    expect(result.claim.reasons.join(' ')).toMatch(
      /forecast|future window|has not ended/i,
    );
  });

  it('requires the programme to name its scientific owner before operational adoption', () => {
    const fixture = hypotheticalPackage();
    fixture.snapshot.scientific_owner = null;
    const result = fixture.project();
    expect(result.claim.eligible).toBe(false);
    expect(result.claim.reasons.join(' ')).toMatch(
      /named programme scientific owner/i,
    );
  });
});
