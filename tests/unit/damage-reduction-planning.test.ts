import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Artifact } from '../../app/contracts/artifacts.js';
import type {
  ConditionalPlanInput,
  ReductionCandidate,
} from '../../app/contracts/damage-reduction-plan.js';
import { contractHash } from '../../app/contracts/json.js';
import { independentlyCheckReduction } from '../../app/capabilities/damage-reduction-planning/checker.js';
import {
  syntheticResidualImport,
  SYNTHETIC_REDUCTION_TARGET,
} from '../../app/capabilities/damage-reduction-planning/fixtures.js';
import {
  createReductionSelection,
  exactReductionRef,
} from '../../app/capabilities/damage-reduction-planning/inputs.js';
import { assessReduction } from '../../app/capabilities/damage-reduction-planning/methods.js';
import { draftConditionalPlan } from '../../app/capabilities/damage-reduction-planning/planning.js';
import { independentlyCheckConditionalPlan } from '../../app/capabilities/damage-reduction-planning/planning-checker.js';
import {
  FROZEN_PLANNING_CASES,
  syntheticReductionCandidate,
} from '../../app/capabilities/damage-reduction-planning/planning-fixtures.js';

function artifact(
  kind: string,
  content: unknown,
  assignmentId?: string,
): Artifact {
  return {
    schema_version: 'haze.artifact.v3',
    id: randomUUID(),
    version: 1,
    sha256: contractHash(content),
    kind,
    identity: { principal: 'test', workspace: 'test' },
    producer: {
      kind: assignmentId ? 'assignment' : 'user',
      id: assignmentId ?? 'test',
    },
    ...(assignmentId
      ? { assignment_id: assignmentId, assignment_revision: 1 }
      : {}),
    created_at: '2026-10-27T00:00:00Z',
    content: content as Artifact['content'],
    dependencies: [],
    required_tools: [],
    evidence_origin: 'synthetic_fixture',
  };
}
function fixture(
  intervention: string | null = '880',
  candidate: ReductionCandidate = syntheticReductionCandidate(),
  numericalOrigin: 'synthetic' | 'supplied' = 'synthetic',
): ConditionalPlanInput {
  const imported = syntheticResidualImport('1000', intervention);
  imported.origin = numericalOrigin;
  const original = artifact('artifact.import', imported);
  original.evidence_origin =
    numericalOrigin === 'synthetic' ? 'synthetic_fixture' : 'user_supplied';
  const selected = createReductionSelection(SYNTHETIC_REDUCTION_TARGET, [
    {
      artifact: exactReductionRef(original),
      row_ids: ['baseline-1', 'intervention-1'],
    },
  ]);
  const selection = artifact(
    'reduction.input-selection',
    selected,
    randomUUID(),
  );
  const assessment = artifact(
    'reduction.assessment',
    assessReduction(selected, [original], exactReductionRef(selection)),
    randomUUID(),
  );
  const reviewerId = randomUUID();
  const arithmeticReview = artifact(
    'reduction.review',
    independentlyCheckReduction(
      selected,
      [original],
      exactReductionRef(selection),
      assessment.content as ReturnType<typeof assessReduction>,
      exactReductionRef(assessment),
      { assignment_id: reviewerId, revision: 1 },
      assessment.assignment_id,
    ),
    reviewerId,
  );
  return {
    request: {
      schema_version: 'haze.reduction.preview-request.v1',
      selection: selected,
      candidate,
    },
    selection,
    assessment,
    arithmeticReview,
    sources: [original],
  };
}
function review(
  input: ConditionalPlanInput,
  content = draftConditionalPlan(input),
  reviewerId = randomUUID(),
  producerId = randomUUID(),
) {
  const plan = artifact('reduction.conditional-plan', content, producerId);
  return independentlyCheckConditionalPlan({
    ...input,
    plan,
    reviewer: { assignment_id: reviewerId, revision: 1 },
  });
}

