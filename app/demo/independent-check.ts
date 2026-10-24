import { planningSchema, type PlanningBundle } from '../contracts/planning.js';

export const INDEPENDENT_METHOD = 'haze.demo-independent-minute.v1';

export interface ScenarioInput {
  scenario_id: string;
  intervals: {
    location_id: string;
    start: string;
    end: string;
    concentration_ug_m3: number;
  }[];
}

export interface ScheduleInput {
  plan_id: string;
  assignments: { activity_id: string; start: string }[];
}

export interface ReportedValues {
  plan_id: string;
  scenario_id: string;
  worker_values: {
    worker_id: string;
    activity_values: { activity_id: string; value: number }[];
    total: number;
  }[];
  crew_total: number;
}

export interface IndependentPolicy {
  minimum_relative_gain: number;
  max_total_movement_minutes: number;
  max_changed_activities: number;
  max_individual_movement_minutes: Record<string, number>;
  required_scenario_ids: string[];
}

export interface PlanCheck {
  plan_id: string;
  feasible: boolean;
  coverage_complete: boolean;
  worker_protection: boolean;
  activity_protection: boolean;
  action_qualified: boolean;
  movement: { M: number; N: number; L: number };
  gains: {
    scenario_id: string;
    baseline: number;
    candidate: number;
    gain: number;
    fraction: number | null;
  }[];
}

export interface IndependentReport {
  method: typeof INDEPENDENT_METHOD;
  scope: 'synthetic_engineering_only';
  passed: boolean;
  findings: { code: string; explanation: string }[];
  checked_values: ReportedValues[];
  plans: PlanCheck[];
  ranking: {
    selected_plan_id: string | null;
    ordered_plan_ids: string[];
    scope: 'independently_checked_supplied_plans_only';
  };
}

/**
 * Separate minute-cell recomputation for the review fixtures. The producer uses
 * interval intersections; this module never imports it or trusts its pass flags.
 * A passed machine check is not human review or acceptance for operational use.
 */
