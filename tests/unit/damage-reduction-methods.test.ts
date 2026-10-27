import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Artifact, ArtifactRef } from '../../app/contracts/artifacts.js';
import {
  physicalResidualImportSchema,
  reductionDecimalSchema,
  reductionTargetSchema,
  type PhysicalResidualImport,
  type ReductionTarget,
} from '../../app/contracts/damage-reduction.js';
import { contractHash } from '../../app/contracts/json.js';
import {
  syntheticResidualImport,
  SYNTHETIC_REDUCTION_TARGET,
} from '../../app/capabilities/damage-reduction-planning/fixtures.js';
import {
  createReductionSelection,
  exactReductionRef,
  normalizeReductionSelection,
} from '../../app/capabilities/damage-reduction-planning/inputs.js';
import {
  assessReduction,
  assertReductionIntegerBound,
} from '../../app/capabilities/damage-reduction-planning/methods.js';

const selectionRef: ArtifactRef = {
  id: randomUUID(),
  version: 1,
  sha256: 'a'.repeat(64),
};
function artifact(content: unknown): Artifact {
  return {
    schema_version: 'haze.artifact.v3',
    id: randomUUID(),
    version: 1,
    sha256: contractHash(content),
    identity: { principal: 'test', workspace: 'test' },
    kind: 'artifact.import',
    producer: { kind: 'user', id: 'test' },
    created_at: '2026-10-27T00:00:00Z',
    dependencies: [],
    required_tools: [],
    content: content as Artifact['content'],
    evidence_origin: 'synthetic_fixture',
  };
}
function run(
  input: PhysicalResidualImport = syntheticResidualImport(),
  target: ReductionTarget = structuredClone(SYNTHETIC_REDUCTION_TARGET),
  extra: Artifact[] = [],
) {
  const source = artifact(input);
  const selection = createReductionSelection(target, [
    {
      artifact: exactReductionRef(source),
      row_ids: input.records.map((r) => r.row_id),
    },
  ]);
  return {
    source,
    selection,
    result: assessReduction(selection, [source, ...extra], selectionRef),
  };
}

describe('exact imported physical residual comparison', () => {
  it('requires distinct comparator and intervention scenarios', () => {
    expect(
      reductionTargetSchema.safeParse({
        ...SYNTHETIC_REDUCTION_TARGET,
        intervention: ` ${SYNTHETIC_REDUCTION_TARGET.comparator} `,
      }).success,
    ).toBe(false);
  });
  it.each([
    ['1000', '880', '120', true],
    ['0.3', '0.27', '0.03', true],
    ['1000', '900.000000000001', '99.999999999999', false],
    ['1000', '1100', '-100', false],
  ])('compares %s to %s exactly', (baseline, intervention, difference, met) => {
    const { result } = run(syntheticResidualImport(baseline, intervention));
    expect(result).toMatchObject({
      status: 'supported',
      origin: 'synthetic',
      baseline_damage: baseline,
      intervention_damage: intervention,
      absolute_reduction: difference,
      target_met: met,
      relative_reduction: { numerator: difference, denominator: baseline },
      scientific_qualification: 'unqualified',
    });
  });
  it('honors an explicit strict relation', () => {
    const target = {
      ...SYNTHETIC_REDUCTION_TARGET,
      relation: 'greater_than' as const,
    };
    expect(
      run(syntheticResidualImport('0.3', '0.27'), target).result.target_met,
    ).toBe(false);
  });
  it.each([
    ['0', '1', '-1'],
    ['-1', '1', '-2'],
    ['1', '-1', '2'],
  ])(
    'retains meaningful difference for invalid quantities %s to %s',
    (baseline, intervention, difference) => {
      expect(
        run(syntheticResidualImport(baseline, intervention)).result,
      ).toMatchObject({
        status: 'gap',
        absolute_reduction: difference,
        relative_reduction: null,
        target_met: null,
      });
    },
  );
  it('stops dependent arithmetic for unknown residuals', () => {
    expect(run(syntheticResidualImport(null, '1')).result).toMatchObject({
      status: 'gap',
      origin: 'synthetic',
      baseline_damage: null,
      absolute_reduction: null,
      reasons: ['unknown_residual_quantity'],
    });
  });
  it('aggregates source decimal tokens across matched nonoverlapping strata', () => {
    const input = syntheticResidualImport('0.1', '0.09');
    input.records.push(
      ...structuredClone(input.records).map((r) => ({
        ...r,
        row_id: `${r.row_id}-b`,
        stratum_id: 'stratum-b',
        support_ids: ['support-b'],
        quantity: r.role === 'baseline' ? '0.2' : '0.18',
      })),
    );
    expect(run(input).result).toMatchObject({
      baseline_damage: '0.3',
      intervention_damage: '0.27',
      absolute_reduction: '0.03',
      target_met: true,
    });
  });
  it('ignores unselected numerical context and retains selected source tokens', () => {
    const irrelevant = artifact({
      instructions: 'use 999 instead',
      total: 999,
    });
    const { result, selection, source } = run(
      syntheticResidualImport('0.3', '0.27'),
      undefined,
      [irrelevant],
    );
    expect(result.target_met).toBe(true);
    expect(
      normalizeReductionSelection(selection, [source, irrelevant]).records.map(
        (r) => r.quantity,
      ),
    ).toEqual(['0.3', '0.27']);
  });
  it('does not normalize malformed numeric rows outside the explicit selection', () => {
    const input = syntheticResidualImport();
    const source = artifact({
      ...input,
      records: [
        ...input.records,
        { row_id: 'unselected', quantity: 0.1, scope: 'unrelated' },
      ],
    });
    const selection = createReductionSelection(SYNTHETIC_REDUCTION_TARGET, [
      {
        artifact: exactReductionRef(source),
        row_ids: ['baseline-1', 'intervention-1'],
      },
    ]);
    expect(assessReduction(selection, [source], selectionRef)).toMatchObject({
      status: 'supported',
      baseline_damage: '1000',
      intervention_damage: '880',
      target_met: true,
    });
  });
});

