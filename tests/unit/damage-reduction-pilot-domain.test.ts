import { describe, expect, it } from 'vitest';
import type { Artifact, ArtifactRef } from '../../app/contracts/artifacts.js';
import type {
  PilotDraftContext,
  PilotInput,
  PilotRecordBody,
  PilotRecordContext,
} from '../../app/contracts/damage-reduction-pilot.js';
import type {
  ReductionProgrammeRecord,
  ReductionProgrammeSnapshot,
} from '../../app/contracts/damage-reduction-programme.js';
import { contractHash } from '../../app/contracts/json.js';
import {
  draftPilot,
  independentlyReviewPilot,
} from '../../app/capabilities/damage-reduction-programmes/pilot-methods.js';
import {
  projectPilotRecords,
  validatePilotRecord,
} from '../../app/capabilities/damage-reduction-programmes/pilot-records.js';
import {
  suppliedCompletePilotInput,
  syntheticActionReceipt,
  syntheticDigitalActionRecord,
  syntheticPilotRegistration,
} from '../../app/capabilities/damage-reduction-programmes/pilot-fixtures.js';
import { SYNTHETIC_REDUCTION_TARGET } from '../../app/capabilities/damage-reduction-planning/fixtures.js';
import { syntheticReductionCandidate } from '../../app/capabilities/damage-reduction-planning/planning-fixtures.js';

const id = (number: number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const identity = {
  principal: 'pilot-domain-test',
  workspace: 'pilot-domain-test',
};
const now = '2026-10-27T12:00:00Z';
const ref = ({ id, version, sha256 }: ArtifactRef): ArtifactRef => ({
  id,
  version,
  sha256,
});
type Action = Extract<PilotRecordBody, { kind: 'digital_action' }>;

function setup(wideOperatingWindow = true) {
  let sequence = 20;
  const artifacts = new Map<string, Artifact>();
  const held = new Set<string>();
  const save = (
    content: Artifact['content'],
    kind = 'source.import',
    assignment?: string,
    evidenceOrigin: Artifact['evidence_origin'] = 'user_supplied',
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
      created_at: now,
      dependencies: [],
      required_tools: [],
      content,
      evidence_origin: evidenceOrigin,
    };
    artifacts.set(artifact.id, artifact);
    return artifact;
  };
  const evidence = save({
    origin: 'supplied',
    description:
      'Invented source and human attestations for engineering tests only.',
  });
  const input = suppliedCompletePilotInput(ref(evidence));
  if (wideOperatingWindow)
    input.protocol_spec.digital_rule!.scope.period = {
      start: '2026-01-01',
      end: '2027-12-31',
    };
  const selection = save({
    origin: 'supplied',
    name: 'Exact retained selection',
  });
  const assessment = save({
    origin: 'supplied',
    name: 'Exact retained assessment',
  });
  const plan = save({
    origin: 'supplied',
    name: 'Exact retained conditional plan',
  });
  const planReview = save({
    origin: 'supplied',
    name: 'Exact retained plan review',
  });
  const original = save(input);
  const target = structuredClone(SYNTHETIC_REDUCTION_TARGET);
  const draftContext: PilotDraftContext = {
    programme_id: id(1),
    input_ref: ref(original),
    selection_ref: ref(selection),
    assessment_ref: ref(assessment),
    plan_ref: ref(plan),
    plan_review_ref: ref(planReview),
    target_sha256: contractHash(target),
    scope_sha256: contractHash(target.scope),
    target,
    evidence: [...artifacts.values()],
    candidate_kind: 'exposure_alert',
  };
  const makeDraft = (value: PilotInput = input, context = draftContext) => {
    const values = draftPilot(value, context);
    const feasibility = save(
      values.feasibility,
      'reduction.pilot-feasibility',
      id(2),
    );
    const protocol = save(values.protocol, 'reduction.pilot-protocol', id(2));
    const reviewValue = independentlyReviewPilot(
      value,
      context,
      feasibility,
      protocol,
      { assignment_id: id(3), revision: 1 },
    );
    expect(reviewValue.verdict).toBe('supported');
    const review = save(reviewValue, 'reduction.pilot-review', id(3));
    return {
      attempt_id: id(4),
      feasibility: { artifact: ref(feasibility), value: values.feasibility },
      protocol: { artifact: ref(protocol), value: values.protocol },
      review: { artifact: ref(review), value: reviewValue },
    };
  };
  const draft = makeDraft();
  const snapshot: ReductionProgrammeSnapshot = {
    schema_version: 'haze.reduction.programme.v1',
    id: id(1),
    revision: 1,
    mode: 'fixture',
    title: 'Invented pilot domain test',
    accountable_owner: 'Fixture operator',
    scientific_owner: input.scientific_owner,
    pilot_input_ref: ref(original),
    preview: {
      schema_version: 'haze.reduction.preview-request.v1',
      candidate: syntheticReductionCandidate(),
      selection: {
        schema_version: 'haze.reduction.input-selection.v1',
        target,
        scope_sha256: contractHash(target.scope),
        method_id: 'reduction.imported-residual-comparison.v1',
        method_version: '1',
        sources: [
          {
            artifact: ref(evidence),
            row_ids: ['baseline-1', 'intervention-1'],
          },
        ],
      },
    },
    budget: {
      max_model_calls: 400,
      max_tool_calls: 400,
      max_runs: 12,
      max_attempts_per_phase: 3,
    },
    created_at: now,
    updated_at: now,
  };
  const context: PilotRecordContext = {
    identity,
    now,
    current_draft: draft,
    current_lineage: {
      selection_ref: ref(selection),
      assessment_ref: ref(assessment),
      plan_ref: ref(plan),
      plan_review_ref: ref(planReview),
    },
    readArtifact(reference) {
      const artifact = artifacts.get(reference.id);
      if (!artifact) throw new Error('Missing exact source.');
      return artifact;
    },
    assertEvidenceCurrent(reference) {
      if (held.has(reference.id) || !artifacts.has(reference.id))
        throw new Error('Source is held or unavailable.');
    },
  };
  const record = (body: PilotRecordBody): ReductionProgrammeRecord => ({
    id: id(sequence++),
    programme_id: snapshot.id,
    programme_revision: 1,
    created_at: now,
    record: body,
    task_binding: null,
    applicability: 'programme_record',
  });
  const registration = record(syntheticPilotRegistration(draft, now));
  const action = (overrides: Partial<Action> = {}): Action => ({
    ...syntheticDigitalActionRecord(registration.id),
    mode: 'imported_live',
    status: 'confirmed',
    action_id: `test-action-${sequence++}`,
    occurred_at: now,
    scope: input.protocol_spec.digital_rule!.scope,
    trigger_refs: [ref(evidence)],
    ...overrides,
  });
  const confirm = (
    value: Action,
    overrides: Record<string, unknown> = {},
  ): Action => {
    const receipt = save({
      ...syntheticActionReceipt(value),
      origin: 'imported_service',
      ...overrides,
    });
    return { ...value, receipt_ref: ref(receipt) };
  };
  const project = (records: ReductionProgrammeRecord[]) =>
    projectPilotRecords(snapshot, records, context);
  return {
    artifacts,
    held,
    save,
    evidence,
    original,
    input,
    draftContext,
    makeDraft,
    draft,
    context,
    snapshot,
    record,
    registration,
    action,
    confirm,
    project,
  };
}

