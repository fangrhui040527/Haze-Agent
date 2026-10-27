import type { Artifact, ArtifactRef } from '../../contracts/artifacts.js';
import {
  pilotInputSchema,
  pilotFeasibilitySchema,
  pilotProtocolSchema,
  pilotReviewSchema,
  type PilotDraftContext,
  type PilotInput,
  type PilotFeasibility,
  type PilotProtocol,
  type PilotReview,
} from '../../contracts/damage-reduction-pilot.js';
import {
  canonicalJson,
  contractHash,
  parseContractJson,
} from '../../contracts/json.js';

const topics = [
  'design_identification',
  'comparator',
  'baseline',
  'measurement',
  'outcome_latency',
  'precision_power',
  'attrition_clustering',
  'budget_timing',
] as const;
const key = (ref: ArtifactRef) => `${ref.id}:${ref.version}:${ref.sha256}`;
const exact = ({ id, version, sha256 }: ArtifactRef): ArtifactRef => ({
  id,
  version,
  sha256,
});
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export const PILOT_LIMITATIONS = [
  'Supplied design findings, calculations and human scientific-review attestations are retained; Haze does not implement a causal estimator or universal precision/power calculation.',
  'Classification reports supplied design support and completeness, not scientific qualification, credential verification, or independently reproduced scientific calculations.',
  'A protocol remains a draft until explicitly registered. Registration time and outcome-access attestations do not authenticate external prespecification.',
  'Live alert/scheduling adapters are deferred. Simulated or imported delivery records cannot establish achieved exposure or damage reduction.',
];
export function pilotInputEvidenceReferences(input: PilotInput): ArtifactRef[] {
  const rule = input.protocol_spec.digital_rule;
  const refs = [
    ...input.findings.flatMap((item) => item.evidence),
    ...input.calculations,
    ...(input.design_review?.evidence ?? []),
    ...(rule?.approval.evidence ?? []),
    ...(rule?.trigger_inputs.flatMap((item) => item.evidence) ?? []),
  ];
  return [...new Map(refs.map((ref) => [key(ref), exact(ref)])).values()];
}
function body(artifact: Artifact): unknown {
  return typeof artifact.content === 'string'
    ? parseContractJson(artifact.content)
    : artifact.content;
}
function source(input: PilotInput, context: PilotDraftContext) {
  const sources = context.evidence ?? [];
  const refs = [
    context.input_ref,
    context.selection_ref,
    context.assessment_ref,
    context.plan_ref,
    context.plan_review_ref,
    ...pilotInputEvidenceReferences(input),
  ];
  let synthetic = input.origin === 'synthetic';
  const unavailable: string[] = [];
  for (const ref of refs) {
    const artifacts = sources.filter((item) => key(item) === key(ref));
    if (
      artifacts.length !== 1 ||
      contractHash(artifacts[0]!.content) !== ref.sha256
    ) {
      unavailable.push(ref.id);
      continue;
    }
    const artifact = artifacts[0]!;
    if (artifact.evidence_origin === 'synthetic_fixture') synthetic = true;
    try {
      const value = body(artifact);
      if (
        typeof value === 'object' &&
        value !== null &&
        'origin' in value &&
        (value.origin === 'synthetic' || value.origin === 'synthetic_fixture')
      )
        synthetic = true;
    } catch {
      /* A prose source is retained as prose, never inferred scientific support. */
    }
  }
  return { synthetic, unavailable };
}
function protocolGaps(input: PilotInput, context: PilotDraftContext): string[] {
  const spec = input.protocol_spec,
    target = context.target,
    gaps: string[] = [];
  if (!spec.baseline_window)
    gaps.push(
      'protocol.baseline_window must retain the supplied comparator/baseline collection window.',
    );
  for (const [field, actual, expected] of [
    ['primary_endpoint', spec.primary_endpoint, target.scope.endpoint],
    ['unit', spec.unit, target.scope.unit],
    ['population', spec.population, target.scope.population],
    ['comparator', spec.comparator, target.comparator],
  ] as const)
    if (actual !== expected)
      gaps.push(
        `protocol.${field} must match the exact selected target; missing or conflicting values remain unresolved.`,
      );
  if (!same(spec.observation_window, target.scope.period))
    gaps.push(
      'protocol.observation_window must match the selected outcome period.',
    );
  if (
    !same(spec.target_rule, {
      fraction: target.target_fraction,
      relation: target.relation,
      assessment_rule: target.assessment_rule,
    })
  )
    gaps.push(
      'protocol.target_rule must retain the exact selected threshold relation and criterion.',
    );
  for (const field of [
    'design_name',
    'analysis_method',
    'missingness_rule',
    'deviation_rule',
  ] as const)
    if (!spec[field])
      gaps.push(`protocol.${field} is required before damage-evaluation use.`);
  if (!spec.stopping_criteria.length)
    gaps.push('protocol.stopping_criteria are required.');
  if (!spec.delivery_checks.length)
    gaps.push('protocol.delivery_checks are required.');
  const rule = spec.digital_rule;
  if (!rule)
    gaps.push(
      'protocol.digital_rule is required; no digital service action is authorized.',
    );
  else {
    if (
      !rule.owner ||
      !rule.trigger_rule ||
      !rule.permitted_actions.length ||
      !rule.pause_disable_rule ||
      !rule.safeguards.length ||
      !rule.trigger_inputs.length ||
      rule.trigger_inputs.some((item) => !item.evidence.length)
    )
      gaps.push(
        'protocol.digital_rule requires owner, sourced triggers, permitted actions, safeguards and pause/disable controls.',
      );
    if (
      rule.approval.status !== 'approved' ||
      !rule.approval.approver ||
      !rule.approval.approved_at ||
      !rule.approval.evidence.length
    )
      gaps.push(
        'protocol.digital_rule requires an exact retained human rule-approval attestation.',
      );
    if (
      rule.scope.geography !== target.scope.geography ||
      rule.scope.population !== target.scope.population ||
      rule.scope.period.start > target.scope.period.start ||
      rule.scope.period.end < target.scope.period.end
    )
      gaps.push(
        'protocol.digital_rule operating scope must match the selected geography/population and cover its outcome window.',
      );
    if (!same(rule.scope.period, target.scope.period))
      gaps.push(
        'protocol.digital_rule operating period extends outside the assessed outcome period; scientific applicability beyond the selected period remains unresolved.',
      );
    if (context.candidate_kind && rule.kind !== context.candidate_kind)
      gaps.push(
        'protocol.digital_rule kind conflicts with the selected intervention.',
      );
    if (
      context.planned_rules &&
      ((context.planned_rules.owner !== null &&
        rule.owner !== context.planned_rules.owner) ||
        (context.planned_rules.trigger !== null &&
          rule.trigger_rule !== context.planned_rules.trigger) ||
        (context.planned_rules.action !== null &&
          !rule.permitted_actions.includes(context.planned_rules.action)))
    )
      gaps.push(
        'protocol.digital_rule conflicts with the current conditional-plan rules; retain an explicit reviewed change before relying on it.',
      );
  }
  return gaps;
}
export function draftPilot(
  value: PilotInput,
  context: PilotDraftContext,
): { feasibility: PilotFeasibility; protocol: PilotProtocol } {
  const input = pilotInputSchema.parse(value),
    provenance = source(input, context),
    prerequisites: string[] = [];
  const topicSet = new Set(input.findings.map((finding) => finding.topic));
  if (context.planning_objections?.length)
    prerequisites.push(
      `Resolve the ${context.planning_objections.length} retained current conditional-plan objections/status gaps before damage-evaluation use; their full text remains in the exact referenced plan.`,
    );
  if (topicSet.size !== input.findings.length)
    prerequisites.push(
      'Duplicate finding topic declarations must be reconciled.',
    );
  for (const topic of topics) {
    const finding = input.findings.find((item) => item.topic === topic);
    if (!finding || finding.status !== 'usable' || !finding.evidence.length)
      prerequisites.push(
        `Supply usable, scoped scientific ${topic} findings and exact source evidence.`,
      );
  }
  if (!input.scientific_owner)
    prerequisites.push(
      'Name the scientific owner for the supplied pilot design.',
    );
  if (
    context.expected_scientific_owner &&
    context.expected_scientific_owner !== input.scientific_owner
  )
    prerequisites.push(
      'The supplied scientific owner conflicts with the programme attestation.',
    );
  if (!input.calculations.length)
    prerequisites.push(
      'Supply independently reviewed precision_power calculations and their design-specific assumptions.',
    );
  if (!input.assumptions.length)
    prerequisites.push('Declare the scientific design assumptions.');
  const review = input.design_review;
  const adopted = Boolean(
    review &&
    review.independent &&
    review.reviewer !== input.scientific_owner &&
    review.conflicts !== 'unresolved' &&
    review.decision === 'supports_design' &&
    review.evidence.length &&
    review.adopted_by,
  );
  if (!adopted)
    prerequisites.push(
      'Retain an independent scientific design review, resolved conflicts and explicit local adoption; model agreement is insufficient.',
    );
  if (provenance.unavailable.length)
    prerequisites.push(
      `Retain accessible exact scientific evidence: ${provenance.unavailable.join(', ')}.`,
    );
  if (provenance.synthetic)
    prerequisites.push(
      'Synthetic engineering evidence cannot qualify this pilot for damage-target evaluation.',
    );
  prerequisites.push(...protocolGaps(input, context));
  const limited =
    input.intended_kind !== 'damage_evaluation' ||
    input.findings.some(
      (finding) =>
        finding.status === 'unavailable' &&
        [
          'comparator',
          'baseline',
          'measurement',
          'outcome_latency',
          'precision_power',
        ].includes(finding.topic),
    ) ||
    review?.decision === 'rejects_design';
  const classification: PilotFeasibility['classification'] = limited
    ? 'delivery_exposure_feasibility_only'
    : prerequisites.length
      ? 'conditional'
      : 'damage_evaluation_capable';
  const binding = {
    programme_id: context.programme_id,
    input_ref: context.input_ref,
    selection_ref: context.selection_ref,
    assessment_ref: context.assessment_ref,
    plan_ref: context.plan_ref,
    plan_review_ref: context.plan_review_ref,
    target_sha256: context.target_sha256,
    scope_sha256: context.scope_sha256,
  };
  const origin = provenance.synthetic
    ? ('synthetic' as const)
    : ('supplied' as const);
  return {
    feasibility: pilotFeasibilitySchema.parse({
      schema_version: 'haze.reduction.pilot-feasibility.v1',
      ...binding,
      origin,
      classification,
      classification_basis:
        adopted && !provenance.synthetic
          ? 'supplied_scientific_review_attestation'
          : 'engineering_completeness_only',
      intended_kind: input.intended_kind,
      findings: input.findings,
      calculations: input.calculations,
      assumptions: input.assumptions,
      scientific_review: input.design_review,
      prerequisites,
      limitations: PILOT_LIMITATIONS,
      scientific_qualification: 'unqualified',
      achieved_reduction: false,
    }),
    protocol: pilotProtocolSchema.parse({
      schema_version: 'haze.reduction.pilot-protocol.v1',
      ...binding,
      origin,
      status: 'draft',
      specification: input.protocol_spec,
      prerequisites,
      limitations: PILOT_LIMITATIONS,
      scientific_qualification: 'unqualified',
      achieved_reduction: false,
    }),
  };
}

