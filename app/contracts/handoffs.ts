import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  identifierSchema as id,
  reasonSchema,
  referenceSchema as ref,
  timestampSchema as timestamp,
} from './common.js';
import { planningSchema, planningShape } from './planning.js';

// These are a deliberately bounded review package, not World Model acceptance
// commands. A valid document grants no operational or evidence-acceptance authority.
const identity = {
  id,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
const refs = z.array(ref).max(256);
const text = z.string().min(1).max(4096);
const amount = z.number().finite().nonnegative();
const interval = z.strictObject({ start: timestamp, end: timestamp });
const diagnostic = z.strictObject({ field_path: text, reason: reasonSchema });
const plan = z.strictObject({
  plan_ref: ref,
  assignments: z
    .array(z.strictObject({ activity_id: id, start: timestamp }))
    .min(1)
    .max(256),
});

/** Exact source locations; the full record still needs byte/reference resolution. */
export const sourceLocatorShape = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('passage'),
    document_ref: ref,
    page: z.number().int().positive(),
    section: text,
    quote: text,
    start_offset: z.number().int().nonnegative(),
    end_offset: z.number().int().positive(),
    offset_unit: z.literal('unicode_code_points'),
    quote_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    kind: z.literal('data'),
    series_id: id,
    run_id: id,
    row_indices: z.array(z.number().int().nonnegative()).min(1).max(256),
    intervals: z.array(interval).min(1).max(256),
    location_ids: z.array(id).min(1).max(128),
    selection_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    kind: z.literal('structured_fields'),
    record_ref: ref,
    field_pointers: z
      .array(
        z
          .string()
          .min(1)
          .max(512)
          .regex(/^(\/(?:[^~/]|~[01])*)+$/),
      )
      .min(1)
      .max(256),
  }),
]);

const evidence = z.strictObject({
  ...identity,
  schema_version: z.literal('haze.evidence.v2'),
  source_kind: z.literal('synthetic_fixture'),
  title: text,
  source_owner: z.literal('fictional_engineering_fixture'),
  raw_ref: ref,
  raw_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  locator: sourceLocatorShape,
  provenance: z.strictObject({ preparation: text, method_ref: ref }),
  retrieved_at: timestamp,
  permitted_uses: z.tuple([z.literal('engineering_historical')]),
  disposition: z.literal('fixture_not_accepted'),
  accepted_at: z.null(),
  acceptance_reason: reasonSchema,
  review_refs: z.tuple([]),
  limitations: z.array(text).min(1).max(64),
});

const scenario = z.strictObject({
  ...identity,
  schema_version: z.literal('haze.scenario.v2'),
  scenario_id: z.enum(['nominal', 'plus20']),
  base_scenario_ref: ref.nullable(),
  base_scenario_reason: reasonSchema.nullable(),
  source_kind: z.literal('synthetic_fixture'),
  support: z.literal('fictional_engineering_perturbation'),
  pollutant: z.literal('PM2.5'),
  unit: z.literal('ug/m3'),
  native_temporal_resolution_minutes: z.literal(60),
  allocation: z.literal('piecewise_constant'),
  transformation: z.strictObject({
    kind: z.enum(['identity', 'add_constant']),
    delta_ug_m3: z.union([z.literal(0), z.literal(20)]),
    applies_to: z.literal('all_locations_all_intervals'),
  }),
  evidence_refs: refs.min(1),
  intervals: z
    .array(
      interval.extend({
        location_id: id,
        value: amount.nullable(),
        quality_flag: z.enum(['fictional', 'missing']),
      }),
    )
    .min(1)
    .max(1024),
  review_status: z.literal('not_operationally_reviewed'),
});

