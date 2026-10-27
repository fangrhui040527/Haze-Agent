import type { Artifact } from '../../contracts/artifacts.js';
import {
  damageAccountSchema,
  damageReviewSchema,
} from '../../contracts/damage-account.js';
import {
  damageComparisonRequestSchema,
  damageComparisonSchema,
  damageParameterEvidenceSchema,
  damageScientificCheckSchema,
  damageMethodOutputSchema,
  type DamageComparisonRequest,
} from '../../contracts/damage-evidence-review.js';
import { canonicalJson } from '../../contracts/json.js';
import {
  checkScientificReview,
  retainedArtifact,
  sameEvidenceRef,
} from './science.js';

/** Versioned residual model. Parameter estimates remain separate from its deterministic arithmetic. */
export const DAMAGE_RESIDUAL_METHOD = {
  id: 'damage.evidenced-residual.v1',
  version: '1',
  description:
    'Residual = baseline × (1 − adoption × effectiveness). Fractions apply only to the same reviewed outcome and population.',
} as const;

export function compareDamageInterventions(
  input: unknown,
  artifacts: readonly Artifact[],
  now?: string,
) {
  const request = damageComparisonRequestSchema.parse(input);
  const { baseline } = request;
  if (
    request.interventions[0].id !== 'A' ||
    request.interventions[1].id !== 'B'
  )
    throw new Error(
      'Supply Intervention A followed by lower-budget Intervention B.',
    );
  for (const intervention of request.interventions)
    if (canonicalJson(intervention.baseline) !== canonicalJson(baseline))
      throw new Error(
        'A and B must share the exact account version, outcome, units, population, period, attribution and valuation basis.',
      );
  const commonGaps = baselineGaps(request, artifacts, now);
  const baselineSupported = commonGaps.length === 0;
  const [a, b] = request.interventions;
  const comparableCosts =
    canonicalJson(a.cost_basis) === canonicalJson(b.cost_basis);
  if (!comparableCosts)
    commonGaps.push(
      'Intervention costs have incompatible currencies, price years or lifecycle horizons.',
    );
  const lowerCost =
    comparableCosts &&
    a.cost.value !== null &&
    b.cost.value !== null &&
    b.cost.value < a.cost.value;
  if (!lowerCost)
    commonGaps.push(
      'B has not been shown to cost less than A on a compatible basis.',
    );
  const evidenceBackedCosts = [a, b].every((i) => i.cost.basis === 'evidence');
  if (!evidenceBackedCosts)
    commonGaps.push(
      'The cost comparison includes assumptions or missing cost evidence.',
    );
  const results = request.interventions.map((intervention) => {
    const gaps = [...commonGaps];
    const assumptions: string[] = [];
    for (const key of [
      'adoption',
      'effectiveness',
      'cost',
      'avoided_monetary_damage',
    ] as const) {
      const parameter = intervention[key];
      if (!parameter) continue;
      if (parameter.basis === 'assumption')
        assumptions.push(`${key}: ${parameter.explanation}`);
      if (parameter.basis === 'unavailable')
        gaps.push(`${key}: ${parameter.explanation}`);
      if (parameter.basis === 'evidence') {
        const matches = parameter.evidence.some((ref) => {
          const capture = retainedArtifact(ref, artifacts);
          const parsed = damageParameterEvidenceSchema.safeParse(
            capture.content,
          );
          if (!parsed.success || capture.producer.kind === 'assignment')
            return false;
          const evidence = parsed.data;
          for (const source of evidence.source_refs)
            retainedArtifact(source, artifacts);
          const cost = key === 'cost' || key === 'avoided_monetary_damage';
          return (
            evidence.parameter === key &&
            evidence.value === parameter.value &&
            canonicalJson(evidence.applicability) ===
              canonicalJson(baseline.applicability) &&
            evidence.unit ===
              (cost ? intervention.cost_basis.currency : 'fraction') &&
            (!cost ||
              (evidence.price_year === intervention.cost_basis.price_year &&
                canonicalJson(evidence.horizon) ===
                  canonicalJson(intervention.cost_basis.horizon)))
          );
        });
        if (!matches)
          gaps.push(
            `${key}: retained evidence does not support this exact parameter, scope and unit.`,
          );
      }
    }
    const calculable =
      baselineSupported &&
      !gaps.some((g) => /^(adoption|effectiveness):/.test(g)) &&
      baseline.quantity !== null &&
      baseline.quantity > 0 &&
      intervention.adoption.value !== null &&
      intervention.effectiveness.value !== null;
    const residual = calculable
      ? baseline.quantity! *
        (1 - intervention.adoption.value! * intervention.effectiveness.value!)
      : null;
    const avoided = residual === null ? null : baseline.quantity! - residual;
    const percent =
      avoided === null ? null : (avoided / baseline.quantity!) * 100;
    const costSupported =
      intervention.cost.value !== null &&
      !gaps.some((g) => g.startsWith('cost:'));
    const money = intervention.avoided_monetary_damage;
    const moneySupported =
      !!money &&
      money.value !== null &&
      !gaps.some((g) => g.startsWith('avoided_monetary_damage:'));
    const monetaryBasisMatches =
      baseline.valuation.view !== 'physical' &&
      baseline.valuation.currency === intervention.cost_basis.currency &&
      baseline.valuation.price_year === intervention.cost_basis.price_year;
    if (moneySupported && !monetaryBasisMatches)
      gaps.push(
        'Monetary net benefit is withheld because the selected baseline valuation and intervention cost basis are incompatible.',
      );
    const monetaryDamageConsistent =
      !money ||
      money.value === null ||
      (moneySupported &&
        avoided !== null &&
        Math.abs(money.value - avoided) <=
          Math.max(1, Math.abs(avoided)) * 1e-10);
    if (!monetaryDamageConsistent)
      gaps.push(
        'The optional monetary avoided-damage parameter conflicts with the registered baseline reduction.',
      );
    return {
      id: intervention.id,
      status:
        percent === null
          ? ('insufficient_evidence' as const)
          : percent + 1e-12 >= 10
            ? ('meets_target' as const)
            : ('below_target' as const),
      baseline: baseline.account,
      residual_damage: residual,
      avoided_damage: avoided,
      reduction_percent: percent,
      intervention_cost: costSupported ? intervention.cost.value : null,
      cost_basis: intervention.cost_basis,
      net_monetary_benefit:
        avoided !== null &&
        costSupported &&
        monetaryBasisMatches &&
        monetaryDamageConsistent
          ? avoided - intervention.cost.value!
          : null,
      assumptions,
      evidence: [
        ...new Map(
          ['adoption', 'effectiveness', 'cost', 'avoided_monetary_damage']
            .flatMap((key) => intervention[key as 'adoption']?.evidence ?? [])
            .map((ref) => [canonicalJson(ref), ref]),
        ).values(),
      ],
      gaps,
    };
  });
  return damageComparisonSchema.parse({
    schema_version: 'haze.damage.comparison.v1',
    reporting_type: 'hypothetical_intervention',
    method_id: DAMAGE_RESIDUAL_METHOD.id,
    method_version: '1',
    threshold_percent: 10,
    baseline,
    lower_budget_verified:
      lowerCost &&
      evidenceBackedCosts &&
      results.every((r) => !r.gaps.some((g) => g.startsWith('cost:'))),
    interventions: results,
    gaps: commonGaps,
  });
}

