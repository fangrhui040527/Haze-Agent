import { z } from 'zod';
import { artifactRefSchema } from './artifacts.js';
import { identifierSchema } from './common.js';

/** Browser-safe contracts. Imported quantities are assertions, not scientific validation. */
const text = z.string().min(1).max(4096);
const id = identifierSchema;
const refs = z.array(artifactRefSchema).max(256);
const amount = z.number().finite().nonnegative();
export const damagePeriodSchema = z
  .strictObject({
    start: z.iso.date(),
    end: z.iso.date(),
  })
  .refine((p) => p.start <= p.end, 'Period end precedes start.');
export const damageOriginSchema = z.enum([
  'imported',
  'measured',
  'modeled',
  'synthetic',
]);
export const damageMissingnessSchema = z.enum([
  'available',
  'unavailable',
  'not_applicable',
  'not_estimated',
  'disclosure_suppressed',
  'true_zero',
]);
export const damageScopeSchema = z.strictObject({
  schema_version: z.literal('haze.damage.scope.v1'),
  account_id: id,
  event_id: id,
  intended_use: text,
  source_scope: text,
  smoke_boundary: text,
  source_fire_boundary: text,
  countries: z.array(text).min(1).max(256),
  social_boundary_members: z.array(id).min(1).max(256),
  population: text,
  emissions_period: damagePeriodSchema,
  effect_period: damagePeriodSchema,
  valuation_date: z.iso.date(),
  currency: id,
  price_year: z.number().int().min(1900).max(2200),
  endpoints: z.array(id).min(1).max(256),
  historical_scenario_id: id,
  baseline_scenario_id: id,
  approved_method_ids: z.array(id).min(1).max(32),
  presentation_decimal_places: z.number().int().min(0).max(8).default(3),
});
export const damageEffectSchema = z
  .strictObject({
    effect_id: id,
    endpoint_id: id,
    scenario_id: id,
    baseline_id: id,
    geography: text,
    period: damagePeriodSchema,
    population_stratum: text,
    quantity: amount.nullable(),
    unit: id,
    status: damageMissingnessSchema,
    origin: damageOriginSchema,
    causal_method: text,
    applicability: text,
    uncertainty: z.strictObject({
      interpretation: z.enum([
        'not_quantified',
        'sensitivity_range',
        'confidence_interval',
        'credible_interval',
      ]),
      basis: text,
      lower: amount.optional(),
      upper: amount.optional(),
    }),
    accounting_lens: z.enum(['physical_only', 'social_welfare']),
    overlap_group: id,
    included: z.boolean(),
    exclusion_reason: text.optional(),
    unit_value_id: id.optional(),
    source_refs: refs.default([]),
  })
  .superRefine((e, c) => {
    if (!e.included && !e.exclusion_reason)
      c.addIssue({
        code: 'custom',
        message: 'Excluded effects require an exclusion reason.',
      });
    if (['available', 'true_zero'].includes(e.status) !== (e.quantity !== null))
      c.addIssue({
        code: 'custom',
        message: 'Missingness and numeric quantity disagree.',
      });
    if (e.status === 'true_zero' && e.quantity !== 0)
      c.addIssue({
        code: 'custom',
        message: 'True zero must be numeric zero.',
      });
    if (e.quantity === 0 && e.status === 'available')
      c.addIssue({
        code: 'custom',
        message: 'Zero must be explicitly marked true_zero.',
      });
    const { lower, upper, interpretation } = e.uncertainty;
    if (
      (lower === undefined) !== (upper === undefined) ||
      (interpretation === 'not_quantified' && lower !== undefined) ||
      (interpretation !== 'not_quantified' && lower === undefined) ||
      (lower !== undefined &&
        upper !== undefined &&
        (lower > upper ||
          (e.quantity !== null && (e.quantity < lower || e.quantity > upper))))
    )
      c.addIssue({
        code: 'custom',
        message:
          'Uncertainty bounds require a declared interpretation and must contain the central quantity.',
      });
  });