/** Independently reconstruct copied fields and eligibility; never calls draftPilot. */
export function independentlyReviewPilot(
  value: PilotInput,
  context: PilotDraftContext,
  feasibilityArtifact: Artifact,
  protocolArtifact: Artifact,
  reviewer: PilotReview['reviewer'],
): PilotReview {
  const input = pilotInputSchema.parse(value),
    feasibility = pilotFeasibilitySchema.safeParse(feasibilityArtifact.content),
    protocol = pilotProtocolSchema.safeParse(protocolArtifact.content);
  const checks: PilotReview['checks'] = [],
    findings: string[] = [];
  const check = (code: string, passed: boolean, detail: string) => {
    checks.push({ code, passed, detail });
    if (!passed) findings.push(detail);
  };
  check(
    'independent_reviewer',
    Boolean(
      feasibilityArtifact.assignment_id && protocolArtifact.assignment_id,
    ) &&
      feasibilityArtifact.assignment_id !== reviewer.assignment_id &&
      protocolArtifact.assignment_id !== reviewer.assignment_id,
    'Reviewer must differ from both exact draft producers.',
  );
  check(
    'artifact_contracts',
    feasibility.success && protocol.success,
    'Feasibility and protocol must satisfy their versioned unqualified contracts.',
  );
  check(
    'output_hashes',
    contractHash(feasibilityArtifact.content) === feasibilityArtifact.sha256 &&
      contractHash(protocolArtifact.content) === protocolArtifact.sha256,
    'Exact output references must bind retained artifact bytes.',
  );
  const sources = context.evidence ?? [];
  const original = sources.find((item) => key(item) === key(context.input_ref));
  let originalMatches = false;
  try {
    originalMatches = Boolean(
      original &&
      contractHash(original.content) === original.sha256 &&
      same(pilotInputSchema.parse(body(original)), input),
    );
  } catch {
    /* Explicit failed check below. */
  }
  check(
    'original_input',
    originalMatches,
    'The exact retained original pilot input must reconstruct the supplied declarations.',
  );
  check(
    'target_hashes',
    contractHash(context.target) === context.target_sha256 &&
      contractHash(context.target.scope) === context.scope_sha256,
    'Target and scope hashes must match the selected programme target.',
  );
  if (feasibility.success && protocol.success) {
    const f = feasibility.data,
      p = protocol.data;
    const expectedBinding = {
      programme_id: context.programme_id,
      input_ref: context.input_ref,
      selection_ref: context.selection_ref,
      assessment_ref: context.assessment_ref,
      plan_ref: context.plan_ref,
      plan_review_ref: context.plan_review_ref,
      target_sha256: context.target_sha256,
      scope_sha256: context.scope_sha256,
    };
    check(
      'exact_lineage',
      Object.entries(expectedBinding).every(
        ([field, expected]) =>
          same(f[field as keyof PilotFeasibility], expected) &&
          same(p[field as keyof PilotProtocol], expected),
      ),
      'Both drafts must preserve exact programme, input, assessment, plan and target references.',
    );
    check(
      'source_declarations',
      same(f.findings, input.findings) &&
        same(f.calculations, input.calculations) &&
        same(f.assumptions, input.assumptions) &&
        same(f.scientific_review, input.design_review) &&
        f.intended_kind === input.intended_kind &&
        same(p.specification, input.protocol_spec),
      'Scientific declarations, assumptions, calculations and agreed rules must be copied without inferred efficacy or capacity.',
    );
    const evidenceRefs = [
      context.input_ref,
      context.selection_ref,
      context.assessment_ref,
      context.plan_ref,
      context.plan_review_ref,
      ...input.findings.flatMap((item) => item.evidence),
      ...input.calculations,
      ...(input.design_review?.evidence ?? []),
      ...(input.protocol_spec.digital_rule?.approval.evidence ?? []),
      ...(input.protocol_spec.digital_rule?.trigger_inputs.flatMap(
        (item) => item.evidence,
      ) ?? []),
    ];
    let synthetic = input.origin === 'synthetic',
      missingEvidence = false;
    for (const ref of evidenceRefs) {
      const retained = sources.filter((item) => key(item) === key(ref));
      if (
        retained.length !== 1 ||
        contractHash(retained[0]!.content) !== ref.sha256
      ) {
        missingEvidence = true;
        continue;
      }
      if (retained[0]!.evidence_origin === 'synthetic_fixture')
        synthetic = true;
      try {
        const content = body(retained[0]!);
        if (
          typeof content === 'object' &&
          content !== null &&
          'origin' in content &&
          (content.origin === 'synthetic' ||
            content.origin === 'synthetic_fixture')
        )
          synthetic = true;
      } catch {
        /* Source remains unverified prose. */
      }
    }
    const suppliedReview = input.design_review;
    const adopted = Boolean(
      suppliedReview &&
      suppliedReview.independent &&
      suppliedReview.reviewer !== input.scientific_owner &&
      suppliedReview.conflicts !== 'unresolved' &&
      suppliedReview.decision === 'supports_design' &&
      suppliedReview.evidence.length &&
      suppliedReview.adopted_by,
    );
    const topicsComplete =
      topics.every((topic) =>
        input.findings.some(
          (finding) =>
            finding.topic === topic &&
            finding.status === 'usable' &&
            finding.evidence.length,
        ),
      ) &&
      new Set(input.findings.map((finding) => finding.topic)).size ===
        input.findings.length;
    const spec = input.protocol_spec,
      rule = spec.digital_rule,
      target = context.target;
    const protocolComplete =
      Boolean(spec.baseline_window) &&
      spec.primary_endpoint === target.scope.endpoint &&
      spec.unit === target.scope.unit &&
      spec.population === target.scope.population &&
      spec.comparator === target.comparator &&
      same(spec.observation_window, target.scope.period) &&
      same(spec.target_rule, {
        fraction: target.target_fraction,
        relation: target.relation,
        assessment_rule: target.assessment_rule,
      }) &&
      Boolean(
        spec.design_name &&
        spec.analysis_method &&
        spec.missingness_rule &&
        spec.deviation_rule &&
        spec.stopping_criteria.length &&
        spec.delivery_checks.length &&
        rule &&
        rule.owner &&
        rule.trigger_rule &&
        rule.permitted_actions.length &&
        rule.pause_disable_rule &&
        rule.safeguards.length &&
        rule.trigger_inputs.length &&
        rule.trigger_inputs.every((item) => item.evidence.length) &&
        rule.approval.status === 'approved' &&
        rule.approval.approver &&
        rule.approval.approved_at &&
        rule.approval.evidence.length &&
        rule.scope.geography === target.scope.geography &&
        rule.scope.population === target.scope.population &&
        same(rule.scope.period, target.scope.period) &&
        (!context.candidate_kind || rule.kind === context.candidate_kind) &&
        (!context.planned_rules ||
          ((context.planned_rules.owner === null ||
            rule.owner === context.planned_rules.owner) &&
            (context.planned_rules.trigger === null ||
              rule.trigger_rule === context.planned_rules.trigger) &&
            (context.planned_rules.action === null ||
              rule.permitted_actions.includes(context.planned_rules.action)))),
      );
    const limited =
      input.intended_kind !== 'damage_evaluation' ||
      input.findings.some(
        (finding) =>
          finding.status === 'unavailable' &&
          [
            'comparator',
            'baseline',
            'measurement',
            'outcome_latency',
            'precision_power',
          ].includes(finding.topic),
      ) ||
      suppliedReview?.decision === 'rejects_design';
    const complete =
      !synthetic &&
      !missingEvidence &&
      topicsComplete &&
      input.scientific_owner &&
      (!context.expected_scientific_owner ||
        context.expected_scientific_owner === input.scientific_owner) &&
      input.calculations.length &&
      input.assumptions.length &&
      adopted &&
      protocolComplete &&
      !context.planning_objections?.length;
    const expected = limited
      ? 'delivery_exposure_feasibility_only'
      : complete
        ? 'damage_evaluation_capable'
        : 'conditional';
    check(
      'independent_classification',
      f.classification === expected &&
        f.classification_basis ===
          (adopted && !synthetic
            ? 'supplied_scientific_review_attestation'
            : 'engineering_completeness_only'),
      'Classification must follow independently checked supplied completeness and scientific-review attestations.',
    );
    check(
      'synthetic_origin',
      f.origin === (synthetic ? 'synthetic' : 'supplied') &&
        p.origin === f.origin,
      'Synthetic originals or supporting inputs cannot acquire an empirical origin label.',
    );
    check(
      'explicit_prerequisites',
      same(f.prerequisites, p.prerequisites) &&
        (complete || f.prerequisites.length > 0) &&
        topics
          .filter(
            (topic) =>
              !input.findings.some(
                (finding) =>
                  finding.topic === topic &&
                  finding.status === 'usable' &&
                  finding.evidence.length,
              ),
          )
          .every((topic) =>
            f.prerequisites.some((reason) => reason.includes(topic)),
          ) &&
        (!synthetic ||
          f.prerequisites.some((reason) => reason.includes('Synthetic'))) &&
        (!context.planning_objections?.length ||
          f.prerequisites.some((reason) =>
            reason.includes('conditional-plan objections'),
          )),
      'Missing scientific topics and synthetic limitations must remain explicit prerequisites.',
    );
    check(
      'draft_only',
      p.status === 'draft' &&
        f.scientific_qualification === 'unqualified' &&
        p.scientific_qualification === 'unqualified' &&
        f.limitations.length > 0 &&
        p.limitations.length > 0,
      'Draft/review cannot register a protocol, authorize a service or establish scientific qualification or achieved reduction.',
    );
  }
  return pilotReviewSchema.parse({
    schema_version: 'haze.reduction.pilot-review.v1',
    programme_id: context.programme_id,
    input_ref: context.input_ref,
    reviewed_artifacts: [exact(feasibilityArtifact), exact(protocolArtifact)],
    reviewer,
    verdict: findings.length ? 'rejected' : 'supported',
    checks,
    findings,
    limitations: PILOT_LIMITATIONS,
    scientific_qualification: 'unqualified',
    achieved_reduction: false,
  });
}
