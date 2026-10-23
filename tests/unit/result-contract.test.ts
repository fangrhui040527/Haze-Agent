import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resultSchema, resultShape } from '../../app/contracts/result.js';
import type { Result } from '../../app/contracts/result.js';

const fixtureUrl = new URL(
  '../../output_examples/v2/result.json',
  import.meta.url,
);
const gap = (): Result =>
  resultSchema.parse(JSON.parse(readFileSync(fixtureUrl, 'utf8')));
const ref = (id: string) => ({
  id: `demo:${id}`,
  revision: 1,
  sha256: 'a'.repeat(64),
});
const reason = {
  code: 'not_applicable',
  explanation: 'Not applicable in this test case.',
};

/** Hypothetical verifier payload used only to exercise contract predicates. */
function checkedCandidate(): Result {
  const value = gap();
  const r = value.result;
  const plan = ref('checked-candidate');
  value.decision_ref.candidate_ref = plan;
  value.decision_ref.candidate_reason = null;
  r.decision_outcome = 'action_candidate_found';
  r.evidence_status = 'sufficient_for_declared_use';
  r.feasibility = 'verified';
  r.baseline_improvement = 'verified_positive';
  r.protection_status = { worker: 'pass', activity: 'pass' };
  r.action_threshold_status = 'met';
  r.uncertainty_status = 'supported';
  r.search_status = 'incomplete';
  r.optimality_status = 'unknown';
  r.selected_plan_ref = plan;
  r.selected_plan_reason = null;
  r.baseline_ref = ref('baseline');
  r.baseline_reason = null;
  r.quantified = {
    plan_ref: plan,
    values_ref: ref('paired-values'),
    crew_unit: 'person-hours * ug/m3',
    nominal: {
      baseline: 440,
      candidate: 340,
      absolute_gain: 100,
      percentage_gain: (100 * 100) / 440,
      percentage_reason: null,
    },
    scenarios: [
      {
        scenario_ref: ref('plus-20'),
        baseline: 600,
        candidate: 500,
        absolute_gain: 100,
        percentage_gain: (100 * 100) / 600,
        percentage_reason: null,
      },
    ],
  };
  r.quantified_reason = null;
  r.plan_verification = [
    {
      plan_ref: plan,
      checker_status: 'passed',
      feasibility: 'verified',
      worker_protection: 'pass',
      activity_protection: 'pass',
      uncertainty_status: 'supported',
      action_threshold_status: 'met',
      movement_cost_status: 'pass',
      check_refs: [ref('independent-check')],
      check_details_ref: ref('check-details'),
      check_details_reason: null,
      worker_activity_values_ref: ref('worker-activity-values'),
      worker_activity_values_reason: null,
      protection_violations_ref: null,
      protection_violations_reason: reason,
      protection_violation_count: 0,
    },
  ];
  r.plan_verification_reason = null;
  r.policy = {
    policy_ref: ref('fixture-policy'),
    approval_status: 'fixture',
    floor_results_ref: ref('floor-results'),
    movement: {
      M_activity_minutes: 180,
      N_changed_activities: 2,
      L_max_activity_minutes: 120,
      caps_ref: ref('movement-caps'),
    },
    cost_status: 'not_applicable',
    cost_reason: reason,
    ranking_ref: ref('checked-ranking'),
    objective_ref: ref('objective'),
  };
  r.policy_reason = null;
  r.search.method_ref = ref('method');
  r.search.method_reason = null;
  r.search.declared_set_ref = ref('declared-set');
  r.search.declared_set_reason = null;
  r.search.counts = {
    visited: 2,
    feasible: 2,
    scored: 2,
    protected: 1,
    qualifying: 1,
    independently_checked: 1,
  };
  r.search.cutoff_reason = {
    code: 'budget_cutoff',
    explanation:
      'Hypothetical search stopped after retaining a checked incumbent.',
  };
  value.evidence.records_ref = ref('environmental-evidence');
  value.evidence.records_reason = null;
  value.evidence.coverage_ref = ref('coverage');
  value.evidence.coverage_reason = null;
  value.evidence.scenario_refs = [ref('plus-20')];
  value.evidence.scenarios_reason = null;
  value.evidence.gaps = [];
  return value;
}

