import { z } from 'zod';
import {
  identifierSchema,
  inputOriginSchema,
  reasonSchema,
  referenceSchema,
  timestampSchema,
} from './common.js';

const reasons = z.array(reasonSchema).max(128);
const references = z.array(referenceSchema).max(128);
const text = z.string().min(1).max(2_000);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const amount = z.number().finite().min(0);
const protection = z.enum(['pass', 'fail', 'indeterminate', 'not_checked']);
const feasibility = z.enum(['verified', 'failed', 'not_checked']);
const threshold = z.enum(['met', 'below', 'not_assessable']);
const uncertainty = z.enum([
  'supported',
  'not_supported',
  'not_assessed',
  'incomplete',
]);
const review = z.enum([
  'pending',
  'approve',
  'revise',
  'insufficient_evidence',
  'reject',
]);

const planVerification = z.strictObject({
  plan_ref: referenceSchema,
  checker_status: z.enum(['passed', 'failed', 'not_checked']),
  feasibility,
  worker_protection: protection,
  activity_protection: protection,
  uncertainty_status: uncertainty,
  action_threshold_status: threshold,
  movement_cost_status: z.enum([
    'pass',
    'fail',
    'indeterminate',
    'not_checked',
  ]),
  check_refs: references,
  check_details_ref: referenceSchema.nullable(),
  check_details_reason: reasonSchema.nullable(),
  worker_activity_values_ref: referenceSchema.nullable(),
  worker_activity_values_reason: reasonSchema.nullable(),
  protection_violations_ref: referenceSchema.nullable(),
  protection_violations_reason: reasonSchema.nullable(),
  protection_violation_count: count,
});

const quantified = z.strictObject({
  plan_ref: referenceSchema,
  values_ref: referenceSchema,
  crew_unit: z.literal('person-hours * ug/m3'),
  nominal: z.strictObject({
    baseline: amount,
    candidate: amount,
    absolute_gain: z.number().finite(),
    percentage_gain: z.number().finite().nullable(),
    percentage_reason: reasonSchema.nullable(),
  }),
  scenarios: z
    .array(
      z.strictObject({
        scenario_ref: referenceSchema,
        baseline: amount,
        candidate: amount,
        absolute_gain: z.number().finite(),
        percentage_gain: z.number().finite().nullable(),
        percentage_reason: reasonSchema.nullable(),
      }),
    )
    .min(1)
    .max(32),
});