const policy = z.strictObject({
  ...identity,
  schema_version: z.literal('haze.decision_policy.v2'),
  scope: z.literal('fictional_engineering_only'),
  approval_status: z.literal('fixture'),
  operational_approval_ref: z.null(),
  approval_reason: reasonSchema,
  required_scenario_refs: refs.length(2),
  minimum_gain_percent_each_scenario: z.literal(10),
  maximum_total_movement_minutes: z.literal(360),
  maximum_changed_activity_count: z.literal(3),
  maximum_per_activity_movement_minutes: z.literal(120),
  movement_counting: z.literal('shared_activity_once'),
  worker_nonincrease_required: z.literal(true),
  matched_activity_nonincrease_required: z.literal(true),
  new_controls_allowed: z.literal(false),
  reassignment_allowed: z.literal(false),
  overtime_allowed: z.literal(false),
  displacement_allowed: z.literal(false),
  fixed_work: z.tuple([
    z.literal('activity_ids'),
    z.literal('worker_assignments'),
    z.literal('durations'),
    z.literal('locations'),
    z.literal('services_and_quality'),
    z.literal('existing_controls'),
    z.literal('resource_limits'),
  ]),
  full_occupancy_required: z.literal(true),
  ranking: z.tuple([
    z.literal('least_total_movement'),
    z.literal('fewest_changed_activities'),
    z.literal('least_maximum_activity_movement'),
    z.literal('greatest_minimum_supported_crew_gain'),
    z.literal('greatest_nominal_crew_gain'),
    z.literal('canonical_activity_id_start_utc_sequence'),
  ]),
  numerical_tolerance: z.strictObject({
    method: z.literal('integer_ug_minutes_for_this_fixture'),
    substantive_increase_allowed: z.literal(false),
  }),
  cost_basis_ref: ref,
  unknown_cost_components: z.array(id).max(64),
  limitations: z.array(text).min(1).max(64),
});

const snapshot = z.strictObject({
  ...identity,
  schema_version: z.literal('haze.demo_snapshot.v1'),
  execution_surface: z.literal('historical_harness'),
  record_state: z.literal('demo_local_snapshot'),
  acceptance: z.literal('not_canonically_accepted'),
  proposal_status: z.literal('pending_human_review'),
  publication_status: z.literal('publication_disabled'),
  recommendation_eligible: z.literal(false),
  problem_epoch: z.null(),
  problem_epoch_reason: reasonSchema,
  bundle_ref: ref,
  planning: planningShape,
});

const inputDraft = z.strictObject({
  ...identity,
  schema_version: z.literal('haze.input_draft.v1'),
  state: z.literal('draft'),
  proposed_fields: planningShape.partial(),
  diagnostics: z.array(diagnostic).min(1).max(128),
  accepted_bundle_ref: z.null(),
  acceptance: z.literal('not_accepted'),
});

const plannerInput = z.strictObject({
  ...identity,
  schema_version: z.literal('haze.planner.input.v2'),
  programme_id: id,
  problem_id: id,
  execution_surface: z.literal('historical_harness'),
  intended_use: z.literal('engineering_historical'),
  input_origin: z.literal('synthetic_fixture'),
  snapshot_ref: ref,
  bundle_ref: ref,
  policy_ref: ref,
  scenario_refs: refs.length(2),
  evidence_refs: refs.min(1),
  declared_set_ref: ref,
  decision_time: timestamp,
  input_state: z.literal('demo_snapshot'),
  problem_epoch: z.null(),
  problem_epoch_reason: reasonSchema,
});

