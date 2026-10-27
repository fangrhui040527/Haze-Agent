import { describe, expect, it } from 'vitest';
import type { Artifact, ArtifactRef } from '../../app/contracts/artifacts.js';
import {
  evaluationDecimalSchema,
  externalEvaluationInputSchema,
  type ExternalEvaluationExpectedOutput,
  type ExternalEvaluationInput,
} from '../../app/contracts/damage-reduction-evaluation.js';
import { contractHash } from '../../app/contracts/json.js';
import {
  draftExternalEvaluation,
  independentlyReviewExternalEvaluation,
  inspectEvaluationDossier,
} from '../../app/capabilities/damage-reduction-programmes/evaluation-methods.js';
import {
  syntheticExternalEvaluationInput,
  syntheticEvaluationExpectedOutput,
  syntheticQualificationDossier,
  evaluationFixtureContext,
} from '../../app/capabilities/damage-reduction-programmes/evaluation-fixtures.js';
import { suppliedCompletePilotInput } from '../../app/capabilities/damage-reduction-programmes/pilot-fixtures.js';
import { draftPilot } from '../../app/capabilities/damage-reduction-programmes/pilot-methods.js';
import { SYNTHETIC_REDUCTION_TARGET } from '../../app/capabilities/damage-reduction-planning/fixtures.js';

const id = (number: number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const ref = ({ id, version, sha256 }: ArtifactRef): ArtifactRef => ({
  id,
  version,
  sha256,
});
const identity = {
  principal: 'evaluation-unit-test',
  workspace: 'evaluation-unit-test',
};
const now = '2026-10-27T12:00:00Z';
type Numbers = Pick<
  ExternalEvaluationExpectedOutput,
  | 'baseline_damage'
  | 'intervention_damage'
  | 'absolute_reduction'
  | 'relative_reduction'
  | 'target_met'
>;
const EXPECTED_SUPPORT: Numbers = {
  baseline_damage: '1000',
  intervention_damage: '880',
  absolute_reduction: '120',
  relative_reduction: { numerator: '120', denominator: '1000' },
  target_met: true,
};

function fixture(
  change: (input: ExternalEvaluationInput) => void = () => {},
  numbers: Numbers = EXPECTED_SUPPORT,
) {
  let sequence = 20;
  const artifacts: Artifact[] = [];
  const save = (
    content: Artifact['content'],
    kind = 'source.import',
    assignment?: string,
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
      evidence_origin: 'user_supplied',
    };
    artifacts.push(artifact);
    return artifact;
  };
  const report = save({
    origin: 'supplied',
    description: 'Invented report fixture only; no real scientific case.',
  });
  const data = save({
    origin: 'supplied',
    description: 'Invented original comparative data fixture.',
  });
  const externalReview = save({
    origin: 'supplied',
    description: 'Invented retained external scientific review attestation.',
  });
  const target = structuredClone(SYNTHETIC_REDUCTION_TARGET);
  const pilot = suppliedCompletePilotInput(ref(report));
  const protocolValue = draftPilot(pilot, {
    programme_id: id(1),
    input_ref: ref(report),
    selection_ref: ref(report),
    assessment_ref: ref(report),
    plan_ref: ref(report),
    plan_review_ref: ref(report),
    target,
    target_sha256: contractHash(target),
    scope_sha256: contractHash(target.scope),
    evidence: [report],
  }).protocol;
  const protocol = save(protocolValue, 'reduction.pilot-protocol', id(2));
  const input = syntheticExternalEvaluationInput({
    programme_id: id(1),
    target_sha256: contractHash(target),
    scope_sha256: contractHash(target.scope),
    scope: target.scope,
    registration_id: id(5),
    protocol_ref: ref(protocol),
    action_record_ids: [id(6)],
    rules: [{ id: pilot.protocol_spec.digital_rule!.id, version: '1' }],
    report_ref: ref(report),
    data_ref: ref(data),
    review_ref: ref(externalReview),
    expected_output_ref: ref(report),
  });
  change(input);
  const expected = save({
    ...syntheticEvaluationExpectedOutput(input),
    origin: input.origin,
    ...numbers,
  });
  input.expected_output_refs = [ref(expected)];
  const original = save(input);
  const context = evaluationFixtureContext(
    input,
    ref(original),
    target,
    artifacts,
  );
  const draft = () => draftExternalEvaluation(input, context);
  const check = (products = draft(), reviewerId = id(4)) =>
    independentlyReviewExternalEvaluation(
      input,
      context,
      save(products.result, 'reduction.external-evaluation', id(3)),
      save(products.learning, 'reduction.evaluation-learning', id(3)),
      { assignment_id: reviewerId, revision: 1 },
    );
  return {
    input,
    context,
    draft,
    check,
    save,
    report,
    data,
    externalReview,
    expected,
    original,
    protocol,
    artifacts,
  };
}

