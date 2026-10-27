import type { Artifact, ArtifactRef } from '../../contracts/artifacts.js';
import {
  REDUCTION_METHOD_ID,
  reductionAssessmentSchema,
  type ReductionAssessment,
  type ReductionInputSelection,
} from '../../contracts/damage-reduction.js';
import { normalizeReductionSelection, ReductionInputError } from './inputs.js';
import {
  assertExactIntegerBound,
  parseExactDecimal,
  compareExactResiduals,
} from './exact-comparison.js';

export const REDUCTION_LIMITATIONS = [
  'Comparison of supplied residual point estimates only; no causal, exposure-response, efficacy or adoption estimation.',
  'Scientific applicability is unqualified. A named non-synthetic reference case and scientific-owner applicability review are outstanding.',
  'Declared atomic support is checked for consistency; population membership and source scientific methods are not independently measured.',
  'A scenario cannot establish delivered actions or achieved damage reduction; World Model publication and acceptance remain separate.',
];
/** Exported only to verify the representation guard; checker uses independent arithmetic. */
export function assertReductionIntegerBound(value: bigint): bigint {
  try {
    return assertExactIntegerBound(value);
  } catch {
    throw new ReductionInputError('gap', 'exact_intermediate_overflow');
  }
}

export function assessReduction(
  selection: ReductionInputSelection,
  artifacts: readonly Artifact[],
  selectionRef: ArtifactRef,
): ReductionAssessment {
  const result: ReductionAssessment = {
    schema_version: 'haze.reduction.assessment.v1',
    selection_ref: selectionRef,
    method_id: REDUCTION_METHOD_ID,
    method_version: '1',
    status: 'gap',
    reasons: [],
    origin: 'unknown',
    baseline_damage: null,
    intervention_damage: null,
    absolute_reduction: null,
    relative_reduction: null,
    target_met: null,
    scientific_qualification: 'unqualified',
    limitations: [...REDUCTION_LIMITATIONS],
  };
  try {
    const normalized = normalizeReductionSelection(selection, artifacts);
    result.origin = normalized.origin;
    if (normalized.records.some((record) => record.quantity === null)) {
      result.reasons = ['unknown_residual_quantity'];
      return reductionAssessmentSchema.parse(result);
    }
    const totals = { baseline: 0n, intervention: 0n };
    for (const record of normalized.records) {
      totals[record.role] = assertReductionIntegerBound(
        totals[record.role] + parseExactDecimal(record.quantity!),
      );
    }
    const comparison = compareExactResiduals(
      totals.baseline,
      totals.intervention,
      selection.target.target_fraction,
      selection.target.relation,
    );
    result.baseline_damage = comparison.baseline_damage;
    result.intervention_damage = comparison.intervention_damage;
    result.absolute_reduction = comparison.absolute_reduction;
    if (comparison.reason) result.reasons = [comparison.reason];
    else if (
      normalized.records.some((record) => record.quantity!.startsWith('-'))
    )
      result.reasons = ['nonnegative_residuals_required'];
    else {
      result.relative_reduction = comparison.relative_reduction;
      result.target_met = comparison.target_met;
      result.status = 'supported';
    }
  } catch (error) {
    result.status = error instanceof ReductionInputError ? error.status : 'gap';
    result.reasons = [
      error instanceof ReductionInputError
        ? error.message
        : error instanceof Error &&
            error.message === 'exact_intermediate_overflow'
          ? error.message
          : 'invalid_or_unbounded_input',
    ];
  }
  return reductionAssessmentSchema.parse(result);
}