export const damageUnitValueSchema = z.strictObject({
  unit_value_id: id,
  method_id: id,
  method_version: z.literal('1'),
  compatible_unit: id,
  amount,
  currency: id,
  price_year: z.number().int(),
  valuation_date: z.iso.date(),
  horizon: damagePeriodSchema,
  transfer_assumptions: text,
  discount_assumptions: text,
  included_components: z.array(id).min(1).max(128),
  applicability: text,
  source_refs: refs.default([]),
});
export const damageIncidenceEntrySchema = z.strictObject({
  entry_id: id,
  effect_id: id,
  transaction_id: id,
  payer: id,
  recipient: id,
  payer_in_boundary: z.boolean(),
  recipient_in_boundary: z.boolean(),
  amount,
  currency: id,
  price_year: z.number().int(),
  financing_type: z.enum(['resource_financing', 'transfer']),
  source_refs: refs.default([]),
});
export const damageCoverageEntrySchema = z.strictObject({
  endpoint_id: id,
  geography: text,
  population_stratum: text,
  status: damageMissingnessSchema,
  origin: damageOriginSchema,
  monetary_inclusion: z.boolean(),
  reason: text,
});
export const damageScenarioSchema = z
  .strictObject({
    scenario_id: id,
    kind: z.enum(['historical', 'source_removal', 'project']),
    comparator_id: id,
    description: text,
    effectiveness: text,
    adoption: text,
    maintenance: text,
    durability: text,
    displacement: text,
    costs_and_adverse_effects: text,
    project_cost: z
      .strictObject({ amount, currency: id, price_year: z.number().int() })
      .optional(),
  })
  .superRefine((s, c) => {
    if (s.kind === 'project' && !s.project_cost)
      c.addIssue({
        code: 'custom',
        message:
          'Project appraisal requires a declared compatible project cost.',
      });
    if (s.kind !== 'project' && s.project_cost)
      c.addIssue({
        code: 'custom',
        message:
          'Source-removal and historical scenarios do not establish project costs or returns.',
      });
  });
