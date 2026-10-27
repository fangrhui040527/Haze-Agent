import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ArtifactRef } from '../../app/contracts/artifacts.js';
import { contractHash } from '../../app/contracts/json.js';
import { createReductionCapacityFixture } from '../../app/capabilities/damage-reduction-planning/capacity-fixtures.js';
import { normalizeReductionSelection } from '../../app/capabilities/damage-reduction-planning/inputs.js';
import { assessReduction } from '../../app/capabilities/damage-reduction-planning/methods.js';
import { independentlyCheckReduction } from '../../app/capabilities/damage-reduction-planning/checker.js';

function run(
  fixture: ReturnType<typeof createReductionCapacityFixture>,
  expectedReview = 'supported',
) {
  const selectionRef: ArtifactRef = {
    id: randomUUID(),
    version: 1,
    sha256: contractHash(fixture.selection),
  };
  const assessment = assessReduction(
    fixture.selection,
    fixture.artifacts,
    selectionRef,
  );
  const review = independentlyCheckReduction(
    fixture.selection,
    fixture.artifacts,
    selectionRef,
    assessment,
    { id: randomUUID(), version: 1, sha256: contractHash(assessment) },
    { assignment_id: randomUUID(), revision: 1 },
  );
  expect(review.verdict, JSON.stringify(review.findings)).toBe(expectedReview);
  return assessment;
}

describe('measured reduction representation boundaries', () => {
  it.each([
    [2, 2],
    [100, 8],
    [500, 16],
  ])('compares %i rows from %i originals exactly', (rows, originals) => {
    const fixture = createReductionCapacityFixture(rows, originals);
    expect(run(fixture)).toMatchObject({
      status: 'supported',
      baseline_damage: String((rows / 2) * 100),
      intervention_damage: String((rows / 2) * 88),
      absolute_reduction: String((rows / 2) * 12),
      target_met: true,
    });
  });
  it.each([524_287, 524_288])('accepts %i normalized bytes', (bytes) => {
    const fixture = createReductionCapacityFixture(500, 16, bytes);
    expect(fixture.normalized_bytes).toBe(bytes);
    expect(
      normalizeReductionSelection(fixture.selection, fixture.artifacts).records,
    ).toHaveLength(500);
    expect(run(fixture).status).toBe('supported');
  });
  it('rejects one normalized byte over the ceiling independently of raw JSON size', () => {
    const fixture = createReductionCapacityFixture(500, 16, 524_289);
    expect(run(fixture)).toMatchObject({
      status: 'gap',
      target_met: null,
      reasons: ['normalized_input_byte_limit_exceeded'],
    });
  });
  it('treats 1000 rows as a ceiling subject also to the byte ceiling', () => {
    const fixture = createReductionCapacityFixture(1000, 16);
    expect(fixture.normalized_bytes).toBeGreaterThan(524_288);
    expect(run(fixture)).toMatchObject({
      status: 'gap',
      reasons: ['normalized_input_byte_limit_exceeded'],
    });
  });
  it('checks the aggregate row ceiling across individually valid originals', () => {
    expect(run(createReductionCapacityFixture(1002, 16))).toMatchObject({
      status: 'gap',
      reasons: ['selected_row_limit_exceeded'],
    });
  });
  it('rejects 17 selected originals without enlarging the public contract', () => {
    const fixture = createReductionCapacityFixture(34, 16);
    const extra = createReductionCapacityFixture(2, 1);
    fixture.artifacts.push(...extra.artifacts);
    fixture.selection.sources.push(...extra.selection.sources);
    expect(run(fixture, 'rejected')).toMatchObject({
      status: 'gap',
      reasons: ['invalid_selection_or_precision'],
    });
  });
});
