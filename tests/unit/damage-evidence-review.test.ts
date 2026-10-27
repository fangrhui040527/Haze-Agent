import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  artifactSchema,
  type Artifact,
} from '../../app/contracts/artifacts.js';
import {
  damageAccountSchema,
  damageScopeSchema,
} from '../../app/contracts/damage-account.js';
import {
  damageComparisonRequestSchema,
  damageComparisonReviewSchema,
  type DamageApplicability,
} from '../../app/contracts/damage-evidence-review.js';
import { contractHash } from '../../app/contracts/json.js';
import { createSyntheticDamageImport } from '../../app/capabilities/damage-appraisal/fixtures.js';
import { compareDamageInterventions } from '../../app/capabilities/damage-evidence-review/comparison.js';
import { createDamageEvidenceReviewTools } from '../../app/capabilities/damage-evidence-review/index.js';
import { normalizeDamageInputs } from '../../app/capabilities/damage-appraisal/inputs.js';
import type { ToolContext } from '../../app/orchestration/ports.js';
import {
  assertScientificInputBindings,
  checkScientificReview,
  exactEvidenceRef,
  importPublishedPhysicalEffect,
} from '../../app/capabilities/damage-evidence-review/science.js';

const now = '2026-10-27T00:00:00Z';
const applicability: DamageApplicability = {
  geography: {
    country_code: 'MY',
    level: 'country',
    code_system: 'ISO-3166-1',
    code: 'MY',
    boundary_version: '2015',
  },
  occurrence_period: { start: '2015-09-01', end: '2015-10-31' },
  population: 'Test population, not an empirical estimate',
  endpoint: 'mortality',
  unit: 'expected_deaths',
  attribution_basis: 'published_haze',
  exposure_duration: '2015 episode',
  comparison_scenario: 'no-target-fire',
};
function artifact(
  kind: string,
  content: unknown,
  producer: Artifact['producer']['kind'] = 'service',
): Artifact {
  const reviewer =
    typeof content === 'object' && content !== null && 'reviewer' in content
      ? content.reviewer
      : undefined;
  const assignmentId =
    producer === 'assignment'
      ? typeof reviewer === 'object' &&
        reviewer !== null &&
        'assignment_id' in reviewer
        ? reviewer.assignment_id
        : randomUUID()
      : undefined;
  return artifactSchema.parse({
    schema_version: 'haze.artifact.v3',
    id: randomUUID(),
    version: 1,
    sha256: contractHash(content),
    identity: { principal: 'test', workspace: 'test' },
    kind,
    producer: { kind: producer, id: assignmentId ?? 'test' },
    ...(assignmentId
      ? { assignment_id: assignmentId, assignment_revision: 1 }
      : {}),
    created_at: now,
    dependencies: [],
    required_tools: [],
    content,
    evidence_origin: producer === 'user' ? 'user_supplied' : 'derived',
  });
}
/** All numbers below are explicitly synthetic contract-test data. */
function evidence() {
  const raw = artifact(
    'damage.original-evidence',
    'Synthetic table for software tests: 100 expected deaths.',
  );
  const published = artifact('damage.published-effect', {
    schema_version: 'haze.damage.published-effect.v1',
    effect_id: 'historical-mortality',
    quantity: 100,
    applicability,
    source_refs: [exactEvidenceRef(raw)],
    source_locator: 'Synthetic Table 1, row 1',
  });
  const invocation = {
    schema_version: 'haze.damage.method-invocation.v1',
    method_id: 'damage.published-physical-effect.v1',
    method_version: '1',
    applicability,
    inputs: [exactEvidenceRef(published), exactEvidenceRef(raw)],
    source_location: {
      artifact: exactEvidenceRef(published),
      locator: 'Synthetic Table 1, row 1',
    },
    parameters: { effect_id: 'historical-mortality' },
    uncertainty: {
      interpretation: 'not_quantified',
      basis: 'Synthetic tests only.',
    },
  };
  const output = artifact(
    'damage.method-output',
    importPublishedPhysicalEffect(invocation, [raw, published]),
    'assignment',
  );
  const reviewContent = {
    schema_version: 'haze.damage.scientific-review.v1',
    reviewed_output: exactEvidenceRef(output),
    reviewed_inputs: invocation.inputs,
    method_id: invocation.method_id,
    method_version: '1',
    applicability,
    verdict: 'applicable',
    expert: {
      name: 'Synthetic Reviewer',
      qualification: 'Contract-test role',
      decision_basis: 'Tests only, no real scientific decision.',
    },
    decided_at: '2026-10-26T00:00:00Z',
    expires_at: '2027-10-26T00:00:00Z',
    unresolved_questions: [],
    limitations: ['Synthetic test.'],
  };
  const review = artifact('damage.scientific-review', reviewContent, 'user');
  const artifacts = [raw, published, output, review];
  const check = artifact(
    'damage.scientific-check',
    checkScientificReview({ output, review, artifacts, now }),
    'assignment',
  );
  artifacts.push(check);
  return {
    raw,
    published,
    invocation,
    output,
    review,
    reviewContent,
    artifacts,
    check,
  };
}
function comparisonFixture() {
  const source = evidence();
  const scope = damageScopeSchema.parse({
    ...createSyntheticDamageImport().scope,
    population: applicability.population,
    reporting: {
      schema_version: 'haze.damage.reporting.v2',
      reporting_type: 'historical_account',
      applicability,
      assumptions: ['Synthetic contract test.'],
      scientific_bindings: [
        {
          method_output: exactEvidenceRef(source.output),
          expert_review: exactEvidenceRef(source.review),
        },
      ],
    },
  });
  const account = artifact(
    'damage.account',
    damageAccountSchema.parse({
      schema_version: 'haze.damage.account.v1',
      account_id: scope.account_id,
      scope,
      status: 'partial',
      evidence_origin: 'imported',
      component_refs: [
        'damage.scope',
        'damage.inputs',
        'damage.coverage',
        'damage.physical',
        'damage.incidence',
        'damage.welfare',
        'damage.overlap',
        'damage.methods',
        'damage.scenarios',
      ].map((kind) => ({ kind, artifact: exactEvidenceRef(source.raw) })),
      source_refs: [exactEvidenceRef(source.raw)],
      physical_totals: [
        {
          scenario_id: 'historical',
          endpoint_id: 'mortality',
          unit: 'expected_deaths',
          quantity: 100,
        },
      ],
      financing_totals: [],
      welfare_totals: [],
      coverage: [],
      omissions: [],
      scenarios: [],
      limitations: ['Synthetic contract tests only.'],
      review_status: 'requires_independent_review',
    }),
    'assignment',
  );
  const arithmetic = artifact(
    'damage.review',
    {
      schema_version: 'haze.damage.review.v1',
      verdict: 'supported',
      reviewed_artifacts: [exactEvidenceRef(account)],
      checks: ['Synthetic arithmetic review'],
      findings: [],
      limitations: [],
      applicability: 'not_established_by_arithmetic',
      reviewer: { assignment_id: randomUUID(), revision: 1 },
    },
    'assignment',
  );
  const artifacts = [...source.artifacts, account, arithmetic];
  const baseline = {
    account: exactEvidenceRef(account),
    applicability,
    valuation: { view: 'physical', currency: null, price_year: null },
    quantity: 100,
    scientific_check: exactEvidenceRef(source.check),
    arithmetic_review: exactEvidenceRef(arithmetic),
  };
  const intervention = (id: 'A' | 'B', effectiveness: number, cost: number) => {
    const parameter = (key: string, value: number) => {
      const money = key === 'cost';
      const evidenceArtifact = artifact('damage.parameter-evidence', {
        schema_version: 'haze.damage.parameter-evidence.v1',
        parameter: key,
        value,
        unit: money ? 'MYR' : 'fraction',
        applicability,
        source_refs: [exactEvidenceRef(source.raw)],
        source_locator: 'Synthetic parameter row.',
        ...(money
          ? { price_year: 2015, horizon: applicability.occurrence_period }
          : {}),
      });
      artifacts.push(evidenceArtifact);
      return {
        value,
        basis: 'evidence',
        explanation: 'Synthetic parameter for contract test.',
        evidence: [exactEvidenceRef(evidenceArtifact)],
      };
    };
    return {
      id,
      baseline,
      method_id: 'damage.evidenced-residual.v1',
      mechanism: 'Synthetic exposure protection mechanism.',
      implementation_scope: 'Test population only.',
      prerequisites: ['Synthetic test.'],
      adoption: parameter('adoption', 1),
      effectiveness: parameter('effectiveness', effectiveness),
      cost: parameter('cost', cost),
      cost_basis: {
        currency: 'MYR',
        price_year: 2015,
        horizon: applicability.occurrence_period,
      },
    };
  };
  const request = damageComparisonRequestSchema.parse({
    schema_version: 'haze.damage.comparison-request.v1',
    baseline,
    interventions: [intervention('A', 0.2, 1000), intervention('B', 0.05, 200)],
  });
  return { request, artifacts, source, account };
}