const activityValue = z.strictObject({
  activity_id: id,
  baseline: amount,
  candidate: amount,
  delta: z.number().finite(),
});
const workerValue = z.strictObject({
  worker_id: id,
  baseline: amount,
  candidate: amount,
  delta: z.number().finite(),
  activities: z.array(activityValue).min(1).max(256),
});
const calculation = z.strictObject({
  ...identity,
  schema_version: z.literal('haze.calculation.v2'),
  producer_id: id,
  planner_input_ref: ref,
  bundle_ref: ref,
  policy_ref: ref,
  baseline_ref: ref,
  plan,
  role: z.enum(['baseline', 'less_disruption', 'lower_proxy']),
  worker_unit: z.literal('hours * ug/m3'),
  crew_unit: z.literal('person-hours * ug/m3'),
  scenario_values: z
    .array(
      z.strictObject({
        scenario_ref: ref,
        per_worker: z.array(workerValue).min(1).max(64),
        crew: z.strictObject({
          baseline: amount,
          candidate: amount,
          delta: z.number().finite(),
          absolute_gain: z.number().finite(),
          percentage_gain: z.number().finite().nullable(),
          percentage_reason: reasonSchema.nullable(),
        }),
      }),
    )
    .length(2),
  disruption: z.strictObject({
    total_movement_minutes: amount,
    changed_activity_count: z.number().int().nonnegative(),
    per_activity: z
      .array(
        z.strictObject({ activity_id: id, absolute_movement_minutes: amount }),
      )
      .min(1)
      .max(256),
  }),
  action_qualification: z.strictObject({
    worker_protection: z.enum(['pass', 'fail']),
    activity_protection: z.enum(['pass', 'fail']),
    threshold_status: z.enum(['met', 'below']),
    movement_status: z.enum(['pass', 'fail']),
    qualifying: z.boolean(),
  }),
});

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
const independentCheck = z.strictObject({
  ...identity,
  schema_version: z.literal('haze.independent_check.v2'),
  checker_id: id,
  producer_id: id,
  independent_of_producer: z.literal(true),
  scope: z.literal('engineering_numeric_constraint_check'),
  planner_input_ref: ref,
  snapshot_ref: ref,
  bundle_ref: ref,
  policy_ref: ref,
  scenario_refs: refs.length(2),
  calculation_ref: ref.nullable(),
  calculation_reason: reasonSchema.nullable(),
  plan_ref: ref.nullable(),
  plan_reason: reasonSchema.nullable(),
  checked_at: timestamp,
  findings: z
    .array(
      z.strictObject({
        predicate: z.enum(predicates),
        status: z.enum(['passed', 'failed', 'not_assessable']),
        detail: text,
      }),
    )
    .min(1)
    .max(64),
  status: z.enum(['passed', 'failed', 'not_assessable']),
  human_review_status: z.literal('pending'),
  approval_authority: z.literal('none'),
});

const workerShieldInput = z.strictObject({
  ...identity,
  schema_version: z.literal('haze.workershield.input.v2'),
  run_id: id,
  programme_id: id,
  problem_id: id,
  execution_surface: z.literal('historical_harness'),
  snapshot_ref: ref,
  problem_epoch: z.null(),
  problem_epoch_reason: reasonSchema,
  bundle_ref: ref,
  calculation_ref: ref.nullable(),
  calculation_reason: reasonSchema.nullable(),
  check_refs: refs.min(1),
  investigation_refs: z.strictObject({
    machine_report_ref: ref,
    search_ref: ref,
    ranking_ref: ref.nullable(),
    ranking_reason: reasonSchema.nullable(),
    comparison_calculation_refs: refs,
    comparison_reason: reasonSchema.nullable(),
  }),
  intended_use: z.literal('engineering_historical'),
  mode: z.literal('offline_sample'),
  input_origin: z.literal('synthetic_fixture'),
  requested_question_kind: z.enum([
    'why_this_plan',
    'evidence_gap',
    'search_status',
  ]),
  permitted_plan_refs: refs,
  fact_index: z
    .array(
      z.strictObject({
        fact_id: id,
        check_ref: ref,
        status: z.enum(['passed', 'failed', 'pending']),
      }),
    )
    .max(256),
  evidence_index: z
    .array(z.strictObject({ evidence_ref: ref, locator: sourceLocatorShape }))
    .max(256),
  required_caveat_ids: z.array(id).min(1).max(128),
  missing_field_diagnostics: z.array(diagnostic).max(128),
  tool_allowlist: z
    .array(
      z.enum([
        'inspect_comparison',
        'inspect_rejection',
        'inspect_sensitivity',
        'inspect_coverage',
        'read_source',
        'read_review_status',
      ]),
    )
    .min(1)
    .max(6),
  bounds: z.strictObject({
    maximum_tool_calls: z.number().int().min(1).max(16),
    maximum_elapsed_ms: z.number().int().positive().max(60_000),
    maximum_output_bytes: z.number().int().positive().max(1_048_576),
  }),
  output_schema_version: z.literal('haze.explanation_plan.v2'),
  agent_execution_status: z.literal('not_run'),
  tool_trace_ref: z.null(),
  inference_receipt_ref: z.null(),
  execution_reason: reasonSchema,
});

