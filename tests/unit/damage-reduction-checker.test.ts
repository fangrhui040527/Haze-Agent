import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  artifactSchema,
  type Artifact,
  type ArtifactRef,
} from '../../app/contracts/artifacts.js';
import { contractHash } from '../../app/contracts/json.js';
import {
  type PhysicalResidualImport,
  type ReductionAssessment,
  type ReductionInputSelection,
} from '../../app/contracts/damage-reduction.js';
import { independentlyCheckReduction } from '../../app/capabilities/damage-reduction-planning/checker.js';
import {
  syntheticResidualImport,
  SYNTHETIC_REDUCTION_TARGET,
} from '../../app/capabilities/damage-reduction-planning/fixtures.js';
import { createReductionSelection } from '../../app/capabilities/damage-reduction-planning/inputs.js';
import { assessReduction } from '../../app/capabilities/damage-reduction-planning/methods.js';

function original(bundle: PhysicalResidualImport): Artifact {
  const content = JSON.stringify(bundle);
  return artifactSchema.parse({
    schema_version: 'haze.artifact.v3',
    id: randomUUID(),
    version: 1,
    sha256: contractHash(content),
    identity: { principal: 'checker-test', workspace: 'checker-test' },
    kind: 'source.import',
    producer: { kind: 'user', id: 'checker-test' },
    created_at: '2026-10-27T00:00:00.000Z',
    dependencies: [],
    content,
    evidence_origin: 'synthetic_fixture',
    media_type: 'application/json',
  });
}
const reference = (content: unknown): ArtifactRef => ({
  id: randomUUID(),
  version: 1,
  sha256: contractHash(content),
});
function comparison(
  baseline: string | null = '1000',
  intervention: string | null = '880',
) {
  const artifact = original(syntheticResidualImport(baseline, intervention));
  const selection = createReductionSelection(
    structuredClone(SYNTHETIC_REDUCTION_TARGET),
    [
      {
        artifact: {
          id: artifact.id,
          version: artifact.version,
          sha256: artifact.sha256,
        },
        row_ids: ['baseline-1', 'intervention-1'],
      },
    ],
  );
  const producer = randomUUID();
  const reviewer = { assignment_id: randomUUID(), revision: 1 };
  const review = (
    assessment?: ReductionAssessment,
    sources: Artifact[] = [artifact],
    selected: ReductionInputSelection = selection,
  ) => {
    const selectedRef = reference(selected);
    const output =
      assessment ?? assessReduction(selected, sources, selectedRef);
    return independentlyCheckReduction(
      selected,
      sources,
      selectedRef,
      output,
      reference(output),
      reviewer,
      producer,
    );
  };
  return { artifact, selection, producer, reviewer, review };
}

