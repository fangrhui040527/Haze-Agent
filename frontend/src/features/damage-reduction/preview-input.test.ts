import { describe, expect, it } from 'vitest';
import type { Artifact } from '../../../../app/contracts/artifacts.ts';
import {
  syntheticResidualImport,
  SYNTHETIC_REDUCTION_TARGET,
} from '../../../../app/capabilities/damage-reduction-planning/fixtures.ts';
import { syntheticReductionCandidate } from '../../../../app/capabilities/damage-reduction-planning/planning-fixtures.ts';
import { artifactRef } from '../../services/agents/testFixtures.ts';
import {
  canonicalScope,
  createPreviewRequest,
  proposeEditedCandidate,
  readResidualSource,
  targetFromSources,
} from './preview-input.ts';

function source(content: unknown = syntheticResidualImport()): Artifact {
  return {
    schema_version: 'haze.artifact.v3',
    ...artifactRef,
    identity: { principal: 'fixture', workspace: 'fixture' },
    kind: 'source.import',
    producer: { kind: 'user', id: 'fixture' },
    created_at: '2026-10-27T00:00:00Z',
    dependencies: [],
    required_tools: [],
    content: content as Artifact['content'],
  };
}

describe('planning preview source and request construction', () => {
  it('keeps historical human approval separate from an edited rule draft', () => {
    const prior = syntheticReductionCandidate();
    prior.approval = {
      status: 'approved',
      approver: 'Recorded owner',
      approved_at: '2026-10-27T00:00:00Z',
      evidence: [artifactRef],
    };
    const edited = proposeEditedCandidate({
      ...prior,
      trigger_rule: 'New proposed trigger',
    });
    expect(edited.approval).toEqual({
      status: 'proposed',
      approver: null,
      approved_at: null,
      evidence: [],
    });
    expect(prior.approval.status).toBe('approved');
    expect(edited.trigger_rule).toBe('New proposed trigger');
  });
  it('hashes only the declared scope with server-compatible canonical key order', async () => {
    const request = await createPreviewRequest(
      SYNTHETIC_REDUCTION_TARGET,
      syntheticReductionCandidate(),
      [{ artifact: artifactRef, row_ids: ['baseline-1', 'intervention-1'] }],
    );
    expect(canonicalScope({ z: 'z', a: { b: [2, 1], a: null } })).toBe(
      '{"a":{"a":null,"b":[2,1]},"z":"z"}',
    );
    expect(request.selection.scope_sha256).toBe(
      'd95c95436290a3a146448587c69a6119b50aaef4fc9308070ebf79db9ae7cf39',
    );
    expect(request.selection.sources).toEqual([
      { artifact: artifactRef, row_ids: ['baseline-1', 'intervention-1'] },
    ]);
    expect(request.candidate.name).toBe(
      SYNTHETIC_REDUCTION_TARGET.intervention,
    );
    expect(request.candidate.approval.status).toBe('proposed');
  });
  it('preserves an explicit source-local row subset and exact original reference', async () => {
    const request = await createPreviewRequest(
      SYNTHETIC_REDUCTION_TARGET,
      syntheticReductionCandidate(),
      [{ artifact: artifactRef, row_ids: ['baseline-1'] }],
    );
    expect(request.selection.sources[0]?.row_ids).toEqual(['baseline-1']);
    expect(request.selection.sources[0]?.artifact).toEqual(artifactRef);
    expect(request.selection).not.toHaveProperty('baseline_damage');
  });
  it('copies declared scenario metadata without computing effectiveness', () => {
    expect(targetFromSources([source()])).toEqual(SYNTHETIC_REDUCTION_TARGET);
    expect(
      readResidualSource(source(JSON.stringify(syntheticResidualImport())))
        .records[0]?.quantity,
    ).toBe('1000');
    expect(
      targetFromSources([
        source({
          ...syntheticResidualImport(),
          records: [syntheticResidualImport().records[0]],
        }),
      ]),
    ).toBeNull();
  });
  it('retains unknown quantities and synthetic provenance for a server gap assessment', () => {
    const imported = readResidualSource(
      source(syntheticResidualImport('1000', null)),
    );
    expect(imported.origin).toBe('synthetic');
    expect(imported.records[1]?.quantity).toBeNull();
  });
  it('rejects floating-point source numbers and duplicate original row identifiers', () => {
    const input = syntheticResidualImport();
    expect(() =>
      readResidualSource(
        source({
          ...input,
          records: [{ ...input.records[0], quantity: 1000 }],
        }),
      ),
    ).toThrow('decimal strings');
    expect(() =>
      readResidualSource(
        source({ ...input, records: [input.records[0], input.records[0]] }),
      ),
    ).toThrow('unique');
  });
  it('rejects empty selection, excessive row count and excess decimal precision', async () => {
    await expect(
      createPreviewRequest(
        SYNTHETIC_REDUCTION_TARGET,
        syntheticReductionCandidate(),
        [],
      ),
    ).rejects.toThrow('Select at least one');
    await expect(
      createPreviewRequest(
        SYNTHETIC_REDUCTION_TARGET,
        syntheticReductionCandidate(),
        [
          {
            artifact: artifactRef,
            row_ids: Array.from({ length: 1001 }, (_, index) => `row-${index}`),
          },
        ],
      ),
    ).rejects.toThrow('1,000');
    await expect(
      createPreviewRequest(
        { ...SYNTHETIC_REDUCTION_TARGET, target_fraction: '0.1000000000001' },
        syntheticReductionCandidate(),
        [{ artifact: artifactRef, row_ids: ['baseline-1'] }],
      ),
    ).rejects.toThrow();
  });
});