export const handoffShapes = {
  evidence,
  scenario,
  policy,
  snapshot,
  input_draft: inputDraft,
  planner_input: plannerInput,
  calculation,
  independent_check: independentCheck,
  workershield_input: workerShieldInput,
};
export const HANDOFF_VERSIONS = {
  evidence: 'haze.evidence.v2',
  scenario: 'haze.scenario.v2',
  policy: 'haze.decision_policy.v2',
  snapshot: 'haze.demo_snapshot.v1',
  input_draft: 'haze.input_draft.v1',
  planner_input: 'haze.planner.input.v2',
  calculation: 'haze.calculation.v2',
  independent_check: 'haze.independent_check.v2',
  workershield_input: 'haze.workershield.input.v2',
} as const;
export type HandoffKind = keyof typeof handoffShapes;
export type EvidenceHandoff = z.infer<typeof evidence>;
export type ScenarioHandoff = z.infer<typeof scenario>;
export type PolicyHandoff = z.infer<typeof policy>;
export type SnapshotHandoff = z.infer<typeof snapshot>;
export type InputDraftHandoff = z.infer<typeof inputDraft>;
export type PlannerInputHandoff = z.infer<typeof plannerInput>;
export type CalculationHandoff = z.infer<typeof calculation>;
export type IndependentCheckHandoff = z.infer<typeof independentCheck>;
export type WorkerShieldInputHandoff = z.infer<typeof workerShieldInput>;

type Path = (string | number)[];
type AddIssue = (path: Path, message: string) => void;

function inspectLocalRefs(value: unknown, issue: AddIssue, path: Path = []) {
  if (Array.isArray(value))
    value.forEach((child, n) => inspectLocalRefs(child, issue, [...path, n]));
  else if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (
      typeof object.id === 'string' &&
      'revision' in object &&
      'sha256' in object &&
      !object.id.startsWith('demo:')
    )
      issue(
        [...path, 'id'],
        'Review-package references must be immutable demo-local references',
      );
    for (const [key, child] of Object.entries(object))
      inspectLocalRefs(child, issue, [...path, key]);
  }
}

function inspectLocator(
  locator: z.infer<typeof sourceLocatorShape>,
  issue: AddIssue,
  path: Path,
) {
  if (locator.kind === 'passage') {
    if (
      locator.end_offset - locator.start_offset !==
      Array.from(locator.quote).length
    )
      issue(
        path,
        'Passage offsets must match the exact quoted Unicode code points',
      );
    if (
      createHash('sha256').update(locator.quote, 'utf8').digest('hex') !==
      locator.quote_sha256
    )
      issue(
        [...path, 'quote_sha256'],
        'Passage quote hash must match its UTF-8 bytes',
      );
  } else if (locator.kind === 'data') {
    if (
      new Set(locator.row_indices).size !== locator.row_indices.length ||
      new Set(locator.location_ids).size !== locator.location_ids.length
    )
      issue(path, 'Data locator row and location selections must be unique');
    locator.intervals.forEach((row, n) => {
      if (Date.parse(row.start) >= Date.parse(row.end))
        issue([...path, 'intervals', n], 'Locator intervals must be positive');
    });
  } else if (
    new Set(locator.field_pointers).size !== locator.field_pointers.length
  )
    issue(path, 'Structured field pointers must be unique');
}

