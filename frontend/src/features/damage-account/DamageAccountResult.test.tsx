import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  DamageAccount,
  DamageEffect,
} from '../../../../app/contracts/damage-account.ts';
import type { ArtifactReviewCheck } from '../../../../app/contracts/manager.ts';
import { artifactRef } from '../../services/agents/testFixtures.ts';
import {
  DamageAccountResult,
  damageArtifactReview,
} from './DamageAccountResult.tsx';

const period = { start: '2026-01-01', end: '2026-01-31' };
const kinds = [
  'damage.scope',
  'damage.inputs',
  'damage.coverage',
  'damage.physical',
  'damage.incidence',
  'damage.welfare',
  'damage.overlap',
  'damage.source-fire-extension',
  'damage.methods',
] as const;
function accountFixture(): DamageAccount {
  return {
    schema_version: 'haze.damage.account.v1',
    account_id: 'example-account',
    scope: {
      schema_version: 'haze.damage.scope.v1',
      account_id: 'example-account',
      event_id: 'example-event',
      intended_use: 'Synthetic imported-input accounting example',
      source_scope: 'Invented source',
      smoke_boundary: 'Invented smoke boundary',
      source_fire_boundary: 'Not estimated',
      countries: ['Example country'],
      social_boundary_members: ['households'],
      population: 'Example population',
      emissions_period: period,
      effect_period: period,
      valuation_date: '2026-02-01',
      currency: 'CU',
      price_year: 2026,
      endpoints: ['mortality'],
      historical_scenario_id: 'historical',
      baseline_scenario_id: 'baseline',
      approved_method_ids: ['declared-unit-value'],
      presentation_decimal_places: 3,
    },
    status: 'partial',
    evidence_origin: 'synthetic',
    component_refs: kinds.map((kind, index) => ({
      kind,
      artifact: {
        ...artifactRef,
        id: `${String(index + 1).repeat(8)}-1111-4111-8111-111111111111`,
      },
    })),
    source_refs: [artifactRef],
    physical_totals: [
      {
        scenario_id: 'historical',
        endpoint_id: 'mortality',
        unit: 'expected_deaths',
        quantity: 9.717,
      },
    ],
    financing_totals: [
      {
        scenario_id: 'historical',
        amount: 530000,
        currency: 'CU',
        price_year: 2026,
      },
    ],
    welfare_totals: [
      {
        scenario_id: 'historical',
        amount: 21530000,
        currency: 'CU',
        price_year: 2026,
      },
    ],
    coverage: [
      {
        endpoint_id: 'ecosystems',
        geography: 'Example country',
        population_stratum: 'Example population',
        status: 'not_estimated',
        origin: 'synthetic',
        monetary_inclusion: false,
        reason: 'No ecosystem quantities supplied.',
      },
      {
        endpoint_id: 'worker_days',
        geography: 'Example country',
        population_stratum: 'Protected subgroup',
        status: 'disclosure_suppressed',
        origin: 'imported',
        monetary_inclusion: false,
        reason: 'Suppressed to protect disclosure.',
      },
    ],
    omissions: [],
    scenarios: [],
    limitations: ['Sensitivity bounds exclude unmeasured harm.'],
    review_status: 'requires_independent_review',
  };
}
function checksFor(account: DamageAccount): ArtifactReviewCheck[] {
  return account.component_refs.map(({ artifact }) => ({
    artifact,
    producer_assignment_id: artifact.id,
    producer_revision: 1,
    verdict: 'supported',
    limitations: [],
  }));
}
function renderAccount(
  account = accountFixture(),
  options: Record<string, unknown> = {},
) {
  return renderToStaticMarkup(
    createElement(DamageAccountResult, {
      content: account,
      reviewStatus: 'supported',
      checks: checksFor(account),
      ...options,
    }),
  );
}
describe('schema-validated damage account rendering', () => {
  it('shows the three server accounting views, missingness, synthetic origin and exact sources', () => {
    const markup = renderAccount();
    for (const text of [
      'Physical outcomes',
      'Financial incidence',
      'Selected social welfare',
      '9.717',
      '21530000',
      '530000',
      'not estimated',
      'disclosure suppressed',
      'synthetic fixture',
      'Sensitivity bounds exclude unmeasured harm.',
      'SHA-256',
      'version 1',
    ])
      expect(markup).toContain(text);
    expect(markup).toContain(`/api/artifacts/${artifactRef.id}`);
    expect(markup).toContain('No ecosystem quantities supplied.');
    expect(markup).not.toContain('current supported subtotal');
  });
  it('withholds numerical totals for rejected, unreviewed or wrongly pinned component dependencies', () => {
    const account = accountFixture();
    const checks = checksFor(account);
    const physical = checks.find(
      (check) => check.artifact.id === account.component_refs[3].artifact.id,
    )!;
    for (const verdict of ['rejected', 'needs_review'] as const) {
      physical.verdict = verdict;
      const markup = renderAccount(account, { checks });
      expect(markup).toContain('Account totals withheld');
      expect(markup).not.toContain('21530000');
      expect(markup).not.toContain('9.717');
    }
    physical.verdict = 'supported';
    physical.artifact = { ...physical.artifact, version: 2 };
    expect(renderAccount(account, { checks })).not.toContain('21530000');
    physical.artifact = {
      ...account.component_refs[3].artifact,
      sha256: 'b'.repeat(64),
    };
    expect(renderAccount(account, { checks })).not.toContain('21530000');
    expect(renderAccount(account, { reviewStatus: 'rejected' })).not.toContain(
      '21530000',
    );
    expect(
      renderAccount(account, { reviewStatus: 'needs_review' }),
    ).not.toContain('21530000');
  });
  it('retains reviewed historical values while clearly separating stale currency', () => {
    const markup = renderAccount(accountFixture(), { stale: true });
    expect(markup).toContain('Historical component');
    expect(markup).toContain('stale for the current task');
    expect(markup).toContain('not a current supported subtotal');
    expect(markup).toContain('21530000');
  });
  it('requires the physical, incidence and welfare components and renders only server appraisal metrics', () => {
    const account = accountFixture();
    account.component_refs[3] = {
      ...account.component_refs[3],
      kind: 'damage.scope',
    };
    expect(renderAccount(account)).not.toContain('21530000');
    const appraisal = accountFixture();
    appraisal.component_refs.push({
      kind: 'damage.scenarios',
      artifact: { ...artifactRef, id: 'aaaaaaaa-1111-4111-8111-111111111111' },
    });
    appraisal.scenarios.push({
      scenario_id: 'project',
      comparator_id: 'historical',
      interpretation: 'achievable_project_benefit',
      status: 'available',
      limitation: null,
      avoided_damage: 4570000,
      project_cost: 1000000,
      net_benefit: 3570000,
      benefit_cost_ratio: 4.57,
      currency: 'CU',
      price_year: 2026,
      excludes_cash_return_claim: true,
    });
    const markup = renderAccount(appraisal);
    expect(markup).toContain('4570000');
    expect(markup).toContain('1000000');
    expect(markup).toContain('3570000');
    expect(markup).toContain('4.57');
    expect(markup).toContain('Net benefit');
    expect(markup).toContain('Benefit / cost ratio');
  });
  it('uses a generic fallback for an unknown version and rejects missingness disguised as zero', () => {
    expect(
      renderAccount({
        ...accountFixture(),
        schema_version: 'haze.damage.account.v2',
      } as unknown as DamageAccount),
    ).toContain('does not match a supported schema');
    expect(
      renderToStaticMarkup(
        createElement(DamageAccountResult, {
          kind: 'generic.analysis',
          content: { answer: 'Generic' },
        }),
      ),
    ).toBe('');
    const content = {
      schema_version: 'haze.damage.physical.v1',
      account_id: 'example-account',
      effects: [effectFixture({ quantity: 0, status: 'unavailable' })],
      totals: [],
    };
    expect(
      renderToStaticMarkup(
        createElement(DamageAccountResult, {
          kind: 'damage.physical',
          content,
        }),
      ),
    ).toContain('does not match a supported schema');
  });
  it('shows endpoint uncertainty interpretation, origin and suppressed values without browser calculations', () => {
    const content = {
      schema_version: 'haze.damage.physical.v1',
      account_id: 'example-account',
      effects: [
        effectFixture(),
        effectFixture({
          effect_id: 'suppressed',
          status: 'disclosure_suppressed',
          quantity: null,
        }),
      ],
      totals: [],
    };
    const markup = renderToStaticMarkup(
      createElement(DamageAccountResult, {
        kind: 'damage.physical',
        content,
        reviewStatus: 'supported',
      }),
    );
    expect(markup).toContain('9.717 expected_deaths');
    expect(markup).toContain('sensitivity range');
    expect(markup).toContain('Declared sensitivity only');
    expect(markup).toContain('disclosure suppressed');
    expect(markup).toContain('Not estimated');
    expect(markup).toContain('imported');
    const rejected = renderToStaticMarkup(
      createElement(DamageAccountResult, {
        kind: 'damage.physical',
        content,
        reviewStatus: 'rejected',
      }),
    );
    expect(rejected).not.toContain('9.717');
    expect(rejected).toContain('Withheld');
  });
  it('reveals suppressed effects even when a broad coverage table is available, while keeping a true zero numeric', () => {
    const account = accountFixture();
    account.coverage = [
      {
        endpoint_id: 'worker_days',
        geography: 'Example country',
        population_stratum: 'Protected subgroup',
        status: 'available',
        origin: 'imported',
        monetary_inclusion: false,
        reason: 'The broad imported table is available.',
      },
    ];
    account.omissions = [
      {
        effect_id: 'suppressed-worker-days',
        endpoint_id: 'worker_days',
        scenario_id: 'historical',
        geography: 'Example country',
        population_stratum: 'Protected subgroup',
        unit: 'worker_days',
        status: 'disclosure_suppressed',
        origin: 'imported',
        reason: 'The subgroup quantity is suppressed, not zero.',
        uncertainty: {
          interpretation: 'not_quantified',
          basis: 'Suppressed quantity has no numeric uncertainty interval.',
        },
        source_refs: [artifactRef],
      },
    ];
    const coverage = {
      schema_version: 'haze.damage.coverage.v1',
      account_id: account.account_id,
      status: account.status,
      entries: account.coverage,
      omissions: account.omissions,
      limitations: [],
    };
    const coverageMarkup = renderToStaticMarkup(
      createElement(DamageAccountResult, {
        kind: 'damage.coverage',
        content: coverage,
      }),
    );
    for (const markup of [renderAccount(account), coverageMarkup]) {
      expect(markup).toContain('The broad imported table is available.');
      expect(markup).toContain('Omitted effects by scenario');
      expect(markup).toContain('suppressed-worker-days / historical');
      expect(markup).toContain('disclosure suppressed / imported');
      expect(markup).toContain(
        'The subgroup quantity is suppressed, not zero.',
      );
      expect(markup).toContain(
        'Suppressed quantity has no numeric uncertainty interval.',
      );
      expect(markup).toContain(`/api/artifacts/${artifactRef.id}`);
    }
    const physicalMarkup = renderToStaticMarkup(
      createElement(DamageAccountResult, {
        kind: 'damage.physical',
        reviewStatus: 'supported',
        content: {
          schema_version: 'haze.damage.physical.v1',
          account_id: account.account_id,
          effects: [
            effectFixture({
              effect_id: 'confirmed-zero',
              quantity: 0,
              status: 'true_zero',
              uncertainty: {
                interpretation: 'not_quantified',
                basis: 'An explicit true zero was supplied.',
              },
            }),
          ],
          totals: [],
        },
      }),
    );
    expect(physicalMarkup).toContain('0 expected_deaths / true zero');
    expect(physicalMarkup).toContain('An explicit true zero was supplied.');
  });
  it('keeps older saved accounts without an omissions field readable', () => {
    const legacy = accountFixture();
    Reflect.deleteProperty(legacy, 'omissions');
    const markup = renderAccount(legacy);
    expect(markup).toContain('Selected social welfare');
    expect(markup).toContain('21530000');
    expect(markup).not.toContain('does not match a supported schema');
    expect(markup).not.toContain('Omitted effect records');
  });
  it('gives exact rejected checks precedence over a supported check', () => {
    const supported = checksFor(accountFixture())[0];
    expect(
      damageArtifactReview(supported.artifact, [
        supported,
        { ...supported, verdict: 'rejected' },
      ]),
    ).toBe('rejected');
  });
  it('labels metadata without mandatory review separately from numerical components', () => {
    expect(damageArtifactReview(artifactRef, [], 'damage.scope')).toBe(
      'not_required',
    );
    expect(damageArtifactReview(artifactRef, [], 'damage.welfare')).toBe(
      'needs_review',
    );
    expect(
      damageArtifactReview(artifactRef, [], 'damage.revision-bridge'),
    ).toBe('needs_review');
  });
  it('renders exact reviewer identity and objections from the versioned review artifact', () => {
    const markup = renderToStaticMarkup(
      createElement(DamageAccountResult, {
        kind: 'damage.review',
        content: {
          schema_version: 'haze.damage.review.v1',
          verdict: 'rejected',
          reviewed_artifacts: [artifactRef],
          checks: ['Reconstructed selected totals.'],
          findings: ['Scope applicability unresolved.'],
          limitations: [
            'Arithmetic does not establish scientific applicability.',
          ],
          applicability: 'not_established_by_arithmetic',
          reviewer: { assignment_id: artifactRef.id, revision: 3 },
        },
      }),
    );
    expect(markup).toContain('Arithmetic: rejected');
    expect(markup).toContain('revision 3');
    expect(markup).toContain('Scope applicability unresolved.');
    expect(markup).toContain(`/api/artifacts/${artifactRef.id}`);
  });
  it('keeps revision decomposition distinct from observed haze and withholds unreviewed amounts', () => {
    const content = {
      schema_version: 'haze.damage.revision-bridge.v1',
      account_id: 'example-account',
      previous_account: artifactRef,
      current_account: { ...artifactRef, version: 2 },
      source_refs: [],
      currency: 'CU',
      previous_price_year: 2025,
      current_price_year: 2026,
      comparison_basis: 'declared_accounting_bases_not_observed_haze_change',
      changes: [
        {
          scenario_id: 'historical',
          previous_total: 21530000,
          current_total: 22000000,
          total_change: 470000,
          quantities: 100000,
          coverage: 200000,
          methods: 0,
          values: 170000,
          boundary_and_incidence: 0,
        },
      ],
      limitations: ['New price basis, not changed haze.'],
      applicability: 'not_established_by_arithmetic',
    };
    const markup = renderToStaticMarkup(
      createElement(DamageAccountResult, {
        kind: 'damage.revision-bridge',
        content,
        reviewStatus: 'supported',
      }),
    );
    expect(markup).toContain('not an observed change in haze');
    expect(markup).toContain('470000');
    expect(markup).toContain('Boundary / incidence');
    const pending = renderToStaticMarkup(
      createElement(DamageAccountResult, {
        kind: 'damage.revision-bridge',
        content,
      }),
    );
    expect(pending).toContain('Revision amounts withheld');
    expect(pending).not.toContain('470000');
  });
});

function effectFixture(overrides: Partial<DamageEffect> = {}): DamageEffect {
  return {
    effect_id: 'mortality',
    endpoint_id: 'mortality',
    scenario_id: 'historical',
    baseline_id: 'baseline',
    geography: 'Example country',
    period,
    population_stratum: 'Example population',
    quantity: 9.717,
    unit: 'expected_deaths',
    status: 'available',
    origin: 'imported',
    causal_method: 'Imported causal method',
    applicability: 'Applicability requires domain review.',
    uncertainty: {
      interpretation: 'sensitivity_range',
      basis: 'Declared sensitivity only',
      lower: 8,
      upper: 12,
    },
    accounting_lens: 'social_welfare',
    overlap_group: 'mortality',
    included: true,
    source_refs: [artifactRef],
    ...overrides,
  };
}