describe('frozen conditional planning cases', () => {
  it.each(FROZEN_PLANNING_CASES)(
    '$id retains checked figures and its honest state',
    (testCase) => {
      const candidate = syntheticReductionCandidate();
      if (testCase.id === 'hard_subgroup_violation')
        candidate.constraints = [
          {
            id: 'subgroup-protection',
            description: 'No increased burden for vulnerable workers',
            hard: true,
            status: 'violated',
            evidence: [],
          },
        ];
      if (testCase.id === 'unsupported_effect_claim')
        candidate.claims = [
          {
            id: 'claimed-effect',
            kind: 'effect_estimate',
            statement: 'The product reduces damage by 90%.',
            evidence: [],
          },
        ];
      const input = fixture(testCase.supplied_intervention, candidate);
      const result = draftConditionalPlan(input);
      expect(result).toMatchObject({
        state: testCase.expected_state,
        point_estimate_label: testCase.expected_point_estimate_label,
        origin: 'synthetic',
        scientific_qualification: 'unqualified',
        achieved_reduction: false,
        delivery_status: 'not_delivered',
      });
      expect(review(input, result).verdict).toBe('supported');
    },
  );
  it('does not assume zero costs, capacity or feasibility from omitted inputs', () => {
    const candidate = syntheticReductionCandidate();
    candidate.costs = [];
    candidate.dependencies = [];
    const result = draftConditionalPlan(fixture('880', candidate));
    expect(result.prerequisites.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        'cost-estimate',
        'delivery-capacity',
        'feasibility-constraints',
        'scientific-applicability',
        'rule-owner',
        'trigger-rule',
        'action-rule',
        'human-rule-approval',
      ]),
    );
  });
  it('keeps an approved flag conditional without retained attestation and exact rules', () => {
    const candidate = syntheticReductionCandidate();
    candidate.approval.status = 'approved';
    expect(
      draftConditionalPlan(fixture('880', candidate)).prerequisites.some(
        (item) => item.id === 'human-rule-approval',
      ),
    ).toBe(true);
  });
  it('retains unpriced costs and unknown subgroup constraints as prerequisites', () => {
    const candidate = syntheticReductionCandidate();
    candidate.constraints = [
      {
        id: 'workers',
        description: 'Review subgroup protection',
        hard: true,
        status: 'unknown',
        evidence: [],
      },
    ];
    const result = draftConditionalPlan(fixture('880', candidate));
    expect(result.prerequisites.map((item) => item.reason)).toEqual(
      expect.arrayContaining(['cost', 'constraint', 'dependency']),
    );
    expect(result.state).toBe('conditional');
  });
  it('binds candidate scenario identity and exact versions', () => {
    const input = fixture();
    input.request.candidate.name = 'Another intervention';
    expect(draftConditionalPlan(input).state).toBe('blocked');
    const original = fixture();
    const plan = draftConditionalPlan(original);
    plan.candidate.version = 'another-version';
    expect(review(original, plan).verdict).toBe('rejected');
  });
  it('rejects specifications mistaken for quantified damage effects', () => {
    const input = fixture();
    input.request.candidate.claims.push({
      id: 'spec',
      kind: 'product_specification',
      statement: 'Filter specification implies 25% damage reduction.',
      evidence: [],
    });
    const plan = draftConditionalPlan(input);
    expect(plan.state).toBe('blocked');
    expect(
      plan.recommendations.some(
        (item) => item.action === 'consider_conditional_option',
      ),
    ).toBe(false);
    expect(review(input, plan).verdict).toBe('supported');
  });
  it('permits candidate evidence outside numerical selected originals', () => {
    const input = fixture();
    const source = artifact(
      'artifact.import',
      'Supplied service mechanism description, not an effect estimate.',
    );
    input.sources = [...input.sources, source];
    input.request.candidate.claims = [
      {
        id: 'mechanism',
        kind: 'mechanism',
        statement: 'The service sends alerts under an approved rule.',
        evidence: [exactReductionRef(source)],
      },
    ];
    const plan = draftConditionalPlan(input);
    expect(plan.source_refs).toContainEqual(exactReductionRef(source));
    expect(review(input, plan).verdict).toBe('supported');
  });
  it.each(['body-object', 'body-json-string', 'artifact-metadata'] as const)(
    'retains mixed synthetic planning provenance from %s',
    (label) => {
      const input = fixture('880', syntheticReductionCandidate(), 'supplied');
      expect(input.assessment.content).toMatchObject({ origin: 'supplied' });
      const payload = {
        origin: 'synthetic',
        description: 'Synthetic proposed service mechanism only.',
      };
      const candidateSource = artifact(
        'retained.planning-evidence',
        label === 'body-json-string'
          ? JSON.stringify(payload)
          : label === 'body-object'
            ? payload
            : 'Retained synthetic mechanism source.',
        randomUUID(),
      );
      candidateSource.evidence_origin =
        label === 'artifact-metadata' ? 'synthetic_fixture' : 'derived';
      input.sources = [...input.sources, candidateSource];
      input.request.candidate.claims = [
        {
          id: 'mechanism',
          kind: 'mechanism',
          statement: 'The service routes alerts to configured endpoints.',
          evidence: [exactReductionRef(candidateSource)],
        },
      ];
      const plan = draftConditionalPlan(input);
      expect(plan).toMatchObject({
        origin: 'synthetic',
        scientific_qualification: 'unqualified',
        delivery_status: 'not_delivered',
      });
      expect(review(input, plan).verdict).toBe('supported');
      plan.origin = 'supplied';
      expect(review(input, plan).verdict).toBe('rejected');
    },
  );
  it('does not import synthetic provenance from unselected unrelated context', () => {
    const input = fixture('880', syntheticReductionCandidate(), 'supplied');
    input.sources = [
      ...input.sources,
      artifact('artifact.import', { origin: 'synthetic', unrelated: true }),
    ];
    expect(draftConditionalPlan(input).origin).toBe('supplied');
    expect(review(input).verdict).toBe('supported');
  });
  it('allows a retained generated planning source without using it as numerical input', () => {
    const input = fixture('880', syntheticReductionCandidate(), 'supplied');
    const source = artifact(
      'retained.mechanism-note',
      {
        origin: 'supplied',
        description: 'Supplied service routing description; no effect claim.',
        quantity: 999999,
      },
      randomUUID(),
    );
    source.evidence_origin = 'derived';
    input.sources = [...input.sources, source];
    input.request.candidate.claims = [
      {
        id: 'mechanism',
        kind: 'mechanism',
        statement: 'The service routes alerts.',
        evidence: [exactReductionRef(source)],
      },
    ];
    const plan = draftConditionalPlan(input);
    expect(plan).toMatchObject({
      origin: 'supplied',
      point_estimate_label: 'meets',
    });
    expect(plan.source_refs).toContainEqual(exactReductionRef(source));
    expect(review(input, plan).verdict).toBe('supported');
  });
  it('requires human source-alignment review for supplied positive feasibility attestations', () => {
    const input = fixture();
    const source = exactReductionRef(input.sources[0]!);
    input.request.candidate.constraints = [
      {
        id: 'subgroup',
        description: 'Subgroup safeguard claimed satisfied',
        hard: true,
        status: 'satisfied',
        evidence: [source],
      },
    ];
    input.request.candidate.costs = [
      {
        id: 'cost',
        description: 'Supplied service cost',
        amount: '10',
        unit: 'test-units',
        evidence: [source],
        prerequisite: null,
      },
    ];
    input.request.candidate.dependencies = [
      {
        id: 'capacity',
        description: 'Supplied service capacity',
        status: 'available',
        evidence: [source],
      },
    ];
    const plan = draftConditionalPlan(input);
    const feasibility = plan.prerequisites.find(
      (item) => item.id === 'supplied-feasibility-review',
    );
    expect(feasibility?.reason).toBe('constraint');
    expect(feasibility?.description).toContain(
      'reference integrity does not establish document entailment',
    );
    expect(plan.state).toBe('conditional');
    expect(review(input, plan).verdict).toBe('supported');
    plan.prerequisites = plan.prerequisites.filter(
      (item) => item.id !== 'supplied-feasibility-review',
    );
    plan.recommendations = plan.recommendations.filter(
      (item) => !item.prerequisite_ids.includes('supplied-feasibility-review'),
    );
    expect(review(input, plan).verdict).toBe('rejected');
  });
  it('makes inaccessible source evidence an explicit gap', () => {
    const input = fixture();
    input.request.candidate.claims = [
      {
        id: 'mechanism',
        kind: 'mechanism',
        statement: 'A proposed service component',
        evidence: [{ id: randomUUID(), version: 1, sha256: 'a'.repeat(64) }],
      },
    ];
    expect(draftConditionalPlan(input)).toMatchObject({
      state: 'evidence_gap',
    });
    expect(review(input).verdict).toBe('supported');
  });
  it('does not inherit stale or mismatched arithmetic reviews', () => {
    const input = fixture();
    const reviewData = structuredClone(
      input.arithmeticReview.content,
    ) as Record<string, unknown>;
    reviewData.reviewed_artifacts = [];
    input.arithmeticReview = artifact(
      'reduction.review',
      reviewData,
      input.arithmeticReview.assignment_id,
    );
    const result = draftConditionalPlan(input);
    expect(result).toMatchObject({
      state: 'evidence_gap',
      point_estimate_label: 'unavailable',
    });
  });
});

