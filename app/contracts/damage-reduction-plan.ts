import { z } from 'zod';
import { artifactRefSchema, type Artifact } from './artifacts.js';
import { identifierSchema } from './common.js';
import {
  reductionDecimalSchema,
  reductionInputSelectionSchema,
  reductionScopeSchema,
  reductionTargetSchema,
} from './damage-reduction.js';

const text = z.string().trim().min(1).max(4096);
const refs = z.array(artifactRefSchema).max(16);
export const reductionApprovalSchema = z.strictObject({
  status: z.enum(['proposed', 'approved']),
  approver: text.nullable(),
  approved_at: z.iso.datetime({ offset: true }).nullable(),
  evidence: refs,
});
export const reductionCandidateSchema = z.strictObject({
  id: identifierSchema,
  version: identifierSchema,
  name: text,
  kind: z.enum(['exposure_alert', 'work_schedule']),
  description: text,
  rule_owner: text.nullable(),
  trigger_rule: text.nullable(),
  action_rule: text.nullable(),
  approval: reductionApprovalSchema,
  constraints: z
    .array(
      z.strictObject({
        id: identifierSchema,
        description: text,
        hard: z.boolean(),
        status: z.enum(['satisfied', 'violated', 'unknown']),
        evidence: refs,
      }),
    )
    .max(16)
    .default([]),
  costs: z
    .array(
      z.strictObject({
        id: identifierSchema,
        description: text,
        amount: reductionDecimalSchema.nullable(),
        unit: text,
        evidence: refs,
        prerequisite: text.nullable(),
      }),
    )
    .max(16)
    .default([]),
  dependencies: z
    .array(
      z.strictObject({
        id: identifierSchema,
        description: text,
        status: z.enum(['available', 'unavailable', 'unknown']),
        evidence: refs,
      }),
    )
    .max(16)
    .default([]),
  claims: z
    .array(
      z.strictObject({
        id: identifierSchema,
        kind: z.enum([
          'mechanism',
          'product_specification',
          'effect_estimate',
          'delivery',
          'achieved_reduction',
        ]),
        statement: text,
        evidence: refs,
      }),
    )
    .max(16)
    .default([]),
});
export const reductionPreviewRequestSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.preview-request.v1'),
  selection: reductionInputSelectionSchema,
  candidate: reductionCandidateSchema,
});
export const conditionalPlanPrerequisiteSchema = z.strictObject({
  id: identifierSchema,
  description: text,
  reason: z.enum([
    'scientific_applicability',
    'missing_rule',
    'human_approval',
    'constraint',
    'cost',
    'dependency',
    'scenario_evidence',
    'source_access',
  ]),
  evidence: refs,
});
export const conditionalPlanObjectionSchema = z.strictObject({
  id: identifierSchema,
  severity: z.enum(['blocking', 'material', 'advisory']),
  description: text,
  evidence: refs,
});
export const conditionalPlanRecommendationSchema = z.strictObject({
  id: identifierSchema,
  action: z.enum([
    'define_rules',
    'obtain_approval',
    'resolve_constraint',
    'obtain_cost',
    'confirm_dependency',
    'qualify_applicability',
    'review_scenario',
    'consider_conditional_option',
  ]),
  description: text,
  evidence: refs,
  prerequisite_ids: z.array(identifierSchema).max(96),
});
export const conditionalReductionPlanSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.conditional-plan.v1'),
  method_id: z.literal('reduction.conditional-plan.v1'),
  method_version: z.literal('1'),
  target: reductionTargetSchema,
  selection_ref: artifactRefSchema,
  assessment_ref: artifactRefSchema,
  arithmetic_review_ref: artifactRefSchema,
  candidate: reductionCandidateSchema,
  candidate_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source_refs: z.array(artifactRefSchema).max(64),
  state: z.enum(['conditional', 'blocked', 'evidence_gap']),
  assessment_status: z.enum(['supported', 'incompatible', 'gap']),
  point_estimate_label: z.enum(['meets', 'does_not_meet', 'unavailable']),
  origin: z.enum(['synthetic', 'supplied', 'unknown']),
  scientific_qualification: z.literal('unqualified'),
  delivery_status: z.literal('not_delivered'),
  achieved_reduction: z.literal(false),
  affected_scope: reductionScopeSchema,
  rules: z.strictObject({
    owner: text.nullable(),
    trigger: text.nullable(),
    action: text.nullable(),
    approval: reductionApprovalSchema,
  }),
  recommendations: z.array(conditionalPlanRecommendationSchema).max(64),
  prerequisites: z.array(conditionalPlanPrerequisiteSchema).max(96),
  objections: z.array(conditionalPlanObjectionSchema).max(96),
  limitations: z.array(text).max(32),
});
export const conditionalPlanReviewSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.plan-review.v1'),
  verdict: z.enum(['supported', 'rejected', 'needs_review']),
  reviewed_artifacts: z.array(artifactRefSchema).max(72),
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
  findings: z.array(text).max(96),
  limitations: z.array(text).max(32),
  planning_state: z.enum(['conditional', 'blocked', 'evidence_gap']),
  scientific_qualification: z.literal('unqualified'),
  delivery_status: z.literal('not_delivered'),
  achieved_reduction: z.literal(false),
});
export type ReductionCandidate = z.infer<typeof reductionCandidateSchema>;
export type ReductionPreviewRequest = z.infer<
  typeof reductionPreviewRequestSchema
>;
export type ConditionalReductionPlan = z.infer<
  typeof conditionalReductionPlanSchema
>;
export type ConditionalPlanReview = z.infer<typeof conditionalPlanReviewSchema>;
export interface ConditionalPlanInput {
  request: ReductionPreviewRequest;
  selection: Artifact;
  assessment: Artifact;
  arithmeticReview: Artifact;
  sources: readonly Artifact[];
}