/** Closed structural contract. Cross-field predicates live in resultSchema. */
export const resultShape = z.strictObject({
  schema_version: z.literal('haze.result.v2'),
  run_id: identifierSchema,
  programme_id: identifierSchema,
  problem_id: identifierSchema,
  execution_surface: z.enum(['canonical', 'historical_harness']),
  execution: z.strictObject({
    state: z.enum([
      'queued',
      'running',
      'waiting',
      'paused',
      'completed',
      'failed',
      'cancelled',
      'timed_out',
    ]),
    admitted: z.boolean(),
    admitted_at: timestampSchema.nullable(),
    admission_reason: reasonSchema.nullable(),
    deadline_at: timestampSchema.nullable(),
    deadline_reason: reasonSchema.nullable(),
    finished_at: timestampSchema.nullable(),
    finished_reason: reasonSchema.nullable(),
    parent_run_id: identifierSchema.nullable(),
    parent_reason: reasonSchema.nullable(),
    replacement_run_id: identifierSchema.nullable(),
    replacement_reason: reasonSchema.nullable(),
    checkpoint_ref: referenceSchema.nullable(),
    checkpoint_reason: reasonSchema.nullable(),
    waiting_reason: reasonSchema.nullable(),
  }),
  input_assessment: z.strictObject({
    status: z.enum(['valid', 'invalid', 'incomplete', 'unsupported']),
    field_reasons: reasons,
  }),
  mode: z.enum(['live', 'cached_live', 'offline_sample']),
  input_origin: inputOriginSchema,
  decision_ref: z.strictObject({
    bundle_ref: referenceSchema,
    candidate_ref: referenceSchema.nullable(),
    candidate_reason: reasonSchema.nullable(),
    publication_ref: referenceSchema.nullable(),
    publication_reason: reasonSchema.nullable(),
    epoch_ref: referenceSchema.nullable(),
    epoch_reason: reasonSchema.nullable(),
    head_ref: referenceSchema.nullable(),
    head_reason: reasonSchema.nullable(),
    material_ref: referenceSchema.nullable(),
    material_reason: reasonSchema.nullable(),
    review_refs: references,
    reviews_reason: reasonSchema.nullable(),
    publication_history_ref: referenceSchema.nullable(),
    publication_history_reason: reasonSchema.nullable(),
    currency_receipt_ref: referenceSchema.nullable(),
    currency_receipt_reason: reasonSchema.nullable(),
    checked_at: timestampSchema.nullable(),
    checked_at_reason: reasonSchema.nullable(),
  }),
  result: z.strictObject({
    decision_outcome: z.enum([
      'input_blocked',
      'insufficient_evidence',
      'action_candidate_found',
      'below_action_threshold',
      'no_eligible_plan_found',
      'no_improvement_in_declared_set',
      'search_ended_without_verified_improvement',
      'improvement_not_established',
    ]),
    evidence_status: z.enum(['sufficient_for_declared_use', 'insufficient']),
    feasibility,
    baseline_improvement: z.enum([
      'verified_positive',
      'verified_zero',
      'verified_negative',
      'not_assessable',
    ]),
    protection_status: z.strictObject({
      worker: protection,
      activity: protection,
    }),
    action_threshold_status: threshold,
    uncertainty_status: uncertainty,
    search_status: z.enum(['complete', 'incomplete', 'not_run']),
    search_verification_status: z.enum(['verified', 'partial', 'not_checked']),
    optimality_status: z.enum([
      'proved_for_declared_set',
      'unknown',
      'not_applicable',
    ]),
    review_status: review,
    publication_status: z.enum([
      'unpublished',
      'published',
      'publication_disabled',
    ]),
    currency: z.enum([
      'current',
      'needs_review',
      'stale',
      'superseded',
      'withdrawn',
    ]),
    recommendation_eligible: z.boolean(),
    selected_plan_ref: referenceSchema.nullable(),
    selected_plan_reason: reasonSchema.nullable(),
    comparison_plan_ref: referenceSchema.nullable(),
    comparison_plan_reason: reasonSchema.nullable(),
    baseline_ref: referenceSchema.nullable(),
    baseline_reason: reasonSchema.nullable(),
    alternatives_ref: referenceSchema.nullable(),
    alternatives_reason: reasonSchema.nullable(),
    rejections_ref: referenceSchema.nullable(),
    rejections_reason: reasonSchema.nullable(),
    unscored_ref: referenceSchema.nullable(),
    unscored_reason: reasonSchema.nullable(),
    quantified: quantified.nullable(),
    quantified_reason: reasonSchema.nullable(),
    plan_verification: z.array(planVerification).max(128),
    plan_verification_reason: reasonSchema.nullable(),
    policy: z
      .strictObject({
        policy_ref: referenceSchema,
        approval_status: z.enum(['approved', 'fixture', 'pending', 'rejected']),
        floor_results_ref: referenceSchema,
        movement: z.strictObject({
          M_activity_minutes: amount,
          N_changed_activities: count,
          L_max_activity_minutes: amount,
          caps_ref: referenceSchema,
        }),
        cost_status: z.enum(['known', 'unknown', 'not_applicable']),
        cost_reason: reasonSchema.nullable(),
        ranking_ref: referenceSchema,
        objective_ref: referenceSchema,
      })
      .nullable(),
    policy_reason: reasonSchema.nullable(),
    search: z.strictObject({
      method_ref: referenceSchema.nullable(),
      method_reason: reasonSchema.nullable(),
      declared_set_ref: referenceSchema.nullable(),
      declared_set_reason: reasonSchema.nullable(),
      counts: z.strictObject({
        visited: count,
        feasible: count,
        scored: count,
        protected: count,
        qualifying: count,
        independently_checked: count,
      }),
      cutoff_reason: reasonSchema,
      exclusions_ref: referenceSchema.nullable(),
      exclusions_reason: reasonSchema.nullable(),
      verification_basis_ref: referenceSchema.nullable(),
      verification_basis_reason: reasonSchema.nullable(),
      certificate_ref: referenceSchema.nullable(),
      certificate_reason: reasonSchema.nullable(),
    }),
    target_test: z.strictObject({
      status: z.enum(['met', 'not_met', 'not_assessable']),
      plan_ref: referenceSchema.nullable(),
      rule_ref: referenceSchema.nullable(),
      scope: z.enum(['nominal', 'operational', 'fixture']),
      reason: reasonSchema.nullable(),
    }),
    target_feasibility: z.strictObject({
      status: z.enum(['attainable', 'proved_unattainable', 'unknown']),
      declared_set_ref: referenceSchema.nullable(),
      witness_ref: referenceSchema.nullable(),
      basis_ref: referenceSchema.nullable(),
      reason: reasonSchema.nullable(),
    }),
    gates: z.strictObject({
      real_world_gate_passed: z.boolean(),
      operating_evidence_accepted: z.boolean(),
      applicability_qualified: z.boolean(),
      exact_independent_approval: z.boolean(),
      canonical_current_predicates: z.boolean(),
      gate_receipts_ref: referenceSchema.nullable(),
      gate_receipts_reason: reasonSchema.nullable(),
    }),
    blockers: reasons,
    next_decision: text,
  }),
  evidence: z.strictObject({
    declared_use: text,
    records_ref: referenceSchema.nullable(),
    records_reason: reasonSchema.nullable(),
    coverage_ref: referenceSchema.nullable(),
    coverage_reason: reasonSchema.nullable(),
    scenario_refs: references,
    scenarios_reason: reasonSchema.nullable(),
    projection_vector_ref: referenceSchema.nullable(),
    projection_vector_reason: reasonSchema.nullable(),
    gaps: reasons,
  }),
  claims_ref: referenceSchema.nullable(),
  claims_reason: reasonSchema.nullable(),
  assumptions: z.array(text).max(128),
  assumptions_reason: reasonSchema.nullable(),
  limitations: z.array(text).max(128),
  limitations_reason: reasonSchema.nullable(),
  errors: reasons,
  errors_reason: reasonSchema.nullable(),
  timing: z.strictObject({
    started_at: timestampSchema.nullable(),
    started_reason: reasonSchema.nullable(),
    elapsed_ms: amount.nullable(),
    elapsed_reason: reasonSchema.nullable(),
    readiness_ms: amount.nullable(),
    readiness_reason: reasonSchema.nullable(),
    consumer_ms: amount.nullable(),
    consumer_reason: reasonSchema.nullable(),
    shared_budget_ref: referenceSchema.nullable(),
    shared_budget_reason: reasonSchema.nullable(),
  }),
  integrations: z.strictObject({
    operations: z
      .array(
        z.strictObject({
          adapter: identifierSchema,
          operation: identifierSchema,
          status: z.enum(['executed', 'skipped', 'failed', 'outcome_unknown']),
          remote: z.boolean(),
          receipt_ref: referenceSchema.nullable(),
          receipt_reason: reasonSchema.nullable(),
          cost: amount.nullable(),
          currency: z
            .string()
            .regex(/^[A-Z]{3}$/)
            .nullable(),
          cost_reason: reasonSchema.nullable(),
        }),
      )
      .max(128),
    operations_reason: reasonSchema.nullable(),
  }),
  trace_ref: referenceSchema.nullable(),
  trace_reason: reasonSchema.nullable(),
});

