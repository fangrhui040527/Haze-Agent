import { randomUUID } from 'node:crypto';
import { boundedJsonSchema, type Artifact } from '../../contracts/artifacts.js';
import { contractHash } from '../../contracts/json.js';
import {
  damageImportSchema,
  type DamageImport,
} from '../../contracts/damage-account.js';

/** Frozen before arithmetic tests: invented report example, CU is not a real currency. */
export const SYNTHETIC_DAMAGE_EXPECTATIONS = Object.freeze({
  deaths: 9.7170167,
  historical_loss: 21_534_033.4,
  avoided_damage: 4_570_000,
  project_cost: 1_000_000,
  net_benefit: 3_570_000,
});
const period = { start: '2015-09-01', end: '2015-10-31' };
const rows = [
  ['mortality', 'expected_deaths', 9.7170167, 2_000_000, 2],
  ['treatment', 'treatment_cases', 2000, 200, 500],
  ['discomfort', 'discomfort_cases', 2000, 300, 500],
  ['production', 'production_units', 800_000, 1, 200_000],
  ['protection', 'protective_units', 200_000, 1, 100_000],
  ['transport', 'transport_units', 100_000, 1, 20_000],
] as const;
const fixture = damageImportSchema.parse({
  schema_version: 'haze.damage.import.v1',
  scope: {
    schema_version: 'haze.damage.scope.v1',
    account_id: 'synthetic-report-example',
    event_id: 'invented-episode',
    intended_use:
      'Synthetic software accounting verification only; not a regional damage estimate.',
    source_scope: 'Invented report source-fire boundary.',
    smoke_boundary: 'Imported invented smoke effects.',
    source_fire_boundary: 'Direct source-fire categories not estimated.',
    countries: ['Fixture Region'],
    social_boundary_members: [
      'households',
      'government',
      'insurers',
      'providers',
      'firms',
    ],
    population: 'Invented population',
    emissions_period: period,
    effect_period: period,
    valuation_date: '2015-12-31',
    currency: 'CU',
    price_year: 2015,
    endpoints: rows.map((r) => r[0]),
    historical_scenario_id: 'historical',
    baseline_scenario_id: 'no-target-fire',
    approved_method_ids: [
      'damage.imported-quantity.v1',
      'damage.declared-unit-value.v1',
      'damage.accounting.v1',
      'damage.project-scenario.v1',
    ],
    presentation_decimal_places: 3,
  },
  scenarios: ['historical', 'project'].map((scenario_id) => ({
    scenario_id,
    kind: scenario_id === 'historical' ? 'historical' : 'project',
    comparator_id:
      scenario_id === 'historical' ? 'no-target-fire' : 'historical',
    description:
      'Invented report verification scenario; imported residual physical quantities.',
    effectiveness:
      'Residual quantities are explicitly imported; no attribution or effectiveness model executed.',
    adoption: 'Invented complete adoption in test only.',
    maintenance: 'Included in explicitly declared invented project cost.',
    durability: 'One declared episode only.',
    displacement: 'Invented no displacement assumption.',
    costs_and_adverse_effects:
      'Invented CU1,000,000 project cost; adverse effects omitted in this synthetic example.',
    ...(scenario_id === 'project'
      ? {
          project_cost: { amount: 1_000_000, currency: 'CU', price_year: 2015 },
        }
      : {}),
  })),
  effects: rows.flatMap(([endpoint_id, unit, quantity, , avoided]) =>
    ['historical', 'project'].map((scenario_id) => ({
      effect_id: `${scenario_id}-${endpoint_id}`,
      endpoint_id,
      scenario_id,
      baseline_id: 'no-target-fire',
      geography: 'Fixture Region',
      period,
      population_stratum: 'Invented population',
      quantity: scenario_id === 'historical' ? quantity : quantity - avoided,
      unit,
      status: 'available',
      origin: 'synthetic',
      causal_method:
        'Invented imported report quantity; no exposure/health-response calculation.',
      applicability:
        'Synthetic test only. Not applicable to actual people, episodes or regional policy.',
      uncertainty: {
        interpretation: 'not_quantified',
        basis: 'Invented central test values; no statistical interval.',
      },
      accounting_lens: 'social_welfare',
      overlap_group: endpoint_id,
      included: true,
      unit_value_id: `value-${endpoint_id}`,
      source_refs: [],
    })),
  ),
  unit_values: rows.map(([endpoint_id, compatible_unit, , amount]) => ({
    unit_value_id: `value-${endpoint_id}`,
    method_id: 'damage.declared-unit-value.v1',
    method_version: '1',
    compatible_unit,
    amount,
    currency: 'CU',
    price_year: 2015,
    valuation_date: '2015-12-31',
    horizon: period,
    transfer_assumptions:
      'Invented CU values; no income or geographic transfer.',
    discount_assumptions: 'Single episode, no discount adjustment.',
    included_components: [endpoint_id],
    applicability: 'Synthetic verification only.',
    source_refs: [],
  })),
  coverage: rows.map(([endpoint_id]) => ({
    endpoint_id,
    geography: 'Fixture Region',
    population_stratum: 'Invented population',
    status: 'available',
    origin: 'synthetic',
    monetary_inclusion: true,
    reason: 'Invented central quantity supplied by synthetic fixture.',
  })),
  incidence: [
    ...[
      ['households', 100_000],
      ['government', 200_000],
      ['insurers', 100_000],
    ].map(([payer, amount], i) => ({
      entry_id: `finance-${i}`,
      effect_id: 'historical-treatment',
      transaction_id: `payment-${i}`,
      payer,
      recipient: 'providers',
      payer_in_boundary: true,
      recipient_in_boundary: true,
      amount,
      currency: 'CU',
      price_year: 2015,
      financing_type: 'resource_financing',
      source_refs: [],
    })),
    {
      entry_id: 'internal-fine',
      effect_id: 'historical-treatment',
      transaction_id: 'fine-transaction',
      payer: 'firms',
      recipient: 'government',
      payer_in_boundary: true,
      recipient_in_boundary: true,
      amount: 300_000,
      currency: 'CU',
      price_year: 2015,
      financing_type: 'transfer',
      source_refs: [],
    },
  ],
});

function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
}
freeze(fixture);
export function createSyntheticDamageImport(): DamageImport {
  return structuredClone(fixture);
}
export function createSyntheticDamageArtifact(): Artifact {
  const content = boundedJsonSchema.parse(createSyntheticDamageImport());
  return {
    schema_version: 'haze.artifact.v3',
    id: randomUUID(),
    version: 1,
    sha256: contractHash(content),
    identity: { principal: 'fixture-user', workspace: 'fixture-workspace' },
    kind: 'source.import',
    producer: { kind: 'user', id: 'fixture-user' },
    created_at: '2026-10-25T00:00:00Z',
    dependencies: [],
    required_tools: [],
    content,
    media_type: 'application/json',
    filename: 'synthetic-damage-example.json',
    evidence_origin: 'synthetic_fixture',
    declared_origin: 'Invented report fixture; no empirical readiness.',
  };
}
