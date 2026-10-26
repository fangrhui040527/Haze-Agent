import {
  damageAccountSchema,
  damageComponentSchemas,
  damageOmissionSchema,
  type DamageAccount,
  type DamageComponentKind,
  type DamageComponents,
  type DamageInputs,
} from '../../contracts/damage-account.js';
import {
  artifactRefSchema,
  type ArtifactRef,
} from '../../contracts/artifacts.js';
import { canonicalJson, contractHash } from '../../contracts/json.js';
import { validateDamageInputs } from './scope.js';
import { DAMAGE_METHODS } from './inputs.js';

export const DAMAGE_COMPONENT_KINDS: readonly DamageComponentKind[] = [
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
];
export const SOURCE_FIRE_CATEGORIES = [
  'direct_assets',
  'crops',
  'peat',
  'ecosystems',
  'climate',
] as const;

/** Deterministic imported-quantity accounting. The inputs remain the sole numerical authority. */
export function compileDamageAccount(value: DamageInputs): DamageComponents {
  const inputs = validateDamageInputs(value);
  const { scope } = inputs;
  const account_id = scope.account_id;
  const totals = new Map<
    string,
    { scenario_id: string; endpoint_id: string; unit: string; quantity: number }
  >();
  const values = new Map(inputs.unit_values.map((v) => [v.unit_value_id, v]));
  const lines: DamageComponents['damage.welfare']['lines'] = [];
  const welfare = new Map(inputs.scenarios.map((s) => [s.scenario_id, 0]));
  const financing = new Map(inputs.scenarios.map((s) => [s.scenario_id, 0]));
  const transfers = new Map(inputs.scenarios.map((s) => [s.scenario_id, 0]));
  for (const effect of inputs.effects) {
    if (!effect.included || effect.quantity === null) continue;
    const key = `${effect.scenario_id}|${effect.endpoint_id}|${effect.unit}`;
    const total = totals.get(key) ?? {
      scenario_id: effect.scenario_id,
      endpoint_id: effect.endpoint_id,
      unit: effect.unit,
      quantity: 0,
    };
    total.quantity += effect.quantity;
    totals.set(key, total);
    if (effect.accounting_lens === 'social_welfare') {
      const unitValue = values.get(effect.unit_value_id!)!;
      const amount = effect.quantity * unitValue.amount;
      lines.push({
        effect_id: effect.effect_id,
        scenario_id: effect.scenario_id,
        unit_value_id: unitValue.unit_value_id,
        quantity: effect.quantity,
        quantity_unit: effect.unit,
        unit_value: unitValue.amount,
        amount,
      });
      welfare.set(
        effect.scenario_id,
        welfare.get(effect.scenario_id)! + amount,
      );
    }
  }
  for (const entry of inputs.incidence) {
    const scenario = inputs.effects.find(
      (e) => e.effect_id === entry.effect_id,
    )!.scenario_id;
    if (entry.financing_type === 'resource_financing')
      financing.set(scenario, financing.get(scenario)! + entry.amount);
    else {
      const net =
        entry.amount *
        (Number(entry.payer_in_boundary) - Number(entry.recipient_in_boundary));
      transfers.set(scenario, transfers.get(scenario)! + net);
      welfare.set(scenario, welfare.get(scenario)! + net);
    }
  }
  const transferScenarios = new Set(
    inputs.incidence
      .filter((e) => e.financing_type === 'transfer')
      .map(
        (e) =>
          inputs.effects.find((effect) => effect.effect_id === e.effect_id)!
            .scenario_id,
      ),
  );
  const financingScenarios = new Set(
    inputs.incidence
      .filter((e) => e.financing_type === 'resource_financing')
      .map(
        (e) =>
          inputs.effects.find((effect) => effect.effect_id === e.effect_id)!
            .scenario_id,
      ),
  );
  const valuedScenarios = new Set([
    ...lines.map((line) => line.scenario_id),
    ...transferScenarios,
  ]);
  const moneyTotals = (map: Map<string, number>, supported: Set<string>) =>
    [...map]
      .filter(([scenario_id]) => supported.has(scenario_id))
      .map(([scenario_id, amount]) => ({
        scenario_id,
        amount,
        currency: scope.currency,
        price_year: scope.price_year,
      }));
  const coveredEndpoints = new Set(
    inputs.coverage
      .filter((c) => c.status === 'available' || c.status === 'true_zero')
      .map((c) => c.endpoint_id),
  );
  const gaps =
    inputs.effects.some(
      (e) => e.quantity === null && e.status !== 'not_applicable',
    ) ||
    inputs.coverage.some(
      (c) => !['available', 'true_zero', 'not_applicable'].includes(c.status),
    ) ||
    scope.endpoints.some((endpoint) => !coveredEndpoints.has(endpoint));
  const status = inputs.effects.some((e) => e.included && e.quantity !== null)
    ? gaps
      ? 'partial'
      : 'complete_for_declared_imported_scope'
    : 'gap';
  const coverageEntries = [...inputs.coverage];
  const omissions = inputs.effects
    .filter((effect) => effect.quantity === null)
    .map((effect) =>
      damageOmissionSchema.parse({
        effect_id: effect.effect_id,
        endpoint_id: effect.endpoint_id,
        scenario_id: effect.scenario_id,
        geography: effect.geography,
        population_stratum: effect.population_stratum,
        unit: effect.unit,
        status: effect.status,
        origin: effect.origin,
        reason: (
          effect.exclusion_reason ??
          `Quantity withheld: ${effect.status}. ${effect.applicability}`
        ).slice(0, 4096),
        uncertainty: effect.uncertainty,
        source_refs: effect.source_refs,
      }),
    );
  for (const endpoint of scope.endpoints)
    if (!inputs.coverage.some((c) => c.endpoint_id === endpoint)) {
      for (const geography of scope.countries)
        coverageEntries.push({
          endpoint_id: endpoint,
          geography,
          population_stratum: scope.population,
          status: 'not_estimated',
          origin: 'imported',
          monetary_inclusion: false,
          reason:
            'No imported endpoint support; withheld rather than set to zero.',
        });
    }
  const sourceFire = [...inputs.source_fire_categories];
  for (const category of SOURCE_FIRE_CATEGORIES)
    if (!sourceFire.some((c) => c.category === category))
      sourceFire.push({
        category,
        status: 'not_estimated',
        reason:
          'Source-fire extension is explicit but no registered empirical method or reviewed input is available in this MVP.',
      });
  const components: DamageComponents = {
    'damage.scope': scope,
    'damage.inputs': inputs,
    'damage.coverage': {
      schema_version: 'haze.damage.coverage.v1',
      account_id,
      status,
      entries: coverageEntries,
      omissions,
      limitations: inputs.limitations,
    },
    'damage.physical': {
      schema_version: 'haze.damage.physical.v1',
      account_id,
      effects: inputs.effects,
      totals: [...totals.values()],
    },
    'damage.incidence': {
      schema_version: 'haze.damage.incidence.v1',
      account_id,
      accounting_lens: 'financial_incidence',
      entries: inputs.incidence,
      financing_totals: moneyTotals(financing, financingScenarios),
      net_boundary_transfers: moneyTotals(transfers, transferScenarios),
    },
    'damage.welfare': {
      schema_version: 'haze.damage.welfare.v1',
      account_id,
      accounting_lens: 'selected_social_welfare',
      lines,
      totals: moneyTotals(welfare, valuedScenarios),
      excluded_effect_ids: inputs.effects
        .filter(
          (e) =>
            !e.included ||
            e.quantity === null ||
            e.accounting_lens === 'physical_only',
        )
        .map((e) => e.effect_id),
    },
    'damage.overlap': {
      schema_version: 'haze.damage.overlap.v1',
      account_id,
      decisions: inputs.effects.map((e) => ({
        effect_id: e.effect_id,
        overlap_group: e.overlap_group,
        included: e.included,
        reason:
          e.exclusion_reason ??
          (e.quantity === null
            ? 'Withheld: physical quantity is unavailable; no amount was invented.'
            : 'Declared compatible nonoverlapping accounting path.'),
      })),
    },
    'damage.source-fire-extension': {
      schema_version: 'haze.damage.source-fire-extension.v1',
      account_id,
      categories: sourceFire,
    },
    'damage.methods': {
      schema_version: 'haze.damage.methods.v1',
      account_id,
      methods: scope.approved_method_ids.map((method_id) => ({
        method_id,
        version: '1',
        description: DAMAGE_METHODS[method_id as keyof typeof DAMAGE_METHODS],
      })),
      limitations: inputs.limitations,
    },
    'damage.scenarios': {
      schema_version: 'haze.damage.scenarios.v1',
      account_id,
      scenarios: inputs.scenarios,
      comparisons: inputs.scenarios
        .filter((s) => s.kind !== 'historical')
        .map((s) => {
          const comparisonMissing =
            gaps ||
            !valuedScenarios.has(s.scenario_id) ||
            !valuedScenarios.has(s.comparator_id);
          const avoided_damage = comparisonMissing
            ? null
            : welfare.get(s.comparator_id)! - welfare.get(s.scenario_id)!;
          const project_cost = s.project_cost?.amount ?? null;
          return {
            scenario_id: s.scenario_id,
            comparator_id: s.comparator_id,
            interpretation:
              s.kind === 'project'
                ? 'achievable_project_benefit'
                : 'source_removal_difference',
            status: comparisonMissing ? 'withheld' : 'available',
            limitation: comparisonMissing
              ? 'Incomplete physical, endpoint or monetary support; missing harm cannot be treated as an intervention benefit.'
              : null,
            avoided_damage,
            project_cost,
            net_benefit:
              project_cost === null || avoided_damage === null
                ? null
                : avoided_damage - project_cost,
            benefit_cost_ratio:
              project_cost === null ||
              project_cost === 0 ||
              avoided_damage === null
                ? null
                : avoided_damage / project_cost,
            currency: scope.currency,
            price_year: scope.price_year,
            excludes_cash_return_claim: true,
          };
        }),
    },
  };
  for (const kind of DAMAGE_COMPONENT_KINDS)
    damageComponentSchemas[kind].parse(components[kind]);
  return components;
}

