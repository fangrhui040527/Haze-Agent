import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateContract } from '../../app/contracts/index.js';
import {
  handoffSchemas,
  type CalculationHandoff,
  type IndependentCheckHandoff,
  type PolicyHandoff,
  type ScenarioHandoff,
  type WorkerShieldInputHandoff,
} from '../../app/contracts/handoffs.js';

const ref = (name: string) => ({
  id: `demo:${name}`,
  revision: 1,
  sha256: 'a'.repeat(64),
});
const reason = {
  code: 'no_canonical_acceptance',
  explanation:
    'Fictional immutable review fixture; no accepted canonical authority.',
};
const t = (hour: number) =>
  `2026-10-25T${String(hour).padStart(2, '0')}:00:00+08:00`;
const identity = (name: string) => ({ id: `demo:${name}`, revision: 1 });

function scenario(): ScenarioHandoff {
  return {
    ...identity('nominal'),
    schema_version: 'haze.scenario.v2',
    scenario_id: 'nominal',
    base_scenario_ref: null,
    base_scenario_reason: {
      code: 'base_scenario',
      explanation: 'This is the fictional base.',
    },
    source_kind: 'synthetic_fixture',
    support: 'fictional_engineering_perturbation',
    pollutant: 'PM2.5',
    unit: 'ug/m3',
    native_temporal_resolution_minutes: 60,
    allocation: 'piecewise_constant',
    transformation: {
      kind: 'identity',
      delta_ug_m3: 0,
      applies_to: 'all_locations_all_intervals',
    },
    evidence_refs: [ref('evidence')],
    intervals: [
      {
        start: t(8),
        end: t(9),
        location_id: 'yard',
        value: 100,
        quality_flag: 'fictional',
      },
    ],
    review_status: 'not_operationally_reviewed',
  };
}

function policy(): PolicyHandoff {
  return {
    ...identity('policy'),
    schema_version: 'haze.decision_policy.v2',
    scope: 'fictional_engineering_only',
    approval_status: 'fixture',
    operational_approval_ref: null,
    approval_reason: reason,
    required_scenario_refs: [ref('nominal'), ref('plus20')],
    minimum_gain_percent_each_scenario: 10,
    maximum_total_movement_minutes: 360,
    maximum_changed_activity_count: 3,
    maximum_per_activity_movement_minutes: 120,
    movement_counting: 'shared_activity_once',
    worker_nonincrease_required: true,
    matched_activity_nonincrease_required: true,
    new_controls_allowed: false,
    reassignment_allowed: false,
    overtime_allowed: false,
    displacement_allowed: false,
    fixed_work: [
      'activity_ids',
      'worker_assignments',
      'durations',
      'locations',
      'services_and_quality',
      'existing_controls',
      'resource_limits',
    ],
    full_occupancy_required: true,
    ranking: [
      'least_total_movement',
      'fewest_changed_activities',
      'least_maximum_activity_movement',
      'greatest_minimum_supported_crew_gain',
      'greatest_nominal_crew_gain',
      'canonical_activity_id_start_utc_sequence',
    ],
    numerical_tolerance: {
      method: 'integer_ug_minutes_for_this_fixture',
      substantive_increase_allowed: false,
    },
    cost_basis_ref: ref('cost'),
    unknown_cost_components: ['coordination_cost'],
    limitations: ['No operational cost or suitability approval.'],
  };
}

