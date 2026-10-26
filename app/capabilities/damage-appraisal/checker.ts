import {
  damageAccountSchema,
  damageCheckSchema,
  damageInputsSchema,
  damageOmissionSchema,
  damageRevisionBridgeSchema,
  type DamageAccount,
  type DamageCheck,
  type DamageComponentKind,
  type DamageComponents,
  type DamageInputs,
  type DamageRevisionBridge,
} from '../../contracts/damage-account.js';
import { type ArtifactRef } from '../../contracts/artifacts.js';
import { canonicalJson, contractHash } from '../../contracts/json.js';
import { DAMAGE_METHODS, damageRefKey } from './inputs.js';
import type { DamageRevisionInput } from './publication.js';

/** Independent reconstruction: deliberately imports no producer calculation or reconciliation functions. */
export function independentlyCheckDamageAccount(
  originalInputs: DamageInputs,
  proposed: DamageComponents,
  account?: DamageAccount,
  refs?: Readonly<Record<DamageComponentKind, ArtifactRef>>,
): DamageCheck {
  const findings: string[] = [];
  const checks = [
    'Original input schemas and exact source references',
    'Independent physical and monetary reconstruction',
    'Overlap, financing, internal transfers and social boundary',
    'Coverage, source-fire omissions, methods and scenario interpretation',
    'Manifest component closure and pinned hashes when supplied',
  ];
  const parsed = damageInputsSchema.safeParse(originalInputs);
  if (!parsed.success)
    return damageCheckSchema.parse({
      schema_version: 'haze.damage.check.v1',
      valid: false,
      checks,
      findings: [
        'Original imported inputs do not match the damage input schema.',
      ],
      limitations: [
        'Scientific applicability is not established by arithmetic.',
      ],
      applicability: 'not_established_by_arithmetic',
    });
  const inputs = parsed.data;
  const { scope } = inputs;
  const equal = (a: unknown, b: unknown, label: string) => {
    try {
      if (canonicalJson(a) !== canonicalJson(b))
        findings.push(`${label} differs from independent reconstruction.`);
    } catch {
      findings.push(`${label} is not bounded valid JSON.`);
    }
  };
  const close = (a: number, b: number) =>
    Math.abs(a - b) <=
    Math.max(1e-8, Math.max(Math.abs(a), Math.abs(b)) * 1e-10);
  try {
    const sourceKeys = new Set(inputs.source_refs.map(damageRefKey));
    const duplicate = (ids: string[], label: string) => {
      if (new Set(ids).size !== ids.length)
        findings.push(`Duplicate ${label}.`);
    };
    duplicate(
      inputs.effects.map((e) => e.effect_id),
      'effects',
    );
    duplicate(
      inputs.unit_values.map((e) => e.unit_value_id),
      'unit values',
    );
    duplicate(
      inputs.incidence.map((e) => e.transaction_id),
      'transactions',
    );
    duplicate(
      inputs.incidence.map((e) => e.entry_id),
      'incidence identities',
    );
    duplicate(
      inputs.scenarios.map((e) => e.scenario_id),
      'scenario identities',
    );
    duplicate(
      inputs.source_refs.map((e) => e.id),
      'source identities/versions',
    );
    if (!sourceKeys.size) findings.push('No exact source references.');
    for (const item of [
      ...inputs.effects,
      ...inputs.unit_values,
      ...inputs.incidence,
    ])
      if (
        !item.source_refs.length ||
        item.source_refs.some((ref) => !sourceKeys.has(damageRefKey(ref)))
      )
        findings.push(
          'Row contains a fabricated or mismatched source reference.',
        );
    for (const row of inputs.manifest)
      if (!sourceKeys.has(damageRefKey(row.artifact)))
        findings.push('Manifest source is not authorized.');
    for (const method of scope.approved_method_ids)
      if (!Object.hasOwn(DAMAGE_METHODS, method))
        findings.push('Unsupported method ID.');
    for (const method of [
      'damage.imported-quantity.v1',
      'damage.declared-unit-value.v1',
      'damage.accounting.v1',
    ])
      if (!scope.approved_method_ids.includes(method))
        findings.push('Required accounting method is not approved.');
    const physical: DamageComponents['damage.physical']['totals'] = [];
    const lines: DamageComponents['damage.welfare']['lines'] = [];
    const excluded: string[] = [];
    const welfare = inputs.scenarios.map((s) => ({
      scenario_id: s.scenario_id,
      amount: 0,
      currency: scope.currency,
      price_year: scope.price_year,
    }));
    const financial = structuredClone(welfare);
    const boundary = structuredClone(welfare);
    const selected = new Set<string>();
    const componentSelection = new Set<string>();
    const unitsByEndpoint = new Map<string, string>();
    for (const value of inputs.unit_values)
      if (
        value.method_id !== 'damage.declared-unit-value.v1' ||
        !scope.approved_method_ids.includes(value.method_id) ||
        value.currency !== scope.currency ||
        value.price_year !== scope.price_year ||
        value.valuation_date !== scope.valuation_date ||
        canonicalJson(value.horizon) !== canonicalJson(scope.effect_period)
      )
        findings.push(
          `Unit value ${value.unit_value_id} has incompatible method, currency, year, date or horizon.`,
        );
    for (const effect of inputs.effects) {
      if (
        unitsByEndpoint.has(effect.endpoint_id) &&
        unitsByEndpoint.get(effect.endpoint_id) !== effect.unit
      )
        findings.push('One endpoint mixes physical units.');
      unitsByEndpoint.set(effect.endpoint_id, effect.unit);
      if (
        !scope.endpoints.includes(effect.endpoint_id) ||
        !scope.countries.includes(effect.geography) ||
        canonicalJson(effect.period) !== canonicalJson(scope.effect_period) ||
        effect.baseline_id !== scope.baseline_scenario_id ||
        !inputs.scenarios.some((s) => s.scenario_id === effect.scenario_id)
      )
        findings.push(
          `Effect ${effect.effect_id} conflicts with scope or scenario.`,
        );
      const coverage = inputs.coverage.find(
        (c) =>
          c.endpoint_id === effect.endpoint_id &&
          c.geography === effect.geography &&
          c.population_stratum === effect.population_stratum,
      );
      if (
        !coverage ||
        (coverage.status !== effect.status &&
          coverage.status !== 'available') ||
        (effect.included &&
          effect.quantity !== null &&
          effect.accounting_lens === 'social_welfare' &&
          !coverage.monetary_inclusion)
      )
        findings.push(`Effect ${effect.effect_id} has incompatible coverage.`);
      if (
        !effect.included ||
        effect.quantity === null ||
        effect.accounting_lens === 'physical_only'
      )
        excluded.push(effect.effect_id);
      if (!effect.included || effect.quantity === null) continue;
      const overlapKey = [
        effect.scenario_id,
        effect.geography,
        effect.population_stratum,
        effect.overlap_group,
      ].join('|');
      if (selected.has(overlapKey))
        findings.push('Selected effects contain an overlapping path.');
      selected.add(overlapKey);
      const total = physical.find(
        (t) =>
          t.scenario_id === effect.scenario_id &&
          t.endpoint_id === effect.endpoint_id &&
          t.unit === effect.unit,
      );
      if (total) total.quantity += effect.quantity;
      else
        physical.push({
          scenario_id: effect.scenario_id,
          endpoint_id: effect.endpoint_id,
          unit: effect.unit,
          quantity: effect.quantity,
        });
      if (effect.accounting_lens === 'physical_only') continue;
      const unitValue = inputs.unit_values.find(
        (v) => v.unit_value_id === effect.unit_value_id,
      );
      if (!unitValue || unitValue.compatible_unit !== effect.unit) {
        findings.push(
          `Effect ${effect.effect_id} has incompatible unit value.`,
        );
        continue;
      }
      for (const component of unitValue.included_components) {
        const componentKey = [
          effect.scenario_id,
          effect.geography,
          effect.population_stratum,
          component,
        ].join('|');
        if (componentSelection.has(componentKey))
          findings.push(
            'Selected valuations repeat an included semantic component.',
          );
        componentSelection.add(componentKey);
      }
      const money = effect.quantity * unitValue.amount;
      lines.push({
        effect_id: effect.effect_id,
        scenario_id: effect.scenario_id,
        unit_value_id: unitValue.unit_value_id,
        quantity: effect.quantity,
        quantity_unit: effect.unit,
        unit_value: unitValue.amount,
        amount: money,
      });
      const subtotal = welfare.find(
        (t) => t.scenario_id === effect.scenario_id,
      );
      if (subtotal) subtotal.amount += money;
      const shares = inputs.incidence.filter(
        (e) =>
          e.effect_id === effect.effect_id &&
          e.financing_type === 'resource_financing',
      );
      if (
        shares.length &&
        !close(
          shares.reduce((sum, entry) => sum + entry.amount, 0),
          money,
        )
      )
        findings.push(
          'Financing shares do not equal the single resource cost.',
        );
    }
    for (const entry of inputs.incidence) {
      const effect = inputs.effects.find(
        (e) => e.effect_id === entry.effect_id,
      );
      if (
        !effect ||
        !effect.included ||
        effect.quantity === null ||
        entry.payer === entry.recipient
      ) {
        findings.push(
          'Incidence has an unlinked resource or unbalanced transfer.',
        );
        continue;
      }
      if (
        entry.currency !== scope.currency ||
        entry.price_year !== scope.price_year ||
        entry.payer_in_boundary !==
          scope.social_boundary_members.includes(entry.payer) ||
        entry.recipient_in_boundary !==
          scope.social_boundary_members.includes(entry.recipient)
      )
        findings.push(
          'Incidence currency/year or boundary membership is incompatible.',
        );
      if (entry.financing_type === 'resource_financing') {
        if (
          effect.accounting_lens !== 'social_welfare' ||
          !effect.unit_value_id
        )
          findings.push('Resource financing lacks a compatible valued effect.');
        const subtotal = financial.find(
          (t) => t.scenario_id === effect.scenario_id,
        );
        if (subtotal) subtotal.amount += entry.amount;
      } else {
        const signed =
          entry.payer_in_boundary === entry.recipient_in_boundary
            ? 0
            : entry.payer_in_boundary
              ? entry.amount
              : -entry.amount;
        const subtotal = boundary.find(
          (t) => t.scenario_id === effect.scenario_id,
        );
        if (subtotal) subtotal.amount += signed;
        const loss = welfare.find((t) => t.scenario_id === effect.scenario_id);
        if (loss) loss.amount += signed;
      }
    }
    const coverage = structuredClone(inputs.coverage);
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
      if (!coverage.some((c) => c.endpoint_id === endpoint))
        for (const geography of scope.countries)
          coverage.push({
            endpoint_id: endpoint,
            geography,
            population_stratum: scope.population,
            status: 'not_estimated',
            origin: 'imported',
            monetary_inclusion: false,
            reason:
              'No imported endpoint support; withheld rather than set to zero.',
          });
    const availableEndpoints = new Set(
      inputs.coverage
        .filter((c) => ['available', 'true_zero'].includes(c.status))
        .map((c) => c.endpoint_id),
    );
    const partial =
      inputs.effects.some(
        (e) => e.quantity === null && e.status !== 'not_applicable',
      ) ||
      inputs.coverage.some(
        (c) => !['available', 'true_zero', 'not_applicable'].includes(c.status),
      ) ||
      scope.endpoints.some((e) => !availableEndpoints.has(e));
    const status = physical.length
      ? partial
        ? 'partial'
        : 'complete_for_declared_imported_scope'
      : 'gap';
    const categories = structuredClone(inputs.source_fire_categories);
    for (const category of [
      'direct_assets',
      'crops',
      'peat',
      'ecosystems',
      'climate',
    ])
      if (!categories.some((c) => c.category === category))
        categories.push({
          category,
          status: 'not_estimated',
          reason:
            'Source-fire extension is explicit but no registered empirical method or reviewed input is available in this MVP.',
        });
    const comparisons: DamageComponents['damage.scenarios']['comparisons'] = [];
    if (
      inputs.scenarios.find(
        (s) => s.scenario_id === scope.historical_scenario_id,
      )?.kind !== 'historical'
    )
      findings.push('Historical scenario declaration is missing.');
    for (const s of inputs.scenarios) {
      if (s.kind === 'historical') {
        if (s.scenario_id !== scope.historical_scenario_id)
          findings.push('Multiple historical scenarios.');
        continue;
      }
      const baseline = welfare.find((t) => t.scenario_id === s.comparator_id);
      const residual = welfare.find((t) => t.scenario_id === s.scenario_id);
      if (!baseline || !residual) {
        findings.push('Scenario comparator is unavailable.');
        continue;
      }
      if (
        s.kind === 'project' &&
        !scope.approved_method_ids.includes('damage.project-scenario.v1')
      )
        findings.push('Project scenario method is not approved.');
      const signature = (scenarioId: string) =>
        inputs.effects
          .filter((e) => e.included && e.scenario_id === scenarioId)
          .map((e) =>
            [
              e.endpoint_id,
              e.geography,
              e.population_stratum,
              e.unit,
              e.accounting_lens,
            ].join('|'),
          )
          .sort();
      if (
        canonicalJson(signature(s.scenario_id)) !==
        canonicalJson(signature(s.comparator_id))
      )
        findings.push(
          'Scenario coverage does not match its comparator; omissions are not avoided damage.',
        );
      if (
        s.project_cost &&
        (s.project_cost.currency !== scope.currency ||
          s.project_cost.price_year !== scope.price_year)
      )
        findings.push('Project cost uses incompatible currency or price year.');
      const supportsMoney = (scenarioId: string) =>
        lines.some((line) => line.scenario_id === scenarioId) ||
        inputs.incidence.some(
          (entry) =>
            entry.financing_type === 'transfer' &&
            inputs.effects.find(
              (effect) => effect.effect_id === entry.effect_id,
            )?.scenario_id === scenarioId,
        );
      const comparisonMissing =
        partial ||
        !supportsMoney(s.scenario_id) ||
        !supportsMoney(s.comparator_id);
      const avoided = comparisonMissing
        ? null
        : baseline.amount - residual.amount;
      const cost = s.project_cost ? s.project_cost.amount : null;
      comparisons.push({
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
        avoided_damage: avoided,
        project_cost: cost,
        net_benefit: cost === null || avoided === null ? null : avoided - cost,
        benefit_cost_ratio:
          cost !== null && cost > 0 && avoided !== null ? avoided / cost : null,
        currency: scope.currency,
        price_year: scope.price_year,
        excludes_cash_return_claim: true,
      });
    }
    const supportedWelfare = welfare.filter(
      (total) =>
        lines.some((line) => line.scenario_id === total.scenario_id) ||
        inputs.incidence.some(
          (entry) =>
            entry.financing_type === 'transfer' &&
            inputs.effects.find(
              (effect) => effect.effect_id === entry.effect_id,
            )?.scenario_id === total.scenario_id,
        ),
    );
    const supportedFinancing = financial.filter((total) =>
      inputs.incidence.some(
        (entry) =>
          entry.financing_type === 'resource_financing' &&
          inputs.effects.find((effect) => effect.effect_id === entry.effect_id)
            ?.scenario_id === total.scenario_id,
      ),
    );
    const supportedBoundary = boundary.filter((total) =>
      inputs.incidence.some(
        (entry) =>
          entry.financing_type === 'transfer' &&
          inputs.effects.find((effect) => effect.effect_id === entry.effect_id)
            ?.scenario_id === total.scenario_id,
      ),
    );
    const expected: DamageComponents = {
      'damage.scope': scope,
      'damage.inputs': inputs,
      'damage.physical': {
        schema_version: 'haze.damage.physical.v1',
        account_id: scope.account_id,
        effects: inputs.effects,
        totals: physical,
      },
      'damage.welfare': {
        schema_version: 'haze.damage.welfare.v1',
        account_id: scope.account_id,
        accounting_lens: 'selected_social_welfare',
        lines,
        totals: supportedWelfare,
        excluded_effect_ids: excluded,
      },
      'damage.incidence': {
        schema_version: 'haze.damage.incidence.v1',
        account_id: scope.account_id,
        accounting_lens: 'financial_incidence',
        entries: inputs.incidence,
        financing_totals: supportedFinancing,
        net_boundary_transfers: supportedBoundary,
      },
      'damage.coverage': {
        schema_version: 'haze.damage.coverage.v1',
        account_id: scope.account_id,
        status,
        entries: coverage,
        omissions,
        limitations: inputs.limitations,
      },
      'damage.overlap': {
        schema_version: 'haze.damage.overlap.v1',
        account_id: scope.account_id,
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
        account_id: scope.account_id,
        categories,
      },
      'damage.methods': {
        schema_version: 'haze.damage.methods.v1',
        account_id: scope.account_id,
        methods: scope.approved_method_ids.map((method_id) => ({
          method_id,
          version: '1',
          description:
            DAMAGE_METHODS[method_id as keyof typeof DAMAGE_METHODS] ??
            'Unsupported',
        })),
        limitations: inputs.limitations,
      },
      'damage.scenarios': {
        schema_version: 'haze.damage.scenarios.v1',
        account_id: scope.account_id,
        scenarios: inputs.scenarios,
        comparisons,
      },
    };
    for (const kind of Object.keys(expected) as DamageComponentKind[]) {
      equal(proposed[kind], expected[kind], kind);
      if (refs && contractHash(proposed[kind]) !== refs[kind]?.sha256)
        findings.push(`${kind} does not match its pinned component hash.`);
    }
    if (account) {
      if (!refs)
        findings.push('Manifest checking requires exact component references.');
      const manifest = damageAccountSchema.safeParse(account);
      if (!manifest.success)
        findings.push('Account manifest schema is invalid.');
      else if (refs)
        equal(
          {
            ...manifest.data,
            component_refs: [...manifest.data.component_refs].sort((a, b) =>
              a.kind.localeCompare(b.kind),
            ),
          },
          {
            schema_version: 'haze.damage.account.v1',
            account_id: scope.account_id,
            scope,
            status,
            evidence_origin: inputs.effects.some(
              (e) => e.origin === 'synthetic',
            )
              ? 'synthetic'
              : 'imported',
            component_refs: (Object.keys(expected) as DamageComponentKind[])
              .map((kind) => ({ kind, artifact: refs[kind] }))
              .sort((a, b) => a.kind.localeCompare(b.kind)),
            source_refs: inputs.source_refs,
            physical_totals: physical,
            financing_totals: supportedFinancing,
            welfare_totals: supportedWelfare,
            coverage,
            omissions,
            scenarios: comparisons,
            limitations: inputs.limitations,
            review_status: 'requires_independent_review',
          },
          'Account manifest',
        );
    }
  } catch (error) {
    findings.push(
      `Independent reconstruction could not complete: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Component ordering has no accounting significance; manifest ordering is normalized above.
  return damageCheckSchema.parse({
    schema_version: 'haze.damage.check.v1',
    valid: findings.length === 0,
    checks,
    findings: [...new Set(findings)].slice(0, 256),
    limitations: inputs.limitations,
    applicability: 'not_established_by_arithmetic',
  });
}

/** Reconstructs bridge deltas directly from original rows, without invoking publication or producer arithmetic. */
export function independentlyCheckDamageRevisionBridge(
  previous: DamageRevisionInput,
  current: DamageRevisionInput,
  proposed: DamageRevisionBridge,
): DamageCheck {
  const findings: string[] = [];
  const checks = [
    'Exact previous/current account hashes and source references',
    'Independent selected effect and boundary-transfer totals',
    'Independent quantity, coverage, method and value decomposition',
    'Declared price basis and applicability warning',
  ];
  const parsed = damageRevisionBridgeSchema.safeParse(proposed);
  try {
    if (!parsed.success) throw new Error('Revision bridge schema is invalid.');
    const bridge = parsed.data;
    for (const record of [previous, current]) {
      damageInputsSchema.parse(record.inputs);
      damageAccountSchema.parse(record.account);
      if (contractHash(record.account) !== record.artifact.sha256)
        findings.push('Revision account hash mismatch.');
      if (
        canonicalJson(record.account.scope) !==
          canonicalJson(record.inputs.scope) ||
        canonicalJson(record.account.source_refs) !==
          canonicalJson(record.inputs.source_refs)
      )
        findings.push(
          'Revision account scope/sources do not match original inputs.',
        );
    }
    if (
      previous.inputs.scope.currency !== current.inputs.scope.currency ||
      previous.account.account_id !== current.account.account_id ||
      previous.inputs.scope.event_id !== current.inputs.scope.event_id ||
      damageRefKey(previous.artifact) === damageRefKey(current.artifact)
    )
      findings.push(
        'Revision account identity, currency or distinct-reference requirement failed.',
      );
    if (
      canonicalJson(bridge.previous_account) !==
        canonicalJson(previous.artifact) ||
      canonicalJson(bridge.current_account) !== canonicalJson(current.artifact)
    )
      findings.push('Revision bridge account references are not exact.');
    const sources = [
      ...new Map(
        [...previous.inputs.source_refs, ...current.inputs.source_refs].map(
          (ref) => [damageRefKey(ref), ref],
        ),
      ).values(),
    ];
    if (canonicalJson(sources) !== canonicalJson(bridge.source_refs))
      findings.push('Revision bridge original source closure differs.');
    if (
      bridge.currency !== current.inputs.scope.currency ||
      bridge.previous_price_year !== previous.inputs.scope.price_year ||
      bridge.current_price_year !== current.inputs.scope.price_year ||
      bridge.account_id !== current.account.account_id
    )
      findings.push('Revision bridge price or account basis differs.');
    const economic = (record: DamageRevisionInput) =>
      record.inputs.effects
        .filter(
          (e) =>
            e.included &&
            e.quantity !== null &&
            e.accounting_lens === 'social_welfare',
        )
        .map((e) => ({
          effect: e,
          value: record.inputs.unit_values.find(
            (v) => v.unit_value_id === e.unit_value_id,
          )!,
        }));
    const oldRows = economic(previous),
      newRows = economic(current);
    const scenarioIds = [
      ...new Set(
        [...previous.inputs.scenarios, ...current.inputs.scenarios].map(
          (s) => s.scenario_id,
        ),
      ),
    ];
    const total = (
      record: DamageRevisionInput,
      rows: ReturnType<typeof economic>,
      scenario: string,
    ) => {
      let result = 0;
      for (const row of rows)
        if (row.effect.scenario_id === scenario)
          result += row.effect.quantity! * row.value.amount;
      for (const payment of record.inputs.incidence)
        if (
          payment.financing_type === 'transfer' &&
          record.inputs.effects.find((e) => e.effect_id === payment.effect_id)
            ?.scenario_id === scenario
        )
          result +=
            (payment.payer_in_boundary ? payment.amount : 0) -
            (payment.recipient_in_boundary ? payment.amount : 0);
      return result;
    };
    const expected = scenarioIds.map((scenario_id) => {
      const previous_total = total(previous, oldRows, scenario_id),
        current_total = total(current, newRows, scenario_id);
      const change = {
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
      const prior = oldRows.filter((r) => r.effect.scenario_id === scenario_id);
      const next = newRows.filter((r) => r.effect.scenario_id === scenario_id);
      const grain = (r: (typeof prior)[number]) =>
        canonicalJson([
          r.effect.scenario_id,
          r.effect.endpoint_id,
          r.effect.geography,
          r.effect.population_stratum,
          r.effect.unit,
          r.effect.baseline_id,
          r.effect.period,
        ]);
      const matched = new Set<string>();
      for (const newer of next) {
        const older = prior.find(
          (r) =>
            r.effect.effect_id === newer.effect.effect_id &&
            grain(r) === grain(newer),
        );
        if (!older) {
          change.coverage += newer.effect.quantity! * newer.value.amount;
          continue;
        }
        matched.add(older.effect.effect_id);
        if (
          older.effect.causal_method !== newer.effect.causal_method ||
          older.value.method_id !== newer.value.method_id ||
          older.value.method_version !== newer.value.method_version
        )
          change.methods +=
            newer.effect.quantity! * newer.value.amount -
            older.effect.quantity! * older.value.amount;
        else {
          change.values +=
            newer.effect.quantity! * (newer.value.amount - older.value.amount);
          change.quantities +=
            older.value.amount *
            (newer.effect.quantity! - older.effect.quantity!);
        }
      }
      for (const older of prior)
        if (!matched.has(older.effect.effect_id))
          change.coverage -= older.effect.quantity! * older.value.amount;
      change.boundary_and_incidence =
        change.total_change -
        change.quantities -
        change.coverage -
        change.methods -
        change.values;
      if (Math.abs(change.boundary_and_incidence) < 1e-8)
        change.boundary_and_incidence = 0;
      for (const record of [previous, current]) {
        const fromAccount =
          record.account.welfare_totals.find(
            (t) => t.scenario_id === scenario_id,
          )?.amount ?? 0;
        if (
          Math.abs(
            fromAccount -
              total(
                record,
                record === previous ? oldRows : newRows,
                scenario_id,
              ),
          ) > 1e-7
        )
          findings.push(
            'Revision account selected total does not reconcile independently.',
          );
      }
      return change;
    });
    if (canonicalJson(expected) !== canonicalJson(bridge.changes))
      findings.push(
        'Revision bridge contributions or totals differ from independent reconstruction.',
      );
    if (
      previous.inputs.scope.price_year !== current.inputs.scope.price_year &&
      !bridge.limitations.some((s) =>
        s.includes('not been inflation-normalized'),
      )
    )
      findings.push('Mixed price basis warning is missing.');
    if (
      !bridge.limitations.some((s) =>
        s.includes('not observed changes in haze'),
      )
    )
      findings.push('Accounting change applicability warning is missing.');
  } catch (error) {
    findings.push(error instanceof Error ? error.message : String(error));
  }
  return damageCheckSchema.parse({
    schema_version: 'haze.damage.check.v1',
    valid: findings.length === 0,
    checks,
    findings: [...new Set(findings)],
    limitations: [
      'A reconciled revision bridge does not establish empirical trend, attribution, applicability or legal responsibility.',
    ],
    applicability: 'not_established_by_arithmetic',
  });
}