describe('supplied pilot feasibility and independent reconstruction', () => {
  it('classifies complete supplied attestations without claiming scientific qualification', () => {
    const { draft } = setup(false);
    expect(draft.feasibility.value).toMatchObject({
      classification: 'damage_evaluation_capable',
      origin: 'supplied',
      scientific_qualification: 'unqualified',
      achieved_reduction: false,
    });
    expect(draft.feasibility.value.prerequisites).toEqual([]);
  });

  it.each(['comparator', 'precision_power'] as const)(
    'limits damage evaluation when the supplied %s is unavailable',
    (topic) => {
      const { input, draftContext } = setup(false);
      input.findings.find((finding) => finding.topic === topic)!.status =
        'unavailable';
      expect(draftPilot(input, draftContext).feasibility.classification).toBe(
        'delivery_exposure_feasibility_only',
      );
    },
  );

  it('keeps an absent baseline window and blocking plan objections as explicit conditions', () => {
    const { input, draftContext } = setup(false);
    input.protocol_spec.baseline_window = null;
    const result = draftPilot(input, {
      ...draftContext,
      planning_objections: ['Hard subgroup constraint is violated.'],
    });
    expect(result.feasibility.classification).toBe('conditional');
    expect(result.feasibility.prerequisites.join(' ')).toContain(
      'baseline_window',
    );
    expect(result.feasibility.prerequisites.join(' ')).toContain(
      'conditional-plan objections',
    );
  });

  it('retains synthetic origin inherited from an upstream selected plan', () => {
    const { input, draftContext, save } = setup(false);
    const syntheticPlan = save(
      { origin: 'supplied' },
      'source.import',
      undefined,
      'synthetic_fixture',
    );
    const context = {
      ...draftContext,
      plan_ref: ref(syntheticPlan),
      evidence: [...draftContext.evidence!, syntheticPlan],
    };
    const result = draftPilot(input, context);
    expect(result.feasibility).toMatchObject({
      origin: 'synthetic',
      classification: 'conditional',
    });
    expect(result.protocol.origin).toBe('synthetic');
  });

  it('rejects a producer changing the declared baseline window before independent review', () => {
    const { input, draftContext, save } = setup(false);
    const values = draftPilot(input, draftContext);
    values.protocol.specification.baseline_window = {
      start: '2025-01-01',
      end: '2025-12-31',
    };
    const review = independentlyReviewPilot(
      input,
      draftContext,
      save(values.feasibility, 'reduction.pilot-feasibility', id(2)),
      save(values.protocol, 'reduction.pilot-protocol', id(2)),
      { assignment_id: id(3), revision: 1 },
    );
    expect(review.verdict).toBe('rejected');
  });
});

