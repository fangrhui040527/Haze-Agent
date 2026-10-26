import { pinEvidence } from './evidence.js';
import type { EvidenceCollectionScope } from './contracts.js';
import type { SourceAdapter } from './types.js';

/** Explicit synthetic source for exercising the same collection boundary offline. */
export function createFixtureCollectionAdapter(
  scope: EvidenceCollectionScope,
): SourceAdapter {
  const retrievedAt = '2026-10-24T12:00:00.000Z';
  const sourceId = `fixture-${scope.provider}`;
  return {
    spec: {
      id: sourceId,
      source: {
        id: sourceId,
        name: `Synthetic ${scope.provider} collection fixture`,
        kind: 'forecast_model',
        evidenceKind: 'modeled',
        organisation: 'Explicit local test fixture',
        cadence: 'One explicit fixture run',
        licenceNote: 'Synthetic fixture; no upstream material was retrieved.',
        reliabilityNote:
          'Synthetic fixture; establishes no live evidence readiness.',
        url: 'https://example.invalid/fixture',
      },
      requiresEnv: [],
      query: 'Synthetic collection fixture; no upstream query was executed.',
      placeSelector: `${scope.locations.length} explicitly supplied fixture locations`,
      timeSelector: 'Fixed synthetic fixture instant',
      cadenceSec: 3600,
      rateLimit: 'No network requests',
      freshnessMinutes: 360,
    },
    run() {
      const raw = Buffer.from(
        JSON.stringify({
          synthetic: true,
          provider: scope.provider,
          locations: scope.locations.map((place, index) => ({
            id: place.id,
            value: index + 1,
          })),
        }),
      );
      const evidence = pinEvidence({
        raw,
        sourceId,
        sourceKind: 'modeled',
        upstream: { system: 'synthetic-fixture', id: scope.provider },
        title: 'Explicit synthetic collection fixture',
        sourceOwner: 'Local test fixture',
        locator: {
          kind: 'data',
          url: 'https://example.invalid/fixture',
          selection: 'Explicit synthetic fixture locations',
        },
        pollutant: 'pm25',
        unit: 'µg/m³',
        issuedAt: null,
        issuedAtReason: 'No upstream issuance; synthetic fixture.',
        validInterval: null,
        retrievedAt,
        nativeTemporalResolution: 'Synthetic fixture instant',
        spatialSupport: 'Explicit synthetic fixture locations',
        licenceRef: 'Synthetic fixture; no upstream licence applies.',
        permittedUses: ['offline integration checks'],
        limitations: [
          'Synthetic fixture; no live readiness or real observations established.',
        ],
        coverageChecks: [],
      });
      return Promise.resolve({
        evidence: [evidence],
        stations: [],
        facts: scope.locations.map((place, index) => ({
          about: { type: 'location' as const, id: place.id },
          predicate: 'fixture.pm25',
          value: { pm25: index + 1 },
          observedAt: retrievedAt,
          evidenceId: evidence.record.evidenceId,
        })),
        coverage: {
          requested: scope.locations.length,
          covered: scope.locations.length,
          excluded: [],
          gaps: ['Synthetic fixture; no upstream source was contacted.'],
        },
      });
    },
  };
}
