import type { Location } from '../../../../frontend/src/shared/types/domain.ts';
import { distanceKm } from '../../locations.ts';
import { decisionTimeCheck, resolutionCheck, valuesCheck } from '../checks.ts';
import { bundleRaw, pinEvidence } from '../evidence.ts';
import { boundedFetch } from '../http.ts';
import type {
  AdapterContext,
  AdapterResult,
  FactDraft,
  SourceAdapter,
  WatcherSpec,
} from '../types.ts';

/**
 * NASA FIRMS active-fire detections (VIIRS, near real time) over Malaysia and the
 * neighbouring fire regions whose smoke reaches it (Sumatra, Kalimantan, southern
 * Thailand). A hotspot is a thermal anomaly seen by a satellite: not a confirmed fire,
 * not proof of the land type, and missing detections are not proof of no fire
 * (Spec §21.2).
 */

const BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
/** west,south,east,north */
const AREA = { west: 95, south: -6, east: 120, north: 8 };
const SENSORS = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT'];
const RADIUS_KM = 150;
const WINDOW_HOURS = 24;

export const FIRMS_SOURCE_ID = 'src-nasa-firms-viirs';

export function firmsSpec(): WatcherSpec {
  return {
    id: 'firms-viirs-hotspots',
    source: {
      id: FIRMS_SOURCE_ID,
      name: 'NASA FIRMS (VIIRS active fires)',
      kind: 'satellite',
      evidenceKind: 'observation',
      organisation: 'NASA Fire Information for Resource Management System',
      cadence: 'Several satellite passes per day; checked hourly',
      licenceNote:
        'NASA FIRMS open data; acknowledge NASA FIRMS (LANCE). MAP_KEY held on the server only.',
      reliabilityNote:
        '375 m thermal detections. Clouds and smoke hide fires; a hotspot is not a confirmed fire or land type.',
      url: 'https://firms.modaps.eosdis.nasa.gov',
    },
    requiresEnv: ['FIRMS_MAP_KEY'],
    query: `area CSV, sources ${SENSORS.join(', ')}, 2-day range filtered to the last ${WINDOW_HOURS} h`,
    placeSelector: `bbox ${AREA.west},${AREA.south},${AREA.east},${AREA.north}; hotspots within ${RADIUS_KM} km of each configured city inside it`,
    timeSelector: `last ${WINDOW_HOURS} h of acquisitions`,
    cadenceSec: 60 * 60,
    rateLimit: '5,000 transactions per 10 min per MAP_KEY; 3 requests per run',
    freshnessMinutes: 12 * 60,
  };
}

interface Hotspot {
  lat: number;
  lon: number;
  at: string;
  frp: number | null;
  confidence: 'low' | 'nominal' | 'high';
  satellite: string;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift()?.split(',') ?? [];
  return lines
    .filter((line) => line.length > 0)
    .map((line) => {
      const cells = line.split(',');
      return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
    });
}

function toHotspot(row: Record<string, string>): Hotspot | null {
  const lat = Number(row.latitude);
  const lon = Number(row.longitude);
  const date = row.acq_date;
  const time = (row.acq_time ?? '').padStart(4, '0');
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !date) return null;
  const frp = Number(row.frp);
  const confidence =
    row.confidence === 'h'
      ? 'high'
      : row.confidence === 'l'
        ? 'low'
        : 'nominal';
  return {
    lat,
    lon,
    at: `${date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`,
    frp: Number.isFinite(frp) ? frp : null,
    confidence,
    satellite: row.satellite ?? '',
  };
}

const inArea = (l: { lat: number; lon: number }) =>
  l.lon >= AREA.west &&
  l.lon <= AREA.east &&
  l.lat >= AREA.south &&
  l.lat <= AREA.north;

