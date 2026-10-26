import { createHash } from 'node:crypto';
import { z } from 'zod';
import { boundedJsonSchema } from '../../contracts/artifacts.js';

export const collectionProviderSchema = z.enum([
  'open-meteo',
  'openaq',
  'firms',
  'zetaris',
]);

export const collectionLocationSchema = z.strictObject({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  region: z.string().max(256),
  country: z.string().min(1).max(256),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180),
  timeZone: z.string().min(1).max(256),
  aqiStandard: z.string().max(256),
  populationBand: z.enum(['small', 'medium', 'large', 'mega']),
});

/** The extracted providers collect their current documented window only. */
export const evidenceCollectionScopeSchema = z
  .strictObject({
    capability: z.literal('evidence-collection'),
    provider: collectionProviderSchema,
    locations: z.array(collectionLocationSchema).min(1).max(25),
  })
  .superRefine((scope, context) => {
    if (
      new Set(scope.locations.map((place) => place.id)).size !==
      scope.locations.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Location IDs must be unique.',
      });
  });
export type EvidenceCollectionScope = z.infer<
  typeof evidenceCollectionScopeSchema
>;

const text = z.string().max(16_384);
const timestamp = z.iso.datetime({ offset: true });
const checkSchema = z.strictObject({
  id: text,
  label: text,
  result: z.enum(['pass', 'warn', 'fail', 'pending']),
  detail: text,
});
const evidenceRecordSchema = z.strictObject({
  schemaVersion: z.literal('haze.evidence.v2-subset'),
  evidenceId: text,
  revision: z.literal(1),
  upstream: z.strictObject({ system: text, id: text }),
  rawSha256: z.string().regex(/^[a-f0-9]{64}$/),
  rawRef: text,
  rawBytes: z.number().int().nonnegative(),
  sourceId: text,
  sourceKind: z.enum(['observation', 'forecast', 'modeled']),
  title: text,
  sourceOwner: text,
  locator: z.strictObject({
    kind: z.literal('data'),
    url: text,
    selection: text,
  }),
  pollutant: z.literal('pm25').nullable(),
  unit: z.literal('µg/m³').nullable(),
  issuedAt: timestamp.nullable(),
  issuedAtReason: text.nullable(),
  validInterval: z
    .strictObject({ start: timestamp, end: timestamp })
    .nullable(),
  retrievedAt: timestamp,
  acceptedAt: z.null(),
  acceptedAtReason: text,
  nativeTemporalResolution: text,
  spatialSupport: text,
  licenceRef: text,
  permittedUses: z.array(text),
  limitations: z.array(text),
  disposition: z.literal('pinned_unreviewed'),
  checks: z.array(checkSchema),
});

const sourceSchema = z.strictObject({
  id: text,
  name: text,
  kind: z.enum([
    'ground_monitor',
    'satellite',
    'forecast_model',
    'government',
    'news',
    'community',
    'low_cost_sensor',
    'data_platform',
  ]),
  evidenceKind: z.enum(['observation', 'forecast', 'modeled', 'report']),
  organisation: text,
  cadence: text,
  licenceNote: text,
  reliabilityNote: text,
  url: text,
});

export const collectionCaptureSchema = z
  .strictObject({
    schema_version: z.literal('haze.evidence.collection.capture.v1'),
    mode: z.enum(['live', 'fixture', 'replay']),
    evidence_origin: z.enum(['external_source', 'synthetic_fixture']),
    scope: evidenceCollectionScopeSchema,
    collected_at: timestamp,
    source: sourceSchema,
    selection: z.strictObject({
      query: text,
      place_selector: text,
      time_selector: text,
    }),
    evidence: z.array(
      z.strictObject({ record: evidenceRecordSchema, raw_base64: z.string() }),
    ),
    stations: z.array(
      z.strictObject({
        stationId: text,
        name: text,
        lat: z.number().finite(),
        lon: z.number().finite(),
        provider: text,
        isMonitor: z.boolean(),
        sensorId: z.number().int(),
        nearestLocationId: text,
        distanceKm: z.number().finite().nonnegative(),
      }),
    ),
    facts: z.array(
      z.strictObject({
        about: z.strictObject({
          type: z.enum(['location', 'station']),
          id: text,
        }),
        predicate: text,
        value: z.record(z.string(), z.json()),
        observedAt: timestamp,
        evidenceId: text,
        dedupeKey: text.optional(),
      }),
    ),
    coverage: z.strictObject({
      requested: z.number().int().nonnegative(),
      covered: z.number().int().nonnegative(),
      excluded: z.array(z.strictObject({ id: text, reason: text })),
      gaps: z.array(text),
    }),
  })
  .superRefine((capture, context) => {
    if (!boundedJsonSchema.safeParse(capture).success)
      context.addIssue({
        code: 'custom',
        message:
          'Collection capture exceeds the artifact representation bound; narrow the scope.',
      });
    if (
      capture.mode === 'fixture' &&
      capture.evidence_origin !== 'synthetic_fixture'
    )
      context.addIssue({
        code: 'custom',
        message: 'Fixture collection must retain synthetic evidence origin.',
      });
    const ids = new Set<string>();
    const locationIds = new Set(
      capture.scope.locations.map((place) => place.id),
    );
    const stationIds = new Set(
      capture.stations.map((station) => station.stationId),
    );
    for (const entry of capture.evidence) {
      const raw = Buffer.from(entry.raw_base64, 'base64');
      if (
        raw.toString('base64') !== entry.raw_base64 ||
        raw.length !== entry.record.rawBytes ||
        createHash('sha256').update(raw).digest('hex') !==
          entry.record.rawSha256
      )
        context.addIssue({
          code: 'custom',
          message:
            'Captured raw bytes do not match the pinned evidence record.',
        });
      if (ids.has(entry.record.evidenceId))
        context.addIssue({
          code: 'custom',
          message: 'Duplicate evidence record in collection capture.',
        });
      if (entry.record.sourceId !== capture.source.id)
        context.addIssue({
          code: 'custom',
          message:
            'Evidence source does not match the selected collection source.',
        });
      ids.add(entry.record.evidenceId);
    }
    for (const station of capture.stations)
      if (!locationIds.has(station.nearestLocationId))
        context.addIssue({
          code: 'custom',
          message:
            'Collection station is outside the requested location scope.',
        });
    for (const fact of capture.facts) {
      if (!ids.has(fact.evidenceId))
        context.addIssue({
          code: 'custom',
          message: 'Collection fact lacks its exact retained evidence.',
        });
      if (
        !(fact.about.type === 'location' ? locationIds : stationIds).has(
          fact.about.id,
        )
      )
        context.addIssue({
          code: 'custom',
          message:
            'Collection fact is outside the requested location or station scope.',
        });
    }
  });
export type CollectionCapture = z.infer<typeof collectionCaptureSchema>;
