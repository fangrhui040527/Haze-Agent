import type {
  AgentResult,
  EvidenceCheck,
  HazeItem,
  ItemDetail,
  ItemStatus,
  Location,
  Source,
  TimelineEntry,
  Trend,
} from '../contracts/dashboard.js';
import type { WmFact } from '../world/types.js';
import { freshnessCheck } from '../capabilities/evidence-collection/checks.js';
import type {
  EvidenceRecord,
  WatcherSpec,
} from '../capabilities/evidence-collection/types.js';
import { entityId, type HazeWorld, localId } from '../world/haze-world.js';

/**
 * Turns World Model facts into the frontend's HazeItem rows. Items are a view
 * computed on read (World Model views are projections of the fact log), so nothing
 * here is stored and nothing here changes a value.
 */

const HOTSPOT_MAX_AGE_HOURS = 36;
const TIMELINE_LIMIT = 12;

type Value = Record<string, unknown>;
const str = (v: unknown, fallback: string): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const round1 = (v: number | null) =>
  v === null ? '—' : (Math.round(v * 10) / 10).toString();

function trendOf(
  current: number | null,
  previous: number | null,
): Trend | null {
  if (current === null || previous === null) return null;
  if (previous === 0) return current === 0 ? 'flat' : 'up';
  const change = (current - previous) / previous;
  return change > 0.1 ? 'up' : change < -0.1 ? 'down' : 'flat';
}

function localTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    day: 'numeric',
    month: 'short',
  });
}

function statusFrom(checks: EvidenceCheck[]): ItemStatus {
  if (checks.some((c) => c.id === 'coverage.freshness' && c.result === 'fail'))
    return 'stale';
  if (checks.some((c) => c.result === 'fail')) return 'unverified';
  // Identity and coverage checks passed; independent review is still pending.
  return 'partial';
}

export interface ProjectionContext {
  world: Pick<HazeWorld, 'entity' | 'entities' | 'evidence' | 'facts'>;
  specsBySource: Map<string, WatcherSpec>;
  lastRunMs: Map<string, number>;
  now: Date;
  fictional?: boolean;
}

interface Draft {
  item: Omit<
    HazeItem,
    'relatedIds' | 'checks' | 'status' | 'agentResults' | 'timeline'
  >;
  evidence: EvidenceRecord | null;
  history: WmFact[];
  maxAgeMinutes: number;
  freshnessAt: string;
}

function timeline(
  history: WmFact[],
  describe: (v: Value) => string,
): TimelineEntry[] {
  return history.slice(-TIMELINE_LIMIT).map((fact) => ({
    at: fact.assertedAt,
    label: `${describe(fact.value as Value)} (fact ${fact.id.slice(0, 18)}…)`,
    agent: 'hazeops',
  }));
}

function evidenceDetails(evidence: EvidenceRecord | null): string[] {
  if (!evidence) return ['Evidence record not found in the World Model.'];
  return [
    `Evidence ${evidence.evidenceId}: ${evidence.title}. Retrieved ${evidence.retrievedAt}; raw bytes pinned by SHA-256 ${evidence.rawSha256.slice(0, 16)}….`,
    `Native resolution: ${evidence.nativeTemporalResolution}. Spatial support: ${evidence.spatialSupport}.`,
    `Limitations: ${evidence.limitations.join(' ')}`,
    `Status: ${evidence.acceptedAtReason}`,
  ];
}

function sourceRef(
  sourceId: string,
  evidence: EvidenceRecord | null,
  measuredAt: string | null,
  excerpt: string,
): HazeItem['sources'][number] {
  return {
    sourceId,
    role: 'primary',
    measuredAt,
    publishedAt: null,
    retrievedAt:
      evidence?.retrievedAt ?? measuredAt ?? new Date(0).toISOString(),
    validUntil: evidence?.validInterval?.end ?? null,
    excerpt,
  };
}

