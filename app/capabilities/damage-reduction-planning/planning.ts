import type { Artifact, ArtifactRef } from '../../contracts/artifacts.js';
import {
  conditionalReductionPlanSchema,
  reductionPreviewRequestSchema,
  type ConditionalPlanInput,
  type ConditionalReductionPlan,
  type ReductionCandidate,
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

export const PLANNING_LIMITATIONS = [
  'Conditional planning preview only. No alerts are sent and no work schedule is changed.',
  'Scientific applicability is unqualified; arithmetic agreement and model agreement cannot grant scientific approval.',
  'Candidate descriptions, rule approval and feasibility declarations are supplied attestations, not authenticated identity or independently established efficacy.',
  'Reference integrity checks do not reproduce the semantic entailment of supplied cost, capacity, constraint or rule-approval documents; those declarations require human source-alignment review.',
  'Source references support only their declared claims. Product specifications and mechanism descriptions are not delivered effects or proof of damage reduction.',
  'Costs are supplied planning inputs; no monetary valuation, budget optimization, exposure-response or uptake inference is performed.',
  'Current source access, permissions, applicability and independent reviews must be rechecked through governed task APIs when reusing this saved preview.',
];
const ref = ({ id, version, sha256 }: ArtifactRef): ArtifactRef => ({
  id,
  version,
  sha256,
});
const key = (value: ArtifactRef) =>
  `${value.id}:${value.version}:${value.sha256}`;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function syntheticSource(source: Artifact): boolean {
  if (source.evidence_origin === 'synthetic_fixture') return true;
  let content: unknown = source.content;
  try {
    if (typeof content === 'string') content = parseContractJson(content);
  } catch {
    return false;
  }
  if (typeof content !== 'object' || content === null || Array.isArray(content))
    return false;
  const origin = (content as Record<string, unknown>).origin;
  return origin === 'synthetic' || origin === 'synthetic_fixture';
}
export function candidateEvidenceReferences(
  candidate: ReductionCandidate,
): ArtifactRef[] {
  const all = [
    ...candidate.approval.evidence,
    ...candidate.constraints.flatMap((item) => item.evidence),
    ...candidate.costs.flatMap((item) => item.evidence),
    ...candidate.dependencies.flatMap((item) => item.evidence),
    ...candidate.claims.flatMap((item) => item.evidence),
  ];
  return [...new Map(all.map((item) => [key(item), ref(item)])).values()];
}

/** Fixed planning actions consume checked figures; supplied prose is never executable. */
export function draftConditionalPlan(
  input: ConditionalPlanInput,
): ConditionalReductionPlan {
  const request = reductionPreviewRequestSchema.parse(input.request);
  const candidate = request.candidate;
  const sourceRefs = [
    ...new Map(
      [
        ...request.selection.sources.map((item) => item.artifact),
        ...candidateEvidenceReferences(candidate),
      ].map((item) => [key(item), ref(item)]),
    ).values(),
  ];
  if (sourceRefs.length > 64)
    throw new Error('Conditional preview exceeds 64 exact supporting sources.');
  const sourceAvailable = (value: ArtifactRef) => {
    const matches = input.sources.filter((item) => key(item) === key(value));
    return (
      matches.length === 1 && contractHash(matches[0]!.content) === value.sha256
    );
  };
  const evidenceAvailable = (values: ArtifactRef[]) =>
    values.length > 0 && values.every(sourceAvailable);
  const integrity: string[] = [];
  const assessment = reductionAssessmentSchema.safeParse(
    input.assessment.content,
  );
  const arithmetic = reductionReviewSchema.safeParse(
    input.arithmeticReview.content,
  );
  for (const [label, artifact] of [
    ['selection', input.selection],
    ['assessment', input.assessment],
    ['arithmetic-review', input.arithmeticReview],
  ] as const) {
    if (contractHash(artifact.content) !== artifact.sha256)
      integrity.push(`${label} hash mismatch`);
  }
  if (
    input.selection.kind !== 'reduction.input-selection' ||
    !same(input.selection.content, request.selection)
  )
    integrity.push(
      'Exact selected target or source rows differ from the current preview request.',
    );
  if (
    !assessment.success ||
    input.assessment.kind !== 'reduction.assessment' ||
    (assessment.success &&
      !same(assessment.data.selection_ref, ref(input.selection)))
  )
    integrity.push(
      'Assessment does not bind the exact selected target and source rows.',
    );
  if (!arithmetic.success || input.arithmeticReview.kind !== 'reduction.review')
    integrity.push('An exact independent arithmetic review is unavailable.');
  else {
    if (
      arithmetic.data.verdict !== 'supported' ||
      !arithmetic.data.reviewed_artifacts.some((item) =>
        same(item, ref(input.assessment)),
      ) ||
      !arithmetic.data.reviewed_artifacts.some((item) =>
        same(item, ref(input.selection)),
      )
    )
      integrity.push(
        'Arithmetic review is rejected, incomplete or bound to different evidence.',
      );
    if (
      !input.assessment.assignment_id ||
      !input.arithmeticReview.assignment_id ||
      input.assessment.assignment_id === input.arithmeticReview.assignment_id ||
      arithmetic.data.reviewer.assignment_id !==
        input.arithmeticReview.assignment_id ||
      arithmetic.data.reviewer.revision !==
        input.arithmeticReview.assignment_revision
    )
      integrity.push(
        'Arithmetic review lacks an independent exact assignment attestation.',
      );
  }
  const missingSources = sourceRefs.filter((item) => !sourceAvailable(item));
  const validAssessment = integrity.length === 0 && assessment.success;
  const plan: ConditionalReductionPlan = {
    schema_version: 'haze.reduction.conditional-plan.v1',
    method_id: 'reduction.conditional-plan.v1',
    method_version: '1',
    target: request.selection.target,
    selection_ref: ref(input.selection),
    assessment_ref: ref(input.assessment),
    arithmetic_review_ref: ref(input.arithmeticReview),
    candidate,
    candidate_sha256: contractHash(candidate),
    source_refs: sourceRefs,
    state:
      validAssessment &&
      assessment.data.status === 'supported' &&
      !missingSources.length
        ? 'conditional'
        : 'evidence_gap',
    assessment_status: validAssessment ? assessment.data.status : 'gap',
    point_estimate_label:
      validAssessment && assessment.data.status === 'supported'
        ? assessment.data.target_met
          ? 'meets'
          : 'does_not_meet'
        : 'unavailable',
    origin: validAssessment ? assessment.data.origin : 'unknown',
    scientific_qualification: 'unqualified',
    delivery_status: 'not_delivered',
    achieved_reduction: false,
    affected_scope: request.selection.target.scope,
    rules: {
      owner: candidate.rule_owner,
      trigger: candidate.trigger_rule,
      action: candidate.action_rule,
      approval: candidate.approval,
    },
    recommendations: [],
    prerequisites: [],
    objections: [],
    limitations: [...PLANNING_LIMITATIONS],
  };
  if (
    sourceRefs.some((item) =>
      input.sources.some(
        (source) => key(source) === key(item) && syntheticSource(source),
      ),
    )
  )
    plan.origin = 'synthetic';
  const prerequisite = (
    id: string,
    reason: ConditionalReductionPlan['prerequisites'][number]['reason'],
    description: string,
    evidence: ArtifactRef[] = [],
  ) => plan.prerequisites.push({ id, reason, description, evidence });
  const objection = (
    id: string,
    severity: ConditionalReductionPlan['objections'][number]['severity'],
    description: string,
    evidence: ArtifactRef[] = [],
  ) => plan.objections.push({ id, severity, description, evidence });
  prerequisite(
    'scientific-applicability',
    'scientific_applicability',
    'A scientific owner must supply and adopt a non-synthetic applicability dossier for this exact intervention, endpoint, population, period and source method.',
  );
  for (const [id, value, description] of [
    [
      'rule-owner',
      candidate.rule_owner,
      'Name the human owner accountable for the exact digital rules.',
    ],
    [
      'trigger-rule',
      candidate.trigger_rule,
      'Define the exact agreed trigger, input sources and timing for the proposed digital action.',
    ],
    [
      'action-rule',
      candidate.action_rule,
      'Define the exact recipient/action scope and safeguards for the proposed alert or schedule change.',
    ],
  ] as const)
    if (!value) prerequisite(id, 'missing_rule', description);
  const approvalComplete =
    candidate.approval.status === 'approved' &&
    Boolean(candidate.approval.approver && candidate.approval.approved_at) &&
    evidenceAvailable(candidate.approval.evidence) &&
    Boolean(
      candidate.rule_owner && candidate.trigger_rule && candidate.action_rule,
    );
  if (!approvalComplete)
    prerequisite(
      'human-rule-approval',
      'human_approval',
      'Obtain retained human approval binding the exact trigger/action rules, rule owner and affected scope; a typed approved flag alone is insufficient.',
      candidate.approval.evidence,
    );
  if (candidate.name !== request.selection.target.intervention)
    objection(
      'candidate-scenario-mismatch',
      'blocking',
      'The candidate name does not identify the intervention used in the selected scenario.',
    );
  if (integrity.length) {
    prerequisite(
      'checked-scenario',
      'scenario_evidence',
      `Supply a current exact assessment and independent review: ${integrity.join(' ')}`,
    );
    objection(
      'scenario-lineage',
      'material',
      'The supplied scenario/review lineage cannot support a planning conclusion.',
    );
  } else if (assessment.success && assessment.data.status !== 'supported') {
    prerequisite(
      'checked-scenario',
      'scenario_evidence',
      `Resolve the assessment ${assessment.data.status}: ${assessment.data.reasons.join('; ')}`,
    );
    objection(
      'scenario-unavailable',
      'material',
      'Comparable checked point-estimate evidence is unavailable.',
      [ref(input.assessment)],
    );
  } else if (assessment.success && assessment.data.target_met === false)
    objection(
      'target-not-met',
      'material',
      'No assessed option meets the selected point-estimate target; this option must not be recommended as meeting it.',
      [ref(input.assessment), ref(input.arithmeticReview)],
    );
  if (missingSources.length)
    prerequisite(
      'accessible-sources',
      'source_access',
      `Restore current exact access to ${missingSources.length} selected or candidate evidence source(s): ${missingSources.map((item) => item.id).join(', ')}.`,
    );
  if (!candidate.constraints.length)
    prerequisite(
      'feasibility-constraints',
      'constraint',
      'Identify and review feasibility, subgroup protections and hard constraints before operational use.',
    );
  candidate.constraints.forEach((constraint, index) => {
    const id = `constraint-${index + 1}`;
    if (constraint.status === 'violated') {
      objection(
        id,
        constraint.hard ? 'blocking' : 'material',
        `Supplied constraint violation: ${constraint.description}`,
        constraint.evidence,
      );
      prerequisite(
        id,
        'constraint',
        `Resolve the supplied constraint violation before recommending implementation: ${constraint.description}`,
        constraint.evidence,
      );
    } else if (
      constraint.status === 'unknown' ||
      !evidenceAvailable(constraint.evidence)
    )
      prerequisite(
        id,
        'constraint',
        `Establish current scoped evidence for the constraint: ${constraint.description}`,
        constraint.evidence,
      );
  });
  if (!candidate.costs.length)
    prerequisite(
      'cost-estimate',
      'cost',
      'Obtain a scoped supplied cost estimate, resource commitments and a budget decision.',
    );
  candidate.costs.forEach((cost, index) => {
    if (
      cost.amount === null ||
      cost.amount.startsWith('-') ||
      !evidenceAvailable(cost.evidence)
    )
      prerequisite(
        `cost-${index + 1}`,
        'cost',
        cost.prerequisite
          ? `Resolve the supplied cost prerequisite before recommending implementation: ${cost.prerequisite}`
          : `Obtain a supported nonnegative cost estimate and budget decision: ${cost.description}`,
        cost.evidence,
      );
  });
  if (!candidate.dependencies.length)
    prerequisite(
      'delivery-capacity',
      'dependency',
      'Establish authorized service configuration, staff responsibilities and delivery capacity; none is assumed available.',
    );
  candidate.dependencies.forEach((dependency, index) => {
    if (
      dependency.status !== 'available' ||
      !evidenceAvailable(dependency.evidence)
    )
      prerequisite(
        `dependency-${index + 1}`,
        'dependency',
        `Confirm an available, supported dependency before implementation: ${dependency.description}`,
        dependency.evidence,
      );
  });
  if (
    candidate.constraints.some((item) => item.status === 'satisfied') ||
    candidate.costs.some((item) => item.amount !== null) ||
    candidate.dependencies.some((item) => item.status === 'available') ||
    candidate.approval.status === 'approved'
  )
    prerequisite(
      'supplied-feasibility-review',
      'constraint',
      'Review supplied feasibility attestations against their exact source documents before relying on costs, capacity, satisfied constraints or rule approval; reference integrity does not establish document entailment or authenticate the declarant.',
    );
  candidate.claims.forEach((claim, index) => {
    const forbidden =
      ['effect_estimate', 'delivery', 'achieved_reduction'].includes(
        claim.kind,
      ) ||
      (['product_specification', 'mechanism'].includes(claim.kind) &&
        /(?:%|\breduc|\beffic|\bprevent|\bavoid)/i.test(claim.statement));
    if (forbidden)
      objection(
        `claim-${index + 1}`,
        'blocking',
        'An unsupported candidate effect, achieved-reduction or delivery assertion cannot become a recommendation. Only the exact checked scenario supplies point estimates; product specifications do not establish effects.',
        claim.evidence,
      );
    else if (!evidenceAvailable(claim.evidence)) {
      prerequisite(
        `claim-${index + 1}`,
        'source_access',
        'Supply accessible exact evidence for the candidate mechanism or specification claim.',
        claim.evidence,
      );
      objection(
        `claim-${index + 1}`,
        'material',
        'Candidate mechanism/specification remains unverified and cannot support an effect claim.',
        claim.evidence,
      );
    }
  });
  if (plan.objections.some((item) => item.severity === 'blocking'))
    plan.state = 'blocked';
  const actions = {
    scientific_applicability: 'qualify_applicability',
    missing_rule: 'define_rules',
    human_approval: 'obtain_approval',
    constraint: 'resolve_constraint',
    cost: 'obtain_cost',
    dependency: 'confirm_dependency',
    scenario_evidence: 'review_scenario',
    source_access: 'review_scenario',
  } as const;
  for (const item of plan.prerequisites)
    plan.recommendations.push({
      id: `recommendation-${plan.recommendations.length + 1}`,
      action: actions[item.reason],
      description: item.description,
      evidence: item.evidence,
      prerequisite_ids: [item.id],
    });
  if (plan.state === 'conditional' && plan.point_estimate_label === 'meets')
    plan.recommendations.push({
      id: `recommendation-${plan.recommendations.length + 1}`,
      action: 'consider_conditional_option',
      description:
        'Consider this supplied scenario only as a conditional option after every prerequisite and material objection is resolved; human approval and qualified applicability remain required.',
      evidence: [ref(input.assessment), ref(input.arithmeticReview)],
      prerequisite_ids: plan.prerequisites.map((item) => item.id),
    });
  if (plan.recommendations.length > 64)
    throw new Error(
      'Conditional preview exceeds 64 material recommendations; split the supplied planning inputs explicitly.',
    );
  return conditionalReductionPlanSchema.parse(plan);
}