export function assembleDamageAccount(
  inputs: DamageInputs,
  components: DamageComponents,
  refs: Readonly<Record<DamageComponentKind, ArtifactRef>>,
): DamageAccount {
  validateDamageInputs(inputs);
  if (
    canonicalJson(components['damage.scope']) !== canonicalJson(inputs.scope) ||
    canonicalJson(components['damage.inputs']) !== canonicalJson(inputs)
  )
    throw new Error(
      'Account components are bound to a different imported scope or input manifest.',
    );
  for (const kind of DAMAGE_COMPONENT_KINDS) {
    artifactRefSchema.parse(refs[kind]);
    damageComponentSchemas[kind].parse(components[kind]);
    if (contractHash(components[kind]) !== refs[kind].sha256)
      throw new Error(
        'Account component does not match its exact publication hash.',
      );
  }
  return damageAccountSchema.parse({
    schema_version: 'haze.damage.account.v1',
    account_id: inputs.scope.account_id,
    scope: inputs.scope,
    status: components['damage.coverage'].status,
    evidence_origin: inputs.effects.some((e) => e.origin === 'synthetic')
      ? 'synthetic'
      : 'imported',
    component_refs: DAMAGE_COMPONENT_KINDS.map((kind) => ({
      kind,
      artifact: refs[kind],
    })),
    source_refs: inputs.source_refs,
    physical_totals: components['damage.physical'].totals,
    financing_totals: components['damage.incidence'].financing_totals,
    welfare_totals: components['damage.welfare'].totals,
    coverage: components['damage.coverage'].entries,
    omissions: components['damage.coverage'].omissions,
    scenarios: components['damage.scenarios'].comparisons,
    limitations: inputs.limitations,
    review_status: 'requires_independent_review',
  });
}