describe('damage scientific applicability', () => {
  it('reproduces a published effect and checks a separate exact expert decision', () => {
    const value = evidence();
    expect(checkScientificReview({ ...value, now }).qualified).toBe(true);
    expect(
      importPublishedPhysicalEffect(value.invocation, value.artifacts).quantity,
    ).toBe(100);
  });
  it('rejects generated expert authority, stale decisions and mismatched versions', () => {
    const value = evidence();
    for (const review of [
      artifact('damage.scientific-review', value.reviewContent, 'assignment'),
      artifact(
        'damage.scientific-review',
        { ...value.reviewContent, expires_at: '2026-10-26T12:00:00Z' },
        'user',
      ),
      artifact(
        'damage.scientific-review',
        {
          ...value.reviewContent,
          reviewed_output: { ...exactEvidenceRef(value.output), version: 2 },
        },
        'user',
      ),
      artifact(
        'damage.scientific-review',
        {
          ...value.reviewContent,
          verdict: 'unresolved',
          unresolved_questions: ['Unreviewed endpoint.'],
        },
        'user',
      ),
    ])
      expect(
        checkScientificReview({
          output: value.output,
          review,
          artifacts: [...value.artifacts, review],
          now,
        }).qualified,
      ).toBe(false);
  });
  it('rejects a later observation period or another pollutant and never extrapolates a method', () => {
    const value = evidence();
    const wrongPeriod = {
      ...applicability,
      occurrence_period: { start: '2026-10-01', end: '2026-10-31' },
    };
    expect(
      checkScientificReview({ ...value, applicability: wrongPeriod, now })
        .qualified,
    ).toBe(false);
    expect(() =>
      importPublishedPhysicalEffect(
        {
          ...value.invocation,
          applicability: { ...applicability, unit: 'pm10' },
        },
        value.artifacts,
      ),
    ).toThrow(/applicability/);
  });
  it('keeps legacy scope readable without adding attribution or review metadata', () => {
    const scope = damageScopeSchema.parse(createSyntheticDamageImport().scope);
    expect(scope.reporting).toBeUndefined();
    const value = comparisonFixture();
    const input = {
      scope: {
        ...scope,
        reporting:
          value.account.content &&
          damageAccountSchema.parse(value.account.content).scope.reporting,
      },
    };
    expect(() => assertScientificInputBindings(input as never, [])).toThrow();
  });
  it('keeps synthetic origins outside scientific public-evidence qualification', () => {
    const value = evidence();
    value.raw.evidence_origin = 'synthetic_fixture';
    expect(checkScientificReview({ ...value, now }).qualified).toBe(false);
  });
  it('binds reviewed quantities to accounting inputs and rejects a changed physical quantity', () => {
    const value = comparisonFixture();
    const bundle = createSyntheticDamageImport();
    bundle.scope = damageAccountSchema.parse(value.account.content).scope;
    bundle.effects = bundle.effects.filter(
      (effect) => effect.effect_id === 'historical-mortality',
    );
    bundle.effects[0]!.quantity = 100;
    bundle.effects[0]!.origin = 'imported';
    bundle.effects[0]!.population_stratum = applicability.population;
    bundle.effects[0]!.geography_id = applicability.geography;
    bundle.effects[0]!.uncertainty = {
      interpretation: 'not_quantified',
      basis: 'Contract test.',
    };
    const retained = artifact('source.import', bundle, 'user');
    const inputs = normalizeDamageInputs([retained]);
    expect(() =>
      assertScientificInputBindings(
        inputs,
        [...value.artifacts, retained],
        now,
      ),
    ).not.toThrow();
    inputs.effects[0]!.quantity = 101;
    expect(() =>
      assertScientificInputBindings(
        inputs,
        [...value.artifacts, retained],
        now,
      ),
    ).toThrow(/Each reported physical effect/);
    inputs.effects[0]!.quantity = 100;
    inputs.effects[0]!.geography_id = {
      ...applicability.geography,
      code: 'MY-10',
    };
    expect(() =>
      assertScientificInputBindings(
        inputs,
        [...value.artifacts, retained],
        now,
      ),
    ).toThrow(/Each reported physical effect/);
    inputs.effects[0]!.geography_id = applicability.geography;
    inputs.effects[0]!.population_stratum = 'Different overlapping population';
    expect(() =>
      assertScientificInputBindings(
        inputs,
        [...value.artifacts, retained],
        now,
      ),
    ).toThrow(/Each reported physical effect/);
  });
});

