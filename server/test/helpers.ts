import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPOSITORY_ROOT } from '../src/config.ts';
import type { WorldModelEngine } from '../src/engines.ts';
import { pinEvidence } from '../../dist/capabilities/evidence-collection/evidence.js';
import type { AdapterResult } from '../src/hazeops/types.ts';
import { HazeWorld } from '../src/world/hazeWorld.ts';

/** A fresh in-memory World Model from the pinned engine (needs `npm run build` at the root). */
export async function memoryWorld(): Promise<HazeWorld> {
  const loader = (await import(
    pathToFileURL(join(REPOSITORY_ROOT, 'dist/adapters/meterless/loader.js'))
      .href
  )) as {
    loadPinnedEngines(): Promise<{
      WorldModel: new (o: Record<string, unknown>) => unknown;
    }>;
  };
  const { WorldModel } = await loader.loadPinnedEngines();
  const engine = new WorldModel({
    namespace: 'test',
    storage: 'memory',
    conflictPolicy: 'most-recent-wins',
  }) as WorldModelEngine;
  return new HazeWorld(engine, mkdtempSync(join(tmpdir(), 'haze-test-')));
}

export const KLANG = {
  id: 'klang',
  name: 'Klang',
  region: 'Southeast Asia',
  country: 'Malaysia',
  countryCode: 'MY',
  lat: 3.0449,
  lon: 101.4456,
  timeZone: 'Asia/Kuala_Lumpur',
  aqiStandard: 'Malaysia Air Pollutant Index (API)',
  populationBand: 'large' as const,
};

export function modeledResult(
  value: number,
  observedAt: string,
  raw = `raw-${value}-${observedAt}`,
): AdapterResult {
  const pinned = pinEvidence({
    raw: Buffer.from(raw),
    upstream: { system: 'test', id: 'fixture' },
    sourceId: 'src-openmeteo-cams',
    sourceKind: 'modeled',
    title: 'Test fixture',
    sourceOwner: 'test',
    locator: { kind: 'data', url: 'https://example.test', selection: 'klang' },
    pollutant: 'pm25',
    unit: 'µg/m³',
    issuedAt: null,
    issuedAtReason: 'fixture',
    validInterval: null,
    retrievedAt: observedAt,
    nativeTemporalResolution: 'hourly',
    spatialSupport: 'point',
    licenceRef: 'test licence',
    permittedUses: ['information_display'],
    limitations: ['fixture'],
    coverageChecks: [],
  });
  return {
    evidence: [pinned],
    stations: [],
    facts: [
      {
        about: { type: 'location', id: 'klang' },
        predicate: 'pm25_modeled',
        value: {
          value,
          pm10: null,
          unit: 'µg/m³',
          observedAt,
          valueThreeHoursEarlier: null,
          gridLat: 3,
          gridLon: 101.4,
        },
        observedAt,
        evidenceId: pinned.record.evidenceId,
      },
    ],
    coverage: { requested: 1, covered: 1, excluded: [], gaps: [] },
  };
}
