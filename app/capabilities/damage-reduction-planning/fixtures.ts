import type {
  PhysicalResidualImport,
  ReductionScope,
  ReductionTarget,
} from '../../contracts/damage-reduction.js';

/** Entirely synthetic engineering data, not a scientific reference case. */
export const SYNTHETIC_REDUCTION_SCOPE: ReductionScope = {
  endpoint: 'synthetic lost healthy days',
  unit: 'person-days',
  population: 'synthetic outdoor workforce',
  geography: 'synthetic district',
  pollutant: 'synthetic haze boundary',
  period: { start: '2027-01-01', end: '2027-01-31' },
  coverage: 'One declared synthetic stratum; supplied point estimates only.',
  missingness: 'None in this engineering fixture.',
  exclusions: ['All other endpoints; costs; valuation; delivered effects.'],
};
export const SYNTHETIC_REDUCTION_TARGET: ReductionTarget = {
  scope: SYNTHETIC_REDUCTION_SCOPE,
  target_fraction: '0.1',
  relation: 'at_least',
  comparator:
    'Synthetic ordinary-management schedule with existing protections',
  intervention: 'Synthetic proposed exposure-alert and schedule service',
  assessment_rule: 'point_estimate',
};
export function syntheticResidualImport(
  baseline: string | null = '1000',
  intervention: string | null = '880',
): PhysicalResidualImport {
  return {
    schema_version: 'haze.reduction.physical-import.v1',
    origin: 'synthetic',
    records: (['baseline', 'intervention'] as const).map((role) => ({
      row_id: `${role}-1`,
      role,
      scenario:
        role === 'baseline'
          ? SYNTHETIC_REDUCTION_TARGET.comparator
          : SYNTHETIC_REDUCTION_TARGET.intervention,
      evidence_basis: 'prospective',
      scope: structuredClone(SYNTHETIC_REDUCTION_SCOPE),
      stratum_id: 'synthetic-stratum-1',
      support_ids: ['synthetic-atomic-population-1'],
      quantity: role === 'baseline' ? baseline : intervention,
      original_method: { id: 'synthetic-supplied-estimate', version: '1' },
      applicability:
        'Synthetic engineering fixture only; scientific applicability is unqualified.',
    })),
  };
}