export const damageSourceFireCategorySchema = z.strictObject({
  category: id,
  status: z.enum(['not_estimated', 'not_applicable', 'unavailable']),
  reason: text,
});
export const damageImportSchema = z.strictObject({
  schema_version: z.literal('haze.damage.import.v1'),
  scope: damageScopeSchema.optional(),
  effects: z.array(damageEffectSchema).max(10000).default([]),
  unit_values: z.array(damageUnitValueSchema).max(1000).default([]),
  incidence: z.array(damageIncidenceEntrySchema).max(10000).default([]),
  coverage: z.array(damageCoverageEntrySchema).max(10000).default([]),
  scenarios: z.array(damageScenarioSchema).max(128).default([]),
  source_fire_categories: z
    .array(damageSourceFireCategorySchema)
    .max(128)
    .default([]),
});
export const damageInputManifestEntrySchema = z.strictObject({
  artifact: artifactRefSchema,
  table_type: z.enum([
    'scope',
    'effects',
    'unit_values',
    'incidence',
    'coverage',
    'scenarios',
    'source_fire_categories',
  ]),
  selected_rows: z.array(z.number().int().nonnegative()).max(10000),
  access_classification: z.literal('task-authorized'),
  method_version: z.literal('1'),
  native_support: text,
});
export const damageInputsSchema = damageImportSchema.extend({
  schema_version: z.literal('haze.damage.inputs.v1'),
  scope: damageScopeSchema,
  source_refs: refs,
  manifest: z.array(damageInputManifestEntrySchema).max(256),
  limitations: z.array(text).max(256),
});
export const damagePhysicalSchema = z.strictObject({
  schema_version: z.literal('haze.damage.physical.v1'),
  account_id: id,
  effects: z.array(damageEffectSchema).max(10000),
  totals: z
    .array(
      z.strictObject({
        scenario_id: id,
        endpoint_id: id,
        unit: id,
        quantity: amount,
      }),
    )
    .max(10000),
});
export const damageWelfareLineSchema = z.strictObject({
  effect_id: id,
  scenario_id: id,
  unit_value_id: id,
  quantity: amount,
  quantity_unit: id,
  unit_value: amount,
  amount,
});
export const damageMoneyTotalSchema = z.strictObject({
  scenario_id: id,
  amount: z.number().finite(),
  currency: id,
  price_year: z.number().int(),
});
export const damageWelfareSchema = z.strictObject({
  schema_version: z.literal('haze.damage.welfare.v1'),
  account_id: id,
  accounting_lens: z.literal('selected_social_welfare'),
  lines: z.array(damageWelfareLineSchema).max(10000),
  totals: z.array(damageMoneyTotalSchema).max(128),
  excluded_effect_ids: z.array(id).max(10000),
});
export const damageIncidenceSchema = z.strictObject({
  schema_version: z.literal('haze.damage.incidence.v1'),
  account_id: id,
  accounting_lens: z.literal('financial_incidence'),
  entries: z.array(damageIncidenceEntrySchema).max(10000),
  financing_totals: z.array(damageMoneyTotalSchema).max(128),
  net_boundary_transfers: z.array(damageMoneyTotalSchema).max(128),
});
export const damageOmissionSchema = z.strictObject({
  effect_id: id,
  endpoint_id: id,
  scenario_id: id,
  geography: text,
  population_stratum: text,
  unit: id,
  status: z.enum([
    'unavailable',
    'not_applicable',
    'not_estimated',
    'disclosure_suppressed',
  ]),
  origin: damageOriginSchema,
  reason: text,
  uncertainty: damageEffectSchema.shape.uncertainty,
  source_refs: refs,
});
export const damageCoverageSchema = z.strictObject({
  schema_version: z.literal('haze.damage.coverage.v1'),
  account_id: id,
  status: z.enum(['complete_for_declared_imported_scope', 'partial', 'gap']),
  entries: z.array(damageCoverageEntrySchema).max(10000),
  omissions: z.array(damageOmissionSchema).max(10000).default([]),
  limitations: z.array(text).max(256),
});
export const damageOverlapSchema = z.strictObject({
  schema_version: z.literal('haze.damage.overlap.v1'),
  account_id: id,
  decisions: z
    .array(
      z.strictObject({
        effect_id: id,
        overlap_group: id,
        included: z.boolean(),
        reason: text,
      }),
    )
    .max(10000),
});
export const damageSourceFireExtensionSchema = z.strictObject({
  schema_version: z.literal('haze.damage.source-fire-extension.v1'),
  account_id: id,
  categories: z.array(damageSourceFireCategorySchema).max(128),
});
export const damageMethodsSchema = z.strictObject({
  schema_version: z.literal('haze.damage.methods.v1'),
  account_id: id,
  methods: z
    .array(
      z.strictObject({
        method_id: id,
        version: z.literal('1'),
        description: text,
      }),
    )
    .max(32),
  limitations: z.array(text).max(256),
});
export const damageScenariosSchema = z.strictObject({
  schema_version: z.literal('haze.damage.scenarios.v1'),
  account_id: id,
  scenarios: z.array(damageScenarioSchema).max(128),
  comparisons: z
    .array(
      z.strictObject({
        scenario_id: id,
        comparator_id: id,
        interpretation: z.enum([
          'achievable_project_benefit',
          'source_removal_difference',
        ]),
        status: z.enum(['available', 'withheld']),
        limitation: text.nullable(),
        avoided_damage: z.number().finite().nullable(),
        project_cost: amount.nullable(),
        net_benefit: z.number().finite().nullable(),
        benefit_cost_ratio: z.number().finite().nullable(),
        currency: id,
        price_year: z.number().int(),
        excludes_cash_return_claim: z.literal(true),
      }),
    )
    .max(128),
});
export const damageComponentKindSchema = z.enum([
  'damage.scope',
  'damage.inputs',
  'damage.coverage',
  'damage.physical',
  'damage.incidence',
  'damage.welfare',
  'damage.overlap',
  'damage.source-fire-extension',
  'damage.methods',
  'damage.scenarios',
]);
export const damageAccountSchema = z.strictObject({
  schema_version: z.literal('haze.damage.account.v1'),
  account_id: id,
  scope: damageScopeSchema,
  status: z.enum(['complete_for_declared_imported_scope', 'partial', 'gap']),
  evidence_origin: z.enum(['synthetic', 'imported']),
  component_refs: z
    .array(
      z.strictObject({
        kind: damageComponentKindSchema,
        artifact: artifactRefSchema,
      }),
    )
    .min(9)
    .max(10),
  source_refs: refs,
  physical_totals: damagePhysicalSchema.shape.totals,
  financing_totals: z.array(damageMoneyTotalSchema).max(128),
  welfare_totals: z.array(damageMoneyTotalSchema).max(128),
  coverage: z.array(damageCoverageEntrySchema).max(10000),
  omissions: z.array(damageOmissionSchema).max(10000).default([]),
  scenarios: damageScenariosSchema.shape.comparisons,
  limitations: z.array(text).max(256),
  review_status: z.literal('requires_independent_review'),
});
export const damageCheckSchema = z.strictObject({
  schema_version: z.literal('haze.damage.check.v1'),
  valid: z.boolean(),
  checks: z.array(text).max(256),
  findings: z.array(text).max(256),
  limitations: z.array(text).max(256),
  applicability: z.literal('not_established_by_arithmetic'),
});
export const damageReviewSchema = z.strictObject({
  schema_version: z.literal('haze.damage.review.v1'),
  verdict: z.enum(['supported', 'rejected', 'needs_review']),
  reviewed_artifacts: refs,
  checks: z.array(text).max(256),
  findings: z.array(text).max(256),
  limitations: z.array(text).max(256),
  applicability: z.literal('not_established_by_arithmetic'),
  reviewer: z.strictObject({
    assignment_id: z.uuid(),
    revision: z.number().int().positive(),
  }),
});
export const damageRevisionBridgeSchema = z.strictObject({
  schema_version: z.literal('haze.damage.revision-bridge.v1'),
  account_id: id,
  previous_account: artifactRefSchema,
  current_account: artifactRefSchema,
  source_refs: refs,
  currency: id,
  previous_price_year: z.number().int(),
  current_price_year: z.number().int(),
  comparison_basis: z.literal(
    'declared_accounting_bases_not_observed_haze_change',
  ),
  changes: z
    .array(
      z.strictObject({
        scenario_id: id,
        previous_total: z.number().finite(),
        current_total: z.number().finite(),
        total_change: z.number().finite(),
        quantities: z.number().finite(),
        coverage: z.number().finite(),
        methods: z.number().finite(),
        values: z.number().finite(),
        boundary_and_incidence: z.number().finite(),
      }),
    )
    .max(128),
  limitations: z.array(text).max(256),
  applicability: z.literal('not_established_by_arithmetic'),
});
export type DamageScope = z.infer<typeof damageScopeSchema>;
export type DamageImport = z.infer<typeof damageImportSchema>;
export type DamageInputs = z.infer<typeof damageInputsSchema>;
export type DamageEffect = z.infer<typeof damageEffectSchema>;
export type DamageAccount = z.infer<typeof damageAccountSchema>;
export type DamageCheck = z.infer<typeof damageCheckSchema>;
export type DamageRevisionBridge = z.infer<typeof damageRevisionBridgeSchema>;
export type DamageComponentKind = z.infer<typeof damageComponentKindSchema>;
export const damageComponentSchemas = {
  'damage.scope': damageScopeSchema,
  'damage.inputs': damageInputsSchema,
  'damage.coverage': damageCoverageSchema,
  'damage.physical': damagePhysicalSchema,
  'damage.incidence': damageIncidenceSchema,
  'damage.welfare': damageWelfareSchema,
  'damage.overlap': damageOverlapSchema,
  'damage.source-fire-extension': damageSourceFireExtensionSchema,
  'damage.methods': damageMethodsSchema,
  'damage.scenarios': damageScenariosSchema,
} as const;
export type DamageComponents = {
  'damage.scope': DamageScope;
  'damage.inputs': DamageInputs;
  'damage.coverage': z.infer<typeof damageCoverageSchema>;
  'damage.physical': z.infer<typeof damagePhysicalSchema>;
  'damage.incidence': z.infer<typeof damageIncidenceSchema>;
  'damage.welfare': z.infer<typeof damageWelfareSchema>;
  'damage.overlap': z.infer<typeof damageOverlapSchema>;
  'damage.source-fire-extension': z.infer<
    typeof damageSourceFireExtensionSchema
  >;
  'damage.methods': z.infer<typeof damageMethodsSchema>;
  'damage.scenarios': z.infer<typeof damageScenariosSchema>;
};