export function firmsAdapter(
  locations: readonly Location[],
  mapKey: string,
): SourceAdapter {
  const spec = firmsSpec();
  const covered = locations.filter(inArea);

  return {
    spec,
    async run(context: AdapterContext): Promise<AdapterResult> {
      const area = `${AREA.west},${AREA.south},${AREA.east},${AREA.north}`;
      const parts = [];
      const hotspots: Hotspot[] = [];
      for (const sensor of SENSORS) {
        const fetched = await boundedFetch(
          `${BASE}/${mapKey}/${sensor}/${area}/2`,
          {
            signal: context.signal,
            label: `NASA FIRMS ${sensor}`,
          },
        );
        const text = fetched.raw.toString('utf8');
        if (!text.startsWith('latitude')) {
          throw new Error(
            `NASA FIRMS ${sensor}: unexpected response "${text.slice(0, 120)}"`,
          );
        }
        parts.push({
          label: sensor,
          status: fetched.status,
          sha256: fetched.sha256,
          body: text,
        });
        for (const row of parseCsv(text)) {
          const hotspot = toHotspot(row);
          if (hotspot) hotspots.push(hotspot);
        }
      }

      const windowEnd = new Date(
        Math.floor(context.now.getTime() / 3600_000) * 3600_000,
      );
      const windowStart = new Date(
        windowEnd.getTime() - WINDOW_HOURS * 3600_000,
      );
      const recent = hotspots.filter(
        (h) =>
          h.at >= windowStart.toISOString() &&
          h.at <= context.now.toISOString(),
      );
      const retrievedAt = new Date().toISOString();
      const pinned = pinEvidence({
        raw: bundleRaw(parts),
        upstream: { system: 'nasa-firms', id: `area/${area}` },
        sourceId: FIRMS_SOURCE_ID,
        sourceKind: 'observation',
        title: `${recent.length} VIIRS hotspots in the last ${WINDOW_HOURS} h`,
        sourceOwner: 'NASA FIRMS',
        locator: {
          kind: 'data',
          url: `${BASE}/<MAP_KEY>/{${SENSORS.join('|')}}/${area}/2`,
          selection: `acquisitions ${windowStart.toISOString()} to ${context.now.toISOString()}`,
        },
        pollutant: null,
        unit: null,
        issuedAt: null,
        issuedAtReason:
          'Detections carry acquisition times, not an issue time.',
        validInterval: {
          start: windowStart.toISOString(),
          end: context.now.toISOString(),
        },
        retrievedAt,
        nativeTemporalResolution: 'Per satellite overpass (several per day)',
        spatialSupport: '375 m VIIRS pixels',
        licenceRef: spec.source.licenceNote,
        permittedUses: ['information_display'],
        limitations: [
          'A hotspot is a thermal anomaly, not a confirmed fire.',
          'Land type (peat, forest, farm) is not known from these detections.',
          'Clouds and smoke hide fires: no detection is not proof of no fire.',
          'Hotspot counts are not haze levels and not fire attribution.',
          'Counts are detections from three satellites: one fire can be counted up to three times.',
        ],
        coverageChecks: [
          valuesCheck(recent.map((h) => h.frp)),
          resolutionCheck('375 m pixels, per overpass', false),
          decisionTimeCheck(null, retrievedAt),
        ],
      });

      const facts: FactDraft[] = covered.map((location) => {
        const near = recent
          .map((h) => ({ h, km: distanceKm(h, location) }))
          .filter((x) => x.km <= RADIUS_KM);
        const frps = near
          .map((x) => x.h.frp)
          .filter((v): v is number => v !== null);
        const latest = near.reduce<string | null>(
          (acc, x) => (acc === null || x.h.at > acc ? x.h.at : acc),
          null,
        );
        const confidence = near.some((x) => x.h.confidence === 'high')
          ? 'high'
          : near.some((x) => x.h.confidence === 'nominal')
            ? 'nominal'
            : 'low';
        return {
          about: { type: 'location', id: location.id },
          predicate: 'fire_hotspots_24h',
          value: {
            count: near.length,
            highConfidenceCount: near.filter((x) => x.h.confidence === 'high')
              .length,
            maxFrpMw: frps.length ? Math.max(...frps) : null,
            highestConfidence: near.length ? confidence : null,
            nearestKm: near.length
              ? Math.round(Math.min(...near.map((x) => x.km)))
              : null,
            radiusKm: RADIUS_KM,
            windowStart: windowStart.toISOString(),
            windowEnd: windowEnd.toISOString(),
            latestAcquisition: latest,
          },
          observedAt: windowEnd.toISOString(),
          evidenceId: pinned.record.evidenceId,
          dedupeKey: near.length === 0 ? 'none-detected' : undefined,
        };
      });

      return {
        evidence: [pinned],
        stations: [],
        facts,
        coverage: {
          requested: locations.length,
          covered: covered.length,
          excluded: locations
            .filter((l) => !inArea(l))
            .map((l) => ({
              id: l.id,
              reason: 'outside the FIRMS area watched',
            })),
          gaps: [],
        },
      };
    },
  };
}
