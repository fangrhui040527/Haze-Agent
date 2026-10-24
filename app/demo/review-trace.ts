import { readFileSync } from 'node:fs';
import {
  contractHash,
  canonicalJson,
  planningSchema,
  resultSchema,
  runSchema,
} from '../contracts/index.js';
import type {
  ImmutableReference,
  PlanningBundle,
  Result,
} from '../contracts/index.js';
import { independentlyCheckPlans } from './independent-check.js';
import { handoffSchemas, HANDOFF_VERSIONS } from '../contracts/handoffs.js';
import type {
  HandoffKind,
  CalculationHandoff,
  IndependentCheckHandoff,
} from '../contracts/handoffs.js';
import {
  buildContractErrorExamples,
  replayContractErrorExamples,
} from './contract-errors.js';

export const DEMO_NOTICE =
  'Fictional architecture section 23 engineering illustration; no operating evidence, human agreement, agent execution or publication authority.';
const reason = (code: string, explanation: string) => ({ code, explanation });
const notRun = reason(
  'not_executed',
  'This capability was not executed by the local contract and arithmetic harness.',
);
const historical = reason(
  'canonical_capability_unproved',
  'Canonical acceptance, heads, epochs and publication capability are unproved; immutable demo-local records only.',
);
const pending = reason(
  'human_review_pending',
  'Scope, contract and exact engineering review decisions remain pending; no person was contacted.',
);
const instant = (hour: number) =>
  `2026-10-25T${String(hour).padStart(2, '0')}:00:00+08:00`;

