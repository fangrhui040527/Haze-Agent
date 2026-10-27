import { z } from 'zod';
import { identifierSchema } from './common.js';
import { artifactRefSchema } from './artifacts.js';
import {
  reductionAssessmentSchema,
  reductionInputSelectionSchema,
  reductionReviewSchema,
  reductionTargetSchema,
} from './damage-reduction.js';

/** A finite supplied scenario set, never a sampling distribution. */
export const reductionSensitivityRequestSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.sensitivity-request.v1'),
  target: reductionTargetSchema,
  assumptions: z.string().min(1).max(4096),
  pairs: z
    .array(
      z.strictObject({
        id: identifierSchema,
        label: z.string().min(1).max(256),
        sources: reductionInputSelectionSchema.shape.sources,
      }),
    )
    .min(2)
    .max(16)
    .refine(
      (pairs) => new Set(pairs.map(({ id }) => id)).size === pairs.length,
      'Pair IDs must be unique.',
    ),
});

export const reductionSensitivityReportSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.sensitivity-report.v1'),
  method_id: z.literal('reduction.supplied-pair-sensitivity.v1'),
  request: reductionSensitivityRequestSchema,
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  origin: z.enum(['synthetic', 'supplied', 'unknown']),
  conclusion: z.enum([
    'all_supplied_pairs_meet',
    'some_supplied_pairs_meet',
    'no_supplied_pairs_meet',
    'incomplete',
  ]),
  pairs: z
    .array(
      z.strictObject({
        id: identifierSchema,
        selection_ref: artifactRefSchema,
        selection: reductionInputSelectionSchema,
        assessment_ref: artifactRefSchema,
        assessment: reductionAssessmentSchema,
        review: reductionReviewSchema,
        comparison_compatible: z.boolean(),
        reasons: z.array(z.string().min(1).max(4096)).max(64),
      }),
    )
    .min(2)
    .max(16),
  probability_of_target: z.null(),
  scientific_qualification: z.literal('unqualified'),
  claim_eligibility: z.literal('none'),
  achieved_reduction: z.literal(false),
  limitations: z.array(z.string().min(1).max(4096)).max(16),
});

export type ReductionSensitivityRequest = z.infer<
  typeof reductionSensitivityRequestSchema
>;
export type ReductionSensitivityReport = z.infer<
  typeof reductionSensitivityReportSchema
>;