function baselineGaps(
  request: DamageComparisonRequest,
  artifacts: readonly Artifact[],
  now?: string,
): string[] {
  const { baseline } = request;
  const accountArtifact = retainedArtifact(baseline.account, artifacts);
  const account = damageAccountSchema.parse(accountArtifact.content);
  const gaps: string[] = [];
  if (baseline.quantity === null || baseline.quantity <= 0)
    gaps.push(
      'A positive retained baseline is required for percentage reduction.',
    );
  if (account.evidence_origin === 'synthetic')
    gaps.push(
      'The baseline is a synthetic fixture and cannot establish a public-evidence comparison.',
    );
  if (
    !account.scope.reporting ||
    canonicalJson(account.scope.reporting.applicability) !==
      canonicalJson(baseline.applicability)
  )
    gaps.push(
      'The historical account does not declare this exact scientifically reviewed applicability.',
    );
  if (account.scope.reporting?.reporting_type !== 'historical_account')
    gaps.push('A historical account is required as the baseline.');
  if (
    baseline.applicability.occurrence_period.start !==
      account.scope.effect_period.start ||
    baseline.applicability.occurrence_period.end !==
      account.scope.effect_period.end ||
    baseline.applicability.population !== account.scope.population
  )
    gaps.push(
      'Baseline population or occurrence period differs from the account.',
    );
  const historical = account.scope.historical_scenario_id;
  if (baseline.valuation.view === 'physical') {
    const rows = account.physical_totals.filter(
      (row) =>
        row.scenario_id === historical &&
        row.endpoint_id === baseline.applicability.endpoint &&
        row.unit === baseline.applicability.unit,
    );
    if (
      rows.length !== 1 ||
      rows[0]!.quantity !== baseline.quantity ||
      baseline.valuation.currency !== null ||
      baseline.valuation.price_year !== null
    )
      gaps.push(
        'Requested physical baseline does not equal one exact historical outcome and unit.',
      );
  } else {
    const rows = (
      baseline.valuation.view === 'financial_loss'
        ? account.financing_totals
        : account.welfare_totals
    ).filter(
      (row) =>
        row.scenario_id === historical &&
        row.currency === baseline.valuation.currency &&
        row.price_year === baseline.valuation.price_year,
    );
    if (
      rows.length !== 1 ||
      rows[0]!.amount !== baseline.quantity ||
      baseline.valuation.currency !== account.scope.currency ||
      baseline.valuation.price_year !== account.scope.price_year
    )
      gaps.push(
        'Requested monetary baseline differs from its separately labelled accounting view or price basis.',
      );
  }
  const arithmeticArtifact = retainedArtifact(
    baseline.arithmetic_review,
    artifacts,
  );
  const arithmetic = damageReviewSchema.parse(arithmeticArtifact.content);
  if (
    arithmeticArtifact.producer.kind !== 'assignment' ||
    !arithmeticArtifact.assignment_id ||
    arithmeticArtifact.assignment_id === accountArtifact.assignment_id ||
    arithmeticArtifact.producer.id === accountArtifact.producer.id ||
    arithmetic.reviewer.assignment_id !== arithmeticArtifact.assignment_id ||
    arithmetic.reviewer.revision !== arithmeticArtifact.assignment_revision ||
    arithmetic.verdict !== 'supported' ||
    !arithmetic.reviewed_artifacts.some((ref) =>
      sameEvidenceRef(ref, baseline.account),
    )
  )
    gaps.push(
      'An independent arithmetic review of this exact account version is required.',
    );
  const checkArtifact = retainedArtifact(baseline.scientific_check, artifacts);
  const check = damageScientificCheckSchema.parse(checkArtifact.content);
  const methodOutput = retainedArtifact(check.method_output, artifacts);
  const currentCheck = checkScientificReview({
    output: methodOutput,
    review: retainedArtifact(check.expert_review, artifacts),
    artifacts,
    applicability: baseline.applicability,
    ...(now ? { now } : {}),
  });
  if (
    !check.qualified ||
    !currentCheck.qualified ||
    !account.scope.reporting?.scientific_bindings.some(
      (binding) =>
        sameEvidenceRef(binding.method_output, check.method_output) &&
        sameEvidenceRef(binding.expert_review, check.expert_review),
    )
  )
    gaps.push(
      'The baseline has no current applicable scientific review of its exact evidence and method output.',
    );
  if (
    baseline.valuation.view === 'physical' &&
    damageMethodOutputSchema.parse(methodOutput.content).quantity !==
      baseline.quantity
  )
    gaps.push(
      'The reviewed physical method output differs from the account baseline quantity.',
    );
  return gaps;
}