function draftsFor(
  context: ProjectionContext,
  about: string,
  predicate: string,
  history: WmFact[],
): Draft | null {
  const latest = history.at(-1);
  if (!latest) return null;
  const v = latest.value as Value;
  const previous = history.at(-2)?.value as Value | undefined;
  const evidence = context.world.evidence(str(v.evidenceId, ''));
  const spec = evidence
    ? context.specsBySource.get(evidence.sourceId)
    : undefined;
  const maxAgeMinutes = spec?.freshnessMinutes ?? 180;
  const base = {
    fictional: context.fictional ?? false,
    weather: null,
    fire: null,
    forecast: null,
    impacts: [],
    revision: history.length,
    updatedAt: evidence?.retrievedAt ?? latest.assertedAt,
  };

  if (about.startsWith('location:')) {
    const locationEntity = context.world.entity(about);
    if (!locationEntity) return null;
    const locationId = localId(about);
    const place = locationEntity.name ?? locationId;
    const timeZone = str(locationEntity.attrs.timeZone, 'UTC');

    if (predicate === 'fixture.pm25' && context.fictional) {
      const value = num(v.pm25);
      return {
        item: {
          ...base,
          fictional: true,
          id: `hz-fixture-${locationId}`,
          locationId,
          category: 'reading',
          headline: `Synthetic PM2.5 fixture for ${place}`,
          summary: `Synthetic test value ${round1(value)} µg/m³; no upstream source was contacted`,
          details: [
            'This value was generated by the explicitly selected local fixture provider to test evidence collection and dashboard integration.',
            'It is not an observation, forecast or atmospheric model result and establishes no live or scientific readiness.',
            ...evidenceDetails(evidence),
          ],
          observedAt: latest.assertedAt,
          measurements: [
            { pollutant: 'pm25', value, unit: 'µg/m³', averaging: '1h' },
          ],
          trend: null,
          sources: [
            sourceRef(
              evidence?.sourceId ?? '',
              evidence,
              latest.assertedAt,
              `Synthetic fixture value ${round1(value)} µg/m³`,
            ),
          ],
          tags: ['synthetic', 'fixture'],
        },
        evidence,
        history,
        maxAgeMinutes,
        freshnessAt: latest.assertedAt,
      };
    }

    if (predicate === 'pm25_modeled') {
      const value = num(v.value);
      return {
        item: {
          ...base,
          id: `hz-modeled-${locationId}`,
          locationId,
          category: 'reading',
          headline: `Modeled PM2.5 ${round1(value)} µg/m³ in ${place}`,
          summary: `CAMS model estimate for ${localTime(latest.assertedAt, timeZone)} local · ~45 km cell, not a sensor`,
          details: [
            `The CAMS global atmospheric model estimates PM2.5 at ${round1(value)} µg/m³ and PM10 at ${round1(num(v.pm10))} µg/m³ for the model cell nearest ${place} (cell centre ${String(v.gridLat)}, ${String(v.gridLon)}).`,
            'This is a model estimate of all-source fine particles. It is not a measurement, does not say where the smoke came from, and cannot show street-level differences.',
            ...evidenceDetails(evidence),
          ],
          observedAt: latest.assertedAt,
          measurements: [
            { pollutant: 'pm25', value, unit: 'µg/m³', averaging: '1h' },
            {
              pollutant: 'pm10',
              value: num(v.pm10),
              unit: 'µg/m³',
              averaging: '1h',
            },
          ],
          trend: trendOf(value, num(v.valueThreeHoursEarlier)),
          sources: [
            sourceRef(
              evidence?.sourceId ?? 'src-openmeteo-cams',
              evidence,
              latest.assertedAt,
              `pm2_5 = ${round1(value)} µg/m³ at ${latest.assertedAt} (model cell ${String(v.gridLat)}, ${String(v.gridLon)})`,
            ),
          ],
          tags: ['real', 'modeled', 'cams'],
        },
        evidence,
        history,
        maxAgeMinutes,
        freshnessAt: latest.assertedAt,
      };
    }

    if (predicate === 'pm25_forecast_24h') {
      const max = num(v.maxPm25);
      const direction =
        (v.direction as 'worsening' | 'improving' | 'steady') ?? 'steady';
      return {
        item: {
          ...base,
          id: `hz-forecast-${locationId}`,
          locationId,
          category: 'forecast',
          headline: `PM2.5 forecast for ${place}: ${direction}, peak ~${round1(max)} µg/m³ in the next 24 h`,
          summary: `CAMS model forecast · next 24 h mean ${round1(num(v.meanPm25))} vs past 24 h ${round1(num(v.pastMeanPm25))} µg/m³`,
          details: [
            `Over the next 24 hours the CAMS model expects PM2.5 near ${place} to peak around ${round1(max)} µg/m³, with a mean of ${round1(num(v.meanPm25))} µg/m³ (past 24 hours: ${round1(num(v.pastMeanPm25))} µg/m³), so the direction is "${direction}".`,
            'A model forecast, not an observation. "Worsening" and "improving" compare the two 24-hour means with a ±10% band.',
            ...evidenceDetails(evidence),
          ],
          observedAt: latest.assertedAt,
          measurements: [
            { pollutant: 'pm25', value: max, unit: 'µg/m³', averaging: '1h' },
          ],
          trend:
            direction === 'worsening'
              ? 'up'
              : direction === 'improving'
                ? 'down'
                : 'flat',
          forecast: {
            validFrom: String(v.validFrom),
            validTo: String(v.validTo),
            expectedPm25: max,
            direction,
          },
          sources: [
            sourceRef(
              evidence?.sourceId ?? 'src-openmeteo-cams',
              evidence,
              null,
              `Forecast ${String(v.validFrom)} to ${String(v.validTo)}: max ${round1(max)} µg/m³`,
            ),
          ],
          tags: ['real', 'forecast', 'cams'],
        },
        evidence,
        history,
        maxAgeMinutes,
        freshnessAt: latest.assertedAt,
      };
    }

    if (predicate === 'fire_hotspots_24h') {
      const count = num(v.count) ?? 0;
      const ageHours =
        (context.now.getTime() - Date.parse(latest.assertedAt)) / 3600_000;
      if (count === 0 || ageHours > HOTSPOT_MAX_AGE_HOURS) return null;
      const confidence =
        (v.highestConfidence as 'low' | 'nominal' | 'high') ?? 'nominal';
      return {
        item: {
          ...base,
          id: `hz-hotspots-${locationId}`,
          locationId,
          category: 'hotspot',
          headline: `${count} fire hotspot${count === 1 ? '' : 's'} within ${String(v.radiusKm)} km of ${place} in 24 h`,
          summary: `VIIRS satellite detections · nearest ${String(v.nearestKm)} km · max FRP ${round1(num(v.maxFrpMw))} MW`,
          details: [
            `NASA FIRMS reports ${count} VIIRS thermal detections within ${String(v.radiusKm)} km of ${place} between ${String(v.windowStart)} and ${String(v.windowEnd)} (${String(v.highConfidenceCount)} high-confidence). The nearest is about ${String(v.nearestKm)} km away.`,
            'A hotspot is a thermal anomaly seen from space, not a confirmed fire. The land type is not known from these detections, clouds or smoke can hide fires, and one fire seen by three satellites counts up to three times.',
            ...evidenceDetails(evidence),
          ],
          observedAt: str(v.latestAcquisition, latest.assertedAt),
          measurements: [],
          trend: trendOf(count, num(previous?.count)),
          fire: {
            hotspotCount: count,
            maxFrpMw: num(v.maxFrpMw),
            landType: 'unknown',
            detectionConfidence: confidence,
          },
          sources: [
            sourceRef(
              evidence?.sourceId ?? 'src-nasa-firms-viirs',
              evidence,
              str(v.latestAcquisition, latest.assertedAt),
              `${count} detections within ${String(v.radiusKm)} km`,
            ),
          ],
          tags: ['real', 'satellite', 'firms'],
        },
        evidence,
        history,
        maxAgeMinutes,
        // A count is as fresh as the window it covers, not its newest detection: an
        // up-to-date window with no recent detections is still fresh information.
        freshnessAt: str(v.windowEnd, latest.assertedAt),
      };
    }

    if (predicate.startsWith('pm25_zetaris_')) {
      const value = num(v.value);
      return {
        item: {
          ...base,
          id: `hz-zetaris-${predicate.slice('pm25_zetaris_'.length)}-${locationId}`,
          locationId,
          category: 'reading',
          headline: `PM2.5 ${round1(value)} µg/m³ in ${place} (Zetaris ${String(v.query)})`,
          summary: `From pinned Zetaris query ${String(v.query)}`,
          details: evidenceDetails(evidence),
          observedAt: latest.assertedAt,
          measurements: [
            { pollutant: 'pm25', value, unit: 'µg/m³', averaging: '1h' },
          ],
          trend: trendOf(value, num(previous?.value)),
          sources: [
            sourceRef(
              'src-zetaris',
              evidence,
              latest.assertedAt,
              `query ${String(v.query)}`,
            ),
          ],
          tags: ['real', 'zetaris'],
        },
        evidence,
        history,
        maxAgeMinutes,
        freshnessAt: latest.assertedAt,
      };
    }
    return null;
  }

  if (about.startsWith('station:') && predicate === 'pm25_observed') {
    const station = context.world.entity(about);
    if (!station) return null;
    const a = station.attrs;
    const locationId = str(a.nearestLocationId, '');
    const locationEntity = context.world.entity(
      entityId('location', locationId),
    );
    const place = locationEntity?.name ?? locationId;
    const timeZone = str(locationEntity?.attrs.timeZone, 'UTC');
    const value = num(v.value);
    const kind = a.isMonitor ? 'monitor' : 'low-cost sensor';
    return {
      item: {
        ...base,
        id: `hz-observed-${localId(about)}`,
        locationId,
        category: 'reading',
        headline: `PM2.5 ${round1(value)} µg/m³ at ${station.name ?? 'station'} (${String(a.distanceKm)} km from ${place})`,
        summary: `${String(a.provider)} ${kind} · hourly value for ${localTime(latest.assertedAt, timeZone)} local`,
        details: [
          `The ${String(a.provider)} ${kind} "${station.name ?? ''}" reported PM2.5 of ${round1(value)} µg/m³ for the hour ending ${latest.assertedAt}. It is ${String(a.distanceKm)} km from ${place}, so it describes that spot, not the whole city.`,
          a.isMonitor
            ? 'Listed by OpenAQ as a reference-type monitor.'
            : 'A low-cost optical sensor: useful for trends, less accurate than reference monitors, and sensitive to humidity.',
          ...evidenceDetails(evidence),
        ],
        observedAt: latest.assertedAt,
        measurements: [
          { pollutant: 'pm25', value, unit: 'µg/m³', averaging: '1h' },
        ],
        trend: trendOf(value, num(previous?.value)),
        sources: [
          sourceRef(
            evidence?.sourceId ?? 'src-openaq',
            evidence,
            latest.assertedAt,
            `OpenAQ sensor ${String(v.sensorId)}: ${round1(value)} µg/m³`,
          ),
        ],
        tags: [
          'real',
          'observation',
          a.isMonitor ? 'monitor' : 'low-cost-sensor',
        ],
      },
      evidence,
      history,
      maxAgeMinutes,
      freshnessAt: latest.assertedAt,
    };
  }
  return null;
}

