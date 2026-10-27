import { z } from 'zod';
import { artifactRefSchema } from './artifacts.js';
import { identifierSchema, timestampSchema } from './common.js';

const text = z.string().min(1).max(4096);
const id = identifierSchema;
const period = z
  .strictObject({ start: z.iso.date(), end: z.iso.date() })
  .refine((p) => p.start <= p.end, 'Period ends before it starts.');
const refs = z.array(artifactRefSchema).max(128);
export const damageGeographySchema = z.strictObject({
  country_code: z.literal('MY'),
  level: z.enum(['country', 'state', 'district', 'grid', 'study_area']),
  code_system: text,
  code: text,
  boundary_version: text,
});
export const damageApplicabilitySchema = z.strictObject({
  geography: damageGeographySchema,
  occurrence_period: period,
  population: text,
  endpoint: id,
  unit: id,
  attribution_basis: z.enum([
    'selected_fire',
    'all_pm25',
    'published_haze',
    'unresolved',
  ]),
  exposure_duration: text,
  comparison_scenario: text,
});
export const damageReportingSchema = z.strictObject({
  schema_version: z.literal('haze.damage.reporting.v2'),
  reporting_type: z.enum([
    'historical_account',
    'hypothetical_intervention',
    'achieved_reduction',
  ]),
  applicability: damageApplicabilitySchema,
  assumptions: z.array(text).max(128),
  scientific_bindings: z
    .array(
      z.strictObject({
        method_output: artifactRefSchema,
        expert_review: artifactRefSchema,
      }),
    )
    .max(128),
});
export const damageMethodInvocationSchema = z.strictObject({
  schema_version: z.literal('haze.damage.method-invocation.v1'),
  method_id: z.literal('damage.published-physical-effect.v1'),
  method_version: z.literal('1'),
  applicability: damageApplicabilitySchema,
  inputs: refs.min(1),
  source_location: z.strictObject({
    artifact: artifactRefSchema,
    locator: text,
  }),
  parameters: z.strictObject({ effect_id: id }),
  uncertainty: z.strictObject({
    interpretation: z.enum([
      'not_quantified',
      'confidence_interval',
      'credible_interval',
      'sensitivity_range',
    ]),
    basis: text,
    lower: z.number().finite().nonnegative().optional(),
    upper: z.number().finite().nonnegative().optional(),
  }),
});
export const damageMethodOutputSchema = z.strictObject({
  schema_version: z.literal('haze.damage.method-output.v1'),
  invocation: damageMethodInvocationSchema,
  quantity: z.number().finite().nonnegative(),
  unit: id,
  qualification: z.literal('awaiting_scientific_review'),
});
export const damagePublishedEffectSchema = z.strictObject({
  schema_version: z.literal('haze.damage.published-effect.v1'),
  effect_id: id,
  quantity: z.number().finite().nonnegative(),
  applicability: damageApplicabilitySchema,
  source_refs: refs.min(1),
  source_locator: text,
});
/** An expert decision is imported separately; generated assignments cannot author it. */
export const damageScientificReviewSchema = z
  .strictObject({
    schema_version: z.literal('haze.damage.scientific-review.v1'),
    reviewed_output: artifactRefSchema,
    reviewed_inputs: refs.min(1),
    method_id: id,
    method_version: id,
    applicability: damageApplicabilitySchema,
    verdict: z.enum(['applicable', 'rejected', 'unresolved']),
    expert: z.strictObject({
      name: text,
      qualification: text,
      decision_basis: text,
    }),
    decided_at: timestampSchema,
    expires_at: timestampSchema,
    unresolved_questions: z.array(text).max(128),
    limitations: z.array(text).max(128),
  })
  .refine(
    (r) => r.decided_at < r.expires_at,
    'Review expiry precedes decision.',
  );