describe('reviewed external point-estimate comparison', () => {
  it('reproduces the frozen 1000 to 880 comparison with distinct technical and scientific states', () => {
    const { draft, check } = fixture();
    const products = draft();
    expect(products.result).toMatchObject({
      ...EXPECTED_SUPPORT,
      status: 'supported',
      origin: 'synthetic',
      scientific_qualification: 'unqualified',
      achieved_reduction: false,
    });
    expect(products.learning.outcome).toBe('point_estimate_meets');
    expect(check(products)).toMatchObject({
      verdict: 'supported',
      scientific_qualification: 'unqualified',
      qualification_check: { status: 'not_supplied' },
    });
  });

  it('completes a below-target comparison without turning it into a failed technical review', () => {
    const numbers: Numbers = {
      baseline_damage: '1000',
      intervention_damage: '950',
      absolute_reduction: '50',
      relative_reduction: { numerator: '50', denominator: '1000' },
      target_met: false,
    };
    const { draft, check } = fixture((input) => {
      input.comparative_estimates.intervention = '950';
    }, numbers);
    expect(draft().result).toMatchObject({ ...numbers, status: 'supported' });
    expect(draft().learning.outcome).toBe('point_estimate_below');
    expect(check().verdict).toBe('supported');
  });

  it('preserves unknown quantities as a reviewed evidence gap', () => {
    const numbers: Numbers = {
      baseline_damage: null,
      intervention_damage: null,
      absolute_reduction: null,
      relative_reduction: null,
      target_met: null,
    };
    const { draft, check } = fixture((input) => {
      input.comparative_estimates.intervention = null;
    }, numbers);
    expect(draft().result).toMatchObject({ status: 'gap', target_met: null });
    expect(draft().learning.outcome).toBe('insufficient_evidence');
    expect(check().verdict).toBe('supported');
  });

  it.each(['uncertainty_bound', 'probability'] as const)(
    'retains unsupported %s and never substitutes a point conclusion',
    (criterion) => {
      const numbers = {
        ...EXPECTED_SUPPORT,
        relative_reduction: null,
        target_met: null,
      };
      const { draft, check } = fixture((input) => {
        input.criterion.kind = criterion;
      }, numbers);
      expect(draft().result).toMatchObject({
        status: 'gap',
        criterion: { kind: criterion },
        target_met: null,
        relative_reduction: null,
        absolute_reduction: '120',
      });
      expect(draft().result.reasons.join(' ')).toContain(
        `unsupported_${criterion}_criterion`,
      );
      expect(check().verdict).toBe('supported');
    },
  );

  it('preserves meaningful subtraction for zero baselines without dividing', () => {
    const numbers: Numbers = {
      baseline_damage: '0',
      intervention_damage: '1',
      absolute_reduction: '-1',
      relative_reduction: null,
      target_met: null,
    };
    const { draft, check } = fixture((input) => {
      input.comparative_estimates = { baseline: '0', intervention: '1' };
    }, numbers);
    expect(draft().result).toMatchObject({ ...numbers, status: 'gap' });
    expect(check().verdict).toBe('supported');
  });

  it('compares decimal equality exactly without binary rounding', () => {
    const numbers: Numbers = {
      baseline_damage: '0.3',
      intervention_damage: '0.27',
      absolute_reduction: '0.03',
      relative_reduction: { numerator: '0.03', denominator: '0.3' },
      target_met: true,
    };
    const { draft, check } = fixture((input) => {
      input.comparative_estimates = { baseline: '0.3', intervention: '0.27' };
    }, numbers);
    expect(draft().result).toMatchObject({ ...numbers, status: 'supported' });
    expect(check().verdict).toBe('supported');
  });

  it('retains canonical original tokens and rejects excessive precision and noncanonical decimals', () => {
    for (const token of [
      '-0',
      '1.0',
      '01',
      '1e3',
      '0.0000000000001',
      '1234567890123456789',
    ])
      expect(evaluationDecimalSchema.safeParse(token).success).toBe(false);
    const { input, draft } = fixture();
    expect(draft().result.original_estimates).toEqual(
      input.comparative_estimates,
    );
    expect(
      externalEvaluationInputSchema.safeParse({
        ...input,
        unexpected_causal_estimator: 'invented',
      }).success,
    ).toBe(false);
  });

  it.each(['scope', 'programme', 'method', 'analysis_basis'] as const)(
    'reports incompatible %s binding without a target conclusion',
    (field) => {
      const { context, draft, check } = fixture();
      if (field === 'scope') context.scope_sha256 = 'a'.repeat(64);
      if (field === 'programme') context.programme_id = id(9);
      if (field === 'method') {
        const value = context.evidence.find(
          (artifact) => artifact.kind === 'reduction.pilot-protocol',
        )!;
        const content = structuredClone(value.content) as {
          specification: { analysis_method: { id: string } };
        };
        content.specification.analysis_method.id = 'another-method';
        value.content = content;
        value.sha256 = contractHash(content);
        // The previous exact reference remains unavailable, preventing implicit source replacement.
      }
      if (field === 'analysis_basis') context.analysis_basis = 'exploratory';
      const products = draft();
      expect(products.result.status).not.toBe('supported');
      if (field !== 'method') expect(products.result.target_met).toBeNull();
      expect(check(products).verdict).toBe('supported');
    },
  );

  it('rejects producer tampering and self-review independently', () => {
    const { draft, check } = fixture();
    const changed = draft();
    changed.result.absolute_reduction = '121';
    expect(check(changed).verdict).toBe('rejected');
    expect(check(draft(), id(3)).verdict).toBe('rejected');
  });

  it('rejects an independently supplied expected output disagreement', () => {
    const { draft, check } = fixture(() => {}, {
      ...EXPECTED_SUPPORT,
      target_met: false,
    });
    expect(draft().result).toMatchObject({
      status: 'incompatible',
      target_met: null,
      relative_reduction: null,
    });
    expect(draft().result.reasons).toContain(
      'independent_expected_output_mismatch',
    );
    expect(check().verdict).toBe('supported');
  });

  it('does not treat before-after or unaccounted material deviations as sufficient evidence', () => {
    const { input, context, draft } = fixture((input) => {
      input.design.identification = 'before_after_only';
    });
    context.delivery.unresolved_material_deviation_record_ids = [id(10)];
    expect(draft().result.status).toBe('gap');
    expect(draft().result.reasons).toContain(
      'material_deviations_not_accounted_for',
    );
    expect(draft().result.reasons).toContain(
      'external_comparative_design_required',
    );
    expect(input.design.identification).toBe('before_after_only');
  });

  it('retains synthetic provenance through dependency metadata despite supplied labels', () => {
    const { context, draft, check, data, save } = fixture((input) => {
      input.origin = 'supplied';
    });
    const synthetic = save({
      origin: 'supplied',
      description: 'Synthetic source with an honest metadata flag.',
    });
    synthetic.evidence_origin = 'synthetic_fixture';
    data.dependencies = [ref(synthetic)];
    expect(draft().result.origin).toBe('synthetic');
    expect(check().verdict).toBe('supported');
    context.evidence = context.evidence.filter(
      (artifact) => artifact.id !== synthetic.id,
    );
    expect(draft().result).toMatchObject({ status: 'gap', origin: 'unknown' });
  });

  it('includes explicitly scoped registration and delivery proof origins without adopting unrelated evidence', () => {
    const { context, save, draft, check } = fixture((input) => {
      input.origin = 'supplied';
    });
    const proof = save({
      origin: 'synthetic',
      description: 'An explicitly selected simulated service proof.',
    });
    expect(draft().result.origin).toBe('supplied');
    context.supporting_refs = [ref(proof)];
    expect(draft().result.origin).toBe('synthetic');
    expect(check().verdict).toBe('supported');
    context.evidence = context.evidence.filter(
      (artifact) => artifact.id !== proof.id,
    );
    expect(draft().result).toMatchObject({ status: 'gap', origin: 'unknown' });
    expect(check().verdict).toBe('supported');
  });

  it('inspects imported qualification without granting authority and blocks self-review or source substitution', () => {
    const { input, context, original, save, check, draft } = fixture(
      (input) => {
        input.origin = 'supplied';
      },
    );
    const dossier = syntheticQualificationDossier(input, ref(original));
    dossier.origin = 'supplied';
    dossier.decision = 'qualified';
    dossier.applicability = {
      decision: 'applicable',
      statement: 'Invented engineering applicability attestation only.',
      prerequisites: [],
      unresolved_material_objections: [],
    };
    const artifact = save(dossier);
    context.dossier_ref = ref(artifact);
    expect(inspectEvaluationDossier(input, context).status).toBe('complete');
    expect(draft().result.scientific_qualification).toBe('unqualified');
    expect(check().qualification_check.status).toBe('complete');
    const wrong = {
      ...dossier,
      reviewer: { ...dossier.reviewer, name: input.authors[0]!.name },
    };
    context.dossier_ref = ref(save(wrong));
    expect(inspectEvaluationDossier(input, context).status).toBe('incomplete');
    context.dossier_ref = ref(
      save({ ...dossier, data_refs: dossier.report_refs }),
    );
    expect(inspectEvaluationDossier(input, context).status).toBe('incomplete');
  });
});