function describeValue(predicate: string): (v: Value) => string {
  if (predicate === 'fixture.pm25')
    return (v) =>
      `Synthetic PM2.5 fixture value ${round1(num(v.pm25))} recorded`;
  if (predicate === 'fire_hotspots_24h')
    return (v) => `${String(v.count)} hotspots recorded`;
  if (predicate === 'pm25_forecast_24h')
    return (v) => `Forecast peak ${round1(num(v.maxPm25))} µg/m³ recorded`;
  return (v) => `PM2.5 ${round1(num(v.value))} µg/m³ recorded`;
}

function finish(
  draft: Draft,
  context: ProjectionContext,
  predicate: string,
): HazeItem {
  const checks = [
    freshnessCheck(draft.freshnessAt, context.now, draft.maxAgeMinutes),
    ...(draft.evidence?.checks ?? []),
  ];
  const sourceId = draft.evidence?.sourceId ?? '';
  const spec = context.specsBySource.get(sourceId);
  const agentResults: AgentResult[] = [
    {
      agent: 'hazeops',
      outcome: checks.some((c) => c.result === 'fail') ? 'warning' : 'ok',
      summary: draft.item.fictional
        ? 'Retained explicit synthetic fixture evidence; no upstream source was contacted.'
        : `Retrieved and pinned from ${spec?.source.name ?? sourceId}; identity and coverage checks run.`,
      durationMs: context.lastRunMs.get(spec?.id ?? '') ?? 0,
    },
    {
      agent: 'worldmodel',
      outcome: 'ok',
      summary: `${draft.history.length} fact revision(s) retained in the shared SQLite World Model; newest observation shown, older ones are kept.`,
      durationMs: 0,
    },
    {
      agent: 'evidencecritic',
      outcome: 'skipped',
      summary:
        'Collected evidence remains unreviewed; no independent review is attached to this observation.',
      durationMs: 0,
    },
  ];
  return {
    ...draft.item,
    tags: draft.item.fictional
      ? draft.item.tags.map((tag) => (tag === 'real' ? 'synthetic' : tag))
      : draft.item.tags,
    status: statusFrom(checks),
    checks,
    agentResults,
    timeline: timeline(draft.history, describeValue(predicate)),
    relatedIds: [],
  };
}

