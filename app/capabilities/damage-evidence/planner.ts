import type {
  DamageEvidenceScope,
  EvidenceCapture,
  EvidenceStage,
} from './contracts.js';
import { damageEvidenceScopeSchema } from './contracts.js';
import { DAMAGE_EVIDENCE_SOURCES } from './registry.js';
import { boundEvidenceGaps } from './bounds.js';

export interface EvidenceRequirement {
  id: string;
  stage: EvidenceStage;
  retained_captures: string[];
  retained_capture_count: number;
  omitted_retained_capture_count: number;
  source_ids: string[];
  gaps: string[];
  omitted_gap_count: number;
  queries: { en: string; ms: string }[];
}

export function evidenceCompatibilityGaps(
  scope: DamageEvidenceScope,
  capture: EvidenceCapture,
): string[] {
  const gaps = [...capture.gaps];
  if (capture.evidence_origin === 'synthetic_fixture')
    gaps.push('Synthetic fixtures cannot support a public historical case.');
  if (capture.normalized_values.length > 0) {
    const compatible = capture.normalized_values.some((value) => {
      const periodMatches =
        value.period.start <= scope.occurrence_period.start &&
        value.period.end >= scope.occurrence_period.end;
      const geographyMatches =
        value.geography.level === scope.geography.level &&
        value.geography.name === scope.geography.name;
      const boundaryMatches =
        scope.geography.level === 'country' ||
        (scope.geography.boundary_version !== null &&
          value.geography.boundary_version ===
            scope.geography.boundary_version);
      return periodMatches && geographyMatches && boundaryMatches;
    });
    if (!compatible)
      gaps.push(
        'No value covers the exact requested geography and entire occurrence period; an explicit reviewed temporal/spatial method is required.',
      );
    if (
      scope.geography.level !== 'country' &&
      capture.normalized_values.some(
        (value) =>
          value.geography.level === scope.geography.level &&
          value.geography.name === scope.geography.name &&
          value.geography.boundary_version !== scope.geography.boundary_version,
      )
    )
      gaps.push(
        'Retained source boundary version is unknown or differs from the requested boundary version.',
      );
    if (
      capture.normalized_values.some(
        (value) =>
          value.currency !== null &&
          (value.currency !== scope.currency ||
            value.price_year !== scope.price_year),
      )
    ) {
      gaps.push(
        'Currency or price year differs from the requested monetary basis.',
      );
    }
  }
  if (
    scope.geography.level !== 'country' &&
    scope.geography.boundary_version === null
  )
    gaps.push('Administrative boundary version is unspecified.');
  return boundEvidenceGaps(gaps).gaps;
}