export type Result = z.infer<typeof resultShape>;

/** Validates declared relationships; immutable evidence still requires its own verifier. */
export const resultSchema = resultShape.superRefine((envelope, ctx) => {
  const r = envelope.result;
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });
  const sameRef = (
    a: z.infer<typeof referenceSchema>,
    b: z.infer<typeof referenceSchema>,
  ) => a.id === b.id && a.revision === b.revision && a.sha256 === b.sha256;

  // Every absent field/empty collection is explained; present content has no null reason.
  const reasonNames: Record<string, string> = {
    admitted_at: 'admission_reason',
    deadline_at: 'deadline_reason',
    finished_at: 'finished_reason',
    parent_run_id: 'parent_reason',
    replacement_run_id: 'replacement_reason',
    review_refs: 'reviews_reason',
    scenario_refs: 'scenarios_reason',
    percentage_gain: 'percentage_reason',
    cost: 'cost_reason',
    started_at: 'started_reason',
    elapsed_ms: 'elapsed_reason',
    readiness_ms: 'readiness_reason',
    consumer_ms: 'consumer_reason',
  };
  const inspectReasons = (value: unknown, path: (string | number)[] = []) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => inspectReasons(child, [...path, index]));
    } else if (typeof value === 'object' && value !== null) {
      const object = value as Record<string, unknown>;
      for (const [key, child] of Object.entries(object)) {
        const base = key.endsWith('_ref') ? key.slice(0, -4) : key;
        const reasonKey = reasonNames[key] ?? `${base}_reason`;
        if (reasonKey in object) {
          const absent =
            child === null || (Array.isArray(child) && !child.length);
          if (absent === (object[reasonKey] === null)) {
            issue(
              [...path, reasonKey],
              absent
                ? 'Missing explicit reason'
                : 'Present content must have a null reason',
            );
          }
        }
        inspectReasons(child, [...path, key]);
      }
    }
  };
  inspectReasons(envelope);

  if (envelope.execution_surface === 'historical_harness') {
    const d = envelope.decision_ref;
    if (
      d.epoch_ref ||
      d.head_ref ||
      d.publication_ref ||
      d.publication_history_ref ||
      d.currency_receipt_ref ||
      d.checked_at
    ) {
      issue(
        ['decision_ref'],
        'Historical harness has no canonical epoch, head, publication, history or current-read receipt',
      );
    }
    if (
      r.publication_status !== 'publication_disabled' ||
      r.recommendation_eligible
    ) {
      issue(
        ['result', 'publication_status'],
        'Historical harness disables publication and operational recommendation',
      );
    }
    const inspectRefs = (value: unknown, path: (string | number)[] = []) => {
      if (Array.isArray(value)) {
        value.forEach((child, index) => inspectRefs(child, [...path, index]));
      } else if (typeof value === 'object' && value !== null) {
        const object = value as Record<string, unknown>;
        if (
          'id' in object &&
          'revision' in object &&
          'sha256' in object &&
          typeof object.id === 'string' &&
          !object.id.startsWith('demo:')
        ) {
          issue(
            [...path, 'id'],
            'Historical harness references must be demo-local (demo:)',
          );
        }
        for (const [key, child] of Object.entries(object))
          inspectRefs(child, [...path, key]);
      }
    };
    inspectRefs(envelope);
  }

  if (
    (envelope.input_origin === 'synthetic_fixture' ||
      r.publication_status === 'publication_disabled') &&
    r.recommendation_eligible
  ) {
    issue(
      ['result', 'recommendation_eligible'],
      'Synthetic or publication-disabled results are never operationally eligible',
    );
  }
  if (r.publication_status !== 'published' && r.currency !== 'needs_review') {
    issue(['result', 'currency'], 'An unpublished candidate needs review');
  }
  if (
    r.publication_status === 'published' &&
    (!envelope.decision_ref.publication_ref ||
      !envelope.decision_ref.publication_history_ref)
  ) {
    issue(
      ['decision_ref'],
      'Published results require exact publication and immutable history references',
    );
  }
  if (
    r.review_status === 'approve' &&
    !envelope.decision_ref.review_refs.length
  ) {
    issue(
      ['decision_ref', 'review_refs'],
      'Approval requires exact immutable review references even for engineering-only results',
    );
  }
  if (
    r.currency === 'current' &&
    (!envelope.decision_ref.currency_receipt_ref ||
      !envelope.decision_ref.checked_at)
  ) {
    issue(
      ['decision_ref'],
      'Current status requires an authoritative receipt and checked-at time',
    );
  }

  const gapOnly =
    r.decision_outcome === 'insufficient_evidence' ||
    r.decision_outcome === 'input_blocked';
  if (envelope.input_assessment.status !== 'valid') {
    if (
      !envelope.input_assessment.field_reasons.length ||
      r.decision_outcome !== 'input_blocked'
    ) {
      issue(
        ['input_assessment'],
        'Invalid, incomplete or unsupported input requires field reasons and input_blocked',
      );
    }
  } else if (r.decision_outcome === 'input_blocked') {
    issue(
      ['result', 'decision_outcome'],
      'Valid input does not have an input_blocked outcome',
    );
  }
  if (
    r.evidence_status === 'insufficient' &&
    envelope.input_assessment.status === 'valid' &&
    r.decision_outcome !== 'insufficient_evidence'
  ) {
    issue(
      ['result', 'decision_outcome'],
      'Essential evidence gaps take precedence',
    );
  }
  if (r.evidence_status === 'insufficient' && !envelope.evidence.gaps.length) {
    issue(['evidence', 'gaps'], 'Insufficient evidence requires exact gaps');
  }
  if (
    gapOnly &&
    (r.selected_plan_ref ||
      r.comparison_plan_ref ||
      r.quantified ||
      r.baseline_improvement !== 'not_assessable')
  ) {
    issue(
      ['result'],
      'Gap-only results cannot carry selected/comparison plans or quantified comparison',
    );
  }
  if (
    r.decision_outcome === 'insufficient_evidence' &&
    r.evidence_status !== 'insufficient'
  ) {
    issue(
      ['result', 'evidence_status'],
      'Insufficiency outcome requires insufficient evidence',
    );
  }

  const checkedPlan = (ref: z.infer<typeof referenceSchema>) =>
    r.plan_verification.find((plan) => sameRef(plan.plan_ref, ref));
  const computationalPass = (plan: z.infer<typeof planVerification>) =>
    plan.checker_status === 'passed' &&
    plan.feasibility === 'verified' &&
    plan.worker_protection === 'pass' &&
    plan.activity_protection === 'pass' &&
    plan.uncertainty_status === 'supported' &&
    plan.action_threshold_status === 'met' &&
    plan.movement_cost_status === 'pass' &&
    plan.protection_violation_count === 0;
  for (const [index, plan] of r.plan_verification.entries()) {
    if (
      plan.checker_status === 'passed' &&
      (!plan.check_refs.length || !plan.check_details_ref)
    ) {
      issue(
        ['result', 'plan_verification', index],
        'Passed checks require exact independent check references',
      );
    }
    if (
      plan.protection_violation_count > 0 &&
      plan.worker_protection !== 'fail' &&
      plan.activity_protection !== 'fail'
    ) {
      issue(
        ['result', 'plan_verification', index],
        'Protection violations require a failed protection axis',
      );
    }
    if (
      plan.protection_violation_count > 0 &&
      !plan.protection_violations_ref
    ) {
      issue(
        ['result', 'plan_verification', index],
        'Protection violations require a detailed artifact',
      );
    }
  }
  if (r.selected_plan_ref) {
    const plan = checkedPlan(r.selected_plan_ref);
    if (
      !plan ||
      !computationalPass(plan) ||
      !plan.worker_activity_values_ref ||
      !r.policy ||
      !['approved', 'fixture'].includes(r.policy.approval_status)
    ) {
      issue(
        ['result', 'selected_plan_ref'],
        'Selected plan requires independent feasibility, protection, uncertainty, benefit, movement/cost and policy checks',
      );
    }
    if (
      r.quantified &&
      (r.quantified.nominal.absolute_gain <= 0 ||
        r.quantified.scenarios.some((scenario) => scenario.absolute_gain <= 0))
    ) {
      issue(
        ['result', 'selected_plan_ref'],
        'A selected plan requires positive checked nominal gain and gain in every required scenario',
      );
    }
    if (
      r.decision_outcome !== 'action_candidate_found' ||
      r.baseline_improvement !== 'verified_positive' ||
      r.feasibility !== 'verified' ||
      r.action_threshold_status !== 'met' ||
      r.protection_status.worker !== 'pass' ||
      r.protection_status.activity !== 'pass' ||
      r.uncertainty_status !== 'supported' ||
      !r.quantified ||
      !sameRef(r.selected_plan_ref, r.quantified.plan_ref)
    ) {
      issue(
        ['result'],
        'Selected candidate must agree with verified result axes and quantified witness',
      );
    }
  } else if (r.decision_outcome === 'action_candidate_found') {
    issue(
      ['result', 'selected_plan_ref'],
      'Action candidate outcome requires a selected checked plan',
    );
  }
  if (
    r.comparison_plan_ref &&
    checkedPlan(r.comparison_plan_ref)?.checker_status !== 'passed'
  ) {
    issue(
      ['result', 'comparison_plan_ref'],
      'A comparison plan must be independently checked',
    );
  }
  if (r.quantified) {
    if (
      !r.baseline_ref ||
      r.evidence_status !== 'sufficient_for_declared_use' ||
      checkedPlan(r.quantified.plan_ref)?.checker_status !== 'passed'
    ) {
      issue(
        ['result', 'quantified'],
        'Quantified output needs baseline support, sufficient evidence and an independently checked plan',
      );
    }
    for (const [index, values] of [
      r.quantified.nominal,
      ...r.quantified.scenarios,
    ].entries()) {
      const close = (a: number, b: number) =>
        Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
      if (!close(values.baseline - values.candidate, values.absolute_gain)) {
        issue(
          ['result', 'quantified', index === 0 ? 'nominal' : 'scenarios'],
          'Absolute gain must equal baseline minus candidate',
        );
      }
      if (
        values.baseline === 0
          ? values.percentage_gain !== null
          : values.percentage_gain === null ||
            !close(
              values.percentage_gain,
              (100 * values.absolute_gain) / values.baseline,
            )
      ) {
        issue(
          ['result', 'quantified'],
          'Percentage gain must match arithmetic and be null for a zero baseline',
        );
      }
      if (
        values.baseline === 0 &&
        values.percentage_reason?.code !== 'zero_baseline'
      ) {
        issue(
          ['result', 'quantified'],
          'A null percentage for a zero baseline must identify zero_baseline',
        );
      }
    }
    const nominal = r.quantified.nominal.absolute_gain;
    const axis =
      nominal > 0
        ? 'verified_positive'
        : nominal < 0
          ? 'verified_negative'
          : 'verified_zero';
    if (r.baseline_improvement !== axis)
      issue(
        ['result', 'baseline_improvement'],
        'Improvement axis must agree with checked nominal arithmetic',
      );
  } else if (r.baseline_improvement !== 'not_assessable') {
    issue(
      ['result', 'baseline_improvement'],
      'Verified improvement axes require quantified checked evidence',
    );
  }
  if (
    r.decision_outcome === 'below_action_threshold' &&
    (r.selected_plan_ref ||
      !r.comparison_plan_ref ||
      r.baseline_improvement !== 'verified_positive' ||
      r.action_threshold_status !== 'below' ||
      r.protection_status.worker !== 'pass' ||
      r.protection_status.activity !== 'pass' ||
      r.uncertainty_status !== 'supported' ||
      checkedPlan(r.comparison_plan_ref)?.movement_cost_status !== 'pass')
  ) {
    issue(
      ['result', 'decision_outcome'],
      'Below-threshold outcome requires an otherwise protected checked comparison within movement/cost limits',
    );
  }

  const search = r.search;
  const counts = search.counts;
  if (
    counts.feasible > counts.visited ||
    counts.scored > counts.feasible ||
    counts.protected > counts.scored ||
    counts.qualifying > counts.protected ||
    counts.independently_checked > counts.visited
  ) {
    issue(
      ['result', 'search', 'counts'],
      'Search counts must respect visited/feasible/scored/protected/qualifying containment',
    );
  }
  if (
    r.search_status === 'not_run' &&
    (Object.values(counts).some((value) => value !== 0) ||
      r.search_verification_status !== 'not_checked')
  ) {
    issue(
      ['result', 'search'],
      'A search that did not run has zero counts and no verification',
    );
  }
  if (
    r.search_status !== 'not_run' &&
    (!search.method_ref || !search.declared_set_ref)
  ) {
    issue(
      ['result', 'search'],
      'A search requires a named method and declared set',
    );
  }
  if (
    r.search_verification_status !== 'not_checked' &&
    !search.verification_basis_ref
  ) {
    issue(
      ['result', 'search'],
      'Independent search verification requires its own basis',
    );
  }
  const absenceBasis =
    r.search_verification_status === 'verified' &&
    !!search.verification_basis_ref &&
    (r.search_status === 'complete' || !!search.certificate_ref);
  if (
    r.optimality_status === 'proved_for_declared_set' &&
    (!absenceBasis || !r.policy || !search.declared_set_ref)
  ) {
    issue(
      ['result', 'optimality_status'],
      'Optimality requires independently verified exhaustion/bound, exact objective and set',
    );
  }
  if (
    r.decision_outcome === 'no_improvement_in_declared_set' &&
    (!absenceBasis ||
      r.baseline_improvement === 'verified_positive' ||
      r.selected_plan_ref)
  ) {
    issue(
      ['result', 'decision_outcome'],
      'Absence of improvement requires an independently verified exhaustive or sound-bound basis',
    );
  }
  if (
    r.decision_outcome === 'search_ended_without_verified_improvement' &&
    (r.search_status !== 'incomplete' ||
      r.selected_plan_ref ||
      r.baseline_improvement === 'verified_positive')
  ) {
    issue(
      ['result', 'decision_outcome'],
      'Budget-ended outcome requires incomplete search without a verified improvement',
    );
  }
  if (
    r.decision_outcome === 'improvement_not_established' &&
    (r.search_status !== 'complete' ||
      absenceBasis ||
      r.baseline_improvement === 'verified_positive')
  ) {
    issue(
      ['result', 'decision_outcome'],
      'Unestablished improvement is producer completion without independently verified absence',
    );
  }
  const target = r.target_feasibility;
  if (
    r.target_test.status !== 'not_assessable' &&
    (!r.target_test.plan_ref ||
      !r.target_test.rule_ref ||
      checkedPlan(r.target_test.plan_ref)?.checker_status !== 'passed')
  ) {
    issue(
      ['result', 'target_test'],
      'Target tests require an exact checked plan and rule',
    );
  }
  if (r.target_test.status === 'not_assessable' && !r.target_test.reason)
    issue(['result', 'target_test'], 'Unassessable target requires a reason');
  if (
    target.status === 'attainable' &&
    (!target.witness_ref ||
      !target.declared_set_ref ||
      r.target_test.status !== 'met' ||
      !r.target_test.plan_ref ||
      !sameRef(target.witness_ref, r.target_test.plan_ref))
  ) {
    issue(
      ['result', 'target_feasibility'],
      'Attainability requires a checked target-qualified witness in the declared set',
    );
  }
  if (
    target.status === 'proved_unattainable' &&
    (!absenceBasis || !target.basis_ref || !target.declared_set_ref)
  ) {
    issue(
      ['result', 'target_feasibility'],
      'Unattainability requires independently verified exhaustion or a sound bound',
    );
  }
  if (target.status === 'unknown' && (!target.reason || target.witness_ref)) {
    issue(
      ['result', 'target_feasibility'],
      'Unknown target feasibility requires reasons and no witness',
    );
  }

  if (
    r.recommendation_eligible &&
    (envelope.execution_surface !== 'canonical' ||
      r.publication_status !== 'published' ||
      r.currency !== 'current' ||
      r.review_status !== 'approve' ||
      r.policy?.approval_status !== 'approved' ||
      !r.selected_plan_ref ||
      r.blockers.length ||
      !Object.entries(r.gates)
        .filter(
          ([key]) =>
            key !== 'gate_receipts_ref' && key !== 'gate_receipts_reason',
        )
        .every(([, value]) => value === true) ||
      !r.gates.gate_receipts_ref ||
      !envelope.decision_ref.review_refs.length)
  ) {
    issue(
      ['result', 'recommendation_eligible'],
      'Recommendation requires all current canonical, operating, applicability, policy, independent approval and computational gates',
    );
  }
  if (!r.recommendation_eligible && !r.blockers.length) {
    issue(
      ['result', 'blockers'],
      'Ineligible results must list their blockers',
    );
  }
  if (
    envelope.mode === 'offline_sample' &&
    envelope.integrations.operations.some(
      (operation) => operation.remote && operation.status !== 'skipped',
    )
  ) {
    issue(
      ['integrations', 'operations'],
      'Offline sample permits no remote operations',
    );
  }
  for (const [index, operation] of envelope.integrations.operations.entries()) {
    if (operation.status === 'executed' && !operation.receipt_ref)
      issue(
        ['integrations', 'operations', index],
        'Executed integration requires an actual provenance receipt',
      );
    if ((operation.cost === null) !== (operation.currency === null))
      issue(
        ['integrations', 'operations', index],
        'Known cost and currency are supplied together',
      );
  }
});