export function projectItems(context: ProjectionContext): HazeItem[] {
  const items: HazeItem[] = [];
  for (const { about, predicate, history } of context.world.facts()) {
    const draft = draftsFor(context, about, predicate, history);
    if (draft) items.push(finish(draft, context, predicate));
  }
  const byLocation = new Map<string, string[]>();
  for (const item of items) {
    byLocation.set(item.locationId, [
      ...(byLocation.get(item.locationId) ?? []),
      item.id,
    ]);
  }
  for (const item of items) {
    item.relatedIds = (byLocation.get(item.locationId) ?? [])
      .filter((id) => id !== item.id)
      .slice(0, 6);
  }
  return items.sort((a, b) => b.observedAt.localeCompare(a.observedAt));
}

export function projectLocations(
  world: Pick<HazeWorld, 'entities'>,
): Location[] {
  return world.entities('location').map((entity) => {
    const a = entity.attrs;
    return {
      id: localId(entity.id),
      name: entity.name ?? localId(entity.id),
      region: str(a.region, ''),
      country: str(a.country, ''),
      countryCode: str(a.countryCode, ''),
      lat: Number(a.lat),
      lon: Number(a.lon),
      timeZone: str(a.timeZone, 'UTC'),
      aqiStandard: str(a.aqiStandard, ''),
      populationBand:
        (a.populationBand as Location['populationBand']) ?? 'medium',
    };
  });
}

