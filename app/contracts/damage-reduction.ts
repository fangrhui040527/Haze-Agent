import { z } from 'zod';
import { artifactRefSchema } from './artifacts.js';
import { identifierSchema } from './common.js';

export const REDUCTION_METHOD_ID = 'reduction.imported-residual-comparison.v1';
const text = z.string().min(1).max(4096);
const date = z.iso.date();

/** Browser-safe source token contract; precision is representation, not certainty. */
export const reductionDecimalSchema = z
  .string()
  .max(33)
  .regex(/^(?:0|-?(?:[1-9]\d*|0\.\d*[1-9]|[1-9]\d*\.\d*[1-9]))$/)
  .refine((value) => {
    const unsigned = value.replace(/^-/, '');
    const digits = unsigned.replace('.', '').replace(/^0+/, '');
    return digits.length <= 18 && (unsigned.split('.')[1]?.length ?? 0) <= 12;
  }, 'Decimal exceeds 18 significant digits or 12 fractional places.');
const exactResult = z
  .string()
  .max(142)
  .regex(/^(?:0|-?(?:[1-9]\d*|0\.\d*[1-9]|[1-9]\d*\.\d*[1-9]))$/);

export const reductionScopeSchema = z.strictObject({
  endpoint: text,
  unit: text,
  population: text,
  geography: text,
  pollutant: text,
  period: z
    .strictObject({ start: date, end: date })
    .refine((period) => period.start <= period.end, 'Period must be ordered.'),
  coverage: text,
  missingness: text,
  exclusions: z.array(text).max(64),
});
export const reductionTargetSchema = z
  .strictObject({
    scope: reductionScopeSchema,
    target_fraction: reductionDecimalSchema.refine(
      (value) =>
        !value.startsWith('-') &&
        value !== '0' &&
        (value === '1' || value.startsWith('0.')),
      'Target fraction must be greater than zero and at most one.',
    ),
    relation: z.enum(['at_least', 'greater_than']),
    comparator: text,
    intervention: text,
    assessment_rule: z.literal('point_estimate'),
  })
  .refine(
    (target) => target.comparator.trim() !== target.intervention.trim(),
    'Comparator and intervention must identify distinct scenarios.',
  );
export const physicalResidualRecordSchema = z.strictObject({
  row_id: identifierSchema,
  role: z.enum(['baseline', 'intervention']),
  scenario: text,
  evidence_basis: z.enum(['prospective', 'retrospective']),
  scope: reductionScopeSchema,
  stratum_id: identifierSchema,
  support_ids: z.array(identifierSchema).min(1).max(1000),
  quantity: reductionDecimalSchema.nullable(),
  original_method: z.strictObject({
    id: identifierSchema,
    version: identifierSchema,
  }),
  applicability: text,
});
export const physicalResidualImportSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.physical-import.v1'),
  origin: z.enum(['synthetic', 'supplied']),
  records: z.array(physicalResidualRecordSchema).min(1).max(1000),
});
export const reductionInputSelectionSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.input-selection.v1'),
  target: reductionTargetSchema,
  scope_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  method_id: z.literal(REDUCTION_METHOD_ID),
  method_version: z.literal('1'),
  sources: z
    .array(
      z.strictObject({
        artifact: artifactRefSchema,
        row_ids: z.array(identifierSchema).min(1).max(1000),
      }),
    )
    .min(1)
    .max(16),
});
/** The complete operator selection may be pinned as an original instead of repeated in model context. */
export const reductionSelectionRequestSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.selection-request.v1'),
  selection_ref: artifactRefSchema,
});
export const reductionSelectionResolutionSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.selection-resolution.v1'),
  selection: reductionInputSelectionSchema,
  operator_selection_ref: artifactRefSchema,
});
export const reductionAssessmentSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.assessment.v1'),
  selection_ref: artifactRefSchema,
  method_id: z.literal(REDUCTION_METHOD_ID),
  method_version: z.literal('1'),
  status: z.enum(['supported', 'incompatible', 'gap']),
  reasons: z.array(text).max(64),
  origin: z.enum(['synthetic', 'supplied', 'unknown']),
  baseline_damage: exactResult.nullable(),
  intervention_damage: exactResult.nullable(),
  absolute_reduction: exactResult.nullable(),
  relative_reduction: z
    .strictObject({ numerator: exactResult, denominator: exactResult })
    .nullable(),
  target_met: z.boolean().nullable(),
  scientific_qualification: z.literal('unqualified'),
  limitations: z.array(text).max(64),
});
export const reductionReviewSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.review.v1'),
  verdict: z.enum(['supported', 'rejected', 'needs_review']),
  reviewed_artifacts: z.array(artifactRefSchema).max(32),
  reviewer: z.strictObject({
    assignment_id: z.uuid(),
    revision: z.number().int().positive(),
  }),
  checks: z
    .array(
      z.strictObject({
        code: identifierSchema,
        passed: z.boolean(),
        detail: text,
      }),
    )
    .max(64),
  findings: z.array(text).max(64),
  limitations: z.array(text).max(64),
  claim_eligibility: z.enum([
    'arithmetic_checked_scenario',
    'imported_estimate',
    'none',
  ]),
  scientific_qualification: z.literal('unqualified'),
  achieved_reduction: z.literal(false),
});
export type ReductionScope = z.infer<typeof reductionScopeSchema>;
export type ReductionTarget = z.infer<typeof reductionTargetSchema>;
export type PhysicalResidualRecord = z.infer<
  typeof physicalResidualRecordSchema
>;
export type PhysicalResidualImport = z.infer<
  typeof physicalResidualImportSchema
>;
export type ReductionInputSelection = z.infer<
  typeof reductionInputSelectionSchema
>;
export type ReductionAssessment = z.infer<typeof reductionAssessmentSchema>;
export type ReductionReview = z.infer<typeof reductionReviewSchema>;

/** Current claims must be derived at read time; a saved review is historical. */
export const reductionClaimQuerySchema = z.strictObject({
  selection_ref: artifactRefSchema,
  assessment_ref: artifactRefSchema,
  review_ref: artifactRefSchema,
});
export const reductionClaimEligibilitySchema = z.strictObject({
  schema_version: z.literal('haze.reduction.claim-eligibility.v1'),
  ...reductionClaimQuerySchema.shape,
  claim_eligibility: z.enum([
    'none',
    'imported_estimate',
    'arithmetic_checked_scenario',
  ]),
  point_estimate_label: z.enum(['meets', 'does_not_meet', 'unavailable']),
  origin: z.enum(['synthetic', 'supplied', 'unknown']),
  scientific_qualification: z.literal('unqualified'),
  achieved_reduction: z.literal(false),
  reasons: z.array(text).max(64),
  checked_at: z.iso.datetime(),
});
export type ReductionClaimQuery = z.infer<typeof reductionClaimQuerySchema>;
export type ReductionClaimEligibility = z.infer<
  typeof reductionClaimEligibilitySchema
>;

export * from './damage-reduction-pilot.js';
export * from './damage-reduction-evaluation.js';
