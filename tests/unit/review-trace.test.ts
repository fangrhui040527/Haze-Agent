import { describe, expect, it } from 'vitest';
import { contractHash, resultSchema } from '../../app/contracts/index.js';
import { handoffSchemas } from '../../app/contracts/handoffs.js';
import {
  buildDemoInputs,
  evaluateDemoPlan,
  generateDemoReviewPackage,
  validateDemoReviewPackage,
} from '../../app/demo/review-trace.js';

const recordedAt = '2026-10-23T09:00:00.000Z';
const packageValue = generateDemoReviewPackage(recordedAt);
const record = (idSuffix: string) =>
  packageValue.records.find((entry) => entry.ref.id.endsWith(idSuffix))!.record;

describe('section 23 review package', () => {
  it('traces five cases across all four workstream contracts', () => {
    expect(validateDemoReviewPackage(packageValue)).toMatchObject({
      valid: true,
      cases: 5,
      negative_examples: 7,
    });
    expect(packageValue.cases.map((item) => item.case_id)).toEqual([
      'baseline',
      'less-disruption',
      'lower-proxy',
      'missing-evidence',
      'incomplete-search',
    ]);
    for (const item of packageValue.cases) {
      expect(item.evidence_and_inputs.bundle_ref.id).toMatch(/^demo:/);
      expect(item.planner.input_ref.id).toMatch(/^demo:/);
      expect(item.verification.machine_report_ref.id).toMatch(/^demo:/);
      expect(item.workershield.input_ref?.id).toMatch(/^demo:/);
      expect(item.workershield.execution_status).toBe('not_run');
    }
  });

  it('reproduces the worked nominal and +20 examples from hourly interval evidence', () => {
    const expected = [
      ['baseline', [220, 300], [440, 600], [0, 0, 0]],
      ['less-disruption', [170, 250], [340, 500], [180, 2, 120]],
      ['lower-proxy', [120, 200], [240, 400], [360, 3, 120]],
    ] as const;
    for (const [name, worker, crew, movement] of expected) {
      const calculation = handoffSchemas.calculation.parse(
        record(`calculation-${name}`),
      );
      expect(
        calculation.scenario_values.map((scenario) => scenario.crew.candidate),
      ).toEqual(crew);
      expect(
        calculation.scenario_values.map((scenario) =>
          scenario.per_worker.map((entry) => entry.candidate),
        ),
      ).toEqual(worker.map((value) => [value, value]));
      expect([
        calculation.disruption.total_movement_minutes,
        calculation.disruption.changed_activity_count,
        Math.max(
          ...calculation.disruption.per_activity.map(
            (entry) => entry.absolute_movement_minutes,
          ),
        ),
      ]).toEqual(movement);
    }
    expect(
      handoffSchemas.calculation.parse(record('calculation-baseline'))
        .action_qualification.qualifying,
    ).toBe(false);
    expect(
      packageValue.results.named_set.result.selected_plan_ref?.id,
    ).toContain('plan-less-disruption');
    expect(
      packageValue.results.named_set.result.quantified?.nominal.absolute_gain,
    ).toBe(100);
    expect(packageValue.results.named_set.result.optimality_status).toBe(
      'unknown',
    );
  });

  it('retains exact matched activities in each scenario and never infers indoor values from yard', () => {
    const expected = [
      [100, 80, 40],
      [100, 30, 40],
      [50, 30, 40],
    ];
    const plus20 = [
      [120, 100, 80],
      [120, 50, 80],
      [70, 50, 80],
    ];
    for (const [index, name] of [
      'baseline',
      'less-disruption',
      'lower-proxy',
    ].entries()) {
      const calculation = handoffSchemas.calculation.parse(
        record(`calculation-${name}`),
      );
      expect(
        calculation.scenario_values[0]?.per_worker[0]?.activities.map(
          (activity) => activity.candidate,
        ),
      ).toEqual(expected[index]);
      expect(
        calculation.scenario_values[1]?.per_worker[0]?.activities.map(
          (activity) => activity.candidate,
        ),
      ).toEqual(plus20[index]);
    }
    const nominal = handoffSchemas.scenario.parse(record('scenario-nominal'));
    const sensitivity = handoffSchemas.scenario.parse(
      record('scenario-plus20'),
    );
    expect(
      nominal.intervals
        .filter((row) => row.location_id === 'office')
        .map((row) => row.value),
    ).toEqual([20, 20, 20, 20]);
    expect(
      sensitivity.intervals.map(
        (row, index) => row.value! - nominal.intervals[index]!.value!,
      ),
    ).toEqual(Array<number>(8).fill(20));
  });

  it('keeps a missing baseline hour as a domain gap without fabricated zero or selection', () => {
    const result = packageValue.results.missing_evidence;
    expect(result.result.decision_outcome).toBe('insufficient_evidence');
    expect(result.result.quantified).toBeNull();
    expect(result.result.selected_plan_ref).toBeNull();
    expect(result.result.search_status).toBe('not_run');
    expect(result.result.target_feasibility.status).toBe('unknown');
    const shield = handoffSchemas.workershield_input.parse(
      record('workershield-missing-evidence'),
    );
    expect(shield.permitted_plan_refs).toEqual([]);
    expect(shield.missing_field_diagnostics).toHaveLength(2);
    expect(shield.calculation_ref).toBeNull();
    expect(
      handoffSchemas.independent_check.parse(record('check-missing')).status,
    ).toBe('not_assessable');
  });

  it('retains the independently checked incumbent and scopes incomplete checking to two visited plans', () => {
    const result = packageValue.results.incomplete_search.result;
    expect(result.quantified?.nominal).toMatchObject({
      baseline: 440,
      candidate: 340,
      absolute_gain: 100,
    });
    expect(result.search_status).toBe('incomplete');
    expect(result.search.counts).toMatchObject({
      visited: 2,
      independently_checked: 2,
      qualifying: 1,
    });
    expect(result.optimality_status).toBe('unknown');
    expect(result.target_feasibility.status).toBe('attainable');
    expect(result.policy?.ranking_ref.id).toContain('ranking-incomplete');
    const machine = record('independent-machine-incomplete') as {
      plans: { plan_id: string }[];
    };
    expect(machine.plans.map((plan) => plan.plan_id)).toEqual([
      'baseline',
      'less-disruption',
    ]);
  });

  it('gives WorkerShield actual immutable paths to ranking, cutoff and comparisons at the declared scope', () => {
    for (const [name, expectedCount, expectedStatus] of [
      ['less-disruption', 3, 'complete'],
      ['incomplete-search', 2, 'incomplete'],
      ['missing-evidence', 0, 'not_run'],
    ] as const) {
      const shield = handoffSchemas.workershield_input.parse(
        record(`workershield-${name}`),
      );
      const investigation = shield.investigation_refs;
      expect(investigation.comparison_calculation_refs).toHaveLength(
        expectedCount,
      );
      const search = packageValue.records.find(
        (entry) => entry.ref.id === investigation.search_ref.id,
      )!.record as {
        search_status: string;
        counts: { visited: number };
        cutoff_reason: unknown;
      };
      expect(search.search_status).toBe(expectedStatus);
      expect(search.counts.visited).toBe(expectedCount);
      expect(search.cutoff_reason).toBeTruthy();
      expect(
        packageValue.records.some(
          (entry) => entry.ref.id === investigation.machine_report_ref.id,
        ),
      ).toBe(true);
      if (expectedCount === 0) {
        expect(investigation.ranking_ref).toBeNull();
        expect(investigation.ranking_reason).not.toBeNull();
        expect(investigation.comparison_reason).not.toBeNull();
      } else {
        expect(investigation.ranking_ref?.id).toContain('ranking');
        expect(investigation.comparison_reason).toBeNull();
      }
    }
  });

  it('rejects unsupported occupancy and missing/overlapping source bytes rather than forcing an answer', () => {
    const { bundle, plans, scenarios } = buildDemoInputs();
    const invalid = structuredClone(plans[0]!);
    invalid.assignments[0]!.start = '2026-10-25T08:15:00+08:00';
    expect(() => evaluateDemoPlan(bundle, scenarios, invalid)).toThrow();
    const absent = structuredClone(scenarios);
    absent[0]!.intervals.shift();
    expect(() => evaluateDemoPlan(bundle, absent, plans[0]!)).toThrow(
      /missing/,
    );
    const overlap = structuredClone(scenarios);
    overlap[0]!.intervals.push({ ...overlap[0]!.intervals[0]! });
    expect(() => evaluateDemoPlan(bundle, overlap, plans[0]!)).toThrow(
      /overlapping/,
    );
  });

  it('rejects changed or unresolved immutable bytes and unexplained package drift', () => {
    const changed = structuredClone(packageValue);
    (changed.records[0]!.record as { notice: string }).notice = 'changed';
    expect(() => validateDemoReviewPackage(changed)).toThrow(/hash_mismatch/);
    const missing = structuredClone(packageValue);
    missing.records.shift();
    expect(() => validateDemoReviewPackage(missing)).toThrow(
      /unresolved_reference/,
    );
    const drift = structuredClone(packageValue);
    drift.notice = 'Altered package commentary';
    expect(() => validateDemoReviewPackage(drift)).toThrow(
      /demo_package_drift/,
    );
  });

  it('preserves deterministic replay and uses a fresh immutable identity namespace for new generations', () => {
    expect(contractHash(generateDemoReviewPackage(recordedAt))).toBe(
      contractHash(packageValue),
    );
    const later = generateDemoReviewPackage('2026-10-23T09:01:00.000Z');
    expect(
      later.records.some((entry) =>
        packageValue.records.some(
          (previous) => previous.ref.id === entry.ref.id,
        ),
      ),
    ).toBe(false);
  });

  it('cannot approve itself or enable publication or operational use', () => {
    for (const result of Object.values(packageValue.results)) {
      expect(result.execution.admitted).toBe(false);
      expect(result.result.review_status).toBe('pending');
      expect(result.result.publication_status).toBe('publication_disabled');
      expect(result.result.recommendation_eligible).toBe(false);
      const unsafe = structuredClone(result);
      unsafe.result.recommendation_eligible = true;
      expect(resultSchema.safeParse(unsafe).success).toBe(false);
    }
    expect(
      packageValue.results.named_set.integrations.operations.every(
        (operation) => operation.status === 'skipped',
      ),
    ).toBe(true);
  });
});
