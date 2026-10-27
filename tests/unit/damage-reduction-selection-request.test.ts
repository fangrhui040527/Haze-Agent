import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Artifact } from '../../app/contracts/artifacts.js';
import { contractHash } from '../../app/contracts/json.js';
import { createReductionCapacityFixture } from '../../app/capabilities/damage-reduction-planning/capacity-fixtures.js';
import {
  exactReductionRef,
  resolveReductionSelectionRequest,
} from '../../app/capabilities/damage-reduction-planning/inputs.js';

function example() {
  const fixture = createReductionCapacityFixture(2, 1);
  const original: Artifact = {
    ...fixture.artifacts[0]!,
    id: randomUUID(),
    content: JSON.stringify(fixture.selection),
    sha256: contractHash(JSON.stringify(fixture.selection)),
  };
  const request = {
    schema_version: 'haze.reduction.selection-request.v1',
    selection_ref: exactReductionRef(original),
  };
  return { fixture, original, request };
}

describe('exact operator selection originals', () => {
  it('resolves the pinned selection without changing its target, rows or sources', () => {
    const { fixture, original, request } = example();
    expect(resolveReductionSelectionRequest(request, [original])).toEqual(
      fixture.selection,
    );
    expect(resolveReductionSelectionRequest(fixture.selection, [])).toEqual(
      fixture.selection,
    );
  });
  it('refuses unavailable or wrong-version originals instead of substituting another selection', () => {
    const { original, request } = example();
    expect(() => resolveReductionSelectionRequest(request, [])).toThrow(
      'exact_operator_selection_original_required',
    );
    expect(() =>
      resolveReductionSelectionRequest(request, [{ ...original, version: 2 }]),
    ).toThrow('exact_operator_selection_original_required');
  });
  it('rejects an oversized row declaration before requiring numerical originals', () => {
    const fixture = createReductionCapacityFixture(1002, 16);
    const { original } = example();
    original.content = JSON.stringify(fixture.selection);
    original.sha256 = contractHash(original.content);
    expect(() =>
      resolveReductionSelectionRequest(
        {
          schema_version: 'haze.reduction.selection-request.v1',
          selection_ref: exactReductionRef(original),
        },
        [original],
      ),
    ).toThrow('selected_row_limit_exceeded');
  });
  it.each(['hash', 'derived', 'assignment', 'dependencies'])(
    'rejects an invalid %s selection original',
    (kind) => {
      const { original, request } = example();
      if (kind === 'hash') original.content = '{}';
      if (kind === 'derived') original.evidence_origin = 'derived';
      if (kind === 'assignment')
        original.producer = { kind: 'assignment', id: randomUUID() };
      if (kind === 'dependencies')
        original.dependencies = [exactReductionRef(original)];
      expect(() =>
        resolveReductionSelectionRequest(request, [original]),
      ).toThrow('original_operator_selection_required');
    },
  );
});