function calculation(): CalculationHandoff {
  return {
    ...identity('calculation'),
    schema_version: 'haze.calculation.v2',
    producer_id: 'fixture_producer',
    planner_input_ref: ref('planner_input'),
    bundle_ref: ref('planning'),
    policy_ref: ref('policy'),
    baseline_ref: ref('baseline'),
    plan: {
      plan_ref: ref('less_disruption'),
      assignments: [
        { activity_id: 'inspection', start: t(8) },
        { activity_id: 'maintenance', start: t(11) },
        { activity_id: 'administration', start: t(9) },
      ],
    },
    role: 'less_disruption',
    worker_unit: 'hours * ug/m3',
    crew_unit: 'person-hours * ug/m3',
    scenario_values: [
      {
        scenario_ref: ref('nominal'),
        baseline: [100, 80, 40],
        candidate: [100, 30, 40],
      },
      {
        scenario_ref: ref('plus20'),
        baseline: [120, 100, 80],
        candidate: [120, 50, 80],
      },
    ].map((source) => {
      const baseline = source.baseline.reduce((sum, value) => sum + value, 0),
        candidate = source.candidate.reduce((sum, value) => sum + value, 0);
      return {
        scenario_ref: source.scenario_ref,
        per_worker: ['worker-a', 'worker-b'].map((worker_id) => ({
          worker_id,
          baseline,
          candidate,
          delta: candidate - baseline,
          activities: ['inspection', 'maintenance', 'administration'].map(
            (activity_id, index) => ({
              activity_id,
              baseline: source.baseline[index]!,
              candidate: source.candidate[index]!,
              delta: source.candidate[index]! - source.baseline[index]!,
            }),
          ),
        })),
        crew: {
          baseline: baseline * 2,
          candidate: candidate * 2,
          delta: (candidate - baseline) * 2,
          absolute_gain: (baseline - candidate) * 2,
          percentage_gain: (100 * (baseline - candidate)) / baseline,
          percentage_reason: null,
        },
      };
    }),
    disruption: {
      total_movement_minutes: 180,
      changed_activity_count: 2,
      per_activity: [
        { activity_id: 'inspection', absolute_movement_minutes: 0 },
        { activity_id: 'maintenance', absolute_movement_minutes: 120 },
        { activity_id: 'administration', absolute_movement_minutes: 60 },
      ],
    },
    action_qualification: {
      worker_protection: 'pass',
      activity_protection: 'pass',
      threshold_status: 'met',
      movement_status: 'pass',
      qualifying: true,
    },
  };
}

function check(): IndependentCheckHandoff {
  return {
    ...identity('independent_check'),
    schema_version: 'haze.independent_check.v2',
    checker_id: 'independent_machine_checker',
    producer_id: 'fixture_producer',
    independent_of_producer: true,
    scope: 'engineering_numeric_constraint_check',
    planner_input_ref: ref('planner_input'),
    snapshot_ref: ref('snapshot'),
    bundle_ref: ref('planning'),
    policy_ref: ref('policy'),
    scenario_refs: [ref('nominal'), ref('plus20')],
    calculation_ref: ref('calculation'),
    calculation_reason: null,
    plan_ref: ref('less_disruption'),
    plan_reason: null,
    checked_at: t(8),
    findings: [
      'reference_integrity',
      'fixed_work',
      'full_occupancy',
      'normalized_constraints',
      'coverage',
      'paired_scenarios',
      'integration',
      'worker_nonincrease',
      'matched_activity_nonincrease',
      'action_floor',
      'movement_caps',
      'ranking',
    ].map((predicate) => ({
      predicate,
      status: 'passed',
      detail: 'Independently reproduced under the explicitly fictional inputs.',
    })) as IndependentCheckHandoff['findings'],
    status: 'passed',
    human_review_status: 'pending',
    approval_authority: 'none',
  };
}

function workerShield(): WorkerShieldInputHandoff {
  return {
    ...identity('workershield_input'),
    schema_version: 'haze.workershield.input.v2',
    run_id: 'demo-run',
    programme_id: 'engineering-demo',
    problem_id: 'klang-fictional',
    execution_surface: 'historical_harness',
    snapshot_ref: ref('snapshot'),
    problem_epoch: null,
    problem_epoch_reason: reason,
    bundle_ref: ref('planning'),
    calculation_ref: ref('calculation'),
    calculation_reason: null,
    check_refs: [ref('check')],
    investigation_refs: {
      machine_report_ref: ref('machine_report'),
      search_ref: ref('search'),
      ranking_ref: ref('ranking'),
      ranking_reason: null,
      comparison_calculation_refs: [
        ref('less_disruption_calculation'),
        ref('lower_proxy_calculation'),
      ],
      comparison_reason: null,
    },
    intended_use: 'engineering_historical',
    mode: 'offline_sample',
    input_origin: 'synthetic_fixture',
    requested_question_kind: 'why_this_plan',
    permitted_plan_refs: [ref('less_disruption')],
    fact_index: [],
    evidence_index: [],
    required_caveat_ids: ['fictional_inputs', 'not_operational'],
    missing_field_diagnostics: [],
    tool_allowlist: ['inspect_comparison', 'inspect_sensitivity'],
    bounds: {
      maximum_tool_calls: 4,
      maximum_elapsed_ms: 1000,
      maximum_output_bytes: 8000,
    },
    output_schema_version: 'haze.explanation_plan.v2',
    agent_execution_status: 'not_run',
    tool_trace_ref: null,
    inference_receipt_ref: null,
    execution_reason: {
      code: 'interface_only',
      explanation: 'No agent or inference service executed.',
    },
  };
}

