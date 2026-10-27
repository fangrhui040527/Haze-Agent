import type { Artifact, ArtifactRef } from '../../contracts/artifacts.js';
import {
  EVALUATION_COMPARISON_METHOD,
  externalEvaluationInputSchema,
  externalEvaluationResultSchema,
  externalEvaluationExpectedOutputSchema,
  evaluationLearningSchema,
  evaluationTechnicalReviewSchema,
  scientificQualificationDossierSchema,
  type ExternalEvaluationInput,
  type ExternalEvaluationResult,
  type EvaluationLearning,
  type EvaluationMethodContext,
  type EvaluationTechnicalReview,
  type ScientificQualificationDossier,
} from '../../contracts/damage-reduction-evaluation.js';
import { pilotProtocolSchema } from '../../contracts/damage-reduction-pilot.js';
import {
  canonicalJson,
  contractHash,
  parseContractJson,
} from '../../contracts/json.js';
import {
  compareExactResiduals,
  parseExactDecimal,
} from '../damage-reduction-planning/exact-comparison.js';

const key = (value: ArtifactRef) =>
  `${value.id}:${value.version}:${value.sha256}`;
const ref = ({ id, version, sha256 }: ArtifactRef): ArtifactRef => ({
  id,
  version,
  sha256,
});
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function equivalentExpectedRatio(
  expected: ExternalEvaluationResult['relative_reduction'],
  actual: ExternalEvaluationResult['relative_reduction'],
): boolean {
  if (expected === null || actual === null) return expected === actual;
  const decimal = (token: string) => ({
    coefficient: BigInt(token.replace('.', '')),
    places: token.split('.')[1]?.length ?? 0,
  });
  const en = decimal(expected.numerator),
    ed = decimal(expected.denominator),
    an = decimal(actual.numerator),
    ad = decimal(actual.denominator);
  if (ed.coefficient === 0n || ad.coefficient === 0n) return false;
  const left =
    en.coefficient * ad.coefficient * 10n ** BigInt(ed.places + an.places);
  const right =
    an.coefficient * ed.coefficient * 10n ** BigInt(en.places + ad.places);
  return (
    [
      en.coefficient,
      ed.coefficient,
      an.coefficient,
      ad.coefficient,
      left,
      right,
    ].every((value) => value.toString().replace('-', '').length <= 128) &&
    left === right
  );
}
const body = (artifact: Artifact): unknown => {
  if (typeof artifact.content !== 'string') return artifact.content;
  try {
    return parseContractJson(artifact.content);
  } catch {
    return artifact.content;
  }
};
const equalIds = (a: readonly string[], b: readonly string[]) =>
  same([...a].sort(), [...b].sort());
const equalRules = (
  a: readonly { id: string; version: string }[],
  b: readonly { id: string; version: string }[],
) =>
  same(
    [...a].sort((x, y) =>
      `${x.id}:${x.version}`.localeCompare(`${y.id}:${y.version}`),
    ),
    [...b].sort((x, y) =>
      `${x.id}:${x.version}`.localeCompare(`${y.id}:${y.version}`),
    ),
  );
export const EVALUATION_LIMITATIONS = [
  'Haze reproduces supplied residual point-estimate subtraction and exact threshold comparison only; it does not reproduce the external causal estimator, identification design, data collection or uncertainty calculation.',
  'External scientific review, reviewer identity, credentials, conflicts and local adoption are retained human attestations. Arithmetic and model agreement cannot grant scientific qualification.',
  'Bound and probability criteria are unsupported by this registered method. No point-estimate fallback substitutes for a requested uncertainty criterion.',
  'Digital receipts and delivery verification do not by themselves establish adherence, reduced exposure or achieved damage reduction. World Model acceptance and H-MEM publication remain separate.',
];
const SUBTRACTION_REPRODUCTION =
  'Exact subtraction of the supplied canonical residual quantities, using the Plan 01 fixed-decimal comparison kernel.';
const RATIO_REPRODUCTION =
  'Exact rational relative reduction and unrounded cross-multiplied point-estimate threshold comparison.';