export const damageScientificCheckSchema = z.strictObject({
  schema_version: z.literal('haze.damage.scientific-check.v1'),
  method_output: artifactRefSchema,
  expert_review: artifactRefSchema,
  qualified: z.boolean(),
  reasons: z.array(text).max(128),
  checked_at: timestampSchema,
  applicability: damageApplicabilitySchema,
  reviewer: z
    .strictObject({
      assignment_id: z.uuid(),
      revision: z.number().int().positive(),
    })
    .optional(),
});
export const damageComparisonReviewSchema = z.strictObject({
  schema_version: z.literal('haze.damage.comparison-review.v1'),
  valid: z.boolean(),
  findings: z.array(text).max(128),
  reviewed_artifacts: refs.min(2),
  applicability: z.literal('arithmetic_only_scientific_review_is_separate'),
  reviewer: z.strictObject({
    assignment_id: z.uuid(),
    revision: z.number().int().positive(),
  }),
});
const parameter = z
  .strictObject({
    value: z.number().finite().nonnegative().nullable(),
    basis: z.enum(['evidence', 'assumption', 'unavailable']),
    explanation: text,
    evidence: refs,
  })
  .superRefine((p, c) => {
    if ((p.value === null) !== (p.basis === 'unavailable'))
      c.addIssue({
        code: 'custom',
        message: 'Unavailable parameters must remain null.',
      });
    if (p.basis === 'evidence' && !p.evidence.length)
      c.addIssue({
        code: 'custom',
        message: 'Evidence-backed parameters require exact evidence.',
      });
  });
export const damageComparisonBaselineSchema = z.strictObject({
  account: artifactRefSchema,
  applicability: damageApplicabilitySchema,
  valuation: z.strictObject({
    view: z.enum(['physical', 'financial_loss', 'social_welfare']),
    currency: id.nullable(),
    price_year: z.number().int().min(1900).max(2200).nullable(),
  }),
  quantity: z.number().finite().nonnegative().nullable(),
  scientific_check: artifactRefSchema,
  arithmetic_review: artifactRefSchema,
});
export const damageParameterEvidenceSchema = z.strictObject({
  schema_version: z.literal('haze.damage.parameter-evidence.v1'),
  parameter: z.enum([
    'adoption',
    'effectiveness',
    'cost',
    'avoided_monetary_damage',
  ]),
  value: z.number().finite().nonnegative(),
  unit: id,
  applicability: damageApplicabilitySchema,
  source_refs: refs.min(1),
  source_locator: text,
  price_year: z.number().int().optional(),
  horizon: period.optional(),
});
export const damageInterventionSchema = z
  .strictObject({
    id: z.enum(['A', 'B']),
    baseline: damageComparisonBaselineSchema,
    method_id: z.literal('damage.evidenced-residual.v1'),
    mechanism: text,
    implementation_scope: text,
    prerequisites: z.array(text).max(128),
    adoption: parameter,
    effectiveness: parameter,
    cost: parameter,
    cost_basis: z.strictObject({
      currency: id,
      price_year: z.number().int(),
      horizon: period,
    }),
    avoided_monetary_damage: parameter.optional(),
  })
  .superRefine((i, c) => {
    for (const key of ['adoption', 'effectiveness'] as const)
      if (i[key].value !== null && i[key].value > 1)
        c.addIssue({
          code: 'custom',
          path: [key],
          message: 'Fraction must lie within 0 to 1.',
        });
  });
export const damageComparisonRequestSchema = z.strictObject({
  schema_version: z.literal('haze.damage.comparison-request.v1'),
  baseline: damageComparisonBaselineSchema,
  interventions: z.tuple([damageInterventionSchema, damageInterventionSchema]),
});
const interventionResult = z.strictObject({
  id: z.enum(['A', 'B']),
  status: z.enum(['meets_target', 'below_target', 'insufficient_evidence']),
  baseline: artifactRefSchema,
  residual_damage: z.number().finite().nonnegative().nullable(),
  avoided_damage: z.number().finite().nonnegative().nullable(),
  reduction_percent: z.number().finite().nullable(),
  intervention_cost: z.number().finite().nonnegative().nullable(),
  cost_basis: z.strictObject({
    currency: id,
    price_year: z.number().int(),
    horizon: period,
  }),
  net_monetary_benefit: z.number().finite().nullable(),
  assumptions: z.array(text).max(128),
  evidence: refs,
  gaps: z.array(text).max(128),
});
export const damageComparisonSchema = z.strictObject({
  schema_version: z.literal('haze.damage.comparison.v1'),
  reporting_type: z.literal('hypothetical_intervention'),
  method_id: z.literal('damage.evidenced-residual.v1'),
  method_version: z.literal('1'),
  threshold_percent: z.literal(10),
  baseline: damageComparisonBaselineSchema,
  lower_budget_verified: z.boolean(),
  interventions: z.tuple([interventionResult, interventionResult]),
  gaps: z.array(text).max(128),
});
export type DamageApplicability = z.infer<typeof damageApplicabilitySchema>;
export type DamageMethodInvocation = z.infer<
  typeof damageMethodInvocationSchema
>;
export type DamageComparison = z.infer<typeof damageComparisonSchema>;
export type DamageComparisonRequest = z.infer<
  typeof damageComparisonRequestSchema
>;