describe('retained pilot governance and delivery evidence', () => {
  it('keeps reviewed feasibility after the active pilot draft is invalidated', () => {
    const { registration, context, project } = setup();
    context.current_draft = null;
    const result = project([registration]);
    expect(result.feasibility?.current).toBe(true);
    expect(result.registrations[0]).toMatchObject({
      currency: 'current',
      timing: 'attested_before_outcomes',
    });
  });

  it('does not erase known outcomes when earlier registration evidence becomes held', () => {
    const { registration, draft, held, record, project, makeDraft } = setup();
    if (registration.record.kind !== 'pilot_registration')
      throw new Error('Expected registration');
    registration.record.outcome_access.collection = 'started';
    registration.record.outcome_access.collection_started_at =
      '2026-10-26T12:00:00Z';
    held.add(draft.protocol.artifact.id);
    const later = record(syntheticPilotRegistration(makeDraft(), now));
    const result = project([registration, later]);
    expect(result.registrations[0]?.currency).toBe('stale');
    expect(result.registrations[1]?.timing).toBe('late_or_outcome_aware');
  });

  it('rejects contradictory not-started declarations containing a collection timestamp', () => {
    const { registration, snapshot, context } = setup();
    if (registration.record.kind !== 'pilot_registration')
      throw new Error('Expected registration');
    registration.record.outcome_access.collection_started_at =
      '2026-10-26T12:00:00Z';
    const registrationRecord = registration.record;
    expect(() =>
      validatePilotRecord(registrationRecord, snapshot, [], context),
    ).toThrow();
  });

  it('retains imported confirmation with a missing protocol, while excluding it from agreed delivery', () => {
    const { action, confirm, record, project } = setup();
    const result = project([
      record(confirm(action({ registration_id: null }))),
    ]);
    expect(result.actions[0]).toMatchObject({
      effective_status: 'confirmed',
      origin: 'imported_service',
      recorded_delivery: false,
    });
  });

  it('recognizes exact imported receipts and prevents later approval from retroauthorizing an action', () => {
    const first = setup();
    expect(
      first.project([
        first.registration,
        first.record(first.confirm(first.action())),
      ]).actions[0],
    ).toMatchObject({ effective_status: 'confirmed', recorded_delivery: true });
    const second = setup();
    const beforeApproval = second.action({
      occurred_at: '2026-09-30T23:59:59Z',
    });
    expect(
      second.project([
        second.registration,
        second.record(second.confirm(beforeApproval)),
      ]).actions[0],
    ).toMatchObject({
      effective_status: 'confirmed',
      recorded_delivery: false,
    });
  });

  it.each(['human_report', 'synthetic'] as const)(
    'never treats a %s wrapper as actual agreed delivery',
    (origin) => {
      const { registration, action, confirm, record, project } = setup();
      const result = project([
        registration,
        record(confirm(action(), { origin })),
      ]);
      expect(result.actions[0]?.recorded_delivery).toBe(false);
      expect(result.actions[0]?.effective_status).not.toBe('confirmed');
    },
  );

  it('compares offset timestamps as instants and rejects mismatched action versions and payloads', () => {
    const { registration, action, confirm, record, project } = setup();
    const valid = confirm(action({ occurred_at: '2026-10-27T20:00:00+08:00' }));
    expect(
      project([registration, record(valid)]).actions[0]?.recorded_delivery,
    ).toBe(true);
    for (const mismatch of [
      { action_version: '2' },
      { permitted_action: 'Unapproved different action' },
      { trigger_refs: [] },
    ]) {
      const result = project([
        registration,
        record(confirm(action(), mismatch)),
      ]);
      expect(result.actions[0]?.effective_status).toBe('unknown');
      expect(result.actions[0]?.recorded_delivery).toBe(false);
    }
  });

  it('rejects rebinding the same action identity to another operational payload', () => {
    const { registration, action, record, snapshot, context } = setup();
    const initial = record(action());
    const changed = {
      ...initial.record,
      permitted_action: 'Different schedule change',
    } as Action;
    expect(() =>
      validatePilotRecord(changed, snapshot, [registration, initial], context),
    ).toThrow();
  });

  it('rejects operational rule changes without a new rule version', () => {
    const {
      registration,
      input,
      draftContext,
      save,
      artifacts,
      makeDraft,
      snapshot,
      context,
    } = setup();
    const amendedInput = structuredClone(input);
    amendedInput.protocol_spec.version = '2';
    amendedInput.protocol_spec.digital_rule!.trigger_rule =
      'A different operational trigger';
    const original = save(amendedInput);
    const amended = makeDraft(amendedInput, {
      ...draftContext,
      input_ref: ref(original),
      evidence: [...artifacts.values()],
    });
    const amendment: PilotRecordBody = {
      kind: 'pilot_amendment',
      registration_id: registration.id,
      amended_protocol_ref: amended.protocol.artifact,
      review_ref: amended.review.artifact,
      reason: 'Explicit operational amendment',
      affected_fields: ['digital_rule'],
      outcomes_available: 'no',
      attested_by: 'Fixture operator',
      attested_at: now,
    };
    expect(() =>
      validatePilotRecord(amendment, snapshot, [registration], context),
    ).toThrow(/version/i);
  });
});