function refine<K extends HandoffKind>(kind: K): (typeof handoffShapes)[K] {
  return handoffShapes[kind].superRefine((value, ctx) => {
    const issue: AddIssue = (path, message) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (!value.id.startsWith('demo:'))
      issue(['id'], 'Review-package records must have demo-local IDs');
    inspectLocalRefs(value, issue);
    if (
      'problem_epoch_reason' in value &&
      value.problem_epoch_reason.code !== 'no_canonical_acceptance'
    )
      issue(
        ['problem_epoch_reason'],
        'Historical harness requires reason=no_canonical_acceptance',
      );
    if ('locator' in value) inspectLocator(value.locator, issue, ['locator']);
    if ('evidence_index' in value)
      value.evidence_index.forEach((row, n) =>
        inspectLocator(row.locator, issue, ['evidence_index', n, 'locator']),
      );
    if ('raw_ref' in value && value.raw_ref.sha256 !== value.raw_sha256)
      issue(['raw_sha256'], 'Raw byte hash must match the exact raw reference');
    if ('planning' in value) {
      const parsed = planningSchema.safeParse(value.planning);
      if (!parsed.success)
        parsed.error.issues.forEach((failure) =>
          issue(['planning', ...failure.path.map(String)], failure.message),
        );
      if (value.planning.input_origin !== 'synthetic_fixture')
        issue(
          ['planning', 'input_origin'],
          'The review package accepts fictional planning inputs only',
        );
    }
    if ('scenario_id' in value) {
      const nominal = value.scenario_id === 'nominal';
      if (value.base_scenario_ref?.id === value.id)
        issue(['base_scenario_ref'], 'A scenario cannot derive from itself');
      if (
        nominal
          ? value.base_scenario_ref !== null ||
            value.base_scenario_reason === null ||
            value.transformation.kind !== 'identity' ||
            value.transformation.delta_ug_m3 !== 0
          : value.base_scenario_ref === null ||
            value.base_scenario_reason !== null ||
            value.transformation.kind !== 'add_constant' ||
            value.transformation.delta_ug_m3 !== 20
      )
        issue(
          ['transformation'],
          'Nominal is identity; +20 is a paired additive perturbation of an exact nominal record',
        );
      const byLocation = new Map<string, { start: number; end: number }[]>();
      value.intervals.forEach((row, n) => {
        const a = Date.parse(row.start),
          b = Date.parse(row.end);
        if (b - a !== 3_600_000)
          issue(
            ['intervals', n],
            'Fictional source intervals retain native hourly resolution',
          );
        if ((row.value === null) !== (row.quality_flag === 'missing'))
          issue(
            ['intervals', n],
            'Missing values require a missing flag; fictional values cannot be marked missing',
          );
        const previous = byLocation.get(row.location_id) ?? [];
        if (previous.some((slot) => slot.start < b && a < slot.end))
          issue(
            ['intervals', n],
            'Source intervals at one location must not overlap',
          );
        previous.push({ start: a, end: b });
        byLocation.set(row.location_id, previous);
      });
    }
    if (
      'required_scenario_refs' in value &&
      value.required_scenario_refs[0]?.id ===
        value.required_scenario_refs[1]?.id
    )
      issue(
        ['required_scenario_refs'],
        'Two distinct paired scenario records are required',
      );
    if (
      'scenario_refs' in value &&
      value.scenario_refs[0]?.id === value.scenario_refs[1]?.id
    )
      issue(['scenario_refs'], 'Scenario references must be distinct');
    if ('scenario_values' in value) checkCalculation(value, issue);
    if ('checker_id' in value) {
      if (value.checker_id === value.producer_id)
        issue(
          ['checker_id'],
          'Independent checker identity must differ from the calculation producer',
        );
      if (
        (value.calculation_ref === null) ===
          (value.calculation_reason === null) ||
        (value.plan_ref === null) === (value.plan_reason === null)
      )
        issue(
          ['calculation_reason'],
          'Missing calculation/plan references need explicit reasons; present references have null reasons',
        );
      if (
        new Set(value.findings.map((finding) => finding.predicate)).size !==
        value.findings.length
      )
        issue(['findings'], 'Check predicates must be unique');
      if (
        value.status === 'passed' &&
        (value.calculation_ref === null ||
          value.plan_ref === null ||
          predicates.some(
            (predicate) =>
              !value.findings.some(
                (finding) =>
                  finding.predicate === predicate &&
                  finding.status === 'passed',
              ),
          ))
      )
        issue(
          ['status'],
          'A passed engineering check needs exact calculation/plan refs and every required predicate passed',
        );
      if (
        value.status === 'failed' &&
        !value.findings.some((finding) => finding.status === 'failed')
      )
        issue(['status'], 'Failed checks need a failed finding');
      if (
        value.status === 'not_assessable' &&
        !value.findings.some((finding) => finding.status === 'not_assessable')
      )
        issue(
          ['status'],
          'Unassessable checks need an explicit unassessable finding',
        );
    }
    if ('fact_index' in value) {
      const investigation = value.investigation_refs;
      if (
        (investigation.ranking_ref === null) ===
          (investigation.ranking_reason === null) ||
        (investigation.comparison_calculation_refs.length === 0) ===
          (investigation.comparison_reason === null)
      )
        issue(
          ['investigation_refs'],
          'Missing ranking or comparison records need explicit reasons; present records have null reasons',
        );
      if (
        value.calculation_ref === null &&
        (investigation.ranking_ref !== null ||
          investigation.comparison_calculation_refs.length !== 0)
      )
        issue(
          ['investigation_refs'],
          'A gap-only input exposes no calculated comparison or ranking records',
        );
      if (
        new Set(
          investigation.comparison_calculation_refs.map((record) => record.id),
        ).size !== investigation.comparison_calculation_refs.length
      )
        issue(
          ['investigation_refs', 'comparison_calculation_refs'],
          'Comparison calculation references must be unique',
        );
      if (
        (value.calculation_ref === null) ===
        (value.calculation_reason === null)
      )
        issue(
          ['calculation_reason'],
          'Missing calculation requires a reason; a present calculation has a null reason',
        );
      if (
        value.calculation_ref === null &&
        (value.permitted_plan_refs.length !== 0 ||
          value.fact_index.some((fact) => fact.status === 'passed'))
      )
        issue(
          ['permitted_plan_refs'],
          'A gap-only input exposes no quantified comparison or permitted plan',
        );
      if (
        value.requested_question_kind === 'evidence_gap' &&
        !value.missing_field_diagnostics.length
      )
        issue(
          ['missing_field_diagnostics'],
          'Evidence-gap questions require exact diagnostics',
        );
      if (new Set(value.tool_allowlist).size !== value.tool_allowlist.length)
        issue(['tool_allowlist'], 'Tool names must be unique');
    }
  }) as (typeof handoffShapes)[K];
}

