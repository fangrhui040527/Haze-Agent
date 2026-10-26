import {
  damageInputsSchema,
  type DamageInputs,
} from '../../contracts/damage-account.js';
import { DAMAGE_METHODS, damageRefKey } from './inputs.js';
import { canonicalJson } from '../../contracts/json.js';

/** Compatibility is deliberately strict: conversions, causal inference and discounting are outside this release. */
export function validateDamageInputs(value: unknown): DamageInputs {
  const inputs = damageInputsSchema.parse(value);
  const { scope } = inputs;
  const unique = (items: string[], label: string) => {
    if (new Set(items).size !== items.length)
      throw new Error(`Duplicate ${label}.`);
  };
  unique(
    inputs.effects.map((e) => e.effect_id),
    'effects',
  );
  unique(
    inputs.unit_values.map((v) => v.unit_value_id),
    'unit values',
  );
  unique(
    inputs.incidence.map((e) => e.entry_id),
    'incidence entries',
  );
  unique(
    inputs.incidence.map((e) => e.transaction_id),
    'financing/transfer transactions',
  );
  unique(
    inputs.scenarios.map((s) => s.scenario_id),
    'scenarios',
  );
  unique(scope.endpoints, 'scope endpoints');
  unique(scope.countries, 'scope countries');
  unique(scope.social_boundary_members, 'social boundary members');
  unique(inputs.source_refs.map(damageRefKey), 'source references');
  unique(
    inputs.source_fire_categories.map((c) => c.category),
    'source-fire categories',
  );
  unique(
    inputs.coverage.map(
      (e) => `${e.endpoint_id}|${e.geography}|${e.population_stratum}`,
    ),
    'coverage support',
  );
  const sources = new Set(inputs.source_refs.map(damageRefKey));
  if (!sources.size)
    throw new Error('Exact imported source references are required.');
  for (const method of scope.approved_method_ids)
    if (!Object.hasOwn(DAMAGE_METHODS, method))
      throw new Error(`Unsupported damage method ID: ${method}.`);
  for (const required of [
    'damage.imported-quantity.v1',
    'damage.declared-unit-value.v1',
    'damage.accounting.v1',
  ])
    if (!scope.approved_method_ids.includes(required))
      throw new Error(`Scope must approve registered method ${required}.`);
  for (const item of [
    ...inputs.effects,
    ...inputs.unit_values,
    ...inputs.incidence,
  ]) {
    if (
      !item.source_refs.length ||
      item.source_refs.some((ref) => !sources.has(damageRefKey(ref)))
    )
      throw new Error(
        'Missing, fabricated or wrong-version/hash source reference.',
      );
  }
  for (const manifest of inputs.manifest)
    if (!sources.has(damageRefKey(manifest.artifact)))
      throw new Error('Manifest source is not authorized.');
  const scenarios = new Map(inputs.scenarios.map((s) => [s.scenario_id, s]));
  if (
    !scenarios.has(scope.historical_scenario_id) ||
    scenarios.get(scope.historical_scenario_id)?.kind !== 'historical'
  )
    throw new Error('Historical scenario declaration is required.');
  for (const scenario of inputs.scenarios) {
    if (
      scenario.kind === 'historical' &&
      scenario.scenario_id !== scope.historical_scenario_id
    )
      throw new Error('Only one historical scenario is supported.');
    if (
      scenario.kind !== 'historical' &&
      !scenarios.has(scenario.comparator_id)
    )
      throw new Error('Scenario comparator is unavailable.');
    if (
      scenario.kind === 'project' &&
      !scope.approved_method_ids.includes('damage.project-scenario.v1')
    )
      throw new Error('Project scenario method is not approved.');
    if (
      scenario.project_cost &&
      (scenario.project_cost.currency !== scope.currency ||
        scenario.project_cost.price_year !== scope.price_year)
    )
      throw new Error(
        'Project cost currency or price year conflicts with account.',
      );
  }
  const selectedGroups = new Set<string>();
  const selectedComponents = new Set<string>();
  const endpointUnits = new Map<string, string>();
  const values = new Map(inputs.unit_values.map((v) => [v.unit_value_id, v]));
  const effects = new Map(inputs.effects.map((e) => [e.effect_id, e]));
  for (const value of inputs.unit_values) {
    if (
      value.method_id !== 'damage.declared-unit-value.v1' ||
      !scope.approved_method_ids.includes(value.method_id)
    )
      throw new Error('Unsupported unit value method.');
    if (
      value.currency !== scope.currency ||
      value.price_year !== scope.price_year ||
      value.valuation_date !== scope.valuation_date ||
      canonicalJson(value.horizon) !== canonicalJson(scope.effect_period)
    )
      throw new Error('Mixed currency, price year, valuation date or horizon.');
  }
  for (const effect of inputs.effects) {
    if (
      endpointUnits.has(effect.endpoint_id) &&
      endpointUnits.get(effect.endpoint_id) !== effect.unit
    )
      throw new Error('Mixed physical units for one endpoint.');
    endpointUnits.set(effect.endpoint_id, effect.unit);
    if (
      !scope.endpoints.includes(effect.endpoint_id) ||
      !scope.countries.includes(effect.geography) ||
      effect.baseline_id !== scope.baseline_scenario_id ||
      !scenarios.has(effect.scenario_id) ||
      canonicalJson(effect.period) !== canonicalJson(scope.effect_period)
    )
      throw new Error(
        'Effect conflicts with declared scope, population support, comparator or period.',
      );
    const selected = effect.included && effect.quantity !== null;
    if (selected) {
      const key = `${effect.scenario_id}|${effect.geography}|${effect.population_stratum}|${effect.overlap_group}`;
      if (selectedGroups.has(key))
        throw new Error('Overlapping selected effect/valuation paths.');
      selectedGroups.add(key);
    }
    if (selected && effect.accounting_lens === 'social_welfare') {
      const value = effect.unit_value_id
        ? values.get(effect.unit_value_id)
        : undefined;
      if (!value || value.compatible_unit !== effect.unit)
        throw new Error('Missing or incompatible quantity/unit value.');
      for (const component of value.included_components) {
        const key = `${effect.scenario_id}|${effect.geography}|${effect.population_stratum}|${component}`;
        if (selectedComponents.has(key))
          throw new Error(
            'Overlapping included valuation components, even across declared overlap groups.',
          );
        selectedComponents.add(key);
      }
    }
    const covered = inputs.coverage.find(
      (c) =>
        c.endpoint_id === effect.endpoint_id &&
        c.geography === effect.geography &&
        c.population_stratum === effect.population_stratum,
    );
    if (!covered)
      throw new Error(
        'Effect lacks explicit endpoint/geography/population coverage.',
      );
    if (covered.status !== effect.status && covered.status !== 'available')
      throw new Error('Coverage and effect missingness conflict.');
    if (
      selected &&
      effect.accounting_lens === 'social_welfare' &&
      !covered.monetary_inclusion
    )
      throw new Error('Selected welfare effect is excluded by coverage.');
  }
  for (const scenario of inputs.scenarios.filter(
    (s) => s.kind !== 'historical',
  )) {
    const support = (scenarioId: string) =>
      inputs.effects
        .filter((e) => e.scenario_id === scenarioId && e.included)
        .map(
          (e) =>
            `${e.endpoint_id}|${e.geography}|${e.population_stratum}|${e.unit}|${e.accounting_lens}`,
        )
        .sort();
    if (
      canonicalJson(support(scenario.scenario_id)) !==
      canonicalJson(support(scenario.comparator_id))
    )
      throw new Error(
        'Scenario/comparator physical coverage differs; omitted harm cannot be treated as avoided damage.',
      );
  }
  for (const entry of inputs.incidence) {
    const effect = effects.get(entry.effect_id);
    if (!effect || entry.payer === entry.recipient)
      throw new Error('Unlinked effect or unbalanced transfer parties.');
    if (
      entry.currency !== scope.currency ||
      entry.price_year !== scope.price_year
    )
      throw new Error('Mixed incidence currency or price year.');
    if (
      entry.payer_in_boundary !==
        scope.social_boundary_members.includes(entry.payer) ||
      entry.recipient_in_boundary !==
        scope.social_boundary_members.includes(entry.recipient)
    )
      throw new Error(
        'Incidence social-boundary membership conflicts with scope.',
      );
    if (effect.quantity === null || !effect.included)
      throw new Error(
        'Financing/transfer references an excluded or missing effect.',
      );
    if (
      entry.financing_type === 'resource_financing' &&
      (effect.accounting_lens !== 'social_welfare' || !effect.unit_value_id)
    )
      throw new Error('Resource financing needs a valued resource effect.');
  }
  for (const effect of inputs.effects) {
    const shares = inputs.incidence.filter(
      (i) =>
        i.effect_id === effect.effect_id &&
        i.financing_type === 'resource_financing',
    );
    if (!shares.length) continue;
    const unitValue = values.get(effect.unit_value_id!);
    const cost = effect.quantity! * unitValue!.amount;
    if (
      Math.abs(shares.reduce((sum, i) => sum + i.amount, 0) - cost) >
      Math.max(1e-8, Math.abs(cost) * 1e-10)
    )
      throw new Error(
        'Inconsistent financing shares; financing must equal the resource cost exactly once.',
      );
  }
  return inputs;
}
