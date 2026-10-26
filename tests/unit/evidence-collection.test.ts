import { describe, expect, it, vi } from 'vitest';
import { collectOnce } from '../../app/capabilities/evidence-collection/collection.js';
import { pinEvidence } from '../../app/capabilities/evidence-collection/evidence.js';
import { openMeteoSpec } from '../../app/capabilities/evidence-collection/sources/openMeteo.js';
import type {
  AdapterResult,
  SourceAdapter,
} from '../../app/capabilities/evidence-collection/types.js';

function collected(): AdapterResult {
  const evidence = pinEvidence({
    raw: Buffer.from('{"pm25":12}'),
    upstream: { system: 'test', id: 'sample' },
    sourceId: 'src-openmeteo-cams',
    sourceKind: 'modeled',
    title: 'Synthetic collection test',
    sourceOwner: 'test',
    locator: { kind: 'data', url: 'https://example.test', selection: 'sample' },
    pollutant: 'pm25',
    unit: 'µg/m³',
    issuedAt: null,
    issuedAtReason: 'Unknown',
    validInterval: null,
    retrievedAt: '2026-10-26T00:00:00Z',
    nativeTemporalResolution: 'Unknown',
    spatialSupport: 'Synthetic point',
    licenceRef: 'test',
    permittedUses: ['testing'],
    limitations: ['Synthetic fixture'],
    coverageChecks: [],
  });
  return {
    evidence: [evidence],
    stations: [],
    facts: [],
    coverage: { requested: 1, covered: 1, excluded: [], gaps: [] },
  };
}

describe('shared one-shot evidence collection', () => {
  const context = () => ({
    now: new Date('2026-10-26T00:00:00Z'),
    runId: 'test-run',
    signal: new AbortController().signal,
  });

  it('retains exact provider bytes and metadata without a storage dependency', async () => {
    const result = collected();
    const run = vi.fn().mockResolvedValue(result);
    const adapter: SourceAdapter = { spec: openMeteoSpec([]), run };
    const input = context();
    expect(await collectOnce(adapter, input)).toBe(result);
    expect(run).toHaveBeenCalledExactlyOnceWith(input);
    expect(result.evidence[0]?.record.acceptedAt).toBeNull();
  });

  it('does not start a cancelled collection', async () => {
    const run = vi.fn().mockResolvedValue(collected());
    await expect(
      collectOnce(
        { spec: openMeteoSpec([]), run },
        { ...context(), signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects changed raw bytes before a caller can persist them', async () => {
    const result = collected();
    result.evidence[0]!.raw = Buffer.from('tampered');
    await expect(
      collectOnce(
        { spec: openMeteoSpec([]), run: () => Promise.resolve(result) },
        context(),
      ),
    ).rejects.toThrow('pinned raw bytes');
  });

  it('rejects facts whose evidence was not returned by the source', async () => {
    const result = collected();
    result.facts.push({
      about: { type: 'location', id: 'klang' },
      predicate: 'pm25_modeled',
      value: { value: 12 },
      observedAt: '2026-10-26T00:00:00Z',
      evidenceId: 'missing',
    });
    await expect(
      collectOnce(
        { spec: openMeteoSpec([]), run: () => Promise.resolve(result) },
        context(),
      ),
    ).rejects.toThrow('corresponding pinned evidence');
  });
});