/** Retained captures are checked first; documents and raw data never grant applicability. */
export function planDamageEvidence(
  input: DamageEvidenceScope,
  retained: readonly EvidenceCapture[] = [],
) {
  const scope = damageEvidenceScopeSchema.parse(input);
  const ids = [
    'episode_definition',
    'population',
    'physical_effect_method',
    'published_physical_effect',
  ];
  if (scope.attribution_basis === 'fire_attributed')
    ids.push('fire_attribution');
  else if (scope.attribution_basis === 'unspecified')
    ids.push('attribution_basis_decision');
  if (
    scope.monetary_view === 'financial_loss' ||
    scope.monetary_view === 'both'
  )
    ids.push('financial_unit_value');
  if (
    scope.monetary_view === 'social_welfare' ||
    scope.monetary_view === 'both'
  )
    ids.push('welfare_unit_value');
  if (
    scope.monetary_view !== 'physical_only' &&
    (scope.currency === null || scope.price_year === null)
  )
    ids.push('monetary_basis_decision');
  const requirements: EvidenceRequirement[] = ids.map((id) => {
    const sources = DAMAGE_EVIDENCE_SOURCES.filter((source) =>
      source.supported_inputs.includes(id),
    );
    const sourceIds = sources.map((source) => source.id);
    const captures = retained.filter((capture) =>
      sourceIds.includes(capture.source_id),
    );
    const compatible = captures.filter(
      (capture) => evidenceCompatibilityGaps(scope, capture).length === 0,
    );
    const validated = compatible.filter(
      (capture) => capture.stage === 'validated',
    );
    const stage: EvidenceStage = validated.length
      ? 'validated'
      : compatible.length
        ? 'acquired'
        : sources.length
          ? 'discovered'
          : 'missing';
    return {
      id,
      stage,
      retained_captures: [
        ...compatible.toReversed(),
        ...captures
          .toReversed()
          .filter((capture) => !compatible.includes(capture)),
      ]
        .slice(0, 100)
        .map((capture) => capture.capture_id),
      retained_capture_count: captures.length,
      omitted_retained_capture_count: Math.max(0, captures.length - 100),
      source_ids: sourceIds,
      ...boundEvidenceGaps(
        [
          ...(captures.length
            ? captures.flatMap((capture) =>
                evidenceCompatibilityGaps(scope, capture),
              )
            : ['No retained compatible evidence.']),
          ...sources
            .filter((source) => source.kind === 'access_gap')
            .flatMap((source) => source.access_requirements),
          'Scientific applicability has not been reviewed for this exact scope and evidence version.',
        ],
        32,
      ),
      queries: sources.map((source) => source.discovery_queries),
    };
  });
  const interventions = ['A', 'B'].map((id) => ({
    id,
    stage: 'missing' as const,
    categories_considered: ['source_prevention', 'exposure_protection'],
    requirements: [
      'mechanism',
      'implementation_scope',
      'adoption',
      'effectiveness',
      'incremental_lifecycle_cost',
      'prerequisites',
    ].map((parameter) => ({
      id: `${id}.${parameter}`,
      stage: 'missing' as const,
      gap: 'Requires compatible public evidence or an explicitly labelled assumption; no value is inferred.',
    })),
    estimate: null,
  }));
  return {
    schema_version: 'haze.damage.evidence.plan.v1' as const,
    scope,
    requirements,
    interventions,
    feasibility: 'blocked' as const,
    quantified_outputs_permitted: false,
    lower_budget_B_verified: false,
    gaps: [
      'No reviewed physical-effect input is available yet.',
      'A/B must share the exact baseline version and B must have a lower compatible evidenced cost.',
    ],
  };
}

export interface EvidenceCaseCandidate {
  id: string;
  scope: DamageEvidenceScope;
  retained: EvidenceCapture[];
  rationale: string;
}

/** Ranking is transparent and does not promote a merely best-ranked case to feasible. */
export function selectDamageEvidenceCase(
  candidates: readonly EvidenceCaseCandidate[],
) {
  if (candidates.length === 0)
    throw new Error('At least one episode candidate is required.');
  const findings = candidates
    .map((candidate) => {
      const plan = planDamageEvidence(candidate.scope, candidate.retained);
      const completeness = plan.requirements.reduce(
        (sum, requirement) =>
          sum +
          {
            missing: 0,
            discovered: 1,
            acquired: 2,
            validated: 3,
            applicable: 4,
          }[requirement.stage],
        0,
      );
      const publishedCaptures = candidate.retained.filter(
        (capture) =>
          capture.gaps.length === 0 &&
          DAMAGE_EVIDENCE_SOURCES.some(
            (source) =>
              source.id === capture.source_id &&
              source.supported_inputs.includes('published_physical_effect'),
          ),
      ).length;
      // Documentary breadth only breaks equal completeness; it cannot establish applicability.
      const score = completeness + Math.min(publishedCaptures, 9) / 10;
      return { id: candidate.id, score, rationale: candidate.rationale, plan };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const selected = findings[0]!;
  return {
    schema_version: 'haze.damage.evidence.case-selection.v1' as const,
    selected_candidate: selected.plan.requirements.some((requirement) =>
      ['acquired', 'validated', 'applicable'].includes(requirement.stage),
    )
      ? selected.id
      : null,
    decision: selected.plan.requirements.some((requirement) =>
      ['acquired', 'validated', 'applicable'].includes(requirement.stage),
    )
      ? ('investigate_best_available_candidate' as const)
      : ('no_supported_candidate_yet' as const),
    selection_basis:
      'Compatible retained evidence completeness; published effects and reviewed methods remain mandatory.',
    selected_sources: selected.plan.requirements.flatMap(
      (requirement) => requirement.retained_captures,
    ),
    rejected_alternatives: findings.slice(1).map((finding) => ({
      id: finding.id,
      score: finding.score,
      reason:
        'Lower compatible evidence score or deterministic tie-break; not evidence of scientific inapplicability.',
    })),
    findings,
    unresolved_requirements: selected.plan.requirements.filter(
      (requirement) => requirement.stage !== 'applicable',
    ),
    intervention_specs: selected.plan.interventions,
    quantified_outputs_permitted: false,
  };
}
