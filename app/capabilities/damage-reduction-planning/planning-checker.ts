import type { ArtifactRef } from '../../contracts/artifacts.js';
import {
  conditionalPlanReviewSchema,
  conditionalReductionPlanSchema,
  reductionPreviewRequestSchema,
  type ConditionalPlanInput,
  type ConditionalPlanReview,
  type ConditionalReductionPlan,
} from '../../contracts/damage-reduction-plan.js';
import {
  reductionAssessmentSchema,
  reductionReviewSchema,
} from '../../contracts/damage-reduction.js';
import {
  canonicalJson,
  contractHash,
  parseContractJson,
} from '../../contracts/json.js';
import { independentlyCheckReduction } from './checker.js';

const exact = ({ id, version, sha256 }: ArtifactRef): ArtifactRef => ({
  id,
  version,
  sha256,
});
const fingerprint = (value: ArtifactRef) =>
  `${value.id}:${value.version}:${value.sha256}`;
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Independent structural/feasibility reconstruction; never invokes the plan producer. */
export function independentlyCheckConditionalPlan(
  input: ConditionalPlanInput & {
    plan: ConditionalPlanInput['selection'];
    reviewer: ConditionalPlanReview['reviewer'];
  },
): ConditionalPlanReview {
  const checks: ConditionalPlanReview['checks'] = [];
  const findings: string[] = [];
  const check = (code: string, passed: boolean, detail: string) => {
    checks.push({ code, passed, detail });
    if (!passed) findings.push(detail);
  };
  const request = reductionPreviewRequestSchema.safeParse(input.request);
  const proposed = conditionalReductionPlanSchema.safeParse(input.plan.content);
  const assessment = reductionAssessmentSchema.safeParse(
    input.assessment.content,
  );
  const arithmetic = reductionReviewSchema.safeParse(
    input.arithmeticReview.content,
  );
  check(
    'preview_contract',
    request.success,
    'Preview request must satisfy its bounded operator-input contract.',
  );
  check(
    'plan_contract',
    proposed.success,
    'Conditional plan must satisfy the bounded unqualified, not-delivered contract.',
  );
  check(
    'independent_planning_reviewer',
    Boolean(input.plan.assignment_id) &&
      input.plan.assignment_id !== input.reviewer.assignment_id,
    'Plan reviewer must differ from the exact plan producer.',
  );
  check(
    'plan_hash',
    contractHash(input.plan.content) === input.plan.sha256 &&
      input.plan.kind === 'reduction.conditional-plan',
    'Plan reference must bind the exact saved conditional-plan artifact.',
  );
  let planningState: ConditionalPlanReview['planning_state'] = 'evidence_gap';
  let reviewSources: ArtifactRef[] = [];
  if (request.success && proposed.success) {
    const value = proposed.data;
    const candidate = request.data.candidate;
    const evidence = [
      ...request.data.selection.sources.map((item) => item.artifact),
      ...candidate.approval.evidence,
      ...candidate.constraints.flatMap((item) => item.evidence),
      ...candidate.costs.flatMap((item) => item.evidence),
      ...candidate.dependencies.flatMap((item) => item.evidence),
      ...candidate.claims.flatMap((item) => item.evidence),
    ];
    reviewSources = [
      ...new Map(
        evidence.map((item) => [fingerprint(item), exact(item)]),
      ).values(),
    ];
    const available = (item: ArtifactRef) => {
      const matches = input.sources.filter(
        (source) => fingerprint(source) === fingerprint(item),
      );
      return (
        matches.length === 1 &&
        contractHash(matches[0]!.content) === item.sha256
      );
    };
    const hasEvidence = (refs: ArtifactRef[]) =>
      refs.length > 0 && refs.every(available);
    const missing = reviewSources.filter((item) => !available(item));
    const originalBinding =
      input.selection.kind === 'reduction.input-selection' &&
      equal(input.selection.content, request.data.selection) &&
      contractHash(input.selection.content) === input.selection.sha256;
    const assessmentBinding =
      assessment.success &&
      input.assessment.kind === 'reduction.assessment' &&
      contractHash(input.assessment.content) === input.assessment.sha256 &&
      equal(assessment.data.selection_ref, exact(input.selection));
    const reviewBinding =
      arithmetic.success &&
      input.arithmeticReview.kind === 'reduction.review' &&
      contractHash(input.arithmeticReview.content) ===
        input.arithmeticReview.sha256 &&
      arithmetic.data.verdict === 'supported' &&
      arithmetic.data.reviewed_artifacts.some((item) =>
        equal(item, exact(input.selection)),
      ) &&
      arithmetic.data.reviewed_artifacts.some((item) =>
        equal(item, exact(input.assessment)),
      ) &&
      Boolean(
        input.assessment.assignment_id && input.arithmeticReview.assignment_id,
      ) &&
      input.assessment.assignment_id !== input.arithmeticReview.assignment_id &&
      arithmetic.data.reviewer.assignment_id ===
        input.arithmeticReview.assignment_id &&
      arithmetic.data.reviewer.revision ===
        input.arithmeticReview.assignment_revision;
    const validScenario =
      originalBinding &&
      assessmentBinding &&
      reviewBinding &&
      assessment.success;
    if (validScenario && assessment.success) {
      const numerical = independentlyCheckReduction(
        request.data.selection,
        input.sources,
        exact(input.selection),
        assessment.data,
        exact(input.assessment),
        input.reviewer,
        input.assessment.assignment_id,
      );
      check(
        'reconstructed_scenario',
        numerical.verdict === 'supported',
        'Selected originals must independently reconstruct the checked assessment before supporting its planning labels.',
      );
      check(
        'arithmetic_claim_alignment',
        arithmetic.success &&
          arithmetic.data.claim_eligibility === numerical.claim_eligibility &&
          arithmetic.data.checks.every((item) => item.passed),
        'Saved arithmetic review claim and checks must agree with current independent reconstruction.',
      );
    }
    check(
      'target_and_scope',
      equal(value.target, request.data.selection.target) &&
        equal(value.affected_scope, request.data.selection.target.scope),
      'Plan must preserve the exact selected target and affected scope.',
    );
    check(
      'candidate_version',
      equal(value.candidate, candidate) &&
        value.candidate_sha256 === contractHash(candidate),
      'Candidate identity, version, supplied assertions and exact hash must remain unchanged.',
    );
    check(
      'exact_scenario_references',
      equal(value.selection_ref, exact(input.selection)) &&
        equal(value.assessment_ref, exact(input.assessment)) &&
        equal(value.arithmetic_review_ref, exact(input.arithmeticReview)),
      'Plan must bind the exact selection, assessment and independent arithmetic review.',
    );
    check(
      'source_closure',
      equal(value.source_refs, reviewSources),
      'Plan supporting sources must contain exactly selected originals and explicitly cited candidate evidence.',
    );
    check(
      'exact_rule_attestation',
      equal(value.rules, {
        owner: candidate.rule_owner,
        trigger: candidate.trigger_rule,
        action: candidate.action_rule,
        approval: candidate.approval,
      }),
      'Human rule ownership, approval and trigger/action rules must be retained as supplied attestations.',
    );
    const label =
      validScenario &&
      assessment.success &&
      assessment.data.status === 'supported'
        ? assessment.data.target_met
          ? 'meets'
          : 'does_not_meet'
        : 'unavailable';
    check(
      'checked_point_estimate_label',
      value.point_estimate_label === label &&
        value.assessment_status ===
          (validScenario && assessment.success
            ? assessment.data.status
            : 'gap'),
      'Point-estimate label and evidence status must come from the exact checked scenario.',
    );
    let origin =
      validScenario && assessment.success ? assessment.data.origin : 'unknown';
    const hasSyntheticProvenance = (content: unknown): boolean => {
      let original = content;
      if (typeof original === 'string') {
        try {
          original = parseContractJson(original);
        } catch {
          return false;
        }
      }
      return (
        typeof original === 'object' &&
        original !== null &&
        !Array.isArray(original) &&
        ((original as Record<string, unknown>).origin === 'synthetic' ||
          (original as Record<string, unknown>).origin === 'synthetic_fixture')
      );
    };
    if (
      reviewSources.some((item) =>
        input.sources.some(
          (source) =>
            fingerprint(source) === fingerprint(item) &&
            (source.evidence_origin === 'synthetic_fixture' ||
              hasSyntheticProvenance(source.content)),
        ),
      )
    )
      origin = 'synthetic';
    check(
      'honest_origin',
      value.origin === origin,
      'Synthetic numerical or candidate evidence must not be relabelled empirical.',
    );
    const required = new Map<
      string,
      {
        reason: ConditionalReductionPlan['prerequisites'][number]['reason'];
        evidence: ArtifactRef[];
      }
    >();
    const objected = new Map<
      string,
      ConditionalReductionPlan['objections'][number]['severity']
    >();
    const require = (
      id: string,
      reason: ConditionalReductionPlan['prerequisites'][number]['reason'],
      evidence: ArtifactRef[] = [],
    ) => required.set(id, { reason, evidence });
    require('scientific-applicability', 'scientific_applicability');
    for (const [id, field] of [
      ['rule-owner', candidate.rule_owner],
      ['trigger-rule', candidate.trigger_rule],
      ['action-rule', candidate.action_rule],
    ] as const)
      if (!field) require(id, 'missing_rule');
    if (!(
      candidate.approval.status === 'approved' &&
      candidate.approval.approver &&
      candidate.approval.approved_at &&
      hasEvidence(candidate.approval.evidence) &&
      candidate.rule_owner &&
      candidate.trigger_rule &&
      candidate.action_rule
    ))
      require('human-rule-approval', 'human_approval', candidate.approval
        .evidence);
    if (candidate.name !== request.data.selection.target.intervention)
      objected.set('candidate-scenario-mismatch', 'blocking');
    if (!validScenario) {
      require('checked-scenario', 'scenario_evidence');
      objected.set('scenario-lineage', 'material');
    } else if (assessment.success && assessment.data.status !== 'supported') {
      require('checked-scenario', 'scenario_evidence');
      objected.set('scenario-unavailable', 'material');
    } else if (assessment.success && assessment.data.target_met === false)
      objected.set('target-not-met', 'material');
    if (missing.length) require('accessible-sources', 'source_access');
    if (!candidate.constraints.length)
      require('feasibility-constraints', 'constraint');
    candidate.constraints.forEach((item, index) => {
      const id = `constraint-${index + 1}`;
      if (item.status === 'violated') {
        objected.set(id, item.hard ? 'blocking' : 'material');
        require(id, 'constraint', item.evidence);
      } else if (item.status !== 'satisfied' || !hasEvidence(item.evidence))
        require(id, 'constraint', item.evidence);
    });
    if (!candidate.costs.length) require('cost-estimate', 'cost');
    candidate.costs.forEach((item, index) => {
      if (
        item.amount === null ||
        item.amount.startsWith('-') ||
        !hasEvidence(item.evidence)
      )
        require(`cost-${index + 1}`, 'cost', item.evidence);
    });
    if (!candidate.dependencies.length)
      require('delivery-capacity', 'dependency');
    candidate.dependencies.forEach((item, index) => {
      if (item.status !== 'available' || !hasEvidence(item.evidence))
        require(`dependency-${index + 1}`, 'dependency', item.evidence);
    });
    if (
      candidate.constraints.some((item) => item.status === 'satisfied') ||
      candidate.costs.some((item) => item.amount !== null) ||
      candidate.dependencies.some((item) => item.status === 'available') ||
      candidate.approval.status === 'approved'
    )
      require('supplied-feasibility-review', 'constraint');
    candidate.claims.forEach((item, index) => {
      const id = `claim-${index + 1}`;
      const unsupported =
        item.kind === 'effect_estimate' ||
        item.kind === 'delivery' ||
        item.kind === 'achieved_reduction' ||
        (['product_specification', 'mechanism'].includes(item.kind) &&
          /(?:%|\breduc|\beffic|\bprevent|\bavoid)/i.test(item.statement));
      if (unsupported) objected.set(id, 'blocking');
      else if (!hasEvidence(item.evidence)) {
        require(id, 'source_access', item.evidence);
        objected.set(id, 'material');
      }
    });
    const actualPrereqs = new Map(
      value.prerequisites.map((item) => [item.id, item]),
    );
    check(
      'complete_prerequisites',
      actualPrereqs.size === value.prerequisites.length &&
        actualPrereqs.size === required.size &&
        [...required].every(([id, item]) => {
          const actual = actualPrereqs.get(id);
          return (
            actual &&
            actual.reason === item.reason &&
            equal(actual.evidence, item.evidence)
          );
        }),
      'Every unresolved scientific, rule, cost, capacity, subgroup, source or scenario prerequisite must remain explicit and bound to its evidence.',
    );
    const prerequisiteIntents = {
      scientific_applicability: [
        'A scientific owner must supply and adopt a non-synthetic applicability dossier',
      ],
      missing_rule: [
        'Name the human owner accountable',
        'Define the exact agreed trigger',
        'Define the exact recipient/action scope',
      ],
      human_approval: [
        'Obtain retained human approval binding the exact trigger/action rules',
      ],
      constraint: [
        'Identify and review feasibility',
        'Resolve the supplied constraint violation before recommending implementation:',
        'Establish current scoped evidence for the constraint:',
        'Review supplied feasibility attestations against their exact source documents before relying on costs, capacity, satisfied constraints or rule approval;',
      ],
      cost: [
        'Obtain a scoped supplied cost estimate',
        'Obtain a supported nonnegative cost estimate and budget decision:',
        'Resolve the supplied cost prerequisite before recommending implementation:',
      ],
      dependency: [
        'Establish authorized service configuration',
        'Confirm an available, supported dependency before implementation:',
      ],
      scenario_evidence: [
        'Supply a current exact assessment and independent review:',
        'Resolve the assessment ',
      ],
      source_access: [
        'Restore current exact access to ',
        'Supply accessible exact evidence for the candidate mechanism or specification claim.',
      ],
    };
    check(
      'prerequisite_intent',
      value.prerequisites.every((item) =>
        prerequisiteIntents[item.reason].some((prefix) =>
          item.description.startsWith(prefix),
        ),
      ),
      'Prerequisites must retain a concrete conditional evidence/approval action; supplied prose cannot replace them with implementation or effect assertions.',
    );
    const actualObjections = new Map(
      value.objections.map((item) => [item.id, item]),
    );
    check(
      'retained_objections',
      actualObjections.size === value.objections.length &&
        actualObjections.size === objected.size &&
        [...objected].every(
          ([id, severity]) => actualObjections.get(id)?.severity === severity,
        ),
      'Hard constraint violations, unmet targets and unsupported effect/specification/delivery assertions must retain independent objections.',
    );
    planningState = [...objected.values()].includes('blocking')
      ? 'blocked'
      : validScenario &&
          assessment.success &&
          assessment.data.status === 'supported' &&
          !missing.length
        ? 'conditional'
        : 'evidence_gap';
    check(
      'planning_state',
      value.state === planningState,
      'A hard constraint or unsupported effect assertion blocks the option; missing comparative evidence remains an evidence gap.',
    );
    const actions = {
      scientific_applicability: 'qualify_applicability',
      missing_rule: 'define_rules',
      human_approval: 'obtain_approval',
      constraint: 'resolve_constraint',
      cost: 'obtain_cost',
      dependency: 'confirm_dependency',
      scenario_evidence: 'review_scenario',
      source_access: 'review_scenario',
    };
    const justified = value.recommendations.every((recommendation) => {
      if (recommendation.action === 'consider_conditional_option')
        return (
          planningState === 'conditional' &&
          label === 'meets' &&
          equal(recommendation.evidence, [
            exact(input.assessment),
            exact(input.arithmeticReview),
          ]) &&
          equal(
            recommendation.prerequisite_ids,
            value.prerequisites.map((item) => item.id),
          ) &&
          recommendation.description ===
            'Consider this supplied scenario only as a conditional option after every prerequisite and material objection is resolved; human approval and qualified applicability remain required.'
        );
      if (recommendation.prerequisite_ids.length !== 1) return false;
      const prerequisite = actualPrereqs.get(
        recommendation.prerequisite_ids[0]!,
      );
      return Boolean(
        prerequisite &&
        actions[prerequisite.reason] === recommendation.action &&
        recommendation.description === prerequisite.description &&
        equal(recommendation.evidence, prerequisite.evidence),
      );
    });
    const expectedRecommendations =
      required.size +
      (planningState === 'conditional' && label === 'meets' ? 1 : 0);
    check(
      'supported_recommendations',
      justified &&
        value.recommendations.length === expectedRecommendations &&
        new Set(value.recommendations.map((item) => item.id)).size ===
          value.recommendations.length &&
        [...required.keys()].every((id) =>
          value.recommendations.some(
            (item) =>
              item.prerequisite_ids.length === 1 &&
              item.prerequisite_ids[0] === id,
          ),
        ),
      'Each material recommendation must use checked scenario evidence or one exact stated prerequisite; unsupported effects and immediate implementation cannot be recommended.',
    );
    check(
      'conditional_scientific_limits',
      value.scientific_qualification === 'unqualified' &&
        value.delivery_status === 'not_delivered' &&
        value.achieved_reduction === false &&
        value.limitations.length >= 4 &&
        actualPrereqs.has('scientific-applicability'),
      'The preview cannot establish scientific approval, live delivery, available capacity or achieved reduction.',
    );
  }
  return conditionalPlanReviewSchema.parse({
    schema_version: 'haze.reduction.plan-review.v1',
    verdict: findings.length ? 'rejected' : 'supported',
    reviewed_artifacts: [
      exact(input.selection),
      exact(input.assessment),
      exact(input.arithmeticReview),
      exact(input.plan),
      ...reviewSources,
    ],
    reviewer: input.reviewer,
    checks,
    findings,
    planning_state: planningState,
    scientific_qualification: 'unqualified',
    delivery_status: 'not_delivered',
    achieved_reduction: false,
    limitations: [
      'Checks exact source/claim lineage, independently reconstructed numerical support and supplied feasibility objections only.',
      'Candidate narratives, source authenticity, professional credentials and scientific applicability are not independently established.',
      'Cost, capacity, constraint and approval declarations remain supplied attestations; exact accessible references do not reproduce document entailment or authenticate their author.',
      'Human approval is a retained local attestation; this preview sends no alert and changes no schedule.',
    ],
  });
}