function checkCalculation(value: CalculationHandoff, issue: AddIssue) {
  const close = (a: number, b: number) =>
    Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  const workerPass = value.scenario_values.every((scenario) =>
    scenario.per_worker.every((worker) => worker.candidate <= worker.baseline),
  );
  const activityPass = value.scenario_values.every((scenario) =>
    scenario.per_worker.every((worker) =>
      worker.activities.every(
        (activity) => activity.candidate <= activity.baseline,
      ),
    ),
  );
  const thresholdPass = value.scenario_values.every(
    (scenario) =>
      scenario.crew.percentage_gain !== null &&
      scenario.crew.percentage_gain >= 10,
  );
  const movementPass =
    value.disruption.total_movement_minutes <= 360 &&
    value.disruption.changed_activity_count <= 3 &&
    value.disruption.per_activity.every(
      (activity) => activity.absolute_movement_minutes <= 120,
    );
  const sameIds = (left: string[], right: string[]) =>
    left.length === right.length &&
    [...left].sort().every((entry, n) => entry === [...right].sort()[n]);
  const activityIds = value.plan.assignments.map(
    (assignment) => assignment.activity_id,
  );
  const firstWorkers = value.scenario_values[0]?.per_worker ?? [];
  if (
    new Set(value.plan.assignments.map((assignment) => assignment.activity_id))
      .size !== value.plan.assignments.length
  )
    issue(
      ['plan', 'assignments'],
      'Each activity must have one unique assignment',
    );
  if (
    new Set(value.scenario_values.map((scenario) => scenario.scenario_ref.id))
      .size !== 2
  )
    issue(
      ['scenario_values'],
      'Calculations need two distinct paired scenario records',
    );
  value.scenario_values.forEach((scenario, s) => {
    if (
      !sameIds(
        firstWorkers.map((worker) => worker.worker_id),
        scenario.per_worker.map((worker) => worker.worker_id),
      )
    )
      issue(
        ['scenario_values', s, 'per_worker'],
        'Paired scenarios must retain the same workers',
      );
    if (
      new Set(scenario.per_worker.map((worker) => worker.worker_id)).size !==
      scenario.per_worker.length
    )
      issue(['scenario_values', s, 'per_worker'], 'Worker IDs must be unique');
    scenario.per_worker.forEach((worker, w) => {
      const baselineWorker = firstWorkers.find(
        (entry) => entry.worker_id === worker.worker_id,
      );
      if (
        !sameIds(
          baselineWorker?.activities.map((activity) => activity.activity_id) ??
            [],
          worker.activities.map((activity) => activity.activity_id),
        ) ||
        worker.activities.some(
          (activity) => !activityIds.includes(activity.activity_id),
        )
      )
        issue(
          ['scenario_values', s, 'per_worker', w, 'activities'],
          'Paired scenarios must retain the same assigned known activities',
        );
      if (
        new Set(worker.activities.map((activity) => activity.activity_id))
          .size !== worker.activities.length
      )
        issue(
          ['scenario_values', s, 'per_worker', w, 'activities'],
          'Matched activity IDs must be unique',
        );
      worker.activities.forEach((activity, a) => {
        if (!close(activity.delta, activity.candidate - activity.baseline))
          issue(
            ['scenario_values', s, 'per_worker', w, 'activities', a, 'delta'],
            'Matched activity delta is candidate minus baseline',
          );
      });
      if (
        !close(
          worker.baseline,
          worker.activities.reduce(
            (sum, activity) => sum + activity.baseline,
            0,
          ),
        ) ||
        !close(
          worker.candidate,
          worker.activities.reduce(
            (sum, activity) => sum + activity.candidate,
            0,
          ),
        ) ||
        !close(worker.delta, worker.candidate - worker.baseline)
      )
        issue(
          ['scenario_values', s, 'per_worker', w],
          'Worker totals must reproduce their matched-activity sums',
        );
    });
    const crew = scenario.crew;
    if (
      !close(
        crew.baseline,
        scenario.per_worker.reduce((sum, worker) => sum + worker.baseline, 0),
      ) ||
      !close(
        crew.candidate,
        scenario.per_worker.reduce((sum, worker) => sum + worker.candidate, 0),
      ) ||
      !close(crew.delta, crew.candidate - crew.baseline) ||
      !close(crew.absolute_gain, crew.baseline - crew.candidate)
    )
      issue(
        ['scenario_values', s, 'crew'],
        'Crew totals, delta and gain must reproduce worker sums',
      );
    if (
      crew.baseline === 0
        ? crew.percentage_gain !== null ||
          crew.percentage_reason?.code !== 'zero_baseline'
        : crew.percentage_gain === null ||
          crew.percentage_reason !== null ||
          !close(
            crew.percentage_gain,
            (100 * crew.absolute_gain) / crew.baseline,
          )
    )
      issue(
        ['scenario_values', s, 'crew', 'percentage_gain'],
        'Percentage gain must agree with the signed gain and a positive baseline',
      );
  });
  const movement = value.disruption;
  if (
    !sameIds(
      activityIds,
      movement.per_activity.map((activity) => activity.activity_id),
    )
  )
    issue(
      ['disruption', 'per_activity'],
      'Movement must account for every declared activity, including zero movement',
    );
  if (
    new Set(movement.per_activity.map((activity) => activity.activity_id))
      .size !== movement.per_activity.length ||
    !close(
      movement.total_movement_minutes,
      movement.per_activity.reduce(
        (sum, activity) => sum + activity.absolute_movement_minutes,
        0,
      ),
    ) ||
    movement.changed_activity_count !==
      movement.per_activity.filter(
        (activity) => activity.absolute_movement_minutes > 0,
      ).length
  )
    issue(
      ['disruption'],
      'Shared-activity movement/count totals must agree, counting each activity once',
    );
  const q = value.action_qualification;
  if (
    (q.worker_protection === 'pass') !== workerPass ||
    (q.activity_protection === 'pass') !== activityPass ||
    (q.threshold_status === 'met') !== thresholdPass ||
    (q.movement_status === 'pass') !== movementPass ||
    q.qualifying !==
      (workerPass && activityPass && thresholdPass && movementPass)
  )
    issue(
      ['action_qualification'],
      'Qualification axes must agree independently with paired values and movement policy',
    );
}

export const handoffSchemas = {
  evidence: refine('evidence'),
  scenario: refine('scenario'),
  policy: refine('policy'),
  snapshot: refine('snapshot'),
  input_draft: refine('input_draft'),
  planner_input: refine('planner_input'),
  calculation: refine('calculation'),
  independent_check: refine('independent_check'),
  workershield_input: refine('workershield_input'),
};