describe('one-baseline intervention comparisons', () => {
  const monetaryFixture = () => {
    const value = comparisonFixture();
    const original = damageAccountSchema.parse(value.account.content);
    original.scope.currency = 'MYR';
    original.financing_totals = [
      {
        scenario_id: 'historical',
        amount: 1000,
        currency: 'MYR',
        price_year: 2015,
      },
    ];
    const account = artifact('damage.account', original, 'assignment');
    const review = artifact(
      'damage.review',
      {
        schema_version: 'haze.damage.review.v1',
        verdict: 'supported',
        reviewed_artifacts: [exactEvidenceRef(account)],
        checks: ['Synthetic monetary fixture reconstruction.'],
        findings: [],
        limitations: [],
        applicability: 'not_established_by_arithmetic',
        reviewer: { assignment_id: randomUUID(), revision: 1 },
      },
      'assignment',
    );
    value.artifacts.push(account, review);
    value.request.baseline = {
      ...value.request.baseline,
      account: exactEvidenceRef(account),
      arithmetic_review: exactEvidenceRef(review),
      quantity: 1000,
      valuation: { view: 'financial_loss', currency: 'MYR', price_year: 2015 },
    };
    for (const intervention of value.request.interventions)
      intervention.baseline = structuredClone(value.request.baseline);
    return value;
  };
  it('derives monetary net benefit from the same registered avoided damage and cost basis', () => {
    const value = monetaryFixture();
    const result = compareDamageInterventions(
      value.request,
      value.artifacts,
      now,
    );
    expect(result.interventions[0]).toMatchObject({
      avoided_damage: 200,
      intervention_cost: 1000,
      net_monetary_benefit: -800,
    });
    expect(result.interventions[1]).toMatchObject({
      avoided_damage: 50,
      intervention_cost: 200,
      net_monetary_benefit: -150,
    });
    value.request.interventions[0].avoided_monetary_damage = {
      value: 900,
      basis: 'assumption',
      explanation: 'Conflicting monetary estimate.',
      evidence: [],
    };
    const conflicting = compareDamageInterventions(
      value.request,
      value.artifacts,
      now,
    );
    expect(conflicting.interventions[0].net_monetary_benefit).toBeNull();
    expect(conflicting.interventions[0].gaps.join(' ')).toMatch(
      /conflicts with the registered baseline reduction/,
    );
  });
  it('withholds a baseline whose arithmetic review came from its producing assignment', () => {
    const value = comparisonFixture();
    const oldReview = value.artifacts.find(
      (a) => a.id === value.request.baseline.arithmetic_review.id,
    )!;
    const content = {
      ...(oldReview.content as Record<string, unknown>),
      reviewer: { assignment_id: value.account.assignment_id, revision: 1 },
    };
    const sameProducer = artifact('damage.review', content, 'assignment');
    value.artifacts.push(sameProducer);
    value.request.baseline.arithmetic_review = exactEvidenceRef(sameProducer);
    for (const intervention of value.request.interventions)
      intervention.baseline = structuredClone(value.request.baseline);
    const result = compareDamageInterventions(
      value.request,
      value.artifacts,
      now,
    );
    expect(
      result.interventions.every((i) => i.status === 'insufficient_evidence'),
    ).toBe(true);
    expect(result.gaps.join(' ')).toMatch(/independent arithmetic review/);
  });
  it('retains a below-10% lower-budget B and separates costs from outcomes', () => {
    const value = comparisonFixture();
    const result = compareDamageInterventions(
      value.request,
      value.artifacts,
      now,
    );
    expect(result.lower_budget_verified).toBe(true);
    expect(result.interventions[0]).toMatchObject({
      status: 'meets_target',
      residual_damage: 80,
      avoided_damage: 20,
      reduction_percent: 20,
      intervention_cost: 1000,
      net_monetary_benefit: null,
    });
    expect(result.interventions[1]).toMatchObject({
      status: 'below_target',
      residual_damage: 95,
      avoided_damage: 5,
      reduction_percent: 5,
      intervention_cost: 200,
    });
  });
  it('rejects changed A/B baseline versions, units, population or valuation basis', () => {
    const value = comparisonFixture();
    value.request.interventions[1].baseline.account.version = 2;
    expect(() =>
      compareDamageInterventions(value.request, value.artifacts, now),
    ).toThrow(/share the exact/);
  });
  it('never fills unknown effectiveness with zero and keeps cost evidence independent', () => {
    const value = comparisonFixture();
    value.request.interventions[1].effectiveness = {
      value: null,
      basis: 'unavailable',
      explanation: 'No causal evidence.',
      evidence: [],
    };
    const result = compareDamageInterventions(
      value.request,
      value.artifacts,
      now,
    );
    expect(result.interventions[1]).toMatchObject({
      status: 'insufficient_evidence',
      residual_damage: null,
      avoided_damage: null,
      reduction_percent: null,
      intervention_cost: 200,
    });
  });
  it('withholds scientific results when a previously applicable review expires', () => {
    const value = comparisonFixture();
    const result = compareDamageInterventions(
      value.request,
      value.artifacts,
      '2028-01-01T00:00:00Z',
    );
    expect(
      result.interventions.every((r) => r.status === 'insufficient_evidence'),
    ).toBe(true);
    expect(result.gaps.join(' ')).toMatch(/current applicable/);
  });
  it('preserves labelled assumptions and refuses an evidenced lower-budget claim from them', () => {
    const value = comparisonFixture();
    value.request.interventions[1].cost = {
      value: 200,
      basis: 'assumption',
      explanation: 'Hypothetical budget ceiling.',
      evidence: [],
    };
    const result = compareDamageInterventions(
      value.request,
      value.artifacts,
      now,
    );
    expect(result.lower_budget_verified).toBe(false);
    expect(result.interventions[1].assumptions).toContain(
      'cost: Hypothetical budget ceiling.',
    );
    expect(result.interventions[1].reduction_percent).toBe(5);
  });
  it('independently rejects tampered arithmetic and a false lower-budget flag', async () => {
    const value = comparisonFixture();
    const request = artifact('damage.comparison-request', value.request);
    const comparison = compareDamageInterventions(
      value.request,
      value.artifacts,
      now,
    );
    comparison.interventions[0].residual_damage = 79;
    comparison.lower_budget_verified = false;
    const resultArtifact = artifact(
      'damage.comparison',
      comparison,
      'assignment',
    );
    const context: ToolContext = {
      taskId: randomUUID(),
      runId: randomUUID(),
      assignmentId: randomUUID(),
      assignmentRevision: 1,
      objectiveRevision: 1,
      generation: 1,
      identity: { principal: 'test', workspace: 'test' },
      deadline: '2027-01-01T00:00:00Z',
      signal: new AbortController().signal,
      inputs: [...value.artifacts, request, resultArtifact],
      outputs: [],
      peers: [],
    };
    const tool = createDamageEvidenceReviewTools({ mode: 'fixture' }).find(
      (candidate) => candidate.id === 'damage.interventions.check',
    )!;
    const checked = damageComparisonReviewSchema.parse(
      await tool.execute(
        {
          request: exactEvidenceRef(request),
          comparison: exactEvidenceRef(resultArtifact),
        },
        context,
      ),
    );
    expect(checked.valid).toBe(false);
    expect(checked.findings.join(' ')).toMatch(/cost qualification/);
    expect(checked.findings.join(' ')).toMatch(/Independent residual/);
  });
});