describe('independent residual comparison review', () => {
  it.each([
    ['1000', '880'],
    ['0.3', '0.27'],
    ['0.300000000001', '0.270000000001'],
    ['1000', '1100'],
    ['0', '0'],
    ['-1', '1'],
    ['1', '-1'],
    [null, '880'],
  ])(
    'reconstructs %s to %s from retained original decimal strings',
    (baseline, intervention) => {
      const test = comparison(baseline, intervention);
      const review = test.review();
      expect(review.verdict).toBe('supported');
      expect(review.checks.every((check) => check.passed)).toBe(true);
      expect(review.scientific_qualification).toBe('unqualified');
      expect(review.achieved_reduction).toBe(false);
    },
  );

  it('independently applies an explicit strict threshold', () => {
    const test = comparison('0.3', '0.27');
    test.selection.target.relation = 'greater_than';
    expect(test.review().verdict).toBe('supported');
  });

  it.each([
    'baseline_damage',
    'intervention_damage',
    'absolute_reduction',
    'relative_reduction',
    'target_met',
    'origin',
  ] as const)(
    'rejects changed %s even when the output artifact has a valid new hash',
    (field) => {
      const test = comparison();
      const selectedRef = reference(test.selection);
      const output = assessReduction(
        test.selection,
        [test.artifact],
        selectedRef,
      );
      const tampered = structuredClone(output);
      if (field === 'relative_reduction')
        tampered.relative_reduction = { numerator: '999', denominator: '1000' };
      else if (field === 'target_met') tampered.target_met = false;
      else if (field === 'origin') tampered.origin = 'supplied';
      else tampered[field] = '999';
      const reviewed = independentlyCheckReduction(
        test.selection,
        [test.artifact],
        selectedRef,
        tampered,
        reference(tampered),
        test.reviewer,
        test.producer,
      );
      expect(reviewed.verdict).toBe('rejected');
      expect(reviewed.claim_eligibility).toBe('none');
      expect(
        reviewed.checks.find((check) => check.code === `exact_${field}`)
          ?.passed,
      ).toBe(false);
    },
  );

  it('rejects review by the assessment producer', () => {
    const test = comparison();
    const selectedRef = reference(test.selection);
    const output = assessReduction(
      test.selection,
      [test.artifact],
      selectedRef,
    );
    expect(
      independentlyCheckReduction(
        test.selection,
        [test.artifact],
        selectedRef,
        output,
        reference(output),
        { assignment_id: test.producer, revision: 1 },
        test.producer,
      ).verdict,
    ).toBe('rejected');
  });

  it('rejects changed input and output reference hashes', () => {
    const test = comparison();
    const selectedRef = reference(test.selection);
    const output = assessReduction(
      test.selection,
      [test.artifact],
      selectedRef,
    );
    const wrong = { ...reference(output), sha256: '0'.repeat(64) };
    const review = independentlyCheckReduction(
      test.selection,
      [test.artifact],
      { ...selectedRef, sha256: '1'.repeat(64) },
      output,
      wrong,
      test.reviewer,
      test.producer,
    );
    expect(review.verdict).toBe('rejected');
    expect(
      review.checks.find((check) => check.code === 'selection_hash')?.passed,
    ).toBe(false);
    expect(
      review.checks.find((check) => check.code === 'assessment_hash')?.passed,
    ).toBe(false);
  });

  it('reproduces an honest missing-source gap and ignores unselected context', () => {
    const test = comparison();
    expect(test.review(undefined, []).verdict).toBe('supported');
    expect(
      test.review(undefined, [
        test.artifact,
        original(syntheticResidualImport('1', '999')),
      ]).verdict,
    ).toBe('supported');
  });

  it('rejects a fabricated reason for an otherwise correctly calculated gap', () => {
    const test = comparison('0', '0');
    const selectedRef = reference(test.selection);
    const output = assessReduction(
      test.selection,
      [test.artifact],
      selectedRef,
    );
    output.reasons = ['unrelated_evidence_gap'];
    const review = independentlyCheckReduction(
      test.selection,
      [test.artifact],
      selectedRef,
      output,
      reference(output),
      test.reviewer,
      test.producer,
    );
    expect(review.verdict).toBe('rejected');
    expect(
      review.checks.find((check) => check.code === 'explicit_gaps')?.passed,
    ).toBe(false);
  });

  it('does not use an unselected malformed original row as numerical input', () => {
    const bundle = syntheticResidualImport();
    bundle.records.push({
      ...structuredClone(bundle.records[0]!),
      row_id: 'unselected',
      quantity: '1e20',
    });
    const artifact = original(bundle);
    const selection = createReductionSelection(SYNTHETIC_REDUCTION_TARGET, [
      {
        artifact: {
          id: artifact.id,
          version: artifact.version,
          sha256: artifact.sha256,
        },
        row_ids: ['baseline-1', 'intervention-1'],
      },
    ]);
    const selectedRef = reference(selection);
    const output = assessReduction(selection, [artifact], selectedRef);
    expect(output.status).toBe('supported');
    expect(
      independentlyCheckReduction(
        selection,
        [artifact],
        selectedRef,
        output,
        reference(output),
        { assignment_id: randomUUID(), revision: 1 },
        randomUUID(),
      ).verdict,
    ).toBe('supported');
  });

  it.each([
    'scope',
    'scenario',
    'overlap',
    'method',
    'basis',
    'missing_row',
    'source_hash',
    'precision',
    'legacy',
    'synthetic_conflict',
  ] as const)('independently checks %s incompatibility or gap', (failure) => {
    const bundle = syntheticResidualImport();
    if (failure === 'scope') bundle.records[1]!.scope.unit = 'another unit';
    if (failure === 'scenario')
      bundle.records[1]!.scenario = 'another intervention';
    if (failure === 'overlap')
      bundle.records.push({
        ...structuredClone(bundle.records[0]!),
        row_id: 'baseline-2',
      });
    if (failure === 'method') bundle.records[1]!.original_method.version = '2';
    if (failure === 'basis')
      bundle.records[1]!.evidence_basis = 'retrospective';
    if (failure === 'precision')
      bundle.records[0]!.quantity = '0.0000000000001';
    if (failure === 'legacy')
      for (const row of bundle.records)
        row.original_method.id = 'damage.project-scenario.v1';
    if (failure === 'synthetic_conflict') bundle.origin = 'supplied';
    const artifact = original(bundle);
    const selection = createReductionSelection(SYNTHETIC_REDUCTION_TARGET, [
      {
        artifact: {
          id: artifact.id,
          version: artifact.version,
          sha256: artifact.sha256,
        },
        row_ids:
          failure === 'missing_row'
            ? ['missing']
            : bundle.records.map((row) => row.row_id),
      },
    ]);
    if (failure === 'source_hash') artifact.content = '{}';
    const selectedRef = reference(selection);
    const output = assessReduction(selection, [artifact], selectedRef);
    const review = independentlyCheckReduction(
      selection,
      [artifact],
      selectedRef,
      output,
      reference(output),
      { assignment_id: randomUUID(), revision: 1 },
      randomUUID(),
    );
    expect(output.status).not.toBe('supported');
    expect(review.verdict).toBe('supported');
    expect(review.claim_eligibility).toBe('none');
  });
});