describe('haze.result.v2', () => {
  it('accepts the labeled gap-only specimen without invented execution or numbers', () => {
    const value = gap();
    expect(value.execution.admitted).toBe(false);
    expect(value.result.quantified).toBeNull();
    expect(value.result.search_status).toBe('not_run');
    expect(value.result.recommendation_eligible).toBe(false);
    expect(value.trace_ref).toBeNull();
  });

  it('exports a closed JSON Schema structural contract', () => {
    const schema = z.toJSONSchema(resultShape);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.result).toMatchObject({
      additionalProperties: false,
    });
    expect(schema.required).toContain('input_assessment');
  });

  it('rejects undeclared safety and optimality shortcuts', () => {
    expect(resultSchema.safeParse({ ...gap(), safe: true }).success).toBe(
      false,
    );
    const value = gap();
    expect(
      resultSchema.safeParse({
        ...value,
        result: { ...value.result, globally_optimal: true },
      }).success,
    ).toBe(false);
  });

  it('requires reasons for absent fields and rejects contradictory null reasons', () => {
    const value = gap();
    value.result.quantified_reason = null;
    expect(resultSchema.safeParse(value).success).toBe(false);
    const present = checkedCandidate();
    present.result.selected_plan_reason = reason;
    expect(resultSchema.safeParse(present).success).toBe(false);
  });

  it('does not allow selected plans or quantified gains on the gap-only path', () => {
    const value = gap();
    value.result.selected_plan_ref = ref('unverified-plan');
    value.result.selected_plan_reason = null;
    expect(resultSchema.safeParse(value).success).toBe(false);
    const withNumbers = checkedCandidate();
    withNumbers.result.decision_outcome = 'insufficient_evidence';
    withNumbers.result.evidence_status = 'insufficient';
    withNumbers.evidence.gaps = [reason];
    expect(resultSchema.safeParse(withNumbers).success).toBe(false);
  });

  it('forces invalid input to the blocked path with field reasons', () => {
    const value = gap();
    value.input_assessment.status = 'invalid';
    expect(resultSchema.safeParse(value).success).toBe(false);
    value.result.decision_outcome = 'input_blocked';
    value.input_assessment.field_reasons = [reason];
    expect(resultSchema.safeParse(value).success).toBe(true);
  });

  it('keeps historical references demo-local and canonical fields null', () => {
    const value = gap();
    value.decision_ref.bundle_ref.id = 'canonical-bundle';
    expect(resultSchema.safeParse(value).success).toBe(false);
    const canonical = gap();
    canonical.decision_ref.epoch_ref = ref('fake-epoch');
    canonical.decision_ref.epoch_reason = null;
    expect(resultSchema.safeParse(canonical).success).toBe(false);
  });

  it('never makes synthetic or publication-disabled results operational recommendations', () => {
    const value = checkedCandidate();
    value.result.recommendation_eligible = true;
    expect(resultSchema.safeParse(value).success).toBe(false);
    value.execution_surface = 'canonical';
    expect(resultSchema.safeParse(value).success).toBe(false);
  });

  it('retains a checked engineering candidate when search is incomplete', () => {
    const value = checkedCandidate();
    expect(resultSchema.safeParse(value).success).toBe(true);
    expect(value.result.search_status).toBe('incomplete');
    expect(value.result.optimality_status).toBe('unknown');
    expect(value.result.recommendation_eligible).toBe(false);
  });

  it.each([
    'checker_status',
    'feasibility',
    'worker_protection',
    'activity_protection',
    'uncertainty_status',
    'action_threshold_status',
    'movement_cost_status',
  ] as const)('excludes a selected plan when its %s check fails', (axis) => {
    const value = checkedCandidate();
    const plan = value.result.plan_verification[0]!;
    const failures = {
      checker_status: 'failed',
      feasibility: 'failed',
      worker_protection: 'fail',
      activity_protection: 'fail',
      uncertainty_status: 'not_supported',
      action_threshold_status: 'below',
      movement_cost_status: 'fail',
    } as const;
    Object.assign(plan, { [axis]: failures[axis] });
    expect(resultSchema.safeParse(value).success).toBe(false);
  });

  it('requires independent check artifacts rather than producer pass booleans', () => {
    const value = checkedCandidate();
    value.result.plan_verification[0]!.check_refs = [];
    expect(resultSchema.safeParse(value).success).toBe(false);
  });

  it('rejects wrong gain arithmetic and percentages', () => {
    const value = checkedCandidate();
    value.result.quantified!.nominal.absolute_gain = 200;
    expect(resultSchema.safeParse(value).success).toBe(false);
    const percentage = checkedCandidate();
    percentage.result.quantified!.nominal.percentage_gain = 50;
    expect(resultSchema.safeParse(percentage).success).toBe(false);
  });

  it('uses null percentage for a supported zero baseline', () => {
    const value = checkedCandidate();
    value.result.selected_plan_ref = null;
    value.result.selected_plan_reason = reason;
    value.result.comparison_plan_ref = value.result.quantified!.plan_ref;
    value.result.comparison_plan_reason = null;
    value.result.decision_outcome = 'search_ended_without_verified_improvement';
    value.result.baseline_improvement = 'verified_zero';
    value.result.quantified!.nominal = {
      baseline: 0,
      candidate: 0,
      absolute_gain: 0,
      percentage_gain: null,
      percentage_reason: {
        code: 'zero_baseline',
        explanation: 'A relative gain is undefined when baseline is zero.',
      },
    };
    expect(resultSchema.safeParse(value).success).toBe(true);
    value.result.quantified!.nominal.percentage_gain = 0;
    value.result.quantified!.nominal.percentage_reason = null;
    expect(resultSchema.safeParse(value).success).toBe(false);
  });

  it.each([0, -10])(
    'rejects a selected candidate with scenario gain %s',
    (gain) => {
      const value = checkedCandidate();
      const scenario = value.result.quantified!.scenarios[0]!;
      scenario.absolute_gain = gain;
      scenario.candidate = scenario.baseline - gain;
      scenario.percentage_gain = (100 * gain) / scenario.baseline;
      expect(resultSchema.safeParse(value).success).toBe(false);
    },
  );

  it('requires exact review evidence for engineering approval', () => {
    const value = checkedCandidate();
    value.result.review_status = 'approve';
    expect(resultSchema.safeParse(value).success).toBe(false);
    value.decision_ref.review_refs = [ref('exact-engineering-review')];
    value.decision_ref.reviews_reason = null;
    expect(resultSchema.safeParse(value).success).toBe(true);
    expect(value.result.recommendation_eligible).toBe(false);
  });

  it('does not hide a protection failure under below-action-threshold', () => {
    const value = checkedCandidate();
    value.result.decision_outcome = 'below_action_threshold';
    value.result.selected_plan_ref = null;
    value.result.selected_plan_reason = reason;
    value.result.comparison_plan_ref = value.result.quantified!.plan_ref;
    value.result.comparison_plan_reason = null;
    value.result.action_threshold_status = 'below';
    value.result.protection_status.activity = 'fail';
    expect(resultSchema.safeParse(value).success).toBe(false);
  });

  it('does not turn producer completion into independently proved absence', () => {
    const value = gap();
    value.result.search_status = 'complete';
    value.result.search.method_ref = ref('method');
    value.result.search.method_reason = null;
    value.result.search.declared_set_ref = ref('searched-set');
    value.result.search.declared_set_reason = null;
    value.result.decision_outcome = 'no_improvement_in_declared_set';
    expect(resultSchema.safeParse(value).success).toBe(false);
    value.result.optimality_status = 'proved_for_declared_set';
    expect(resultSchema.safeParse(value).success).toBe(false);
  });

  it('requires a checked witness or an independently verified bound for target conclusions', () => {
    const value = gap();
    value.result.target_feasibility.status = 'attainable';
    expect(resultSchema.safeParse(value).success).toBe(false);
    value.result.target_feasibility.status = 'proved_unattainable';
    expect(resultSchema.safeParse(value).success).toBe(false);
  });

  it('checks count containment and disallows activity on a search that did not run', () => {
    const value = gap();
    value.result.search.counts.visited = 1;
    expect(resultSchema.safeParse(value).success).toBe(false);
    const candidate = checkedCandidate();
    candidate.result.search.counts.feasible = 3;
    expect(resultSchema.safeParse(candidate).success).toBe(false);
  });

  it('does not invent remote execution, receipts or zero costs in offline sample', () => {
    const value = gap();
    value.integrations.operations[0]!.status = 'executed';
    expect(resultSchema.safeParse(value).success).toBe(false);
    value.mode = 'live';
    expect(resultSchema.safeParse(value).success).toBe(false);
    const cost = gap();
    cost.integrations.operations[0]!.cost = 0;
    expect(resultSchema.safeParse(cost).success).toBe(false);
  });

  it('bounds output arrays and rejects non-finite quantitative values', () => {
    const value = gap();
    value.limitations = Array.from({ length: 129 }, () => 'Limit');
    expect(resultSchema.safeParse(value).success).toBe(false);
    const candidate = checkedCandidate();
    candidate.result.quantified!.nominal.baseline = Infinity;
    expect(resultSchema.safeParse(candidate).success).toBe(false);
  });
});