describe('bounded historical handoff contracts', () => {
  it('accepts nominal and paired +20 scenario definitions', () => {
    expect(handoffSchemas.scenario.parse(scenario()).scenario_id).toBe(
      'nominal',
    );
    const plus = scenario();
    Object.assign(plus, {
      id: 'demo:plus20',
      scenario_id: 'plus20',
      base_scenario_ref: ref('nominal'),
      base_scenario_reason: null,
      transformation: {
        kind: 'add_constant',
        delta_ug_m3: 20,
        applies_to: 'all_locations_all_intervals',
      },
    });
    plus.intervals[0]!.value = 120;
    expect(handoffSchemas.scenario.parse(plus).scenario_id).toBe('plus20');
  });

  it.each([
    [
      'unpaired transformation',
      (s: ScenarioHandoff) => {
        s.transformation.delta_ug_m3 = 20;
      },
    ],
    [
      'invented missing value',
      (s: ScenarioHandoff) => {
        s.intervals[0]!.value = null;
      },
    ],
    [
      'subhour environmental precision',
      (s: ScenarioHandoff) => {
        s.intervals[0]!.end = '2026-10-25T08:15:00+08:00';
      },
    ],
    [
      'overlapping location series',
      (s: ScenarioHandoff) => {
        s.intervals.push({ ...s.intervals[0]! });
      },
    ],
    [
      'non-local reference',
      (s: ScenarioHandoff) => {
        s.evidence_refs[0]!.id = 'canonical:evidence';
      },
    ],
  ] as const)('rejects %s', (_name, change) => {
    const value = scenario();
    change(value);
    expect(handoffSchemas.scenario.safeParse(value).success).toBe(false);
  });

  it('requires fictional thresholds, fixed work, and paired distinct scenario references', () => {
    expect(
      handoffSchemas.policy.parse(policy()).maximum_total_movement_minutes,
    ).toBe(360);
    expect(
      handoffSchemas.policy.safeParse({
        ...policy(),
        reassignment_allowed: true,
      }).success,
    ).toBe(false);
    expect(
      handoffSchemas.policy.safeParse({
        ...policy(),
        minimum_gain_percent_each_scenario: 5,
      }).success,
    ).toBe(false);
    expect(
      handoffSchemas.policy.safeParse({
        ...policy(),
        required_scenario_refs: [ref('nominal'), ref('nominal')],
      }).success,
    ).toBe(false);
  });

  it('keeps unattested draft fields separate from any accepted bundle', () => {
    const draft = {
      ...identity('draft'),
      schema_version: 'haze.input_draft.v1',
      state: 'draft',
      proposed_fields: { programme_id: 'fictional-programme' },
      diagnostics: [
        {
          field_path: '/attestation_ref',
          reason: {
            code: 'unattested',
            explanation: 'Requires an authorized human attestation.',
          },
        },
      ],
      accepted_bundle_ref: null,
      acceptance: 'not_accepted',
    };
    expect(handoffSchemas.input_draft.parse(draft).state).toBe('draft');
    expect(handoffSchemas.planner_input.safeParse(draft).success).toBe(false);
    expect(
      handoffSchemas.input_draft.safeParse({
        ...draft,
        accepted_bundle_ref: ref('invented_approval'),
      }).success,
    ).toBe(false);
    expect(
      handoffSchemas.input_draft.safeParse({
        ...draft,
        proposed_fields: { hidden_constraint: true },
      }).success,
    ).toBe(false);
  });

  it('checks the existing fixed-work shape inside an explicitly unaccepted snapshot', () => {
    const planning: unknown = JSON.parse(
      readFileSync(
        new URL('../../input_examples/v2/planning.json', import.meta.url),
        'utf8',
      ),
    );
    const record = {
      ...identity('snapshot'),
      schema_version: 'haze.demo_snapshot.v1',
      execution_surface: 'historical_harness',
      record_state: 'demo_local_snapshot',
      acceptance: 'not_canonically_accepted',
      proposal_status: 'pending_human_review',
      publication_status: 'publication_disabled',
      recommendation_eligible: false,
      problem_epoch: null,
      problem_epoch_reason: reason,
      bundle_ref: ref('planning'),
      planning,
    };
    expect(handoffSchemas.snapshot.safeParse(record).success).toBe(true);
    expect(
      handoffSchemas.snapshot.safeParse({
        ...record,
        recommendation_eligible: true,
      }).success,
    ).toBe(false);
    expect(
      handoffSchemas.snapshot.safeParse({
        ...record,
        planning: { ...(planning as object), activities: [] },
      }).success,
    ).toBe(false);
  });

  it('checks exact passage bytes and tagged locator fields', () => {
    const quote = 'Fictional hourly series.';
    const record = {
      ...identity('evidence'),
      schema_version: 'haze.evidence.v2',
      source_kind: 'synthetic_fixture',
      title: 'Fictional fixture',
      source_owner: 'fictional_engineering_fixture',
      raw_ref: ref('raw'),
      raw_sha256: 'a'.repeat(64),
      locator: {
        kind: 'passage',
        document_ref: ref('raw'),
        page: 1,
        section: 'Fixture',
        quote,
        start_offset: 0,
        end_offset: Array.from(quote).length,
        offset_unit: 'unicode_code_points',
        quote_sha256: createHash('sha256').update(quote).digest('hex'),
      },
      provenance: {
        preparation: 'Invented for engineering only.',
        method_ref: ref('method'),
      },
      retrieved_at: t(8),
      permitted_uses: ['engineering_historical'],
      disposition: 'fixture_not_accepted',
      accepted_at: null,
      acceptance_reason: reason,
      review_refs: [],
      limitations: ['No workplace applicability.'],
    };
    expect(handoffSchemas.evidence.safeParse(record).success).toBe(true);
    expect(validateContract('evidence', record)).toEqual(record);
    expect(() =>
      validateContract('evidence', {
        ...record,
        locator: { ...record.locator, quote: 'Altered.' },
      }),
    ).toThrow('invalid_contract');
    expect(() =>
      validateContract('evidence', { ...record, raw_sha256: 'b'.repeat(64) }),
    ).toThrow('invalid_contract');
    expect(
      handoffSchemas.evidence.safeParse({
        ...record,
        locator: { ...record.locator, quote: 'Altered.' },
      }).success,
    ).toBe(false);
    expect(
      handoffSchemas.evidence.safeParse({
        ...record,
        raw_sha256: 'b'.repeat(64),
      }).success,
    ).toBe(false);
    expect(
      handoffSchemas.evidence.safeParse({
        ...record,
        locator: {
          kind: 'structured_fields',
          record_ref: ref('raw'),
          field_pointers: ['/policy/~2invalid'],
        },
      }).success,
    ).toBe(false);
  });

  it('reproduces crew/worker/matched-activity totals and shared-activity movement', () => {
    expect(
      handoffSchemas.calculation.parse(calculation()).scenario_values[0]!.crew
        .absolute_gain,
    ).toBe(100);
    const value = calculation();
    value.scenario_values[0]!.crew.absolute_gain += 1;
    expect(handoffSchemas.calculation.safeParse(value).success).toBe(false);
    const moved = calculation();
    moved.disruption.total_movement_minutes = 360;
    expect(handoffSchemas.calculation.safeParse(moved).success).toBe(false);
    const qualification = calculation();
    qualification.action_qualification.qualifying = false;
    expect(handoffSchemas.calculation.safeParse(qualification).success).toBe(
      false,
    );
  });

  it('prevents total improvement from disguising matched-activity worsening', () => {
    const value = calculation();
    const worker = value.scenario_values[0]!.per_worker[0]!;
    worker.activities[0]!.candidate += 1;
    worker.activities[0]!.delta += 1;
    worker.activities[1]!.candidate -= 1;
    worker.activities[1]!.delta -= 1;
    expect(handoffSchemas.calculation.safeParse(value).success).toBe(false);
    value.action_qualification.activity_protection = 'fail';
    value.action_qualification.qualifying = false;
    expect(handoffSchemas.calculation.safeParse(value).success).toBe(true);
  });

  it('requires a distinct checker, exact calculation reference and all scoped findings', () => {
    expect(
      handoffSchemas.independent_check.parse(check()).human_review_status,
    ).toBe('pending');
    expect(
      handoffSchemas.independent_check.safeParse({
        ...check(),
        checker_id: 'fixture_producer',
      }).success,
    ).toBe(false);
    const missing = check();
    missing.findings.pop();
    expect(handoffSchemas.independent_check.safeParse(missing).success).toBe(
      false,
    );
    expect(
      handoffSchemas.independent_check.safeParse({
        ...check(),
        calculation_ref: null,
        calculation_reason: reason,
      }).success,
    ).toBe(false);
    expect(
      handoffSchemas.independent_check.safeParse({
        ...check(),
        human_review_status: 'approve',
      }).success,
    ).toBe(false);
  });

  it('prepares bounded WorkerShield input without inventing agent execution or receipts', () => {
    expect(
      handoffSchemas.workershield_input.parse(workerShield())
        .agent_execution_status,
    ).toBe('not_run');
    expect(
      handoffSchemas.workershield_input.safeParse({
        ...workerShield(),
        tool_trace_ref: ref('fabricated_trace'),
      }).success,
    ).toBe(false);
    expect(
      handoffSchemas.workershield_input.safeParse({
        ...workerShield(),
        execution_surface: 'canonical',
      }).success,
    ).toBe(false);
    expect(
      handoffSchemas.workershield_input.safeParse({
        ...workerShield(),
        problem_epoch_reason: {
          code: 'current',
          explanation: 'Invented epoch.',
        },
      }).success,
    ).toBe(false);
    const gap = workerShield();
    gap.requested_question_kind = 'evidence_gap';
    gap.calculation_ref = null;
    gap.calculation_reason = reason;
    expect(handoffSchemas.workershield_input.safeParse(gap).success).toBe(
      false,
    );
    gap.permitted_plan_refs = [];
    gap.investigation_refs.ranking_ref = null;
    gap.investigation_refs.ranking_reason = reason;
    gap.investigation_refs.comparison_calculation_refs = [];
    gap.investigation_refs.comparison_reason = reason;
    gap.missing_field_diagnostics = [
      {
        field_path: '/scenario/yard/08',
        reason: {
          code: 'missing_coverage',
          explanation: 'Baseline interval absent.',
        },
      },
    ];
    expect(handoffSchemas.workershield_input.safeParse(gap).success).toBe(true);
  });

  it('pins the actual machine report, cutoff metadata, ranking and alternative calculations', () => {
    const input = workerShield();
    expect(
      handoffSchemas.workershield_input.parse(input).investigation_refs
        .comparison_calculation_refs,
    ).toHaveLength(2);
    expect(
      handoffSchemas.workershield_input.safeParse({
        ...input,
        investigation_refs: {
          ...input.investigation_refs,
          machine_report_ref: null,
        },
      }).success,
    ).toBe(false);
    expect(
      handoffSchemas.workershield_input.safeParse({
        ...input,
        investigation_refs: { ...input.investigation_refs, search_ref: null },
      }).success,
    ).toBe(false);
    expect(
      handoffSchemas.workershield_input.safeParse({
        ...input,
        investigation_refs: { ...input.investigation_refs, ranking_ref: null },
      }).success,
    ).toBe(false);
    expect(
      handoffSchemas.workershield_input.safeParse({
        ...input,
        investigation_refs: {
          ...input.investigation_refs,
          comparison_calculation_refs: [],
        },
      }).success,
    ).toBe(false);
    expect(
      handoffSchemas.workershield_input.safeParse({
        ...input,
        investigation_refs: {
          ...input.investigation_refs,
          comparison_reason: reason,
        },
      }).success,
    ).toBe(false);
    expect(
      handoffSchemas.workershield_input.safeParse({
        ...input,
        investigation_refs: {
          ...input.investigation_refs,
          comparison_calculation_refs: [
            ref('same_calculation'),
            ref('same_calculation'),
          ],
        },
      }).success,
    ).toBe(false);
  });
});
