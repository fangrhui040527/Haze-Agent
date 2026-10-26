import { type ArtifactRef } from '../../contracts/artifacts.js';
import { canonicalJson, contractHash } from '../../contracts/json.js';
import {
  damageRevisionBridgeSchema,
  type DamageAccount,
  type DamageEffect,
  type DamageInputs,
  type DamageRevisionBridge,
} from '../../contracts/damage-account.js';
import { validateDamageInputs } from './scope.js';
import { compileDamageAccount } from './methods.js';
import { damageRefKey } from './inputs.js';

export type DamageRevisionInput = {
  inputs: DamageInputs;
  account: DamageAccount;
  artifact: ArtifactRef;
};
const selected = (e: DamageEffect) =>
  e.included && e.quantity !== null && e.accounting_lens === 'social_welfare';
const support = (e: DamageEffect) =>
  [
    e.scenario_id,
    e.endpoint_id,
    e.geography,
    e.population_stratum,
    e.unit,
    e.baseline_id,
    e.period.start,
    e.period.end,
  ].join('|');

/** Explicitly selected prior/current accounts only. This does not silently reuse stale evidence. */
export function createDamageRevisionBridge(
  previous: DamageRevisionInput,
  current: DamageRevisionInput,
): DamageRevisionBridge {
  for (const record of [previous, current]) {
    validateDamageInputs(record.inputs);
    if (record.artifact.sha256 !== contractHash(record.account))
      throw new Error('Revision account hash mismatch.');
    if (
      canonicalJson(record.account.scope) !==
        canonicalJson(record.inputs.scope) ||
      canonicalJson(record.account.source_refs) !==
        canonicalJson(record.inputs.source_refs)
    )
      throw new Error(
        'Revision account does not match the exact imported scope and sources.',
      );
    const reconstruction = compileDamageAccount(record.inputs);
    if (
      canonicalJson(record.account.welfare_totals) !==
      canonicalJson(reconstruction['damage.welfare'].totals)
    )
      throw new Error(
        'Revision account totals do not reconcile with imported inputs.',
      );
  }
  if (
    previous.account.account_id !== current.account.account_id ||
    previous.inputs.scope.event_id !== current.inputs.scope.event_id
  )
    throw new Error('Revision bridge requires the same account and event.');
  if (previous.inputs.scope.currency !== current.inputs.scope.currency)
    throw new Error(
      'Revision bridge cannot compare mixed currencies without a registered conversion.',
    );
  if (damageRefKey(previous.artifact) === damageRefKey(current.artifact))
    throw new Error('Revision bridge requires distinct exact accounts.');
  const scenarios = [
    ...new Set(
      [
        ...previous.account.welfare_totals,
        ...current.account.welfare_totals,
      ].map((t) => t.scenario_id),
    ),
  ];
  const changes = scenarios.map((scenario_id) => {
    const previous_total =
      previous.account.welfare_totals.find((t) => t.scenario_id === scenario_id)
        ?.amount ?? 0;
    const current_total =
      current.account.welfare_totals.find((t) => t.scenario_id === scenario_id)
        ?.amount ?? 0;
    const row = {
      scenario_id,
      previous_total,
      current_total,
      total_change: current_total - previous_total,
      quantities: 0,
      coverage: 0,
      methods: 0,
      values: 0,
      boundary_and_incidence: 0,
    };
    const oldEffects = previous.inputs.effects.filter(
      (e) => e.scenario_id === scenario_id && selected(e),
    );
    const newEffects = current.inputs.effects.filter(
      (e) => e.scenario_id === scenario_id && selected(e),
    );
    const oldCost = (e: DamageEffect) =>
      e.quantity! *
      previous.inputs.unit_values.find(
        (v) => v.unit_value_id === e.unit_value_id,
      )!.amount;
    const newCost = (e: DamageEffect) =>
      e.quantity! *
      current.inputs.unit_values.find(
        (v) => v.unit_value_id === e.unit_value_id,
      )!.amount;
    const matched = new Set<string>();
    for (const before of oldEffects) {
      const after = newEffects.find(
        (e) =>
          e.effect_id === before.effect_id && support(e) === support(before),
      );
      if (!after) {
        row.coverage -= oldCost(before);
        continue;
      }
      matched.add(after.effect_id);
      const oldValue = previous.inputs.unit_values.find(
        (v) => v.unit_value_id === before.unit_value_id,
      )!;
      const newValue = current.inputs.unit_values.find(
        (v) => v.unit_value_id === after.unit_value_id,
      )!;
      if (
        before.causal_method !== after.causal_method ||
        oldValue.method_id !== newValue.method_id ||
        oldValue.method_version !== newValue.method_version
      )
        row.methods += newCost(after) - oldCost(before);
      else {
        row.quantities +=
          (after.quantity! - before.quantity!) * oldValue.amount;
        row.values += after.quantity! * (newValue.amount - oldValue.amount);
      }
    }
    for (const after of newEffects)
      if (!matched.has(after.effect_id)) row.coverage += newCost(after);
    row.boundary_and_incidence =
      row.total_change -
      row.quantities -
      row.coverage -
      row.methods -
      row.values;
    if (Math.abs(row.boundary_and_incidence) < 1e-8)
      row.boundary_and_incidence = 0;
    return row;
  });
  const source_refs = [
    ...new Map(
      [...previous.inputs.source_refs, ...current.inputs.source_refs].map(
        (ref) => [damageRefKey(ref), ref],
      ),
    ).values(),
  ];
  return damageRevisionBridgeSchema.parse({
    schema_version: 'haze.damage.revision-bridge.v1',
    account_id: current.account.account_id,
    previous_account: previous.artifact,
    current_account: current.artifact,
    source_refs,
    currency: current.inputs.scope.currency,
    previous_price_year: previous.inputs.scope.price_year,
    current_price_year: current.inputs.scope.price_year,
    comparison_basis: 'declared_accounting_bases_not_observed_haze_change',
    changes,
    limitations: [
      'This is an accounting decomposition on the declared bases; changed methods, coverage or prices are not observed changes in haze.',
      'Quantity contributions use previous unit values; value contributions use current quantities. Method changes take precedence over quantity/value decomposition.',
      'Changed grain, inclusion or endpoint support is classified as coverage. Boundary and financing changes are shown separately.',
      ...(previous.inputs.scope.price_year !== current.inputs.scope.price_year
        ? [
            'Price years differ; amounts have not been inflation-normalized and are not a like-for-like real welfare trend.',
          ]
        : []),
      'Prior evidence requires explicit applicability and review checks before reuse. Scientific applicability is not established by arithmetic.',
    ],
    applicability: 'not_established_by_arithmetic',
  });
}