export function independentlyCheckPlans(
  input: PlanningBundle,
  scenarios: ScenarioInput[],
  plans: ScheduleInput[],
  reported: ReportedValues[],
  policy: IndependentPolicy,
): IndependentReport {
  const report: IndependentReport = {
    method: INDEPENDENT_METHOD,
    scope: 'synthetic_engineering_only',
    passed: false,
    findings: [],
    checked_values: [],
    plans: [],
    ranking: {
      selected_plan_id: null,
      ordered_plan_ids: [],
      scope: 'independently_checked_supplied_plans_only',
    },
  };
  const finding = (code: string, explanation: string) =>
    report.findings.push({ code, explanation });
  const parsed = planningSchema.safeParse(input);
  if (!parsed.success || input.input_origin !== 'synthetic_fixture') {
    finding(
      'invalid_engineering_bundle',
      'A valid, explicitly fictional fixed-work planning bundle is required.',
    );
    return report;
  }
  if (
    !Number.isFinite(policy.minimum_relative_gain) ||
    policy.minimum_relative_gain <= 0 ||
    !policy.required_scenario_ids.length ||
    new Set(policy.required_scenario_ids).size !==
      policy.required_scenario_ids.length ||
    !Number.isFinite(policy.max_total_movement_minutes) ||
    policy.max_total_movement_minutes < 0 ||
    !Number.isInteger(policy.max_changed_activities) ||
    policy.max_changed_activities < 0 ||
    input.activities.some(
      (a) =>
        !Number.isFinite(
          policy.max_individual_movement_minutes[a.activity_id],
        ) || policy.max_individual_movement_minutes[a.activity_id]! < 0,
    )
  ) {
    finding(
      'invalid_fixture_policy',
      'Positive benefit floor, named scenarios and finite movement caps must be explicit.',
    );
    return report;
  }
  const horizonStart = Date.parse(input.assessment.start);
  const horizonEnd = Date.parse(input.assessment.end);
  const step = input.assessment.planning_step_minutes * 60_000;
  const activities = new Map(input.activities.map((a) => [a.activity_id, a]));
  const baseStarts = new Map(
    input.baseline.assignments.map((a) => [a.activity_id, Date.parse(a.start)]),
  );

  function feasible(plan: ScheduleInput): boolean {
    const starts = new Map(
      plan.assignments.map((a) => [a.activity_id, Date.parse(a.start)]),
    );
    if (
      starts.size !== plan.assignments.length ||
      starts.size !== activities.size ||
      [...starts.keys()].some((id) => !activities.has(id))
    )
      return false;
    for (const a of input.activities) {
      const start = starts.get(a.activity_id)!;
      const end = start + a.duration_minutes * 60_000;
      if (
        !Number.isFinite(start) ||
        (start - horizonStart) % step !== 0 ||
        !a.allowed_starts.some((t) => Date.parse(t) === start) ||
        start < Date.parse(a.release) ||
        end > Date.parse(a.deadline) ||
        start < horizonStart ||
        end > horizonEnd ||
        (a.timing_rule === 'fixed_baseline_start' &&
          start !== baseStarts.get(a.activity_id)) ||
        a.predecessor_ids.some(
          (id) =>
            starts.get(id)! + activities.get(id)!.duration_minutes * 60_000 >
            start,
        )
      )
        return false;
    }
    for (const worker of input.crew.workers) {
      const duties = input.activities
        .filter((a) => a.worker_ids.includes(worker.worker_id))
        .map((a) => ({
          start: starts.get(a.activity_id)!,
          end: starts.get(a.activity_id)! + a.duration_minutes * 60_000,
        }))
        .sort((a, b) => a.start - b.start);
      let cursor = horizonStart;
      for (const duty of duties) {
        if (duty.start !== cursor) return false;
        const availableMinutes = worker.available_intervals.reduce(
          (sum, slot) =>
            sum +
            Math.max(
              0,
              Math.min(duty.end, Date.parse(slot.end)) -
                Math.max(duty.start, Date.parse(slot.start)),
            ),
          0,
        );
        if (availableMinutes !== duty.end - duty.start) return false;
        cursor = duty.end;
      }
      if (cursor !== horizonEnd) return false;
    }
    // Independent capacity evaluation at each whole-minute cell.
    for (let time = horizonStart; time < horizonEnd; time += 60_000) {
      for (const resource of input.resources) {
        const slot = resource.capacity_intervals.find(
          (s) =>
            Date.parse(s.start) <= time && Date.parse(s.end) >= time + 60_000,
        );
        const demand = input.activities.reduce((sum, a) => {
          const start = starts.get(a.activity_id)!;
          return (
            sum +
            (start <= time && time < start + a.duration_minutes * 60_000
              ? (a.resource_demands.find(
                  (d) => d.resource_id === resource.resource_id,
                )?.quantity ?? 0)
              : 0)
          );
        }, 0);
        if (demand > (slot?.capacity ?? 0)) return false;
      }
    }
    return true;
  }

  function compute(
    plan: ScheduleInput,
    scenario: ScenarioInput,
  ): ReportedValues | null {
    const rows: ReportedValues['worker_values'] = [];
    for (const worker of input.crew.workers) {
      const values: { activity_id: string; value: number }[] = [];
      for (const activity of input.activities.filter((a) =>
        a.worker_ids.includes(worker.worker_id),
      )) {
        const assignment = plan.assignments.find(
          (a) => a.activity_id === activity.activity_id,
        );
        if (!assignment) return null;
        const begin = Date.parse(assignment.start);
        let concentrationMinutes = 0;
        for (let minute = 0; minute < activity.duration_minutes; minute++) {
          const time = begin + minute * 60_000;
          const covering = scenario.intervals.filter(
            (row) =>
              row.location_id === activity.location_id &&
              Date.parse(row.start) <= time &&
              Date.parse(row.end) >= time + 60_000,
          );
          if (
            covering.length !== 1 ||
            !Number.isFinite(covering[0]!.concentration_ug_m3) ||
            covering[0]!.concentration_ug_m3 < 0
          )
            return null;
          concentrationMinutes += covering[0]!.concentration_ug_m3;
        }
        values.push({
          activity_id: activity.activity_id,
          value: concentrationMinutes / 60,
        });
      }
      rows.push({
        worker_id: worker.worker_id,
        activity_values: values,
        total: values.reduce((sum, a) => sum + a.value, 0),
      });
    }
    return {
      plan_id: plan.plan_id,
      scenario_id: scenario.scenario_id,
      worker_values: rows,
      crew_total: rows.reduce((sum, w) => sum + w.total, 0),
    };
  }

  const baseline: ScheduleInput = {
    plan_id: 'baseline',
    assignments: input.baseline.assignments,
  };
  if (!feasible(baseline)) {
    finding(
      'infeasible_baseline',
      'Independent fixed-work and occupancy checks failed for the baseline.',
    );
    return report;
  }
  if (
    new Set(scenarios.map((s) => s.scenario_id)).size !== scenarios.length ||
    policy.required_scenario_ids.some(
      (id) => !scenarios.some((s) => s.scenario_id === id),
    )
  ) {
    finding(
      'missing_or_duplicate_scenario',
      'Every required paired scenario must have exactly one source record.',
    );
    return report;
  }
  if (new Set(plans.map((p) => p.plan_id)).size !== plans.length) {
    finding(
      'duplicate_plan_id',
      'Every independently checked plan needs a unique identity.',
    );
    return report;
  }
  const nominal = scenarios.find((s) => s.scenario_id === 'nominal');
  const plus20 = scenarios.find((s) => s.scenario_id === 'plus20');
  const rowKey = (r: ScenarioInput['intervals'][number]) =>
    `${r.location_id}/${r.start}/${r.end}`;
  if (
    !nominal ||
    !plus20 ||
    scenarios.length !== 2 ||
    policy.required_scenario_ids.length !== 2 ||
    !policy.required_scenario_ids.includes('nominal') ||
    !policy.required_scenario_ids.includes('plus20')
  ) {
    finding(
      'paired_scenario_mismatch',
      'This engineering checker requires exactly the declared nominal and plus20 scenarios.',
    );
    return report;
  }
  const plusRows = new Map(
    plus20.intervals.map((r) => [rowKey(r), r.concentration_ug_m3]),
  );
  if (
    plusRows.size !== plus20.intervals.length ||
    new Set(nominal.intervals.map(rowKey)).size !== nominal.intervals.length ||
    nominal.intervals.length !== plusRows.size ||
    nominal.intervals.some(
      (r) =>
        !Number.isFinite(r.concentration_ug_m3) ||
        r.concentration_ug_m3 < 0 ||
        plusRows.get(rowKey(r)) !== r.concentration_ug_m3 + 20,
    )
  ) {
    finding(
      'paired_scenario_mismatch',
      'The +20 perturbation must add exactly 20 to each identical location/native interval; it is not operational uncertainty evidence.',
    );
  }
  const expectedCount = plans.length * scenarios.length;
  const expectedKeys = new Set(
    plans.flatMap((p) => scenarios.map((s) => `${p.plan_id}/${s.scenario_id}`)),
  );
  if (
    reported.length !== expectedCount ||
    new Set(reported.map((r) => `${r.plan_id}/${r.scenario_id}`)).size !==
      reported.length ||
    reported.some((r) => !expectedKeys.has(`${r.plan_id}/${r.scenario_id}`))
  ) {
    finding(
      'reported_table_set_mismatch',
      'Reported plan/scenario rows must be complete and unique.',
    );
  }
  for (const plan of plans) {
    if (!feasible(plan)) {
      finding(
        'infeasible_schedule',
        `Fixed-work, occupancy, windows or resources failed for ${plan.plan_id}.`,
      );
      continue;
    }
    const movement = input.activities.map(
      (a) =>
        Math.abs(
          Date.parse(
            plan.assignments.find((s) => s.activity_id === a.activity_id)
              ?.start ?? '',
          ) - baseStarts.get(a.activity_id)!,
        ) / 60_000,
    );
    const check: PlanCheck = {
      plan_id: plan.plan_id,
      feasible: feasible(plan),
      coverage_complete: true,
      worker_protection: true,
      activity_protection: true,
      action_qualified: false,
      movement: {
        M: movement.reduce((a, b) => a + b, 0),
        N: movement.filter((m) => m > 0).length,
        L: Math.max(0, ...movement),
      },
      gains: [],
    };
    for (const scenario of scenarios) {
      const base = compute(baseline, scenario);
      const actual = compute(plan, scenario);
      if (!base || !actual) {
        check.coverage_complete = false;
        finding(
          'missing_or_ambiguous_coverage',
          `Exact source interval coverage is missing or overlaps for ${plan.plan_id}/${scenario.scenario_id}.`,
        );
        continue;
      }
      report.checked_values.push(actual);
      const claim = reported.find(
        (r) =>
          r.plan_id === plan.plan_id && r.scenario_id === scenario.scenario_id,
      );
      const sortedWorkers = (r: ReportedValues) =>
        JSON.stringify(
          [...r.worker_values]
            .sort((a, b) => a.worker_id.localeCompare(b.worker_id))
            .map((w) => ({
              worker_id: w.worker_id,
              total: w.total,
              activity_values: [...w.activity_values]
                .sort((a, b) => a.activity_id.localeCompare(b.activity_id))
                .map((a) => ({ activity_id: a.activity_id, value: a.value })),
            })),
        );
      if (
        !claim ||
        claim.crew_total !== actual.crew_total ||
        sortedWorkers(claim) !== sortedWorkers(actual)
      ) {
        finding(
          'producer_value_mismatch',
          `Independent source-byte recomputation disagrees with ${plan.plan_id}/${scenario.scenario_id}.`,
        );
      }
      for (const w of actual.worker_values) {
        const bw = base.worker_values.find((b) => b.worker_id === w.worker_id)!;
        if (w.total > bw.total) check.worker_protection = false;
        if (
          w.activity_values.some(
            (a) =>
              a.value >
              bw.activity_values.find((b) => b.activity_id === a.activity_id)!
                .value,
          )
        )
          check.activity_protection = false;
      }
      const gain = base.crew_total - actual.crew_total;
      check.gains.push({
        scenario_id: scenario.scenario_id,
        baseline: base.crew_total,
        candidate: actual.crew_total,
        gain,
        fraction: base.crew_total > 0 ? gain / base.crew_total : null,
      });
    }
    const movementPass =
      check.movement.M <= policy.max_total_movement_minutes &&
      check.movement.N <= policy.max_changed_activities &&
      input.activities.every(
        (a, i) =>
          movement[i]! <=
          policy.max_individual_movement_minutes[a.activity_id]!,
      );
    if (!check.coverage_complete) {
      check.worker_protection = false;
      check.activity_protection = false;
    }
    check.action_qualified =
      check.coverage_complete &&
      check.worker_protection &&
      check.activity_protection &&
      movementPass &&
      policy.required_scenario_ids.every((id) =>
        check.gains.some(
          (g) =>
            g.scenario_id === id &&
            g.gain > 0 &&
            g.fraction !== null &&
            g.fraction >= policy.minimum_relative_gain,
        ),
      );
    report.plans.push(check);
  }
  report.passed = report.findings.length === 0;
  if (report.passed) {
    const key = (planId: string) =>
      plans
        .find((p) => p.plan_id === planId)!
        .assignments.slice()
        .sort((a, b) =>
          a.activity_id < b.activity_id
            ? -1
            : a.activity_id > b.activity_id
              ? 1
              : 0,
        )
        .map((a) => `${a.activity_id}=${new Date(a.start).toISOString()}`)
        .join('|');
    const tuple = (p: PlanCheck) => [
      p.movement.M,
      p.movement.N,
      p.movement.L,
      -Math.min(
        ...p.gains
          .filter((g) => policy.required_scenario_ids.includes(g.scenario_id))
          .map((g) => g.gain),
      ),
      -(p.gains.find((g) => g.scenario_id === 'nominal')?.gain ?? 0),
    ];
    const ranked = report.plans
      .filter((p) => p.action_qualified)
      .sort((a, b) => {
        const aa = tuple(a),
          bb = tuple(b);
        for (let n = 0; n < aa.length; n++)
          if (aa[n] !== bb[n]) return aa[n]! - bb[n]!;
        return key(a.plan_id) < key(b.plan_id)
          ? -1
          : key(a.plan_id) > key(b.plan_id)
            ? 1
            : 0;
      });
    report.ranking.ordered_plan_ids = ranked.map((p) => p.plan_id);
    report.ranking.selected_plan_id = ranked[0]?.plan_id ?? null;
  }
  return report;
}