const INSPECTION_SCOPE = [
  'Exact imported report/data/review/expected-output references and declared protocol/rule/delivery lineage.',
];
const EXTERNAL_CALCULATIONS = [
  'Causal estimator, comparative identification, source measurements, adjustment, dependence and uncertainty.',
];
const lessonsFor = (outcome: EvaluationLearning['outcome']) => [
  outcome === 'point_estimate_meets'
    ? 'The supplied residual point estimate meets the selected numerical threshold.'
    : outcome === 'point_estimate_below'
      ? 'The supplied residual point estimate is below the selected numerical threshold.'
      : 'The supplied evidence does not support this registered numerical comparison.',
  'The external design, causal estimate and uncertainty remain externally calculated; technical agreement does not establish scientific qualification.',
  'Retain protocol, rule, delivery and material-deviation lineage when interpreting this result; publication requires a separate integration.',
];
export function evaluationInputEvidenceReferences(
  input: ExternalEvaluationInput,
): ArtifactRef[] {
  return [
    ...new Map(
      [
        input.protocol.protocol_ref,
        ...input.report_refs,
        ...input.data_refs,
        ...input.external_review_refs,
        ...input.expected_output_refs,
      ].map((item) => [key(item), ref(item)]),
    ).values(),
  ];
}
export function evaluationDossierEvidenceReferences(
  dossier: ScientificQualificationDossier,
): ArtifactRef[] {
  return [
    ...new Map(
      [
        dossier.evaluation_input_ref,
        dossier.protocol.protocol_ref,
        ...dossier.report_refs,
        ...dossier.data_refs,
        ...dossier.external_review_refs,
        ...dossier.expected_output_refs,
        ...dossier.evidence,
        ...dossier.reference_case.evidence,
      ].map((item) => [key(item), ref(item)]),
    ).values(),
  ];
}
function original(
  ref: ArtifactRef,
  context: EvaluationMethodContext,
): Artifact | undefined {
  return context.evidence.find(
    (artifact) =>
      key(artifact) === key(ref) &&
      contractHash(artifact.content) === ref.sha256,
  );
}
function provenance(
  input: ExternalEvaluationInput,
  context: EvaluationMethodContext,
) {
  let synthetic = input.origin === 'synthetic';
  const missing: string[] = [],
    done = new Set<string>(),
    visiting = new Set<string>();
  const visit = (reference: ArtifactRef): void => {
    if (done.has(key(reference))) return;
    if (visiting.has(key(reference)) || done.size + visiting.size >= 256) {
      missing.push('cyclic_or_unbounded_evidence');
      return;
    }
    const artifact = original(reference, context);
    if (!artifact) {
      missing.push(reference.id);
      return;
    }
    visiting.add(key(reference));
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
      const expected = externalEvaluationExpectedOutputSchema.safeParse(value);
      if (expected.success)
        for (const reference of expected.data.evidence) visit(reference);
    } catch {
      /* prose remains evidence */
    }
    for (const dependency of artifact.dependencies) visit(dependency);
    visiting.delete(key(reference));
    done.add(key(reference));
  };
  const dossierArtifact =
    context.dossier_ref && original(context.dossier_ref, context);
  const dossier =
    dossierArtifact &&
    scientificQualificationDossierSchema.safeParse(body(dossierArtifact));
  for (const reference of [
    context.input_ref,
    ...(context.supporting_refs ?? []),
    ...(context.dossier_ref ? [context.dossier_ref] : []),
    ...evaluationInputEvidenceReferences(input),
    ...(dossier && dossier.success
      ? evaluationDossierEvidenceReferences(dossier.data)
      : []),
  ])
    visit(reference);
  return { synthetic, missing };
}
function inputIssues(
  input: ExternalEvaluationInput,
  context: EvaluationMethodContext,
) {
  const incompatible: string[] = [],
    gaps: string[] = [];
  if (input.programme_id !== context.programme_id)
    incompatible.push('programme_mismatch');
  if (
    input.target_sha256 !== context.target_sha256 ||
    context.target_sha256 !== contractHash(context.target)
  )
    incompatible.push('target_hash_mismatch');
  if (
    input.scope_sha256 !== context.scope_sha256 ||
    context.scope_sha256 !== contractHash(context.target.scope) ||
    !same(input.scope, context.target.scope)
  )
    incompatible.push('scope_mismatch');
  if (
    !same(input.registered_target, {
      fraction: context.target.target_fraction,
      relation: context.target.relation,
    })
  )
    incompatible.push('registered_threshold_mismatch');
  if (!context.protocol_ref || !context.registration_id)
    gaps.push('current_registered_protocol_required');
  else if (
    key(input.protocol.protocol_ref) !== key(context.protocol_ref) ||
    input.protocol.registration_id !== context.registration_id ||
    input.protocol.analysis_basis !== context.analysis_basis ||
    !equalIds(input.protocol.amendment_record_ids, context.amendment_record_ids)
  )
    incompatible.push('registered_protocol_lineage_mismatch');
  for (const list of [
    input.protocol.amendment_record_ids,
    input.delivery.action_record_ids,
    input.delivery.deviation_record_ids,
    input.delivery.verification_record_ids,
    input.delivery.accounted_deviation_record_ids,
  ])
    if (new Set(list).size !== list.length)
      incompatible.push('duplicate_record_binding');
  if (
    new Set(input.delivery.rules.map((rule) => `${rule.id}:${rule.version}`))
      .size !== input.delivery.rules.length
  )
    incompatible.push('duplicate_rule_binding');
  if (!input.delivery.action_record_ids.length)
    gaps.push('actual_delivery_records_required');
  if (
    input.delivery.action_record_ids.some(
      (id) =>
        !context.delivery.action_record_ids.includes(id) ||
        !context.delivery.confirmed_action_record_ids.includes(id),
    )
  )
    gaps.push('evaluated_actions_require_current_actual_agreed_delivery');
  if (
    !equalIds(
      input.delivery.deviation_record_ids,
      context.delivery.deviation_record_ids,
    ) ||
    input.delivery.verification_record_ids.some(
      (id) => !context.delivery.verification_record_ids.includes(id),
    ) ||
    !equalRules(input.delivery.rules, context.delivery.rules)
  )
    incompatible.push('delivery_rule_or_record_lineage_mismatch');
  if (
    input.delivery.accounted_deviation_record_ids.some(
      (id) => !input.delivery.deviation_record_ids.includes(id),
    ) ||
    context.delivery.unresolved_material_deviation_record_ids.some(
      (id) => !input.delivery.accounted_deviation_record_ids.includes(id),
    )
  )
    gaps.push('material_deviations_not_accounted_for');
  if (input.design.identification !== 'externally_reviewed_comparative')
    gaps.push('external_comparative_design_required');
  if (!input.design.assumptions.length)
    gaps.push('design_assumptions_required');
  if (/^damage\./.test(input.source_method.id))
    incompatible.push(
      'legacy_quantity_method_cannot_supply_external_evaluation',
    );
  if (input.criterion.kind !== 'point_estimate')
    gaps.push(`unsupported_${input.criterion.kind}_criterion`);
  for (const field of [
    'report_refs',
    'data_refs',
    'external_review_refs',
    'expected_output_refs',
  ] as const)
    if (!input[field].length) gaps.push(`${field}_required`);
  if (!input.material_limitations.length)
    gaps.push('material_limitations_required');
  const protocolArtifact = original(input.protocol.protocol_ref, context);
  const parsed =
    protocolArtifact && pilotProtocolSchema.safeParse(body(protocolArtifact));
  if (!parsed || !parsed.success)
    gaps.push('typed_registered_protocol_required');
  else {
    const protocol = parsed.data,
      spec = protocol.specification;
    if (
      protocol.programme_id !== input.programme_id ||
      protocol.target_sha256 !== input.target_sha256 ||
      protocol.scope_sha256 !== input.scope_sha256
    )
      incompatible.push('protocol_programme_or_target_mismatch');
    if (
      !spec.analysis_method ||
      !same(
        { id: spec.analysis_method.id, version: spec.analysis_method.version },
        input.source_method,
      ) ||
      spec.design_name !== input.design.registered_name
    )
      incompatible.push('registered_analysis_or_design_mismatch');
    if (
      spec.primary_endpoint !== input.scope.endpoint ||
      spec.unit !== input.scope.unit ||
      spec.population !== input.scope.population ||
      !same(spec.observation_window, input.scope.period)
    )
      incompatible.push('protocol_endpoint_population_period_mismatch');
    if (
      spec.analysis_method &&
      spec.analysis_method.uncertainty_rule !== input.criterion.kind
    )
      gaps.push('registered_uncertainty_interpretation_mismatch');
  }
  const inputArtifact = original(context.input_ref, context);
  if (
    !inputArtifact ||
    !same(
      externalEvaluationInputSchema.safeParse(body(inputArtifact)).data,
      input,
    )
  )
    gaps.push('exact_original_evaluation_input_required');
  else if (inputArtifact.producer.kind === 'assignment')
    gaps.push('original_external_evaluation_must_be_supplied');
  for (const reason of context.gate_reasons ?? [])
    gaps.push(`programme_gate: ${reason}`);
  return { incompatible, gaps };
}
export function inspectEvaluationDossier(
  input: ExternalEvaluationInput,
  context: EvaluationMethodContext,
): EvaluationTechnicalReview['qualification_check'] {
  if (!context.dossier_ref)
    return {
      status: 'not_supplied',
      reasons: [
        'A separate scientific qualification dossier and explicit local adoption are required.',
      ],
    };
  const reasons: string[] = [],
    artifact = original(context.dossier_ref, context);
  const parsed =
    artifact && scientificQualificationDossierSchema.safeParse(body(artifact));
  if (!parsed || !parsed.success)
    return {
      status: 'incomplete',
      reasons: [
        'The exact supplied qualification dossier is unavailable or invalid.',
      ],
    };
  const dossier = parsed.data;
  const sources = provenance(input, context);
  if (sources.synthetic)
    reasons.push(
      'Selected evaluation/qualification support includes synthetic evidence.',
    );
  if (sources.missing.length)
    reasons.push('The exact selected evidence closure is incomplete.');
  if (
    dossier.programme_id !== input.programme_id ||
    key(dossier.evaluation_input_ref) !== key(context.input_ref) ||
    dossier.target_sha256 !== input.target_sha256 ||
    dossier.scope_sha256 !== input.scope_sha256
  )
    reasons.push(
      'Dossier programme, original input and target/scope bindings must match exactly.',
    );
  for (const field of [
    'source_method',
    'design',
    'scope',
    'protocol',
    'delivery',
    'criterion',
    'authors',
    'material_limitations',
    'uncertainty_interpretation',
  ] as const)
    if (!same(dossier[field], input[field]))
      reasons.push(
        `Dossier ${field} must retain the exact imported evaluation declaration.`,
      );
  for (const field of [
    'report_refs',
    'data_refs',
    'external_review_refs',
    'expected_output_refs',
  ] as const) {
    const actual = dossier[field].map(key),
      expected = input[field].map(key);
    if (
      !actual.length ||
      actual.length !== new Set(actual).size ||
      expected.length !== new Set(expected).size ||
      !equalIds(actual, expected)
    )
      reasons.push(
        `Dossier ${field} must cover exactly the selected external study's original evidence.`,
      );
  }
  if (
    context.expectedScientificOwner &&
    dossier.scientific_owner !== context.expectedScientificOwner
  )
    reasons.push(
      'Dossier scientific owner must match the selected programme owner attestation.',
    );
  if (
    !dossier.reviewer.independent ||
    dossier.reviewer.conflicts === 'unresolved' ||
    dossier.authors.some((author) => author.name === dossier.reviewer.name) ||
    dossier.scientific_owner === dossier.reviewer.name
  )
    reasons.push(
      'Dossier review requires a declared independent reviewer with resolved conflicts, distinct from authors and the scientific owner.',
    );
  if (
    dossier.origin === 'synthetic' ||
    artifact.evidence_origin === 'synthetic_fixture'
  )
    reasons.push(
      'Synthetic qualification evidence cannot establish operational scientific qualification.',
    );
  if (
    dossier.decision !== 'qualified' ||
    dossier.applicability.decision !== 'applicable' ||
    dossier.applicability.prerequisites.length ||
    dossier.applicability.unresolved_material_objections.length
  )
    reasons.push(
      'Conditional, unqualified, withdrawn or unresolved applicability remains a qualification gap.',
    );
  if (
    !dossier.evidence.length ||
    dossier.evidence.some((reference) => !original(reference, context))
  )
    reasons.push(
      'Exact accessible external scientific review evidence is required.',
    );
  if (
    !dossier.reference_case.evidence.length ||
    dossier.reference_case.evidence.some(
      (reference) => !original(reference, context),
    )
  )
    reasons.push(
      'A named reference case with exact accessible evidence must be retained.',
    );
  return { status: reasons.length ? 'incomplete' : 'complete', reasons };
}
export function draftExternalEvaluation(
  value: ExternalEvaluationInput,
  context: EvaluationMethodContext,
): { result: ExternalEvaluationResult; learning: EvaluationLearning } {
  const input = externalEvaluationInputSchema.parse(value),
    sources = provenance(input, context),
    issues = inputIssues(input, context);
  if (sources.missing.length)
    issues.gaps.push('exact_evidence_closure_unavailable');
  const result: ExternalEvaluationResult = {
    schema_version: 'haze.reduction.external-evaluation.v1',
    programme_id: context.programme_id,
    input_ref: ref(context.input_ref),
    dossier_ref: context.dossier_ref ? ref(context.dossier_ref) : null,
    method_id: EVALUATION_COMPARISON_METHOD,
    method_version: '1',
    source_method: input.source_method,
    design: input.design,
    target_sha256: input.target_sha256,
    scope_sha256: input.scope_sha256,
    protocol: input.protocol,
    delivery: input.delivery,
    scope: input.scope,
    criterion: input.criterion,
    registered_target: input.registered_target,
    original_estimates: input.comparative_estimates,
    status: 'gap',
    reasons: [],
    origin: sources.synthetic
      ? 'synthetic'
      : sources.missing.length
        ? 'unknown'
        : 'supplied',
    baseline_damage: null,
    intervention_damage: null,
    absolute_reduction: null,
    relative_reduction: null,
    target_met: null,
    reproduced: [],
    inspected: INSPECTION_SCOPE,
    externally_calculated: EXTERNAL_CALCULATIONS,
    uncertainty_interpretation: input.uncertainty_interpretation,
    material_limitations: input.material_limitations,
    limitations: [...EVALUATION_LIMITATIONS],
    scientific_qualification: 'unqualified',
    achieved_reduction: false,
  };
  const { baseline, intervention } = input.comparative_estimates;
  if (baseline === null || intervention === null)
    issues.gaps.push('unknown_comparative_residual_quantity');
  else {
    try {
      const comparison = compareExactResiduals(
        parseExactDecimal(baseline),
        parseExactDecimal(intervention),
        input.registered_target.fraction,
        input.registered_target.relation,
      );
      result.baseline_damage = comparison.baseline_damage;
      result.intervention_damage = comparison.intervention_damage;
      result.absolute_reduction = comparison.absolute_reduction;
      result.reproduced = [SUBTRACTION_REPRODUCTION];
      if (comparison.reason) issues.gaps.push(comparison.reason);
      else if (input.criterion.kind === 'point_estimate') {
        result.relative_reduction = comparison.relative_reduction;
        result.target_met = comparison.target_met;
        result.reproduced.push(RATIO_REPRODUCTION);
      }
    } catch {
      issues.gaps.push('exact_intermediate_overflow');
    }
  }
  for (const reference of input.expected_output_refs) {
    const artifact = original(reference, context),
      parsed =
        artifact &&
        externalEvaluationExpectedOutputSchema.safeParse(body(artifact));
    if (!parsed || !parsed.success || artifact.producer.kind === 'assignment') {
      issues.gaps.push('independently_supplied_typed_expected_output_required');
      continue;
    }
    const expected = parsed.data;
    if (
      expected.programme_id !== input.programme_id ||
      expected.target_sha256 !== input.target_sha256 ||
      expected.scope_sha256 !== input.scope_sha256 ||
      !same(expected.source_method, input.source_method) ||
      !same(expected.design, {
        id: input.design.id,
        version: input.design.version,
      }) ||
      expected.criterion !== input.criterion.kind
    )
      issues.incompatible.push('expected_output_binding_mismatch');
    if (input.authors.some((author) => author.name === expected.prepared_by))
      issues.gaps.push('independent_expected_output_reviewer_required');
    if (
      input.criterion.kind === 'point_estimate' &&
      (result.baseline_damage !== expected.baseline_damage ||
        result.intervention_damage !== expected.intervention_damage ||
        result.absolute_reduction !== expected.absolute_reduction ||
        !equivalentExpectedRatio(
          expected.relative_reduction,
          result.relative_reduction,
        ) ||
        result.target_met !== expected.target_met)
    )
      issues.incompatible.push('independent_expected_output_mismatch');
  }
  result.status = issues.incompatible.length
    ? 'incompatible'
    : issues.gaps.length
      ? 'gap'
      : 'supported';
  result.reasons = [...new Set([...issues.incompatible, ...issues.gaps])];
  if (result.status === 'incompatible') {
    result.relative_reduction = null;
    result.target_met = null;
  }
  const outcome =
    result.status !== 'supported' || result.target_met === null
      ? 'insufficient_evidence'
      : result.target_met
        ? 'point_estimate_meets'
        : 'point_estimate_below';
  const learning = evaluationLearningSchema.parse({
    schema_version: 'haze.reduction.evaluation-learning.v1',
    programme_id: context.programme_id,
    input_ref: context.input_ref,
    target_sha256: input.target_sha256,
    scope_sha256: input.scope_sha256,
    protocol_ref: input.protocol.protocol_ref,
    origin: result.origin,
    outcome,
    lessons: lessonsFor(outcome),
    next_requirements: [
      ...result.reasons,
      'Scientific qualification and explicit local adoption remain separate server-validated human records.',
    ],
    evidence: [
      ref(context.input_ref),
      ...(context.dossier_ref ? [ref(context.dossier_ref)] : []),
      ...evaluationInputEvidenceReferences(input),
    ],
    publication: 'not_published',
    scientific_qualification: 'unqualified',
    achieved_reduction: false,
  });
  return { result: externalEvaluationResultSchema.parse(result), learning };
}

