import { z } from 'zod';
import { identifierSchema, timestampSchema } from '../../contracts/common.js';
import { artifactRefSchema } from '../../contracts/artifacts.js';

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const boundedText = z.string().min(1).max(4096);

export const damageAccountTypeSchema = z.enum([
  'physical_outcomes',
  'financial_incidence',
  'social_welfare',
  'source_fire_extension',
]);

export const damageAccountScopeSchema = z
  .strictObject({
    account_id: identifierSchema,
    account_type: damageAccountTypeSchema,
    episode_id: identifierSchema,
    geography: z.strictObject({
      id: identifierSchema,
      label: boundedText,
      level: z.enum([
        'locality',
        'district',
        'state',
        'country',
        'regional',
        'global',
      ]),
    }),
    period: z.strictObject({
      start: timestampSchema,
      end: timestampSchema,
    }),
    counterfactual_id: identifierSchema,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    price_year: z.number().int().min(1900).max(2200).optional(),
    valuation_date: timestampSchema.optional(),
  })
  .superRefine((scope, context) => {
    if (Date.parse(scope.period.end) <= Date.parse(scope.period.start))
      context.addIssue({
        code: 'custom',
        path: ['period'],
        message: 'Account periods must have a positive end-exclusive interval.',
      });
    if (
      ['financial_incidence', 'social_welfare'].includes(scope.account_type) &&
      (!scope.currency || !scope.price_year)
    )
      context.addIssue({
        code: 'custom',
        path: ['currency'],
        message:
          'Financial and welfare accounts require a declared currency and price year.',
      });
  });

export const damageComponentRefSchema = z.strictObject({
  component_id: identifierSchema,
  revision,
  artifact: artifactRefSchema,
});

export const damageComponentCategorySchema = z.enum([
  'physical_outcome',
  'financial_entry',
  'welfare_valuation',
  'source_fire_extension',
]);

export const damageAccountManifestSchema = z.strictObject({
  schema_version: z.literal('haze.damage.account-manifest.v1'),
  scope: damageAccountScopeSchema,
  revision,
  required_component_ids: z.array(identifierSchema).min(1).max(64),
  components: z.array(damageComponentRefSchema).max(64),
});

export const damageAccountComponentSchema = z.strictObject({
  schema_version: z.literal('haze.damage.component.v1'),
  account_id: identifierSchema,
  component_id: identifierSchema,
  revision,
  scope_sha256: digest,
  category: damageComponentCategorySchema,
  measure: z.strictObject({
    value: z.number(),
    unit: identifierSchema,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
  }),
  evidence: z.array(artifactRefSchema).max(64),
  overlap_group: identifierSchema.optional(),
  included_in_total: z.boolean(),
  limitations: z.array(z.string().max(4096)).max(32),
});

export const damageReviewTypeSchema = z.enum([
  'arithmetic',
  'scientific_applicability',
]);

export const damageAccountReviewSchema = z.strictObject({
  schema_version: z.literal('haze.damage.component-review.v1'),
  account_id: identifierSchema,
  component: damageComponentRefSchema,
  review_type: damageReviewTypeSchema,
  status: z.enum(['supported', 'rejected']),
  checked_artifacts: z.array(artifactRefSchema).min(1).max(64),
  limitations: z.array(z.string().max(4096)).max(32),
});

export const damageAccountLineageSchema = z
  .strictObject({
    schema_version: z.literal('haze.damage.account-lineage.v1'),
    account_id: identifierSchema,
    from_revision: revision,
    to_revision: revision,
    from_manifest: artifactRefSchema,
    to_manifest: artifactRefSchema,
    reason: boundedText,
    recorded_at: timestampSchema,
  })
  .superRefine((lineage, context) => {
    if (lineage.to_revision <= lineage.from_revision)
      context.addIssue({
        code: 'custom',
        path: ['to_revision'],
        message: 'Account lineage must advance to a later revision.',
      });
  });

export type DamageAccountScope = z.infer<typeof damageAccountScopeSchema>;
export type DamageComponentRef = z.infer<typeof damageComponentRefSchema>;
export type DamageAccountManifest = z.infer<typeof damageAccountManifestSchema>;
export type DamageAccountComponent = z.infer<
  typeof damageAccountComponentSchema
>;
export type DamageAccountReview = z.infer<typeof damageAccountReviewSchema>;
export type DamageReviewType = z.infer<typeof damageReviewTypeSchema>;
export type DamageAccountLineage = z.infer<typeof damageAccountLineageSchema>;
