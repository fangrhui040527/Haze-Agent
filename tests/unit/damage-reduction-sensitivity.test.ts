import { describe, expect, it } from 'vitest';
import type { Artifact } from '../../app/contracts/artifacts.js';
import {
  reductionSensitivityRequestSchema,
  type ReductionSensitivityRequest,
} from '../../app/contracts/damage-reduction-sensitivity.js';
import type { PhysicalResidualImport } from '../../app/contracts/damage-reduction.js';
import { contractHash } from '../../app/contracts/json.js';
import { createReductionCapacityFixture } from '../../app/capabilities/damage-reduction-planning/capacity-fixtures.js';
import { analyzeReductionSensitivity } from '../../app/capabilities/damage-reduction-planning/sensitivity.js';
import {
  createReductionSelection,
  exactReductionRef,
} from '../../app/capabilities/damage-reduction-planning/inputs.js';

function example(quantities: (string | null)[] = ['88', '95']) {
  const artifacts: Artifact[] = [];
  const pairs = quantities.map((quantity, index) => {
    const fixture = createReductionCapacityFixture(2, 1);
    const source = fixture.artifacts[0]!;
    const content = source.content as PhysicalResidualImport;
    content.records[1]!.quantity = quantity;
    source.sha256 = contractHash(content);
    artifacts.push(source);
    return {
      id: `pair-${index}`,
      label: `Supplied pair ${index}`,
      sources: createReductionSelection(fixture.target, [
        {
          artifact: exactReductionRef(source),
          row_ids: ['r0', 'r1'],
        },
      ]).sources,
    };
  });
  const request: ReductionSensitivityRequest = {
    schema_version: 'haze.reduction.sensitivity-request.v1',
    target: createReductionCapacityFixture(2, 1).target,
    assumptions:
      'Synthetic paired scenarios for engineering verification only.',
    pairs,
  };
  return { request, artifacts };
}

describe('finite supplied-pair sensitivity diagnostic', () => {
  it('shows target sensitivity without turning a scenario frequency into probability', () => {
    const { request, artifacts } = example();
    const report = analyzeReductionSensitivity(request, artifacts);
    expect(report.conclusion).toBe('some_supplied_pairs_meet');
    expect(report.pairs.map(({ assessment }) => assessment.target_met)).toEqual(
      [true, false],
    );
    expect(
      report.pairs.map(({ assessment }) => assessment.absolute_reduction),
    ).toEqual(['12', '5']);
    expect(report.probability_of_target).toBeNull();
    expect(report.scientific_qualification).toBe('unqualified');
    expect(report.origin).toBe('synthetic');
    expect(report.claim_eligibility).toBe('none');
    expect(report.achieved_reduction).toBe(false);
    for (const pair of report.pairs) {
      expect(pair.review.verdict).toBe('supported');
      expect(pair.selection_ref.sha256).toBe(contractHash(pair.selection));
      expect(pair.assessment_ref.sha256).toBe(contractHash(pair.assessment));
    }
  });
  it.each([
    [['88', '90'], 'all_supplied_pairs_meet'],
    [['95', '110'], 'no_supplied_pairs_meet'],
    [['88', null], 'incomplete'],
  ])(
    'retains complete/incomplete distinctions for %j',
    (quantities, conclusion) => {
      const { request, artifacts } = example(quantities);
      expect(analyzeReductionSensitivity(request, artifacts).conclusion).toBe(
        conclusion,
      );
    },
  );
  it('uses exact inclusive and strict decisions for every supplied pair', () => {
    const { request, artifacts } = example(['90', '90']);
    request.target.relation = 'greater_than';
    expect(analyzeReductionSensitivity(request, artifacts).conclusion).toBe(
      'no_supplied_pairs_meet',
    );
  });
  it.each(['method', 'support', 'basis'])(
    'does not combine differing %s as one sensitivity comparison',
    (kind) => {
      const { request, artifacts } = example(['88', '88']);
      const source = artifacts[1]!;
      const content = source.content as PhysicalResidualImport;
      content.records.forEach((row) => {
        if (kind === 'method') row.original_method.version = '2';
        if (kind === 'support') row.support_ids = ['other-support'];
        if (kind === 'basis') row.evidence_basis = 'retrospective';
      });
      source.sha256 = contractHash(content);
      request.pairs[1]!.sources[0]!.artifact = exactReductionRef(source);
      const report = analyzeReductionSensitivity(request, artifacts);
      expect(report.conclusion).toBe('incomplete');
      expect(report.pairs[1]!.reasons).toContain(
        'paired_support_or_method_mismatch',
      );
    },
  );
  it('preserves missing originals/hash failures as gaps, even when other pairs meet', () => {
    const { request, artifacts } = example(['88', '88']);
    artifacts[1]!.sha256 = 'f'.repeat(64);
    const report = analyzeReductionSensitivity(request, artifacts);
    expect(report.conclusion).toBe('incomplete');
    expect(report.pairs[1]!.assessment.status).toBe('gap');
  });
  it('rejects duplicate pair IDs and probability claims in the input contract', () => {
    const { request } = example();
    expect(
      reductionSensitivityRequestSchema.safeParse({
        ...request,
        probability_of_target: 0.9,
      }).success,
    ).toBe(false);
    request.pairs[1]!.id = request.pairs[0]!.id;
    expect(reductionSensitivityRequestSchema.safeParse(request).success).toBe(
      false,
    );
  });
  it('bounds aggregate work even if each selection is individually valid', () => {
    const { request, artifacts } = example();
    request.pairs = Array.from({ length: 16 }, (_, i) => ({
      ...request.pairs[0]!,
      id: `p${i}`,
      sources: [
        {
          ...request.pairs[0]!.sources[0]!,
          row_ids: Array.from({ length: 64 }, (_, r) => `r${r}`),
        },
      ],
    }));
    expect(() => analyzeReductionSensitivity(request, artifacts)).toThrow(
      'sensitivity_bundle_limit_exceeded',
    );
  });
  it('bounds total normalized bytes across individually valid paired selections', () => {
    const { request, artifacts } = example(
      Array.from({ length: 16 }, () => '88'),
    );
    for (const field of [
      'endpoint',
      'unit',
      'population',
      'geography',
      'pollutant',
      'coverage',
      'missingness',
    ] as const)
      request.target.scope[field] = 'x'.repeat(4096);
    request.target.scope.exclusions = ['x'.repeat(4096), 'y'.repeat(4096)];
    artifacts.forEach((artifact, index) => {
      (artifact.content as PhysicalResidualImport).records.forEach((row) => {
        row.scope = structuredClone(request.target.scope);
      });
      artifact.sha256 = contractHash(artifact.content);
      request.pairs[index]!.sources[0]!.artifact = exactReductionRef(artifact);
    });
    expect(() => analyzeReductionSensitivity(request, artifacts)).toThrow(
      'sensitivity_normalized_byte_limit_exceeded',
    );
  });
});
