import { z } from 'zod';
import { artifactRefSchema } from './artifacts.js';
import {
  reductionAssessmentSchema,
  reductionClaimEligibilitySchema,
  reductionInputSelectionSchema,
  reductionReviewSchema,
} from './damage-reduction.js';
import {
  conditionalPlanReviewSchema,
  conditionalReductionPlanSchema,
} from './damage-reduction-plan.js';

/** Governed read projection; saved review flags alone never grant current claims. */
export const reductionPreviewViewSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.preview-view.v1'),
  task_id: z.uuid(),
  run_id: z.uuid(),
  objective_revision: z.number().int().positive(),
  state: z.enum(['pending', 'current', 'stale', 'unavailable']),
  selection: z
    .strictObject({
      artifact: artifactRefSchema,
      value: reductionInputSelectionSchema,
    })
    .nullable(),
  assessment: z
    .strictObject({
      artifact: artifactRefSchema,
      value: reductionAssessmentSchema,
    })
    .nullable(),
  arithmetic_review: z
    .strictObject({ artifact: artifactRefSchema, value: reductionReviewSchema })
    .nullable(),
  plan: z
    .strictObject({
      artifact: artifactRefSchema,
      value: conditionalReductionPlanSchema,
    })
    .nullable(),
  plan_review: z
    .strictObject({
      artifact: artifactRefSchema,
      value: conditionalPlanReviewSchema,
    })
    .nullable(),
  claims: reductionClaimEligibilitySchema.nullable(),
  plan_eligibility: z.enum(['conditional', 'blocked', 'none']),
  source_refs: z.array(artifactRefSchema).max(64),
  reasons: z.array(z.string().min(1).max(4096)).max(96),
});
export type ReductionPreviewView = z.infer<typeof reductionPreviewViewSchema>;