/** Independently reconstructs original quantities and lineage; never calls the producer or its comparison kernel. */
export function independentlyReviewExternalEvaluation(
  value: ExternalEvaluationInput,
  context: EvaluationMethodContext,
  resultArtifact: Artifact,
  learningArtifact: Artifact,
  reviewer: { assignment_id: string; revision: number },
): EvaluationTechnicalReview {
  const checks: EvaluationTechnicalReview['checks'] = [],
    findings: string[] = [];
  const check = (code: string, passed: boolean, detail: string) => {
    checks.push({ code, passed, detail });
    if (!passed) findings.push(detail);
  };
  const input = externalEvaluationInputSchema.parse(value),
    parsedResult = externalEvaluationResultSchema.safeParse(
      body(resultArtifact),
    ),
    parsedLearning = evaluationLearningSchema.safeParse(body(learningArtifact));
  const exactSource = (reference: ArtifactRef) =>
    context.evidence.find(
      (artifact) =>
        key(reference) === key(artifact) &&
        contractHash(artifact.content) === reference.sha256,
    );
  const sourceInput = exactSource(context.input_ref);
  check(
    'original_input',
    Boolean(
      sourceInput &&
      sourceInput.producer.kind !== 'assignment' &&
      same(
        externalEvaluationInputSchema.safeParse(body(sourceInput)).data,
        input,
      ),
    ),
    'The comparison must reconstruct the exact supplied original external-evaluation input.',
  );
  check(
    'independent_assignments',
    Boolean(
      resultArtifact.assignment_id &&
      learningArtifact.assignment_id &&
      resultArtifact.producer.kind === 'assignment' &&
      learningArtifact.producer.kind === 'assignment' &&
      resultArtifact.producer.id === resultArtifact.assignment_id &&
      learningArtifact.producer.id === learningArtifact.assignment_id &&
      resultArtifact.assignment_id !== reviewer.assignment_id &&
      learningArtifact.assignment_id !== reviewer.assignment_id,
    ),
    'The technical reviewer must be a distinct registered assignment from both product producers.',
  );
  check(
    'product_integrity',
    resultArtifact.kind === 'reduction.external-evaluation' &&
      learningArtifact.kind === 'reduction.evaluation-learning' &&
      contractHash(resultArtifact.content) === resultArtifact.sha256 &&
      contractHash(learningArtifact.content) === learningArtifact.sha256 &&
      parsedResult.success &&
      parsedLearning.success,
    'Exact registered evaluation and learning products must retain valid schemas, kinds and original hashes.',
  );
  const incompat: string[] = [],
    gaps: string[] = [];
  let synthetic = input.origin === 'synthetic';
  const visited = new Set<string>(),
    active = new Set<string>();
  const inspect = (reference: ArtifactRef): void => {
    if (visited.has(key(reference))) return;
    if (active.has(key(reference)) || active.size + visited.size >= 256) {
      gaps.push('evidence_closure');
      return;
    }
    const artifact = exactSource(reference);
    if (!artifact) {
      gaps.push('evidence_closure');
      return;
    }
    active.add(key(reference));
    if (artifact.evidence_origin === 'synthetic_fixture') synthetic = true;
    try {
      const content = body(artifact);
      if (
        typeof content === 'object' &&
        content !== null &&
        'origin' in content &&
        ['synthetic', 'synthetic_fixture'].includes(String(content.origin))
      )
        synthetic = true;
      const expected =
        externalEvaluationExpectedOutputSchema.safeParse(content);
      if (expected.success)
        for (const reference of expected.data.evidence) inspect(reference);
    } catch {
      /* retain prose */
    }
    for (const dependency of artifact.dependencies) inspect(dependency);
    active.delete(key(reference));
    visited.add(key(reference));
  };
  const originalDossierArtifact =
    context.dossier_ref && exactSource(context.dossier_ref);
  const originalDossier =
    originalDossierArtifact &&
    scientificQualificationDossierSchema.safeParse(
      body(originalDossierArtifact),
    );
  for (const reference of [
    context.input_ref,
    ...(context.supporting_refs ?? []),
    ...(context.dossier_ref ? [context.dossier_ref] : []),
    input.protocol.protocol_ref,
    ...input.report_refs,
    ...input.data_refs,
    ...input.external_review_refs,
    ...input.expected_output_refs,
    ...(originalDossier && originalDossier.success
      ? [
          originalDossier.data.evaluation_input_ref,
          originalDossier.data.protocol.protocol_ref,
          ...originalDossier.data.report_refs,
          ...originalDossier.data.data_refs,
          ...originalDossier.data.external_review_refs,
          ...originalDossier.data.expected_output_refs,
          ...originalDossier.data.evidence,
          ...originalDossier.data.reference_case.evidence,
        ]
      : []),
  ])
    inspect(reference);
  if (
    input.programme_id !== context.programme_id ||
    input.target_sha256 !== context.target_sha256 ||
    context.target_sha256 !== contractHash(context.target) ||
    input.scope_sha256 !== context.scope_sha256 ||
    context.scope_sha256 !== contractHash(context.target.scope) ||
    !same(input.scope, context.target.scope)
  )
    incompat.push('target_scope_programme');
  if (
    input.registered_target.fraction !== context.target.target_fraction ||
    input.registered_target.relation !== context.target.relation
  )
    incompat.push('threshold');
  if (!context.protocol_ref || !context.registration_id)
    gaps.push('registration');
  else if (
    key(input.protocol.protocol_ref) !== key(context.protocol_ref) ||
    input.protocol.registration_id !== context.registration_id ||
    input.protocol.analysis_basis !== context.analysis_basis ||
    !equalIds(input.protocol.amendment_record_ids, context.amendment_record_ids)
  )
    incompat.push('protocol');
  for (const values of [
    input.protocol.amendment_record_ids,
    input.delivery.action_record_ids,
    input.delivery.deviation_record_ids,
    input.delivery.verification_record_ids,
    input.delivery.accounted_deviation_record_ids,
  ])
    if (values.length !== new Set(values).size) incompat.push('duplicates');
  if (
    new Set(input.delivery.rules.map((rule) => `${rule.id}:${rule.version}`))
      .size !== input.delivery.rules.length
  )
    incompat.push('rules_duplicate');
  if (
    !input.delivery.action_record_ids.length ||
    input.delivery.action_record_ids.some(
      (id) =>
        !context.delivery.action_record_ids.includes(id) ||
        !context.delivery.confirmed_action_record_ids.includes(id),
    )
  )
    gaps.push('actual_delivery');
  if (
    !equalIds(
      input.delivery.deviation_record_ids,
      context.delivery.deviation_record_ids,
    ) ||
    input.delivery.verification_record_ids.some(
      (id) => !context.delivery.verification_record_ids.includes(id),
    ) ||
    !equalRules(input.delivery.rules, context.delivery.rules)
  )
    incompat.push('delivery_lineage');
  if (
    input.delivery.accounted_deviation_record_ids.some(
      (id) => !input.delivery.deviation_record_ids.includes(id),
    ) ||
    context.delivery.unresolved_material_deviation_record_ids.some(
      (id) => !input.delivery.accounted_deviation_record_ids.includes(id),
    )
  )
    gaps.push('deviations');
  if (
    input.design.identification !== 'externally_reviewed_comparative' ||
    !input.design.assumptions.length
  )
    gaps.push('design');
  if (/^damage\./.test(input.source_method.id)) incompat.push('legacy_method');
  if (input.criterion.kind !== 'point_estimate') gaps.push('uncertainty');
  for (const values of [
    input.report_refs,
    input.data_refs,
    input.external_review_refs,
    input.expected_output_refs,
    input.material_limitations,
  ])
    if (!values.length) gaps.push('required_evidence');
  if (context.gate_reasons?.length) gaps.push('programme_gate');
  const protocolArtifact = exactSource(input.protocol.protocol_ref),
    protocol =
      protocolArtifact && pilotProtocolSchema.safeParse(body(protocolArtifact));
  if (!protocol || !protocol.success) gaps.push('typed_protocol');
  else {
    const p = protocol.data,
      s = p.specification;
    if (
      p.programme_id !== input.programme_id ||
      p.target_sha256 !== input.target_sha256 ||
      p.scope_sha256 !== input.scope_sha256
    )
      incompat.push('protocol_scope');
    if (
      !s.analysis_method ||
      s.analysis_method.id !== input.source_method.id ||
      s.analysis_method.version !== input.source_method.version ||
      s.design_name !== input.design.registered_name
    )
      incompat.push('registered_method_design');
    if (
      s.primary_endpoint !== input.scope.endpoint ||
      s.unit !== input.scope.unit ||
      s.population !== input.scope.population ||
      !same(s.observation_window, input.scope.period)
    )
      incompat.push('registered_observation');
    if (
      s.analysis_method &&
      s.analysis_method.uncertainty_rule !== input.criterion.kind
    )
      gaps.push('registered_uncertainty');
  }
  if (
    !sourceInput ||
    sourceInput.producer.kind === 'assignment' ||
    !same(
      externalEvaluationInputSchema.safeParse(body(sourceInput)).data,
      input,
    )
  )
    gaps.push('original_input');
  // Separate variable-scale rational arithmetic: unlike the producer's fixed 12-place kernel.
  const unpack = (token: string) => {
    const negative = token.startsWith('-');
    const digits = token.replace(/^-/, '').split('.');
    return {
      n: BigInt(`${negative ? '-' : ''}${digits.join('')}`),
      places: digits[1]?.length ?? 0,
    };
  };
  const format = (n: bigint, places: number) => {
    if (places === 0) return n.toString();
    const digits = (n < 0n ? -n : n).toString().padStart(places + 1, '0');
    const decimals = digits.slice(-places).replace(/0+$/, '');
    return `${n < 0n ? '-' : ''}${digits.slice(0, -places)}${decimals ? `.${decimals}` : ''}`;
  };
  let baseline: string | null = null,
    intervention: string | null = null,
    difference: string | null = null;
  let ratio: ExternalEvaluationResult['relative_reduction'] = null,
    met: boolean | null = null;
  if (
    input.comparative_estimates.baseline === null ||
    input.comparative_estimates.intervention === null
  )
    gaps.push('quantities');
  else {
    const b = unpack(input.comparative_estimates.baseline),
      i = unpack(input.comparative_estimates.intervention);
    const places = Math.max(b.places, i.places),
      bn = b.n * 10n ** BigInt(places - b.places),
      inum = i.n * 10n ** BigInt(places - i.places),
      dn = bn - inum;
    baseline = format(bn, places);
    intervention = format(inum, places);
    difference = format(dn, places);
    if (bn <= 0n || inum < 0n) gaps.push('invalid_residuals');
    else if (input.criterion.kind === 'point_estimate') {
      const threshold = unpack(input.registered_target.fraction),
        left = dn * 10n ** BigInt(threshold.places),
        right = bn * threshold.n;
      if (
        [bn, inum, dn, left, right].some(
          (n) => n.toString().replace('-', '').length > 128,
        )
      )
        gaps.push('overflow');
      else {
        ratio = { numerator: difference, denominator: baseline };
        met =
          input.registered_target.relation === 'at_least'
            ? left >= right
            : left > right;
      }
    }
  }
  // Compare supplied expected fractions independently, without requiring the
  // external preparer to use our unreduced difference/baseline representation.
  const matchesExpectedRatio = (
    expected: ExternalEvaluationResult['relative_reduction'],
  ) => {
    if (expected === null || ratio === null) return expected === ratio;
    const n = unpack(expected.numerator),
      d = unpack(expected.denominator),
      reconstructedN = unpack(ratio.numerator),
      reconstructedD = unpack(ratio.denominator);
    if (d.n === 0n || reconstructedD.n === 0n) return false;
    const supplied =
      n.n * reconstructedD.n * 10n ** BigInt(d.places + reconstructedN.places);
    const reconstructed =
      reconstructedN.n * d.n * 10n ** BigInt(n.places + reconstructedD.places);
    return (
      [
        n.n,
        d.n,
        reconstructedN.n,
        reconstructedD.n,
        supplied,
        reconstructed,
      ].every((value) => value.toString().replace('-', '').length <= 128) &&
      supplied === reconstructed
    );
  };
  for (const reference of input.expected_output_refs) {
    const artifact = exactSource(reference),
      expected =
        artifact &&
        externalEvaluationExpectedOutputSchema.safeParse(body(artifact));
    if (
      !expected ||
      !expected.success ||
      artifact.producer.kind === 'assignment'
    ) {
      gaps.push('expected_outputs');
      continue;
    }
    const e = expected.data;
    if (
      e.programme_id !== input.programme_id ||
      e.target_sha256 !== input.target_sha256 ||
      e.scope_sha256 !== input.scope_sha256 ||
      !same(e.source_method, input.source_method) ||
      e.design.id !== input.design.id ||
      e.design.version !== input.design.version ||
      e.criterion !== input.criterion.kind
    )
      incompat.push('expected_binding');
    if (input.authors.some((author) => author.name === e.prepared_by))
      gaps.push('expected_independence');
    if (
      input.criterion.kind === 'point_estimate' &&
      (e.baseline_damage !== baseline ||
        e.intervention_damage !== intervention ||
        e.absolute_reduction !== difference ||
        !matchesExpectedRatio(e.relative_reduction) ||
        e.target_met !== met)
    )
      incompat.push('expected_mismatch');
  }
  const reconstructedPoint = met !== null;
  const status = incompat.length
    ? 'incompatible'
    : gaps.length
      ? 'gap'
      : 'supported';
  if (incompat.length) {
    ratio = null;
    met = null;
  }
  if (parsedResult.success && parsedLearning.success) {
    const r = parsedResult.data,
      l = parsedLearning.data;
    check(
      'exact_bindings',
      r.programme_id === context.programme_id &&
        key(r.input_ref) === key(context.input_ref) &&
        same(r.dossier_ref, context.dossier_ref) &&
        r.target_sha256 === input.target_sha256 &&
        r.scope_sha256 === input.scope_sha256 &&
        same(r.source_method, input.source_method) &&
        same(r.design, input.design) &&
        same(r.protocol, input.protocol) &&
        same(r.delivery, input.delivery) &&
        same(r.scope, input.scope) &&
        same(r.criterion, input.criterion) &&
        same(r.registered_target, input.registered_target) &&
        same(r.original_estimates, input.comparative_estimates),
      'Result must bind the exact supplied programme, method, design, target, protocol, delivery and original decimal tokens.',
    );
    check(
      'independent_arithmetic',
      r.baseline_damage === baseline &&
        r.intervention_damage === intervention &&
        r.absolute_reduction === difference &&
        same(r.relative_reduction, ratio) &&
        r.target_met === met,
      'Independent variable-scale integer reconstruction must agree exactly with subtraction, rational reduction and the selected criterion.',
    );
    check(
      'support_state',
      r.status === status &&
        (status === 'supported'
          ? r.reasons.length === 0
          : r.reasons.length > 0),
      'Support status must preserve scope incompatibilities and unsupported or incomplete evidence as explicit gaps.',
    );
    const expectedOrigin = synthetic
      ? 'synthetic'
      : gaps.includes('evidence_closure')
        ? 'unknown'
        : 'supplied';
    check(
      'origin',
      r.origin === expectedOrigin,
      'Synthetic provenance from original evidence or immutable dependencies cannot be relabelled supplied.',
    );
    check(
      'limits',
      r.scientific_qualification === 'unqualified' &&
        !r.achieved_reduction &&
        same(r.externally_calculated, EXTERNAL_CALCULATIONS) &&
        same(r.inspected, INSPECTION_SCOPE) &&
        same(
          r.reproduced,
          baseline === null
            ? []
            : [
                SUBTRACTION_REPRODUCTION,
                ...(reconstructedPoint ? [RATIO_REPRODUCTION] : []),
              ],
        ) &&
        same(r.uncertainty_interpretation, input.uncertainty_interpretation) &&
        same(r.material_limitations, input.material_limitations) &&
        same(r.limitations, EVALUATION_LIMITATIONS),
      'Technical reproduction must retain uncertainty/material limitations and cannot grant scientific qualification or achieved-effect status.',
    );
    const outcome =
      status !== 'supported' || met === null
        ? 'insufficient_evidence'
        : met
          ? 'point_estimate_meets'
          : 'point_estimate_below';
    const learningEvidence = [
      ref(context.input_ref),
      ...(context.dossier_ref ? [ref(context.dossier_ref)] : []),
      ...new Map(
        [
          input.protocol.protocol_ref,
          ...input.report_refs,
          ...input.data_refs,
          ...input.external_review_refs,
          ...input.expected_output_refs,
        ].map((item) => [key(item), ref(item)]),
      ).values(),
    ];
    check(
      'learning_alignment',
      l.programme_id === context.programme_id &&
        key(l.input_ref) === key(context.input_ref) &&
        l.target_sha256 === input.target_sha256 &&
        l.scope_sha256 === input.scope_sha256 &&
        key(l.protocol_ref) === key(input.protocol.protocol_ref) &&
        l.origin === expectedOrigin &&
        l.outcome === outcome &&
        same(l.lessons, lessonsFor(outcome)) &&
        same(l.evidence, learningEvidence) &&
        same(l.next_requirements, [
          ...r.reasons,
          'Scientific qualification and explicit local adoption remain separate server-validated human records.',
        ]) &&
        l.publication === 'not_published',
      'Learning must retain exact evidence and only the independently supported point/gap conclusion; publication and qualification remain separate.',
    );
  }
  return evaluationTechnicalReviewSchema.parse({
    schema_version: 'haze.reduction.evaluation-review.v1',
    programme_id: context.programme_id,
    input_ref: context.input_ref,
    dossier_ref: context.dossier_ref,
    reviewed_artifacts: [ref(resultArtifact), ref(learningArtifact)],
    reviewer,
    verdict: findings.length ? 'rejected' : 'supported',
    checks,
    findings,
    qualification_check: inspectEvaluationDossier(input, context),
    reproduced: [
      'Independent variable-scale integer reconstruction of supplied residual subtraction, rational reduction and supported point criterion.',
    ],
    limitations: EVALUATION_LIMITATIONS,
    scientific_qualification: 'unqualified',
    achieved_reduction: false,
  });
}