describe('independent plan checking', () => {
  it('rejects self-review', () => {
    const input = fixture();
    const id = randomUUID();
    expect(review(input, undefined, id, id).verdict).toBe('rejected');
  });
  it('rejects hidden hard objections even when the point estimate meets target', () => {
    const input = fixture();
    input.request.candidate.constraints = [
      {
        id: 'vulnerable-workers',
        description: 'No additional burden',
        hard: true,
        status: 'violated',
        evidence: [],
      },
    ];
    const plan = draftConditionalPlan(input);
    plan.state = 'conditional';
    plan.objections = [];
    expect(review(input, plan).verdict).toBe('rejected');
  });
  it('rejects an unsupported recommendation without evidence or prerequisite', () => {
    const input = fixture();
    const plan = draftConditionalPlan(input);
    plan.recommendations.push({
      id: 'unsupported',
      action: 'consider_conditional_option',
      description:
        'Deploy now because specifications prove achieved reduction.',
      evidence: [],
      prerequisite_ids: [],
    });
    expect(review(input, plan).verdict).toBe('rejected');
  });
  it('rejects forged operational prose even when a recommendation mirrors its prerequisite', () => {
    const input = fixture();
    const plan = draftConditionalPlan(input);
    const prerequisite = plan.prerequisites.find(
      (item) => item.id === 'scientific-applicability',
    )!;
    prerequisite.description =
      'Deploy now because this plan proves achieved damage reduction.';
    plan.recommendations.find(
      (item) => item.prerequisite_ids[0] === prerequisite.id,
    )!.description = prerequisite.description;
    expect(review(input, plan).verdict).toBe('rejected');
  });
  it('rejects altered threshold labels and numerical producer/checker disagreements', () => {
    const input = fixture('950');
    const plan = draftConditionalPlan(input);
    plan.point_estimate_label = 'meets';
    expect(review(input, plan).verdict).toBe('rejected');
    const forged = fixture();
    const data = structuredClone(forged.assessment.content) as Record<
      string,
      unknown
    >;
    data.target_met = false;
    forged.assessment = artifact(
      'reduction.assessment',
      data,
      forged.assessment.assignment_id,
    );
    const reviewData = structuredClone(
      forged.arithmeticReview.content,
    ) as Record<string, unknown>;
    reviewData.reviewed_artifacts = [
      exactReductionRef(forged.selection),
      exactReductionRef(forged.assessment),
    ];
    forged.arithmeticReview = artifact(
      'reduction.review',
      reviewData,
      forged.arithmeticReview.assignment_id,
    );
    expect(review(forged).verdict).toBe('rejected');
  });
  it('rejects synthetic evidence relabelled as empirical and scientific approval', () => {
    const input = fixture();
    const plan = draftConditionalPlan(input);
    plan.origin = 'supplied';
    expect(review(input, plan).verdict).toBe('rejected');
    const claimed = {
      ...draftConditionalPlan(input),
      scientific_qualification: 'qualified',
    };
    const saved = artifact('reduction.conditional-plan', claimed, randomUUID());
    expect(
      independentlyCheckConditionalPlan({
        ...input,
        plan: saved,
        reviewer: { assignment_id: randomUUID(), revision: 1 },
      }).verdict,
    ).toBe('rejected');
  });
});