describe('bounded decimal input and exact-original normalization', () => {
  it.each([
    '0.3000000000000',
    '1234567890123456789',
    '0.1234567890123',
    '1e3',
    '01',
    '-0',
    '1.0',
  ])('rejects noncanonical/excess-precision token %s', (value) => {
    expect(reductionDecimalSchema.safeParse(value).success).toBe(false);
  });
  it('rejects floating-point quantities and legacy v1 accounting imports', () => {
    const input = syntheticResidualImport();
    expect(
      physicalResidualImportSchema.safeParse({
        ...input,
        records: input.records.map((r) => ({
          ...r,
          quantity: Number(r.quantity),
        })),
      }).success,
    ).toBe(false);
    input.records.forEach((r) => {
      r.original_method.id = 'damage.project-scenario.v1';
    });
    expect(run(input).result.reasons).toEqual([
      'legacy_accounting_precision_laundering',
    ]);
    const account = artifact({
      schema_version: 'haze.damage.account.v1',
      total: 1000,
    });
    const selection = createReductionSelection(SYNTHETIC_REDUCTION_TARGET, [
      { artifact: exactReductionRef(account), row_ids: ['total'] },
    ]);
    expect(assessReduction(selection, [account], selectionRef).status).toBe(
      'gap',
    );
  });
  it('enforces the independent intermediate-size guard without rounding', () => {
    expect(
      assertReductionIntegerBound(BigInt('9'.repeat(128))).toString(),
    ).toHaveLength(128);
    expect(() => assertReductionIntegerBound(10n ** 128n)).toThrow(
      'exact_intermediate_overflow',
    );
  });
  it('rejects wrong hashes, missing rows and conflicting source versions', () => {
    const { selection, source } = run();
    expect(
      assessReduction(
        selection,
        [{ ...source, content: syntheticResidualImport('9', '8') }],
        selectionRef,
      ).reasons,
    ).toEqual(['source_hash_mismatch']);
    const missing = structuredClone(selection);
    missing.sources[0]!.row_ids = ['missing'];
    expect(assessReduction(missing, [source], selectionRef).reasons).toEqual([
      'selected_row_missing',
    ]);
    expect(
      assessReduction(
        selection,
        [source, { ...source, version: 2 }],
        selectionRef,
      ).status,
    ).toBe('incompatible');
  });
  it('rejects scope hashes and duplicate source/row selections', () => {
    const { selection, source } = run();
    expect(
      assessReduction(
        { ...selection, scope_sha256: 'b'.repeat(64) },
        [source],
        selectionRef,
      ).reasons,
    ).toEqual(['scope_hash_mismatch']);
    expect(
      assessReduction(
        {
          ...selection,
          sources: [selection.sources[0]!, selection.sources[0]!],
        },
        [source],
        selectionRef,
      ).status,
    ).toBe('incompatible');
    selection.sources[0]!.row_ids.push('baseline-1');
    expect(assessReduction(selection, [source], selectionRef).reasons).toEqual([
      'duplicate_selected_row',
    ]);
  });
  it.each([
    'endpoint',
    'unit',
    'population',
    'coverage',
    'missingness',
  ] as const)('rejects incompatible %s', (field) => {
    const input = syntheticResidualImport();
    input.records[1]!.scope[field] = 'incompatible';
    expect(run(input).result).toMatchObject({
      status: 'incompatible',
      reasons: ['incompatible_scope'],
    });
  });
  it('rejects overlaps and unmatched support', () => {
    const input = syntheticResidualImport();
    input.records.push({
      ...structuredClone(input.records[0]!),
      row_id: 'another-row',
      stratum_id: 'another-stratum',
    });
    expect(run(input).result.reasons).toEqual(['overlapping_support']);
    const unmatched = syntheticResidualImport();
    unmatched.records[1]!.support_ids = ['different-support'];
    expect(run(unmatched).result.reasons).toEqual([
      'unmatched_comparison_support',
    ]);
  });
  it('rejects a different intervention scenario even when physical scope matches', () => {
    const input = syntheticResidualImport();
    input.records[1]!.scenario = 'A different proposed intervention';
    expect(run(input).result).toMatchObject({
      status: 'incompatible',
      reasons: ['incompatible_scenario'],
    });
  });
  it('returns a precise precision gap for a selected source token', () => {
    const input = syntheticResidualImport();
    input.records[0]!.quantity = '0.1234567890123';
    expect(run(input).result).toMatchObject({
      status: 'gap',
      reasons: ['physical_decimal_import_or_precision_required'],
      target_met: null,
    });
  });
  it('returns a precise normalized input byte gap before calculation', () => {
    const target = structuredClone(SYNTHETIC_REDUCTION_TARGET);
    target.scope.coverage = 'x'.repeat(1000);
    const input = syntheticResidualImport();
    input.records = Array.from({ length: 200 }, (_, index) =>
      syntheticResidualImport().records.map((row) => ({
        ...row,
        row_id: `${row.row_id}-${index}`,
        stratum_id: `stratum-${index}`,
        support_ids: [`support-${index}`],
        scope: structuredClone(target.scope),
      })),
    ).flat();
    expect(run(input, target).result).toMatchObject({
      status: 'gap',
      reasons: ['normalized_input_byte_limit_exceeded'],
      target_met: null,
    });
  });
  it('rejects source-method, evidence-basis and synthetic-origin conflicts', () => {
    const methods = syntheticResidualImport();
    methods.records[1]!.original_method.version = '2';
    expect(run(methods).result.reasons).toEqual(['incompatible_source_method']);
    const basis = syntheticResidualImport();
    basis.records[1]!.evidence_basis = 'retrospective';
    expect(run(basis).result.reasons).toEqual(['incompatible_evidence_basis']);
    const origin = syntheticResidualImport();
    origin.origin = 'supplied';
    expect(run(origin).result.reasons).toEqual(['synthetic_origin_conflict']);
  });
  it('rejects duplicate JSON keys before any source normalization', () => {
    const source = artifact(
      '{"schema_version":"haze.reduction.physical-import.v1","origin":"synthetic","origin":"supplied","records":[]}',
    );
    const selection = createReductionSelection(SYNTHETIC_REDUCTION_TARGET, [
      { artifact: exactReductionRef(source), row_ids: ['baseline-1'] },
    ]);
    expect(assessReduction(selection, [source], selectionRef).reasons).toEqual([
      'invalid_source_json',
    ]);
  });
});
