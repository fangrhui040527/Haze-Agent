import { describe, expect, it } from 'vitest';
import {
  buildDemoInputs,
  evaluateDemoPlan,
} from '../../app/demo/review-trace.js';
import { independentlyCheckPlans } from '../../app/demo/independent-check.js';
import {
  buildContractErrorExamples,
  replayContractErrorExamples,
} from '../../app/demo/contract-errors.js';

function checkInput() {
  const { bundle, scenarios, plans, policy } = buildDemoInputs();
  const values = plans.flatMap((plan) =>
    evaluateDemoPlan(bundle, scenarios, plan),
  );
  return { bundle, scenarios, plans, policy, values };
}

describe('independent source-byte check of the section 23 illustration', () => {
  it('reproduces every worker/activity/scenario and ranks less movement before lowest proxy', () => {
    const { bundle, scenarios, plans, policy, values } = checkInput();
    const check = independentlyCheckPlans(
      bundle,
      scenarios,
      plans,
      values,
      policy,
    );
    expect(check.passed).toBe(true);
    expect(
      check.checked_values.map((v) => [v.plan_id, v.scenario_id, v.crew_total]),
    ).toEqual([
      ['baseline', 'nominal', 440],
      ['baseline', 'plus20', 600],
      ['less-disruption', 'nominal', 340],
      ['less-disruption', 'plus20', 500],
      ['lower-proxy', 'nominal', 240],
      ['lower-proxy', 'plus20', 400],
    ]);
    expect(check.ranking.ordered_plan_ids).toEqual([
      'less-disruption',
      'lower-proxy',
    ]);
    expect(
      check.plans.map((p) => [
        p.movement.M,
        p.movement.N,
        p.movement.L,
        p.action_qualified,
      ]),
    ).toEqual([
      [0, 0, 0, false],
      [180, 2, 120, true],
      [360, 3, 120, true],
    ]);
  });

  it('detects altered matched-activity values even when a reported crew sum is unchanged', () => {
    const { bundle, scenarios, plans, policy, values } = checkInput();
    values[0]!.worker_values[0]!.activity_values[0]!.value -= 5;
    values[0]!.worker_values[0]!.activity_values[1]!.value += 5;
    const check = independentlyCheckPlans(
      bundle,
      scenarios,
      plans,
      values,
      policy,
    );
    expect(check.passed).toBe(false);
    expect(check.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'producer_value_mismatch' }),
      ]),
    );
    expect(check.ranking.selected_plan_id).toBeNull();
  });

  it('blocks action when a matched activity worsens despite a lower worker total', () => {
    const { bundle, scenarios, plans, policy } = checkInput();
    for (const scenario of scenarios) {
      scenario.intervals.find(
        (r) => r.location_id === 'yard' && r.start.includes('T11:'),
      )!.concentration_ug_m3 = scenario.scenario_id === 'nominal' ? 90 : 110;
    }
    const plan = plans[2]!;
    const values = evaluateDemoPlan(bundle, scenarios, plan);
    const check = independentlyCheckPlans(
      bundle,
      scenarios,
      [plan],
      values,
      policy,
    );
    expect(check.passed).toBe(true);
    expect(check.plans[0]).toMatchObject({
      worker_protection: true,
      activity_protection: false,
      action_qualified: false,
    });
    expect(check.plans[0]!.gains[0]!.gain).toBeGreaterThan(0);
  });

  it('reports missing essential baseline rows without inventing zero exposure', () => {
    const { bundle, scenarios, plans, policy, values } = checkInput();
    scenarios[0]!.intervals = scenarios[0]!.intervals.filter(
      (r) => !(r.location_id === 'yard' && r.start.includes('T08:')),
    );
    const check = independentlyCheckPlans(
      bundle,
      scenarios,
      plans,
      values,
      policy,
    );
    expect(check.passed).toBe(false);
    expect(
      check.findings.some((f) => f.code === 'missing_or_ambiguous_coverage'),
    ).toBe(true);
    expect(check.checked_values.some((v) => v.scenario_id === 'nominal')).toBe(
      false,
    );
    expect(check.plans.every((p) => !p.action_qualified)).toBe(true);
  });

  it('rejects occupancy failures, incomplete reported tables and missing scenarios', () => {
    const { bundle, scenarios, plans, policy, values } = checkInput();
    const invalid = structuredClone(plans[1]!);
    invalid.assignments[1]!.start = '2026-10-25T10:45:00+08:00';
    expect(
      independentlyCheckPlans(
        bundle,
        scenarios,
        [invalid],
        values.slice(2, 4),
        policy,
      ).passed,
    ).toBe(false);
    expect(
      independentlyCheckPlans(bundle, scenarios, plans, values.slice(1), policy)
        .passed,
    ).toBe(false);
    expect(
      independentlyCheckPlans(
        bundle,
        scenarios.slice(0, 1),
        plans,
        values,
        policy,
      ).passed,
    ).toBe(false);
  });

  it('keeps zero-baseline fractions null and never qualifies zero gain', () => {
    const { bundle, scenarios, plans, policy } = checkInput();
    for (const scenario of scenarios)
      for (const row of scenario.intervals)
        row.concentration_ug_m3 = scenario.scenario_id === 'nominal' ? 0 : 20;
    const values = plans.flatMap((plan) =>
      evaluateDemoPlan(bundle, scenarios, plan),
    );
    const check = independentlyCheckPlans(
      bundle,
      scenarios,
      plans,
      values,
      policy,
    );
    expect(check.passed).toBe(true);
    expect(
      check.plans.every(
        (p) =>
          !p.action_qualified &&
          p.gains.every((g) => g.gain === 0) &&
          p.gains.find((g) => g.scenario_id === 'nominal')?.fraction === null,
      ),
    ).toBe(true);
  });

  it('rejects duplicate plan identities, foreign value rows and a mislabeled +20 transform', () => {
    const { bundle, scenarios, plans, policy, values } = checkInput();
    expect(
      independentlyCheckPlans(
        bundle,
        scenarios,
        [plans[0]!, plans[0]!],
        values.slice(0, 4),
        policy,
      ).findings[0]!.code,
    ).toBe('duplicate_plan_id');
    const foreign = structuredClone(values);
    foreign[0]!.plan_id = 'unrequested-plan';
    expect(
      independentlyCheckPlans(bundle, scenarios, plans, foreign, policy).passed,
    ).toBe(false);
    scenarios[1]!.intervals[0]!.concentration_ug_m3 += 1;
    const changed = plans.flatMap((p) =>
      evaluateDemoPlan(bundle, scenarios, p),
    );
    expect(
      independentlyCheckPlans(
        bundle,
        scenarios,
        plans,
        changed,
        policy,
      ).findings.some((f) => f.code === 'paired_scenario_mismatch'),
    ).toBe(true);
  });

  it('replays reviewable errors against actual parsing, shape, domain and reference checks', () => {
    const { bundle } = checkInput();
    const errors = buildContractErrorExamples(bundle);
    expect(errors).toHaveLength(7);
    expect(() => replayContractErrorExamples(errors)).not.toThrow();
    errors[0]!.expected_code = 'invented';
    expect(() => replayContractErrorExamples(errors)).toThrow(
      'error_example_mismatch',
    );
  });
});