export function projectSources(
  specs: readonly WatcherSpec[],
  world?: Pick<HazeWorld, 'entities'>,
): Source[] {
  const sources = new Map(specs.map((spec) => [spec.source.id, spec.source]));
  // A task may collect a source that is not enabled as a recurring watcher.
  // Its retained source metadata belongs in the same dashboard snapshot.
  for (const entity of world?.entities('source') ?? []) {
    const a = entity.attrs;
    sources.set(localId(entity.id), {
      id: localId(entity.id),
      name: entity.name ?? localId(entity.id),
      kind: a.kind as Source['kind'],
      evidenceKind: a.evidenceKind as Source['evidenceKind'],
      organisation: str(a.organisation, ''),
      cadence: str(a.cadence, ''),
      licenceNote: str(a.licenceNote, ''),
      reliabilityNote: str(a.reliabilityNote, ''),
      url: str(a.url, ''),
    });
  }
  return [...sources.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function projectDetail(
  items: HazeItem[],
  id: string,
  locations: Location[],
  sources: Source[],
): ItemDetail | null {
  const item = items.find((i) => i.id === id);
  if (!item) return null;
  const sourceIds = new Set(item.sources.map((s) => s.sourceId));
  return {
    item,
    location: locations.find((l) => l.id === item.locationId) ?? null,
    sources: sources.filter((s) => sourceIds.has(s.id)),
    related: item.relatedIds
      .map((rid) => items.find((i) => i.id === rid))
      .filter((i): i is HazeItem => i !== undefined),
  };
}