export interface DemoScenario {
  scenario_id: string;
  intervals: {
    location_id: string;
    start: string;
    end: string;
    concentration_ug_m3: number;
  }[];
}
export interface DemoPlan {
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
export interface DemoRecord {
  ref: ImmutableReference;
  record: unknown;
}

/** Registry is a historical artifact manifest, never a canonical store or admission service. */
class DemoRecords {
  readonly records: DemoRecord[] = [];
  constructor(private readonly generationKey = '') {}
  id(name: string) {
    return `demo:review-${this.generationKey ? `${this.generationKey}-` : ''}${name}`;
  }
  put(id: string, record: unknown): ImmutableReference {
    const body =
      record &&
      typeof record === 'object' &&
      'id' in record &&
      'revision' in record
        ? { ...record, id: this.id(id), revision: 1 }
        : record;
    const ref = { id: this.id(id), revision: 1, sha256: contractHash(body) };
    if (this.records.some((entry) => entry.ref.id === ref.id))
      throw new Error('duplicate_demo_record');
    this.records.push({ ref, record: structuredClone(body) });
    return ref;
  }
  artifact(id: string, data: object): ImmutableReference {
    return this.put(id, {
      schema_version: 'haze.demo-record.v2',
      id: this.id(id),
      revision: 1,
      notice: DEMO_NOTICE,
      ...data,
    });
  }
}

function sourceScenarios(): DemoScenario[] {
  return [0, 20].map((offset) => ({
    scenario_id: offset === 0 ? 'nominal' : 'plus20',
    intervals: ['yard', 'office'].flatMap((location_id) =>
      [100, 80, 50, 30].map((value, index) => ({
        location_id,
        start: instant(8 + index),
        end: instant(9 + index),
        concentration_ug_m3: (location_id === 'yard' ? value : 20) + offset,
      })),
    ),
  }));
}

/** Integrate source interval bytes, rejecting gaps rather than silently assigning zero. */
export function evaluateDemoPlan(
  bundle: PlanningBundle,
  scenarios: DemoScenario[],
  plan: DemoPlan,
): ReportedValues[] {
  planningSchema.parse({
    ...bundle,
    baseline: { ...bundle.baseline, assignments: plan.assignments },
  });
  return scenarios.map((scenario) => {
    const worker_values = bundle.crew.workers.map((worker) => {
      const activity_values = bundle.activities
        .filter((activity) => activity.worker_ids.includes(worker.worker_id))
        .map((activity) => {
          const assignment = plan.assignments.find(
            (entry) => entry.activity_id === activity.activity_id,
          )!;
          const start = Date.parse(assignment.start);
          const end = start + activity.duration_minutes * 60_000;
          const rows = scenario.intervals
            .filter((entry) => entry.location_id === activity.location_id)
            .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
          let cursor = start;
          let value = 0;
          for (const row of rows) {
            const from = Math.max(start, Date.parse(row.start));
            const to = Math.min(end, Date.parse(row.end));
            if (from >= to) continue;
            if (from !== cursor)
              throw new Error(
                `missing_or_overlapping_evidence:${scenario.scenario_id}:${activity.location_id}`,
              );
            if (
              !Number.isFinite(row.concentration_ug_m3) ||
              row.concentration_ug_m3 < 0
            )
              throw new Error('invalid_concentration');
            value += ((to - from) / 3_600_000) * row.concentration_ug_m3;
            cursor = to;
          }
          if (cursor !== end)
            throw new Error(
              `missing_evidence:${scenario.scenario_id}:${activity.location_id}`,
            );
          return { activity_id: activity.activity_id, value };
        });
      return {
        worker_id: worker.worker_id,
        activity_values,
        total: activity_values.reduce(
          (sum, activity) => sum + activity.value,
          0,
        ),
      };
    });
    return {
      plan_id: plan.plan_id,
      scenario_id: scenario.scenario_id,
      worker_values,
      crew_total: worker_values.reduce((sum, worker) => sum + worker.total, 0),
    };
  });
}

/** Existing planning v2 is reused; this module adds no live route or production planner. */
export function buildDemoInputs(generationKey = '') {
  const store = new DemoRecords(generationKey);
  const bundle = planningSchema.parse(
    JSON.parse(
      readFileSync(
        new URL('../../input_examples/v2/planning.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  bundle.programme_id = 'haze-engineering-demo';
  bundle.problem_id = 'klang-section23-review';
  const plans: DemoPlan[] = [
    {
      plan_id: 'baseline',
      assignments: [
        { activity_id: 'inspection', start: instant(8) },
        { activity_id: 'maintenance', start: instant(9) },
        { activity_id: 'administration', start: instant(10) },
      ],
    },
    {
      plan_id: 'less-disruption',
      assignments: [
        { activity_id: 'inspection', start: instant(8) },
        { activity_id: 'maintenance', start: instant(11) },
        { activity_id: 'administration', start: instant(9) },
      ],
    },
    {
      plan_id: 'lower-proxy',
      assignments: [
        { activity_id: 'inspection', start: instant(10) },
        { activity_id: 'maintenance', start: instant(11) },
        { activity_id: 'administration', start: instant(8) },
      ],
    },
  ];
  const planRefs = plans.map((plan) =>
    store.artifact(`plan-${plan.plan_id}`, plan),
  );
  bundle.baseline.ref = planRefs[0]!;
  bundle.baseline.assignments = plans[0]!.assignments;
  const policy = {
    minimum_relative_gain: 0.1,
    max_total_movement_minutes: 360,
    max_changed_activities: 3,
    max_individual_movement_minutes: {
      inspection: 120,
      maintenance: 120,
      administration: 120,
    },
    required_scenario_ids: ['nominal', 'plus20'],
  };
  // Specific attested meanings replace the earlier contract-only placeholder records.
  const meanings: Record<string, object> = {
    [bundle.target_ref.id]: {
      target: 'At least 10% crew proxy reduction in nominal and plus20',
      scope: 'fictional_engineering_only',
      relative_floor: 0.1,
    },
    [bundle.method_ref.id]: {
      interpolation: 'piecewise_constant_native_intervals',
      boundary: 'half_open',
      worker_unit: 'hours * ug/m3',
      crew_unit: 'person-hours * ug/m3',
      arithmetic:
        'sum overlap hours times concentration; shared movement counted once',
    },
    [bundle.attestation_ref.id]: {
      status: 'fictional_only',
      fixed_work: true,
      fixed_workers_locations_durations: true,
      timing_rights: 'fictional movable starts only',
      workers: bundle.crew.workers.map((worker) => worker.worker_id),
    },
    [bundle.feasibility_gate_ref.id]: {
      status: 'unresolved',
      phase: 'provisional',
      outcome: null,
      day_one_real_use: 'not_established',
      owner_decision: 'pending',
      operational_recommendation_enabled: false,
      district_id: bundle.district_id,
      problem_id: bundle.problem_id,
      assessment: bundle.assessment,
      decision_time: fixtureTime,
      horizon: { start: bundle.assessment.start, end: bundle.assessment.end },
      findings: [
        'ordinary_schedule',
        'actual_flexibility',
        'authority_and_constraints',
        'information_available_in_time',
        'useful_discrimination',
        'supported_uncertainty',
      ].map((predicate) => ({
        predicate,
        status: 'pending',
        evidence_refs: [],
      })),
      reviewers: [],
      authority: 'pending',
      unresolved_gaps: [
        'No real employer timing rights or ordinary-practice baseline',
        'No prospective workplace series or qualified uncertainty',
        'No exact human scope or contract sign-off',
      ],
      next_decision:
        'A responsible human must record the day-one gate finding from actual evidence before real-use implementation; this harness cannot supply it.',
    },
    [bundle.resource_absence_basis_ref!.id]: {
      fictional_attestation:
        'No shared bottleneck resources for this illustration only',
    },
    [bundle.baseline.ordinary_practice_basis_ref.id]: {
      status: 'fictional_only',
      assignments: plans[0]!.assignments,
      ordinary_practice: 'invented; not evidence of employer practice',
    },
    [bundle.comparison_use_ref.id]: {
      declared_use:
        'Reproduce section 23 fictional nominal/+20 interval comparison',
      support: 'synthetic_only',
      operational_applicability: 'unproved',
    },
    [bundle.constraint_review_ref.id]: {
      fictional_attestation:
        'No travel or setup needed between the two invented locations; no unrecorded waiting or breaks',
      full_occupancy: true,
    },
    [bundle.cost_basis_ref.id]: {
      status: 'not_applicable',
      reason:
        'No monetary cost objective or claim in this engineering scope; movement burden evaluated explicitly',
    },
    [bundle.existing_control_basis_ref!.id]: {
      fictional_attestation:
        'No additional existing controls in this illustration; no modification or removal of controls permitted',
    },
  };
  for (const location of bundle.locations) {
    meanings[location.spatial_support_ref.id] = {
      location_id: location.location_id,
      geometry:
        'fictional point used only to join invented interval values; no station-to-workplace inference',
      independent_series: true,
    };
    meanings[location.existing_control_basis_ref!.id] = {
      location_id: location.location_id,
      fictional_attestation:
        'No additional existing controls in this invented location',
    };
  }
  for (const activity of bundle.activities)
    meanings[activity.required_service_ref.id] = {
      activity_id: activity.activity_id,
      required_service: activity.activity_id,
      duration_minutes: activity.duration_minutes,
      worker_ids: activity.worker_ids,
      location_id: activity.location_id,
      invariant:
        'same work, duration, workers and location; starts only may change',
    };
  const replacements = new Map<string, ImmutableReference>();
  for (const [id, meaning] of Object.entries(meanings))
    replacements.set(id, store.artifact(id.replace(/^demo:/, ''), meaning));
  const replace = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      if (
        typeof object.id === 'string' &&
        'sha256' in object &&
        replacements.has(object.id)
      )
        return replacements.get(object.id);
      return Object.fromEntries(
        Object.entries(object).map(([key, child]) => [key, replace(child)]),
      );
    }
    return value;
  };
  const resolvedBundle = planningSchema.parse(replace(bundle));
  const scenarios = sourceScenarios();
  return { store, bundle: resolvedBundle, scenarios, plans, planRefs, policy };
}

function resultTemplate(
  bundle: PlanningBundle,
  bundleRef: ImmutableReference,
  runId: string,
): Result {
  const value = resultSchema.parse(
    JSON.parse(
      readFileSync(
        new URL('../../output_examples/v2/result.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  const rewriteReasons = (object: unknown): void => {
    if (Array.isArray(object)) object.forEach(rewriteReasons);
    else if (object && typeof object === 'object') {
      const row = object as Record<string, unknown>;
      if (
        row.code === 'contract_specimen_not_executed' ||
        row.code === 'not_checked'
      )
        Object.assign(row, notRun);
      Object.values(row).forEach(rewriteReasons);
    }
  };
  rewriteReasons(value);
  value.run_id = `demo:review-${runId}`;
  value.programme_id = bundle.programme_id;
  value.problem_id = bundle.problem_id;
  value.execution.state = 'completed';
  value.execution.admission_reason = reason(
    'local_generator_only',
    'The local review generator executed. No canonical or user API run was admitted; admission metadata is absent.',
  );
  value.execution.finished_reason = reason(
    'deterministic_fixture_metadata',
    'The command performs local validation; immutable fixture bytes omit wall-clock execution metadata.',
  );
  value.decision_ref.bundle_ref = bundleRef;
  value.decision_ref.reviews_reason = pending;
  value.result.blockers = [
    reason('synthetic_fixture', DEMO_NOTICE),
    historical,
    pending,
  ];
  value.result.next_decision =
    'Review this engineering scope and contracts; assign human owners and resolve real-use, policy, evidence, canonical capability and exact review gates before operational implementation.';
  value.assumptions = [
    DEMO_NOTICE,
    'Same workers, services, durations and locations; only starts move. Full 08:00–12:00 occupancy, no travel/setup or resource bottleneck are fictional attestations.',
  ];
  value.limitations = [
    'The local generator and a separate deterministic checker execute arithmetic and contract validation only; no production planner or WorkerShield agent execution is claimed.',
    'The declared illustration set contains three named schedules; the complete feasible 15-minute search space is not enumerated or certified.',
    'The +20 perturbation is fictional, not a forecast-error distribution or qualified operational uncertainty treatment.',
    'Concentration-time proxy is not dose, safety, health damage or demonstrated workplace benefit. Publication and operational recommendations remain disabled.',
  ];
  return value;
}

function assertReferences(value: unknown, records: DemoRecord[]): void {
  const known = new Map<string, DemoRecord>();
  for (const entry of records) {
    const key = `${entry.ref.id}@${entry.ref.revision}`;
    if (known.has(key)) throw new Error(`duplicate_reference:${key}`);
    if (
      !entry.ref.id.startsWith('demo:') ||
      contractHash(entry.record) !== entry.ref.sha256
    )
      throw new Error(`immutable_record_hash_mismatch:${key}`);
    if (
      entry.record &&
      typeof entry.record === 'object' &&
      'id' in entry.record &&
      entry.record.id !== entry.ref.id
    )
      throw new Error(`immutable_record_identity_mismatch:${key}`);
    known.set(key, entry);
  }
  const visit = (child: unknown): void => {
    if (Array.isArray(child)) return child.forEach(visit);
    if (!child || typeof child !== 'object') return;
    const object = child as Record<string, unknown>;
    if (
      typeof object.id === 'string' &&
      typeof object.revision === 'number' &&
      typeof object.sha256 === 'string'
    ) {
      const entry = known.get(`${object.id}@${object.revision}`);
      if (!entry || entry.ref.sha256 !== object.sha256)
        throw new Error(`unresolved_reference:${object.id}`);
    }
    Object.values(object).forEach(visit);
  };
  visit(value);
}

const fixtureTime = '2026-10-23T08:00:00+08:00';
const noEpoch = reason('no_canonical_acceptance', historical.explanation);

/** Produce a deterministic, reviewable package; no network, approval, or live publication. */
export function generateDemoReviewPackage(
  recordedAt = new Date().toISOString(),
) {
  const {
    store,
    bundle,
    scenarios: sourceDefinitions,
    plans,
    planRefs,
    policy: checkerPolicy,
  } = buildDemoInputs(contractHash({ recorded_at: recordedAt }).slice(0, 12));
  const put = (kind: HandoffKind, name: string, fields: object) => {
    const record = handoffSchemas[kind].parse({
      revision: 1,
      schema_version: HANDOFF_VERSIONS[kind],
      ...fields,
      id: store.id(name),
    });
    return store.put(name, record);
  };
  const evidenceRefs: ImmutableReference[] = [];
  const scenarioRefs: ImmutableReference[] = [];
  for (const scenario of sourceDefinitions) {
    const raw = {
      scenario_id: scenario.scenario_id,
      notice: DEMO_NOTICE,
      intervals: scenario.intervals,
    };
    const rawRef = store.artifact(`raw-${scenario.scenario_id}`, raw);
    const locator = {
      kind: 'data' as const,
      series_id: `demo:section23-${scenario.scenario_id}`,
      run_id: 'demo:review-preparation',
      row_indices: scenario.intervals.map((_, index) => index),
      intervals: scenario.intervals.map(({ start, end }) => ({ start, end })),
      location_ids: ['yard', 'office'],
      selection_sha256: contractHash(scenario.intervals),
    };
    const evidenceRef = put('evidence', `evidence-${scenario.scenario_id}`, {
      source_kind: 'synthetic_fixture',
      title: `Fictional section 23 ${scenario.scenario_id} hourly values`,
      source_owner: 'fictional_engineering_fixture',
      raw_ref: rawRef,
      raw_sha256: rawRef.sha256,
      locator,
      provenance: {
        preparation:
          'Invented section 23 values; office is independently invented. Timestamp records local package generation, not a live source retrieval.',
        method_ref: bundle.method_ref,
      },
      retrieved_at: recordedAt,
      permitted_uses: ['engineering_historical'],
      disposition: 'fixture_not_accepted',
      accepted_at: null,
      acceptance_reason: noEpoch,
      review_refs: [],
      limitations: [
        DEMO_NOTICE,
        'Hourly information allocated piecewise constantly on a 15-minute planning grid; no finer forecast precision implied.',
        '+20 applies to every location and interval; no operational uncertainty support.',
      ],
    });
    evidenceRefs.push(evidenceRef);
    scenarioRefs.push(
      put('scenario', `scenario-${scenario.scenario_id}`, {
        scenario_id: scenario.scenario_id,
        base_scenario_ref:
          scenario.scenario_id === 'nominal' ? null : scenarioRefs[0],
        base_scenario_reason:
          scenario.scenario_id === 'nominal'
            ? reason('base_scenario', 'The nominal source is the fixture base.')
            : null,
        source_kind: 'synthetic_fixture',
        support: 'fictional_engineering_perturbation',
        pollutant: 'PM2.5',
        unit: 'ug/m3',
        native_temporal_resolution_minutes: 60,
        allocation: 'piecewise_constant',
        transformation: {
          kind:
            scenario.scenario_id === 'nominal' ? 'identity' : 'add_constant',
          delta_ug_m3: scenario.scenario_id === 'nominal' ? 0 : 20,
          applies_to: 'all_locations_all_intervals',
        },
        evidence_refs: [evidenceRef],
        intervals: scenario.intervals.map(
          ({ concentration_ug_m3, ...row }) => ({
            ...row,
            value: concentration_ug_m3,
            quality_flag: 'fictional',
          }),
        ),
        review_status: 'not_operationally_reviewed',
      }),
    );
  }
  // Consume the canonical, hash-bound record bytes rather than a detached table
  // of expected totals. Raw source rows and normalized scenario rows must agree.
  const scenarios: DemoScenario[] = scenarioRefs.map((ref, index) => {
    const body = store.records.find((entry) => entry.ref.id === ref.id)!.record;
    const parsed = handoffSchemas.scenario.parse(
      JSON.parse(canonicalJson(body)),
    );
    const evidence = handoffSchemas.evidence.parse(
      store.records.find((entry) => entry.ref.id === evidenceRefs[index]!.id)!
        .record,
    );
    const raw = JSON.parse(
      canonicalJson(
        store.records.find((entry) => entry.ref.id === evidence.raw_ref.id)!
          .record,
      ),
    ) as { intervals: DemoScenario['intervals'] };
    const intervals = parsed.intervals.map((row) => ({
      location_id: row.location_id,
      start: row.start,
      end: row.end,
      concentration_ug_m3: row.value!,
    }));
    if (contractHash(raw.intervals) !== contractHash(intervals))
      throw new Error('normalized_scenario_differs_from_source_bytes');
    return { scenario_id: parsed.scenario_id, intervals };
  });
  bundle.evidence_refs = evidenceRefs;
  bundle.policy_ref = put('policy', 'policy', {
    scope: 'fictional_engineering_only',
    approval_status: 'fixture',
    operational_approval_ref: null,
    approval_reason: reason(
      'fictional_policy',
      'Engineering policy from section 23 only; responsible owner/domain approval pending.',
    ),
    required_scenario_refs: scenarioRefs,
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
    cost_basis_ref: bundle.cost_basis_ref,
    unknown_cost_components: [],
    limitations: [
      'No monetary optimization or workplace benefit claim; fictional movement burden only.',
      DEMO_NOTICE,
    ],
  });
  const actualPolicy = handoffSchemas.policy.parse(
    store.records.find((entry) => entry.ref.id === bundle.policy_ref.id)!
      .record,
  );
  Object.assign(checkerPolicy, {
    minimum_relative_gain:
      actualPolicy.minimum_gain_percent_each_scenario / 100,
    max_total_movement_minutes: actualPolicy.maximum_total_movement_minutes,
    max_changed_activities: actualPolicy.maximum_changed_activity_count,
    max_individual_movement_minutes: Object.fromEntries(
      bundle.activities.map((activity) => [
        activity.activity_id,
        actualPolicy.maximum_per_activity_movement_minutes,
      ]),
    ),
    required_scenario_ids: scenarios.map((scenario) => scenario.scenario_id),
  });
  const bundleRef = store.put('planning', planningSchema.parse(bundle));
  const snapshotRef = put('snapshot', 'snapshot', {
    execution_surface: 'historical_harness',
    record_state: 'demo_local_snapshot',
    acceptance: 'not_canonically_accepted',
    proposal_status: 'pending_human_review',
    publication_status: 'publication_disabled',
    recommendation_eligible: false,
    problem_epoch: null,
    problem_epoch_reason: noEpoch,
    bundle_ref: bundleRef,
    planning: bundle,
  });
  const declaredSetRef = store.artifact('declared-set', {
    scope: 'three_named_section23_schedules_only',
    plan_refs: planRefs,
    full_allowed_set_enumerated: false,
    exclusions:
      'All other 15-minute-grid schedules are outside this illustration; no pruning or global absence claim.',
  });
  const plannerFields = {
    programme_id: bundle.programme_id,
    problem_id: bundle.problem_id,
    execution_surface: 'historical_harness',
    intended_use: 'engineering_historical',
    input_origin: 'synthetic_fixture',
    snapshot_ref: snapshotRef,
    bundle_ref: bundleRef,
    policy_ref: bundle.policy_ref,
    scenario_refs: scenarioRefs,
    evidence_refs: evidenceRefs,
    decision_time: fixtureTime,
    input_state: 'demo_snapshot',
    problem_epoch: null,
    problem_epoch_reason: noEpoch,
    declared_set_ref: declaredSetRef,
  };
  const plannerRef = put('planner_input', 'planner-input', plannerFields);
  const reported = plans.flatMap((plan) =>
    evaluateDemoPlan(bundle, scenarios, plan),
  );
  const independent = independentlyCheckPlans(
    bundle,
    scenarios,
    plans,
    reported,
    checkerPolicy,
  );
  if (!independent.passed)
    throw new Error(
      `independent_demo_check_failed:${JSON.stringify(independent.findings)}`,
    );
  if (independent.ranking.selected_plan_id !== 'less-disruption')
    throw new Error('independent_named_set_ranking_mismatch');
  const machineRef = store.artifact('independent-machine-report', independent);
  const calculationRefs: ImmutableReference[] = [];
  const checkRefs: ImmutableReference[] = [];
  const calculations: CalculationHandoff[] = [];
  const predicates = [
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
  ] as const;
  for (const [index, plan] of plans.entries()) {
    const checks = independent.plans.find(
      (entry) => entry.plan_id === plan.plan_id,
    )!;
    const calculation: CalculationHandoff = handoffSchemas.calculation.parse({
      id: `demo:review-calculation-${plan.plan_id}`,
      revision: 1,
      schema_version: HANDOFF_VERSIONS.calculation,
      producer_id: 'demo:interval-intersection-producer',
      planner_input_ref: plannerRef,
      bundle_ref: bundleRef,
      policy_ref: bundle.policy_ref,
      baseline_ref: planRefs[0],
      plan: { plan_ref: planRefs[index], assignments: plan.assignments },
      role: plan.plan_id.replaceAll('-', '_'),
      worker_unit: 'hours * ug/m3',
      crew_unit: 'person-hours * ug/m3',
      scenario_values: scenarios.map((scenario, scenarioIndex) => {
        const current = reported.find(
          (row) =>
            row.plan_id === plan.plan_id &&
            row.scenario_id === scenario.scenario_id,
        )!;
        const baseline = reported.find(
          (row) =>
            row.plan_id === 'baseline' &&
            row.scenario_id === scenario.scenario_id,
        )!;
        return {
          scenario_ref: scenarioRefs[scenarioIndex],
          per_worker: current.worker_values.map((worker) => {
            const baseWorker = baseline.worker_values.find(
              (row) => row.worker_id === worker.worker_id,
            )!;
            return {
              worker_id: worker.worker_id,
              baseline: baseWorker.total,
              candidate: worker.total,
              delta: worker.total - baseWorker.total,
              activities: worker.activity_values.map((activity) => {
                const baseActivity = baseWorker.activity_values.find(
                  (row) => row.activity_id === activity.activity_id,
                )!;
                return {
                  activity_id: activity.activity_id,
                  baseline: baseActivity.value,
                  candidate: activity.value,
                  delta: activity.value - baseActivity.value,
                };
              }),
            };
          }),
          crew: {
            baseline: baseline.crew_total,
            candidate: current.crew_total,
            delta: current.crew_total - baseline.crew_total,
            absolute_gain: baseline.crew_total - current.crew_total,
            percentage_gain:
              (100 * (baseline.crew_total - current.crew_total)) /
              baseline.crew_total,
            percentage_reason: null,
          },
        };
      }),
      disruption: {
        total_movement_minutes: checks.movement.M,
        changed_activity_count: checks.movement.N,
        per_activity: plan.assignments.map((entry) => ({
          activity_id: entry.activity_id,
          absolute_movement_minutes:
            Math.abs(
              Date.parse(entry.start) -
                Date.parse(
                  plans[0]!.assignments.find(
                    (base) => base.activity_id === entry.activity_id,
                  )!.start,
                ),
            ) / 60_000,
        })),
      },
      action_qualification: {
        worker_protection: checks.worker_protection ? 'pass' : 'fail',
        activity_protection: checks.activity_protection ? 'pass' : 'fail',
        threshold_status: checks.action_qualified ? 'met' : 'below',
        movement_status: 'pass',
        qualifying: checks.action_qualified,
      },
    });
    calculations.push(calculation);
    const calculationRef = store.put(
      `calculation-${plan.plan_id}`,
      calculation,
    );
    calculationRefs.push(calculationRef);
    const typedCheck = {
      checker_id: 'demo:independent-minute-checker',
      producer_id: calculation.producer_id,
      independent_of_producer: true,
      scope: 'engineering_numeric_constraint_check',
      planner_input_ref: plannerRef,
      snapshot_ref: snapshotRef,
      bundle_ref: bundleRef,
      policy_ref: bundle.policy_ref,
      scenario_refs: scenarioRefs,
      calculation_ref: calculationRef,
      calculation_reason: null,
      plan_ref: planRefs[index],
      plan_reason: null,
      checked_at: recordedAt,
      findings: predicates.map((predicate) => ({
        predicate,
        status: 'passed',
        detail:
          predicate === 'action_floor'
            ? `Reproduced qualification=${checks.action_qualified}; baseline zero gain is below the floor and never selected.`
            : predicate === 'ranking'
              ? 'Independent checker orders only checked supplied plans by M, N, L, greatest minimum scenario gain, nominal gain, canonical starts; no full feasible-set ranking claimed.'
              : `Recomputed from exact source/bundle/schedule bytes; machine report ${machineRef.id}. This machine check grants no human approval.`,
      })),
      status: 'passed',
      human_review_status: 'pending',
      approval_authority: 'none',
    };
    checkRefs.push(
      put('independent_check', `check-${plan.plan_id}`, typedCheck),
    );
  }
  const sourceIndex = evidenceRefs.map((ref) => {
    const record = handoffSchemas.evidence.parse(
      store.records.find((row) => row.ref.id === ref.id)!.record,
    );
    return { evidence_ref: ref, locator: record.locator };
  });
  const workerShield = (
    name: string,
    fields: {
      planner: ImmutableReference;
      snapshot: ImmutableReference;
      bundle: ImmutableReference;
      calculation: ImmutableReference | null;
      checks: ImmutableReference[];
      question: 'why_this_plan' | 'search_status' | 'evidence_gap';
      permitted: ImmutableReference[];
      diagnostics?: { field_path: string; reason: ReturnType<typeof reason> }[];
      source_index?: typeof sourceIndex;
      investigation: {
        machine_report_ref: ImmutableReference;
        search_ref: ImmutableReference;
        ranking_ref: ImmutableReference | null;
        ranking_reason: ReturnType<typeof reason> | null;
        comparison_calculation_refs: ImmutableReference[];
        comparison_reason: ReturnType<typeof reason> | null;
      };
    },
  ) =>
    put('workershield_input', `workershield-${name}`, {
      run_id: `demo:review-${name}`,
      programme_id: bundle.programme_id,
      problem_id: bundle.problem_id,
      execution_surface: 'historical_harness',
      snapshot_ref: fields.snapshot,
      problem_epoch: null,
      problem_epoch_reason: noEpoch,
      bundle_ref: fields.bundle,
      calculation_ref: fields.calculation,
      calculation_reason: fields.calculation
        ? null
        : reason(
            'missing_baseline_coverage',
            'No supported baseline integral or quantified comparison is available.',
          ),
      check_refs: fields.checks,
      investigation_refs: fields.investigation,
      intended_use: 'engineering_historical',
      mode: 'offline_sample',
      input_origin: 'synthetic_fixture',
      requested_question_kind: fields.question,
      permitted_plan_refs: fields.permitted,
      fact_index: fields.calculation
        ? fields.checks.map((check) => ({
            fact_id: `demo:checked-${check.id.slice(5)}`,
            check_ref: check,
            status: 'passed',
          }))
        : [],
      evidence_index: fields.source_index ?? sourceIndex,
      required_caveat_ids: [
        'synthetic_fixture',
        'hourly_native_information',
        'proxy_not_dose_or_safety',
        'uncertainty_fictional',
        'canonical_capability_unproved',
        'human_review_pending',
        'declared_search_scope_only',
        'agent_not_run',
      ],
      missing_field_diagnostics: fields.diagnostics ?? [],
      tool_allowlist: [
        'inspect_comparison',
        'inspect_sensitivity',
        'inspect_coverage',
        'read_source',
        'read_review_status',
      ],
      bounds: {
        maximum_tool_calls: 6,
        maximum_elapsed_ms: 30_000,
        maximum_output_bytes: 16_384,
      },
      output_schema_version: 'haze.explanation_plan.v2',
      agent_execution_status: 'not_run',
      tool_trace_ref: null,
      inference_receipt_ref: null,
      execution_reason: reason(
        'interface_prepared_only',
        'Typed inspection inputs are prepared for review. No tool investigation, model call or WorkerShield agent execution occurred.',
      ),
    });
  const rankingRef = store.artifact('ranking', {
    policy_ref: bundle.policy_ref,
    independently_checked_report_ref: machineRef,
    selected_plan_ref: planRefs[1],
    ordered_qualifying_plan_refs: [planRefs[1], planRefs[2]],
    reason:
      'Both alternatives meet the fictional floor and paired protection. M=180 beats M=360 before proxy tie-breaks; baseline zero gain does not qualify.',
    full_allowed_set_enumerated: false,
  });
  const namedSearchRef = store.artifact('search-named-set', {
    planner_input_ref: plannerRef,
    declared_set_ref: declaredSetRef,
    visited_plan_refs: planRefs,
    calculation_refs: calculationRefs,
    check_refs: checkRefs,
    machine_report_ref: machineRef,
    ranking_ref: rankingRef,
    search_status: 'complete',
    search_verification_status: 'partial',
    optimality_status: 'unknown',
    counts: {
      visited: 3,
      feasible: 3,
      scored: 3,
      protected: 3,
      qualifying: 2,
      independently_checked: 3,
    },
    cutoff_reason:
      'All three named supplied schedules inspected; remaining allowed-start schedules outside the illustration. No exhaustive allowed-set search or certificate.',
    full_allowed_set_enumerated: false,
  });
  const workerShieldRefs = plans.map((plan, index) =>
    workerShield(plan.plan_id, {
      planner: plannerRef,
      snapshot: snapshotRef,
      bundle: bundleRef,
      calculation: calculationRefs[index]!,
      checks: [checkRefs[index]!],
      question: 'why_this_plan',
      permitted: planRefs,
      investigation: {
        machine_report_ref: machineRef,
        search_ref: namedSearchRef,
        ranking_ref: rankingRef,
        ranking_reason: null,
        comparison_calculation_refs: calculationRefs,
        comparison_reason: null,
      },
    }),
  );
  const coverageRef = store.artifact('coverage', {
    bundle_ref: bundleRef,
    scenario_refs: scenarioRefs,
    required_locations: ['yard', 'office'],
    interval: bundle.assessment,
    complete: true,
    checked_by_ref: machineRef,
    declared_use: 'fictional_engineering_only',
  });
  const alternativesRef = store.artifact('alternatives', {
    calculation_refs: calculationRefs,
    check_refs: checkRefs,
    ranking_ref: rankingRef,
  });
  const policyCapsRef = store.artifact('movement-caps', checkerPolicy);
  const objectiveRef = store.artifact('objective', {
    policy_ref: bundle.policy_ref,
    minimum_relative_gain_each_required_scenario: 0.1,
    selection_rule:
      'least disruption among independently checked qualifying candidates',
    target_scope: 'fictional_engineering_only',
  });
  const evidenceIndexRef = store.artifact('evidence-index', {
    evidence_refs: evidenceRefs,
    scenario_refs: scenarioRefs,
  });
  const fullTraceRef = store.artifact('trace-named-set', {
    mode: 'historical_harness',
    evidence_refs: evidenceRefs,
    snapshot_ref: snapshotRef,
    planner_input_ref: plannerRef,
    calculation_refs: calculationRefs,
    check_refs: checkRefs,
    search_ref: namedSearchRef,
    ranking_ref: rankingRef,
    workershield_input_refs: workerShieldRefs,
    workershield_execution: 'not_run',
    human_review: 'pending',
  });
  const incompletePlannerRef = put(
    'planner_input',
    'planner-input-incomplete',
    plannerFields,
  );
  const incompleteMachine = independentlyCheckPlans(
    bundle,
    scenarios,
    plans.slice(0, 2),
    reported.filter((row) => row.plan_id !== 'lower-proxy'),
    checkerPolicy,
  );
  if (!incompleteMachine.passed)
    throw new Error('incomplete_incumbent_check_failed');
  if (incompleteMachine.ranking.selected_plan_id !== 'less-disruption')
    throw new Error('independent_incumbent_ranking_mismatch');
  const incompleteMachineRef = store.artifact(
    'independent-machine-incomplete',
    incompleteMachine,
  );
  const incompleteCalculationRefs = calculations
    .slice(0, 2)
    .map((calculation, index) =>
      put('calculation', `calculation-incomplete-${plans[index]!.plan_id}`, {
        ...calculation,
        id: `demo:review-calculation-incomplete-${plans[index]!.plan_id}`,
        planner_input_ref: incompletePlannerRef,
      }),
    );
  const incompleteCheckRefs = checkRefs.slice(0, 2).map((check, index) => {
    const original = handoffSchemas.independent_check.parse(
      store.records.find((entry) => entry.ref.id === check.id)!.record,
    );
    return put(
      'independent_check',
      `check-incomplete-${plans[index]!.plan_id}`,
      {
        ...original,
        id: `demo:review-check-incomplete-${plans[index]!.plan_id}`,
        planner_input_ref: incompletePlannerRef,
        calculation_ref: incompleteCalculationRefs[index],
        findings: original.findings.map((finding) => ({
          ...finding,
          detail: finding.detail.replace(
            machineRef.id,
            incompleteMachineRef.id,
          ),
        })),
      },
    );
  });
  const incompleteRankingRef = store.artifact('ranking-incomplete', {
    policy_ref: bundle.policy_ref,
    independently_checked_report_ref: incompleteMachineRef,
    selected_plan_ref: planRefs[1],
    ordered_qualifying_plan_refs: [planRefs[1]],
    reason:
      'Only baseline and less-disruption are inspected; retained verified improving incumbent, unknown preference over unvisited plans.',
  });
  const incompleteSearchRef = store.artifact('search-incomplete', {
    planner_input_ref: incompletePlannerRef,
    declared_set_ref: declaredSetRef,
    visited_plan_refs: planRefs.slice(0, 2),
    calculation_refs: incompleteCalculationRefs,
    check_refs: incompleteCheckRefs,
    machine_report_ref: incompleteMachineRef,
    ranking_ref: incompleteRankingRef,
    search_status: 'incomplete',
    search_verification_status: 'partial',
    optimality_status: 'unknown',
    counts: {
      visited: 2,
      feasible: 2,
      scored: 2,
      protected: 2,
      qualifying: 1,
      independently_checked: 2,
    },
    cutoff_reason:
      'Deliberate fixture cutoff after baseline and checked less-disruption incumbent; no measured runtime timeout or conclusion about unvisited schedules.',
    full_allowed_set_enumerated: false,
  });
  const incompleteWorkerShieldRef = workerShield('incomplete-search', {
    planner: incompletePlannerRef,
    snapshot: snapshotRef,
    bundle: bundleRef,
    calculation: incompleteCalculationRefs[1]!,
    checks: incompleteCheckRefs,
    question: 'search_status',
    permitted: planRefs.slice(0, 2),
    investigation: {
      machine_report_ref: incompleteMachineRef,
      search_ref: incompleteSearchRef,
      ranking_ref: incompleteRankingRef,
      ranking_reason: null,
      comparison_calculation_refs: incompleteCalculationRefs,
      comparison_reason: null,
    },
  });
  const incompleteTraceRef = store.artifact('trace-incomplete', {
    mode: 'historical_harness',
    evidence_refs: evidenceRefs,
    snapshot_ref: snapshotRef,
    planner_input_ref: incompletePlannerRef,
    visited_plan_refs: planRefs.slice(0, 2),
    calculation_refs: incompleteCalculationRefs,
    check_refs: incompleteCheckRefs,
    search_ref: incompleteSearchRef,
    ranking_ref: incompleteRankingRef,
    workershield_input_ref: incompleteWorkerShieldRef,
    cutoff: 'deliberate fixture cutoff; no measured timeout',
    workershield_execution: 'not_run',
    human_review: 'pending',
  });
  const resultFor = (name: string, incomplete: boolean): Result => {
    const value = resultTemplate(bundle, bundleRef, name);
    const result = value.result;
    value.decision_ref.candidate_ref = planRefs[1]!;
    value.decision_ref.candidate_reason = null;
    result.decision_outcome = 'action_candidate_found';
    result.evidence_status = 'sufficient_for_declared_use';
    result.feasibility = 'verified';
    result.baseline_improvement = 'verified_positive';
    result.protection_status = { worker: 'pass', activity: 'pass' };
    result.action_threshold_status = 'met';
    result.uncertainty_status = 'supported';
    result.search_status = incomplete ? 'incomplete' : 'complete';
    result.search_verification_status = 'partial';
    result.optimality_status = 'unknown';
    result.selected_plan_ref = planRefs[1]!;
    result.selected_plan_reason = null;
    result.comparison_plan_reason = reason(
      'selected_witness_used',
      'The quantified witness is the selected engineering candidate; no separate comparison-only plan is needed.',
    );
    result.rejections_reason = reason(
      'no_rejected_alternatives',
      'No inspected alternative failed the fictional qualification filters. Baseline is a zero-gain comparison anchor and does not qualify as an action.',
    );
    result.unscored_reason = reason(
      'no_unscored_visited_plans',
      'Every visited supplied schedule has complete fictional interval support and is scored. Unvisited schedules carry no inferred values or rejection reasons.',
    );
    result.baseline_ref = planRefs[0]!;
    result.baseline_reason = null;
    result.alternatives_ref = incomplete ? null : alternativesRef;
    result.alternatives_reason = incomplete
      ? reason(
          'unvisited_alternative',
          'Only baseline and less-disruption were inspected; no claim about the unvisited lower-proxy schedule.',
        )
      : null;
    const paired = calculations[1]!.scenario_values;
    const pairedNumbers = (index: number) => {
      const crew = paired[index]!.crew;
      return {
        baseline: crew.baseline,
        candidate: crew.candidate,
        absolute_gain: crew.absolute_gain,
        percentage_gain: crew.percentage_gain,
        percentage_reason: crew.percentage_reason,
      };
    };
    result.quantified = {
      plan_ref: planRefs[1]!,
      values_ref: (incomplete
        ? incompleteCalculationRefs
        : calculationRefs)[1]!,
      crew_unit: 'person-hours * ug/m3',
      nominal: pairedNumbers(0),
      scenarios: [{ scenario_ref: scenarioRefs[1]!, ...pairedNumbers(1) }],
    };
    result.quantified_reason = null;
    result.plan_verification = plans
      .slice(0, incomplete ? 2 : 3)
      .map((_, index) => ({
        plan_ref: planRefs[index]!,
        checker_status: 'passed',
        feasibility: 'verified',
        worker_protection: 'pass',
        activity_protection: 'pass',
        uncertainty_status: 'supported',
        action_threshold_status: index === 0 ? 'below' : 'met',
        movement_cost_status: 'pass',
        check_refs: [(incomplete ? incompleteCheckRefs : checkRefs)[index]!],
        check_details_ref: incomplete ? incompleteMachineRef : machineRef,
        check_details_reason: null,
        worker_activity_values_ref: (incomplete
          ? incompleteCalculationRefs
          : calculationRefs)[index]!,
        worker_activity_values_reason: null,
        protection_violations_ref: null,
        protection_violations_reason: reason(
          'no_violations',
          'The independent checker found no increase in matched activities or worker totals in either fictional scenario.',
        ),
        protection_violation_count: 0,
      }));
    result.plan_verification_reason = null;
    result.policy = {
      policy_ref: bundle.policy_ref,
      approval_status: 'fixture',
      floor_results_ref: (incomplete
        ? incompleteCalculationRefs
        : calculationRefs)[1]!,
      movement: {
        M_activity_minutes: 180,
        N_changed_activities: 2,
        L_max_activity_minutes: 120,
        caps_ref: policyCapsRef,
      },
      cost_status: 'not_applicable',
      cost_reason: reason(
        'no_monetary_objective',
        'Monetary costs excluded from this engineering scope; no zero monetary cost asserted.',
      ),
      ranking_ref: incomplete ? incompleteRankingRef : rankingRef,
      objective_ref: objectiveRef,
    };
    result.policy_reason = null;
    result.search = {
      method_ref: bundle.method_ref,
      method_reason: null,
      declared_set_ref: declaredSetRef,
      declared_set_reason: null,
      counts: {
        visited: incomplete ? 2 : 3,
        feasible: incomplete ? 2 : 3,
        scored: incomplete ? 2 : 3,
        protected: incomplete ? 2 : 3,
        qualifying: incomplete ? 1 : 2,
        independently_checked: incomplete ? 2 : 3,
      },
      cutoff_reason: reason(
        incomplete ? 'fixture_cutoff' : 'named_set_only',
        incomplete
          ? 'Deliberate fixture cutoff after baseline and checked less-disruption incumbent; not a measured runtime timeout.'
          : 'All three supplied schedules were inspected; other allowed 15-minute schedules were not searched. No exhaustive search/certificate or global optimality claim.',
      ),
      exclusions_ref: declaredSetRef,
      exclusions_reason: null,
      verification_basis_ref: incomplete ? incompleteMachineRef : machineRef,
      verification_basis_reason: null,
      certificate_ref: null,
      certificate_reason: reason(
        'no_exhaustion_certificate',
        'Only supplied schedule arithmetic is independently checked; full search exhaustion is unproved.',
      ),
    };
    result.target_test = {
      status: 'met',
      plan_ref: planRefs[1]!,
      rule_ref: objectiveRef,
      scope: 'fixture',
      reason: null,
    };
    result.target_feasibility = {
      status: 'attainable',
      declared_set_ref: declaredSetRef,
      witness_ref: planRefs[1]!,
      basis_ref: (incomplete ? incompleteCheckRefs : checkRefs)[1]!,
      reason: null,
    };
    value.evidence = {
      declared_use:
        'Fictional section 23 nominal/+20 screening comparison only; no operational applicability claim.',
      records_ref: evidenceIndexRef,
      records_reason: null,
      coverage_ref: coverageRef,
      coverage_reason: null,
      scenario_refs: scenarioRefs,
      scenarios_reason: null,
      projection_vector_ref: null,
      projection_vector_reason: historical,
      gaps: [],
    };
    value.trace_ref = incomplete ? incompleteTraceRef : fullTraceRef;
    value.trace_reason = null;
    return resultSchema.parse(value);
  };
  const namedSetResult = resultFor('named-set', false);
  const incompleteResult = resultFor('incomplete-search', true);
  const missingGap = reason(
    'missing_baseline_hour',
    'The yard 08:00–09:00 value is missing in nominal and plus20. Baseline inspection is unsupported; no quantified comparison, selection or inferred zero is allowed.',
  );
  const missingEvidenceRefs: ImmutableReference[] = [];
  const missingScenarioRefs: ImmutableReference[] = [];
  const missingSources = scenarios.map((scenario) => ({
    ...scenario,
    intervals: scenario.intervals.filter(
      (row) => !(row.location_id === 'yard' && row.start === instant(8)),
    ),
  }));
  for (const [index, scenario] of scenarios.entries()) {
    const rows = scenario.intervals.map((row) => ({
      location_id: row.location_id,
      start: row.start,
      end: row.end,
      value:
        row.location_id === 'yard' && row.start === instant(8)
          ? null
          : row.concentration_ug_m3,
      quality_flag:
        row.location_id === 'yard' && row.start === instant(8)
          ? 'missing'
          : 'fictional',
    }));
    const rawRef = store.artifact(`raw-missing-${scenario.scenario_id}`, {
      intervals: rows,
      notice: DEMO_NOTICE,
      deliberate_gap: missingGap,
    });
    const originalEvidence = handoffSchemas.evidence.parse(
      store.records.find((entry) => entry.ref.id === evidenceRefs[index]!.id)!
        .record,
    );
    const evidenceRef = put(
      'evidence',
      `evidence-missing-${scenario.scenario_id}`,
      {
        ...originalEvidence,
        id: `demo:review-evidence-missing-${scenario.scenario_id}`,
        raw_ref: rawRef,
        raw_sha256: rawRef.sha256,
        locator: {
          kind: 'structured_fields',
          record_ref: rawRef,
          field_pointers: ['/intervals'],
        },
        limitations: [...originalEvidence.limitations, missingGap.explanation],
      },
    );
    missingEvidenceRefs.push(evidenceRef);
    const originalScenario = handoffSchemas.scenario.parse(
      store.records.find((entry) => entry.ref.id === scenarioRefs[index]!.id)!
        .record,
    );
    missingScenarioRefs.push(
      put('scenario', `scenario-missing-${scenario.scenario_id}`, {
        ...originalScenario,
        id: `demo:review-scenario-missing-${scenario.scenario_id}`,
        base_scenario_ref: index === 0 ? null : missingScenarioRefs[0],
        evidence_refs: [evidenceRef],
        intervals: rows,
      }),
    );
  }
  const missingPolicyRef = put('policy', 'policy-missing', {
    ...actualPolicy,
    id: 'demo:review-policy-missing',
    required_scenario_refs: missingScenarioRefs,
  });
  const missingBundle = planningSchema.parse({
    ...bundle,
    policy_ref: missingPolicyRef,
    evidence_refs: missingEvidenceRefs,
  });
  const missingBundleRef = store.put('planning-missing', missingBundle);
  const missingSnapshotRef = put('snapshot', 'snapshot-missing', {
    execution_surface: 'historical_harness',
    record_state: 'demo_local_snapshot',
    acceptance: 'not_canonically_accepted',
    proposal_status: 'pending_human_review',
    publication_status: 'publication_disabled',
    recommendation_eligible: false,
    problem_epoch: null,
    problem_epoch_reason: noEpoch,
    bundle_ref: missingBundleRef,
    planning: missingBundle,
  });
  const missingPlannerRef = put('planner_input', 'planner-input-missing', {
    ...plannerFields,
    snapshot_ref: missingSnapshotRef,
    bundle_ref: missingBundleRef,
    policy_ref: missingPolicyRef,
    scenario_refs: missingScenarioRefs,
    evidence_refs: missingEvidenceRefs,
  });
  const missingMachine = independentlyCheckPlans(
    missingBundle,
    missingSources,
    [plans[0]!],
    [],
    checkerPolicy,
  );
  if (missingMachine.passed)
    throw new Error('missing_evidence_was_not_blocked');
  const missingMachineRef = store.artifact(
    'independent-machine-missing',
    missingMachine,
  );
  const missingCheck: Omit<
    IndependentCheckHandoff,
    'id' | 'revision' | 'schema_version'
  > = {
    checker_id: 'demo:independent-minute-checker',
    producer_id: 'demo:interval-intersection-producer',
    independent_of_producer: true,
    scope: 'engineering_numeric_constraint_check',
    planner_input_ref: missingPlannerRef,
    snapshot_ref: missingSnapshotRef,
    bundle_ref: missingBundleRef,
    policy_ref: missingPolicyRef,
    scenario_refs: missingScenarioRefs,
    calculation_ref: null,
    calculation_reason: missingGap,
    plan_ref: null,
    plan_reason: missingGap,
    checked_at: recordedAt,
    findings: predicates.map((predicate) => ({
      predicate,
      status: [
        'reference_integrity',
        'fixed_work',
        'full_occupancy',
        'normalized_constraints',
      ].includes(predicate)
        ? 'passed'
        : 'not_assessable',
      detail: [
        'reference_integrity',
        'fixed_work',
        'full_occupancy',
        'normalized_constraints',
      ].includes(predicate)
        ? 'The fixed-work input shape and immutable references remain valid.'
        : `${missingGap.explanation} Machine report: ${missingMachineRef.id}`,
    })),
    status: 'not_assessable',
    human_review_status: 'pending',
    approval_authority: 'none',
  };
  const missingCheckRef = put(
    'independent_check',
    'check-missing',
    missingCheck,
  );
  const missingSourceIndex = missingEvidenceRefs.map((ref) => ({
    evidence_ref: ref,
    locator: handoffSchemas.evidence.parse(
      store.records.find((entry) => entry.ref.id === ref.id)!.record,
    ).locator,
  }));
  const missingSearchRef = store.artifact('search-missing', {
    planner_input_ref: missingPlannerRef,
    declared_set_ref: declaredSetRef,
    visited_plan_refs: [],
    calculation_refs: [],
    check_refs: [missingCheckRef],
    machine_report_ref: missingMachineRef,
    ranking_ref: null,
    ranking_reason: missingGap,
    search_status: 'not_run',
    search_verification_status: 'not_checked',
    optimality_status: 'unknown',
    counts: {
      visited: 0,
      feasible: 0,
      scored: 0,
      protected: 0,
      qualifying: 0,
      independently_checked: 0,
    },
    cutoff_reason: missingGap,
    full_allowed_set_enumerated: false,
  });
  const missingWorkerShieldRef = workerShield('missing-evidence', {
    planner: missingPlannerRef,
    snapshot: missingSnapshotRef,
    bundle: missingBundleRef,
    calculation: null,
    checks: [missingCheckRef],
    question: 'evidence_gap',
    permitted: [],
    diagnostics: [
      {
        field_path: '/scenarios/nominal/yard/2026-10-25T08:00:00+08:00',
        reason: missingGap,
      },
      {
        field_path: '/scenarios/plus20/yard/2026-10-25T08:00:00+08:00',
        reason: missingGap,
      },
    ],
    source_index: missingSourceIndex,
    investigation: {
      machine_report_ref: missingMachineRef,
      search_ref: missingSearchRef,
      ranking_ref: null,
      ranking_reason: missingGap,
      comparison_calculation_refs: [],
      comparison_reason: missingGap,
    },
  });
  const missingTraceRef = store.artifact('trace-missing', {
    evidence_refs: missingEvidenceRefs,
    scenario_refs: missingScenarioRefs,
    snapshot_ref: missingSnapshotRef,
    planner_input_ref: missingPlannerRef,
    calculations: [],
    check_ref: missingCheckRef,
    search_ref: missingSearchRef,
    workershield_input_ref: missingWorkerShieldRef,
    gap: missingGap,
    workershield_execution: 'not_run',
    human_review: 'pending',
  });
  const missingResult = resultTemplate(
    missingBundle,
    missingBundleRef,
    'missing-evidence',
  );
  missingResult.result.blockers.unshift(missingGap);
  missingResult.result.selected_plan_reason = missingGap;
  missingResult.result.comparison_plan_reason = missingGap;
  missingResult.result.baseline_reason = missingGap;
  missingResult.result.quantified_reason = missingGap;
  missingResult.result.target_test.reason = missingGap;
  missingResult.result.target_feasibility.reason = missingGap;
  missingResult.result.next_decision =
    'Supply a new immutable fixture revision with complete baseline-hour bytes, then recalculate and independently check; human and operational gates remain unresolved.';
  missingResult.evidence = {
    declared_use:
      'Fictional missing-evidence domain outcome; not a transport or validation exception.',
    records_ref: store.artifact('missing-evidence-index', {
      evidence_refs: missingEvidenceRefs,
      scenario_refs: missingScenarioRefs,
    }),
    records_reason: null,
    coverage_ref: store.artifact('coverage-missing', {
      bundle_ref: missingBundleRef,
      scenario_refs: missingScenarioRefs,
      complete: false,
      gaps: [missingGap],
      check_ref: missingCheckRef,
    }),
    coverage_reason: null,
    scenario_refs: missingScenarioRefs,
    scenarios_reason: null,
    projection_vector_ref: null,
    projection_vector_reason: historical,
    gaps: [missingGap],
  };
  missingResult.trace_ref = missingTraceRef;
  missingResult.trace_reason = null;
  resultSchema.parse(missingResult);
  const draftRef = put('input_draft', 'draft', {
    state: 'draft',
    proposed_fields: {
      programme_id: bundle.programme_id,
      problem_id: bundle.problem_id,
    },
    diagnostics: [
      {
        field_path: '/crew',
        reason: reason(
          'required_input_pending',
          'Draft illustration has not supplied the crew or other required fixed-work fields; it cannot be admitted as a bundle.',
        ),
      },
    ],
    accepted_bundle_ref: null,
    acceptance: 'not_accepted',
  });
  const namedResultRef = store.put('result-named-set', namedSetResult);
  const missingResultRef = store.put('result-missing', missingResult);
  const incompleteResultRef = store.put('result-incomplete', incompleteResult);
  const request = runSchema.parse({
    schema_version: 'haze.run.v2',
    programme_id: bundle.programme_id,
    input: {
      operation: 'plan_outdoor_work',
      problem_id: bundle.problem_id,
      bundle_ref: bundleRef,
    },
  });
  const missingRequest = runSchema.parse({
    ...request,
    input: { ...request.input, bundle_ref: missingBundleRef },
  });
  const cases = [
    ...plans.map((plan, index) => ({
      case_id: plan.plan_id,
      result_ref: namedResultRef,
      evidence_and_inputs: {
        snapshot_ref: snapshotRef,
        bundle_ref: bundleRef,
        scenario_refs: scenarioRefs,
        evidence_refs: evidenceRefs,
      },
      planner: {
        input_ref: plannerRef,
        calculation_ref: calculationRefs[index],
        plan_ref: planRefs[index],
      },
      verification: {
        check_ref: checkRefs[index],
        machine_report_ref: machineRef,
      },
      workershield: {
        input_ref: workerShieldRefs[index],
        execution_status: 'not_run',
      },
      expected: {
        nominal_crew: calculations[index]!.scenario_values[0]!.crew.candidate,
        plus20_crew: calculations[index]!.scenario_values[1]!.crew.candidate,
        movement_M: independent.plans[index]!.movement.M,
        changed_N: independent.plans[index]!.movement.N,
        maximum_L: independent.plans[index]!.movement.L,
        action_qualified: independent.plans[index]!.action_qualified,
        selected_in_named_set: index === 1,
        review: 'pending',
        operationally_eligible: false,
      },
    })),
    {
      case_id: 'missing-evidence',
      result_ref: missingResultRef,
      evidence_and_inputs: {
        snapshot_ref: missingSnapshotRef,
        bundle_ref: missingBundleRef,
        scenario_refs: missingScenarioRefs,
        evidence_refs: missingEvidenceRefs,
      },
      planner: {
        input_ref: missingPlannerRef,
        calculation_ref: null,
        reason: missingGap,
      },
      verification: {
        check_ref: missingCheckRef,
        machine_report_ref: missingMachineRef,
      },
      workershield: {
        input_ref: missingWorkerShieldRef,
        execution_status: 'not_run',
      },
      expected: {
        quantified: null,
        selected_plan: null,
        outcome: 'insufficient_evidence',
        review: 'pending',
        operationally_eligible: false,
      },
    },
    {
      case_id: 'incomplete-search',
      result_ref: incompleteResultRef,
      evidence_and_inputs: {
        snapshot_ref: snapshotRef,
        bundle_ref: bundleRef,
        scenario_refs: scenarioRefs,
        evidence_refs: evidenceRefs,
      },
      planner: {
        input_ref: incompletePlannerRef,
        calculation_ref: incompleteCalculationRefs[1],
        visited_plan_refs: planRefs.slice(0, 2),
      },
      verification: {
        check_refs: incompleteCheckRefs,
        machine_report_ref: incompleteMachineRef,
      },
      workershield: {
        input_ref: incompleteWorkerShieldRef,
        execution_status: 'not_run',
      },
      expected: {
        nominal_crew: calculations[1]!.scenario_values[0]!.crew.candidate,
        plus20_crew: calculations[1]!.scenario_values[1]!.crew.candidate,
        verified_gain_retained: true,
        search: 'incomplete',
        optimality: 'unknown',
        review: 'pending',
        operationally_eligible: false,
      },
    },
  ];
  const packageValue = {
    schema_version: 'haze.demo_review_package.v1',
    recorded_at: recordedAt,
    architecture:
      'Haze_Agent_Architecture_v0.13.pdf sections 1–3, 15, 19 and 23',
    notice: DEMO_NOTICE,
    execution_surface: 'historical_harness',
    publication_status: 'publication_disabled',
    recommendation_eligible: false,
    clock: {
      recorded_at:
        'Actual package-generation timestamp; checks replay deterministically using this preserved metadata.',
      decision_time:
        'Fictional fixture preparation clock; planning window is 25 October 2026 08:00–12:00 Asia/Kuala_Lumpur.',
    },
    input_draft_ref: draftRef,
    requests: { named_set: request, missing_evidence: missingRequest },
    results: {
      named_set: namedSetResult,
      missing_evidence: missingResult,
      incomplete_search: incompleteResult,
    },
    cases,
    records: store.records,
  };
  assertReferences(packageValue, store.records);
  return {
    ...packageValue,
    error_examples: buildContractErrorExamples(bundle),
  };
}

export function validateDemoReviewPackage(
  value: ReturnType<typeof generateDemoReviewPackage>,
) {
  const { error_examples: errors, ...valid } = value;
  assertReferences(valid, value.records);
  replayContractErrorExamples(errors);
  for (const entry of value.records) {
    const record = entry.record;
    if (
      typeof record !== 'object' ||
      record === null ||
      !('schema_version' in record)
    )
      continue;
    const kind = (Object.keys(HANDOFF_VERSIONS) as HandoffKind[]).find(
      (name) => HANDOFF_VERSIONS[name] === record.schema_version,
    );
    if (kind) handoffSchemas[kind].parse(record);
    else if (record.schema_version === 'haze.planning.v2')
      planningSchema.parse(record);
    else if (record.schema_version === 'haze.result.v2')
      resultSchema.parse(record);
  }
  for (const result of Object.values(value.results)) resultSchema.parse(result);
  const replayed = generateDemoReviewPackage(value.recorded_at);
  if (contractHash(replayed) !== contractHash(value))
    throw new Error('demo_package_drift:regenerate_demo_package');
  return {
    valid: true,
    cases: value.cases.length,
    immutable_records: value.records.length,
    negative_examples: errors.length,
    publication_status: value.publication_status,
    recommendation_eligible: value.recommendation_eligible,
  };
}
