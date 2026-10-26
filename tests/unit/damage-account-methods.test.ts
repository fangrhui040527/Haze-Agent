import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { contractHash } from '../../app/contracts/json.js';
import {
  damageAccountSchema,
  type DamageComponentKind,
  type DamageComponents,
} from '../../app/contracts/damage-account.js';
import {
  type Artifact,
  type ArtifactRef,
} from '../../app/contracts/artifacts.js';
import { normalizeDamageInputs } from '../../app/capabilities/damage-account/inputs.js';
import {
  compileDamageAccount,
  assembleDamageAccount,
  DAMAGE_COMPONENT_KINDS,
} from '../../app/capabilities/damage-account/methods.js';
import {
  independentlyCheckDamageAccount,
  independentlyCheckDamageRevisionBridge,
} from '../../app/capabilities/damage-account/checker.js';
import { createDamageRevisionBridge } from '../../app/capabilities/damage-account/publication.js';
import {
  createSyntheticDamageArtifact,
  createSyntheticDamageImport,
  SYNTHETIC_DAMAGE_EXPECTATIONS,
} from '../../app/capabilities/damage-account/fixtures.js';

const inputs = () => normalizeDamageInputs([createSyntheticDamageArtifact()]);
function refsFor(components: DamageComponents) {
  return Object.fromEntries(
    DAMAGE_COMPONENT_KINDS.map((kind) => [
      kind,
      { id: randomUUID(), version: 1, sha256: contractHash(components[kind]) },
    ]),
  ) as Record<DamageComponentKind, ArtifactRef>;
}
function artifactWith(
  content: unknown,
  media_type: 'application/json' | 'text/csv' = 'application/json',
): Artifact {
  return {
    ...createSyntheticDamageArtifact(),
    content: content as Artifact['content'],
    sha256: contractHash(content),
    media_type,
  };
}
describe('Damage-account imported-input MVP', () => {
  it('reproduces the frozen invented report independently without rounding physical outcomes', () => {
    const original = inputs();
    const result = compileDamageAccount(original);
    const deaths = result['damage.physical'].totals.find(
      (t) => t.scenario_id === 'historical' && t.endpoint_id === 'mortality',
    )!.quantity;
    expect(deaths).toBe(SYNTHETIC_DAMAGE_EXPECTATIONS.deaths);
    expect(result['damage.welfare'].totals[0]!.amount).toBeCloseTo(
      SYNTHETIC_DAMAGE_EXPECTATIONS.historical_loss,
      7,
    );
    expect(
      result['damage.scenarios'].comparisons[0]!.avoided_damage,
    ).toBeCloseTo(SYNTHETIC_DAMAGE_EXPECTATIONS.avoided_damage, 7);
    expect(result['damage.scenarios'].comparisons[0]!.net_benefit).toBeCloseTo(
      SYNTHETIC_DAMAGE_EXPECTATIONS.net_benefit,
      7,
    );
    expect(
      result['damage.scenarios'].comparisons[0]!.benefit_cost_ratio,
    ).toBeCloseTo(4.57, 7);
    expect(result['damage.incidence'].financing_totals[0]!.amount).toBe(
      400_000,
    );
    expect(result['damage.incidence'].net_boundary_transfers[0]!.amount).toBe(
      0,
    );
    const refs = refsFor(result);
    const account = assembleDamageAccount(original, result, refs);
    expect(damageAccountSchema.parse(account).evidence_origin).toBe(
      'synthetic',
    );
    expect(
      independentlyCheckDamageAccount(original, result, account, refs),
    ).toMatchObject({
      valid: true,
      findings: [],
      applicability: 'not_established_by_arithmetic',
    });
  });
  it('accepts the same bounded typed records through CSV partitions', () => {
    const bundle = createSyntheticDamageImport();
    const csv = [
      'schema_version,table_type,record',
      ...Object.entries(bundle)
        .filter(([key]) => key !== 'schema_version')
        .flatMap(([key, value]) =>
          (Array.isArray(value) ? value : [value]).map((row) =>
            ['haze.damage.import.v1', key, JSON.stringify(row)]
              .map((v) => `"${v.replaceAll('"', '""')}"`)
              .join(','),
          ),
        ),
    ].join('\r\n');
    const normalized = normalizeDamageInputs([artifactWith(csv, 'text/csv')]);
    expect(
      compileDamageAccount(normalized)['damage.welfare'].totals[0]!.amount,
    ).toBeCloseTo(SYNTHETIC_DAMAGE_EXPECTATIONS.historical_loss, 7);
    expect(
      normalized.manifest.every(
        (m) => m.access_classification === 'task-authorized',
      ),
    ).toBe(true);
  });
  it.each([
    'duplicate',
    'overlap',
    'financing',
    'currency',
    'year',
    'unit',
    'horizon',
    'method',
    'prototype-method',
    'scope',
    'reference',
  ] as const)('rejects %s inconsistencies', (kind) => {
    const original = inputs();
    if (kind === 'duplicate')
      original.effects.push(structuredClone(original.effects[0]!));
    if (kind === 'overlap')
      original.effects[2]!.overlap_group = original.effects[0]!.overlap_group;
    if (kind === 'financing') original.incidence[0]!.amount++;
    if (kind === 'currency') original.unit_values[0]!.currency = 'USD';
    if (kind === 'year') original.unit_values[0]!.price_year++;
    if (kind === 'unit') original.effects[0]!.unit = 'people';
    if (kind === 'horizon') original.unit_values[0]!.horizon.end = '2016-10-31';
    if (kind === 'method')
      original.scope.approved_method_ids.push('invented.method');
    if (kind === 'prototype-method')
      original.scope.approved_method_ids.push('toString');
    if (kind === 'scope') original.scope.countries = ['Other Country'];
    if (kind === 'reference') original.effects[0]!.source_refs[0]!.version++;
    expect(() => compileDamageAccount(original)).toThrow();
  });
  it('rejects semantic cost duplication even with a different overlap declaration', () => {
    const original = inputs();
    original.unit_values[1]!.included_components = ['mortality'];
    expect(() => compileDamageAccount(original)).toThrow(
      'Overlapping included',
    );
  });
  it('keeps unavailable and suppressed categories distinct from zero', () => {
    const original = inputs();
    original.effects[0]!.quantity = null;
    original.effects[0]!.status = 'disclosure_suppressed';
    original.coverage[0]!.status = 'available';
    original.scope.endpoints.push('ecosystem');
    original.coverage.push({
      endpoint_id: 'ecosystem',
      geography: 'Fixture Region',
      population_stratum: 'Invented population',
      status: 'unavailable',
      origin: 'imported',
      monetary_inclusion: false,
      reason: 'No supported ecosystem input.',
    });
    const result = compileDamageAccount(original);
    expect(result['damage.physical'].effects[0]!.quantity).toBeNull();
    expect(result['damage.coverage'].status).toBe('partial');
    expect(result['damage.coverage'].entries.at(-1)!.status).toBe(
      'unavailable',
    );
    expect(
      result['damage.source-fire-extension'].categories.every(
        (c) => c.status === 'not_estimated',
      ),
    ).toBe(true);
    expect(independentlyCheckDamageAccount(original, result).valid).toBe(true);
  });
  it.each([
    'total',
    'inclusion',
    'missingness',
    'source',
    'method',
    'manifest',
  ] as const)('independently rejects tampered %s', (kind) => {
    const original = inputs();
    const result = compileDamageAccount(original);
    const refs = refsFor(result);
    const account = assembleDamageAccount(original, result, refs);
    if (kind === 'total') result['damage.welfare'].totals[0]!.amount++;
    if (kind === 'inclusion')
      result['damage.overlap'].decisions[0]!.included = false;
    if (kind === 'missingness')
      result['damage.coverage'].entries[0]!.status = 'true_zero';
    if (kind === 'source')
      result['damage.physical'].effects[0]!.source_refs[0]!.sha256 = 'a'.repeat(
        64,
      );
    if (kind === 'method')
      result['damage.methods'].methods[0]!.method_id = 'made-up';
    if (kind === 'manifest') account.component_refs[0]!.artifact.version++;
    expect(
      independentlyCheckDamageAccount(original, result, account, refs).valid,
    ).toBe(false);
  });
  it('rejects tampered raw bytes and unauthorized row references before normalization', () => {
    const artifact = createSyntheticDamageArtifact();
    artifact.sha256 = 'a'.repeat(64);
    expect(() => normalizeDamageInputs([artifact])).toThrow('hash mismatch');
    const bundle = createSyntheticDamageImport();
    bundle.effects[0]!.source_refs = [
      { id: randomUUID(), version: 2, sha256: 'b'.repeat(64) },
    ];
    expect(() => normalizeDamageInputs([artifactWith(bundle)])).toThrow(
      'source reference',
    );
  });
  it('rejects mismatched comparator coverage, overflow and incompatible project cost', () => {
    const original = inputs();
    original.effects = original.effects.filter(
      (e) => e.effect_id !== 'project-mortality',
    );
    expect(() => compileDamageAccount(original)).toThrow('coverage');
    const overflow = inputs();
    overflow.effects[0]!.quantity = 1e308;
    overflow.unit_values[0]!.amount = 1e308;
    expect(() => compileDamageAccount(overflow)).toThrow();
    const wrongCost = inputs();
    wrongCost.scenarios[1]!.project_cost!.price_year++;
    expect(() => compileDamageAccount(wrongCost)).toThrow('Project cost');
  });
  it('withholds benefit rather than treating a suppressed comparator effect as zero', () => {
    const original = inputs();
    original.effects[0]!.quantity = null;
    original.effects[0]!.status = 'disclosure_suppressed';
    const components = compileDamageAccount(original);
    expect(components['damage.coverage'].status).toBe('partial');
    expect(components['damage.scenarios'].comparisons[0]).toMatchObject({
      status: 'withheld',
      avoided_damage: null,
      net_benefit: null,
      benefit_cost_ratio: null,
    });
    expect(independentlyCheckDamageAccount(original, components).valid).toBe(
      true,
    );
  });
  it('propagates each omitted effect, scenario, evidence and uncertainty despite broadly available input coverage', () => {
    const original = inputs();
    original.effects[0]!.quantity = null;
    original.effects[0]!.status = 'disclosure_suppressed';
    original.effects[0]!.uncertainty = {
      interpretation: 'confidence_interval',
      basis:
        'Imported interval remains a source assertion; central quantity is suppressed.',
      lower: 4,
      upper: 15,
    };
    const components = compileDamageAccount(original);
    expect(original.coverage[0]!.status).toBe('available');
    expect(components['damage.coverage'].status).toBe('partial');
    expect(components['damage.coverage'].omissions).toEqual([
      expect.objectContaining({
        effect_id: 'historical-mortality',
        scenario_id: 'historical',
        status: 'disclosure_suppressed',
        uncertainty: original.effects[0]!.uncertainty,
        source_refs: original.effects[0]!.source_refs,
      }),
    ]);
    const refs = refsFor(components);
    const account = assembleDamageAccount(original, components, refs);
    expect(account.omissions).toEqual(components['damage.coverage'].omissions);
    expect(
      independentlyCheckDamageAccount(original, components, account, refs)
        .valid,
    ).toBe(true);
    account.omissions = [];
    expect(
      independentlyCheckDamageAccount(original, components, account, refs)
        .valid,
    ).toBe(false);
  });
  it('keeps an all-missing account as a gap with withheld monetary totals and no invented zeros', () => {
    const original = inputs();
    original.incidence = [];
    for (const effect of original.effects) {
      effect.quantity = null;
      effect.status = 'unavailable';
    }
    const components = compileDamageAccount(original);
    const account = assembleDamageAccount(
      original,
      components,
      refsFor(components),
    );
    expect(account.status).toBe('gap');
    expect(account.physical_totals).toEqual([]);
    expect(account.welfare_totals).toEqual([]);
    expect(account.financing_totals).toEqual([]);
    expect(account.omissions).toHaveLength(original.effects.length);
    expect(account.scenarios[0]).toMatchObject({
      status: 'withheld',
      avoided_damage: null,
    });
    expect(independentlyCheckDamageAccount(original, components).valid).toBe(
      true,
    );
  });
  it('retains explicit true-zero support without confusing it with physical-only or missing monetary coverage', () => {
    const original = inputs();
    original.incidence = [];
    for (const effect of original.effects) {
      effect.quantity = 0;
      effect.status = 'true_zero';
    }
    const zero = compileDamageAccount(original);
    expect(zero['damage.coverage'].status).toBe(
      'complete_for_declared_imported_scope',
    );
    expect(zero['damage.coverage'].omissions).toEqual([]);
    expect(zero['damage.welfare'].totals.every((t) => t.amount === 0)).toBe(
      true,
    );
    expect(independentlyCheckDamageAccount(original, zero).valid).toBe(true);
    for (const effect of original.effects)
      effect.accounting_lens = 'physical_only';
    const physicalOnly = compileDamageAccount(original);
    expect(physicalOnly['damage.welfare'].totals).toEqual([]);
    expect(physicalOnly['damage.scenarios'].comparisons[0]).toMatchObject({
      status: 'withheld',
      avoided_damage: null,
    });
    expect(independentlyCheckDamageAccount(original, physicalOnly).valid).toBe(
      true,
    );
  });
  it('decomposes a selected exact account revision into quantities and values independently', () => {
    const before = inputs();
    const after = structuredClone(before);
    after.effects[0]!.quantity! += 1;
    after.unit_values[0]!.amount = 3_000_000;
    const snapshot = (original: typeof before) => {
      const components = compileDamageAccount(original);
      const account = assembleDamageAccount(
        original,
        components,
        refsFor(components),
      );
      return {
        inputs: original,
        account,
        artifact: {
          id: randomUUID(),
          version: 1,
          sha256: contractHash(account),
        },
      };
    };
    const previous = snapshot(before),
      current = snapshot(after);
    const bridge = createDamageRevisionBridge(previous, current);
    expect(bridge.changes[0]!.quantities).toBe(2_000_000);
    expect(bridge.changes[0]!.values).toBeCloseTo(
      (SYNTHETIC_DAMAGE_EXPECTATIONS.deaths + 1) * 1_000_000,
      7,
    );
    expect(bridge.changes[0]!.boundary_and_incidence).toBe(0);
    expect(
      independentlyCheckDamageRevisionBridge(previous, current, bridge).valid,
    ).toBe(true);
    bridge.changes[0]!.values++;
    expect(
      independentlyCheckDamageRevisionBridge(previous, current, bridge).valid,
    ).toBe(false);
  });
  it('labels changed methods separately and rejects revision-account hash tampering', () => {
    const before = inputs(),
      after = structuredClone(before);
    after.effects[0]!.quantity! += 1;
    after.effects[0]!.causal_method =
      'Changed imported health model assertion, not an observed change in haze.';
    const snapshot = (original: typeof before) => {
      const components = compileDamageAccount(original);
      const account = assembleDamageAccount(
        original,
        components,
        refsFor(components),
      );
      return {
        inputs: original,
        account,
        artifact: {
          id: randomUUID(),
          version: 1,
          sha256: contractHash(account),
        },
      };
    };
    const previous = snapshot(before),
      current = snapshot(after);
    const bridge = createDamageRevisionBridge(previous, current);
    expect(bridge.changes[0]!.methods).toBe(2_000_000);
    expect(bridge.changes[0]!.quantities).toBe(0);
    expect(
      independentlyCheckDamageRevisionBridge(previous, current, bridge).valid,
    ).toBe(true);
    current.artifact.sha256 = 'b'.repeat(64);
    expect(() => createDamageRevisionBridge(previous, current)).toThrow(
      'hash mismatch',
    );
  });
});
