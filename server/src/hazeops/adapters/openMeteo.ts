import type { Location } from '../../../../frontend/src/shared/types/domain.ts';
import {
  decisionTimeCheck,
  normaliseUnit,
  resolutionCheck,
  unitCheck,
  valuesCheck,
} from '../checks.ts';
import { pinEvidence } from '../evidence.ts';
import { boundedFetch } from '../http.ts';
import type {
  AdapterContext,
  AdapterResult,
  FactDraft,
  PinnedEvidence,
  SourceAdapter,
  WatcherSpec,
} from '../types.ts';

/**
 * Open-Meteo Air Quality API, global CAMS domain. No key needed.
 * Modeled values: a ~45 km model cell with 3-hourly native steps (CAMS global),
 * returned by Open-Meteo on an hourly grid. Not a measurement at the city.
 */

const ENDPOINT = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const CHUNK = 25;
const NATIVE_RESOLUTION =
  'CAMS global model: ~45 km (0.4°) cells, 3-hourly native steps, served on an hourly grid by Open-Meteo';

export const OPEN_METEO_SOURCE_ID = 'src-openmeteo-cams';

export function openMeteoSpec(locations: readonly Location[]): WatcherSpec {
  return {
    id: 'openmeteo-cams-pm25',
    source: {
      id: OPEN_METEO_SOURCE_ID,
      name: 'Open-Meteo Air Quality (CAMS global)',
      kind: 'forecast_model',
      evidenceKind: 'modeled',
      organisation:
        'Open-Meteo, using Copernicus Atmosphere Monitoring Service (CAMS) data',
      cadence: 'CAMS global updates every 12 h; 3-hourly steps',
      licenceNote:
        'Attribution required: Copernicus Atmosphere Monitoring Service (CAMS) and Open-Meteo. Free API is for non-commercial use.',
      reliabilityNote:
        'Regional atmospheric model, not a sensor. ~45 km cells cannot show street-level differences.',
      url: 'https://open-meteo.com/en/docs/air-quality-api',
    },
    requiresEnv: [],
    query:
      'hourly pm2_5, pm10 (domains=cams_global, past 1 day, forecast 2 days)',
    placeSelector: `${locations.length} configured city coordinates`,
    timeSelector: 'now − 24 h to now + 48 h, UTC',
    cadenceSec: 3 * 3600,
    rateLimit: '1 request per 25 places per run; free non-commercial tier',
    freshnessMinutes: 6 * 60,
  };
}

interface OpenMeteoLocation {
  latitude: number;
  longitude: number;
  hourly_units?: Record<string, string>;
  hourly?: {
    time: string[];
    pm2_5?: (number | null)[];
    pm10?: (number | null)[];
  };
}

function hourIndex(times: string[], at: Date): number {
  const target = at.toISOString().slice(0, 13);
  return times.findIndex((t) => t.slice(0, 13) === target);
}

const mean = (values: number[]): number | null =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

export function openMeteoAdapter(
  locations: readonly Location[],
): SourceAdapter {
  const spec = openMeteoSpec(locations);
  return {
    spec,
    async run(context: AdapterContext): Promise<AdapterResult> {
      const evidence: PinnedEvidence[] = [];
      const facts: FactDraft[] = [];
      const excluded: { id: string; reason: string }[] = [];

      for (let start = 0; start < locations.length; start += CHUNK) {
        const chunk = locations.slice(start, start + CHUNK);
        const params = new URLSearchParams({
          latitude: chunk.map((l) => l.lat.toFixed(4)).join(','),
          longitude: chunk.map((l) => l.lon.toFixed(4)).join(','),
          hourly: 'pm2_5,pm10',
          domains: 'cams_global',
          timezone: 'GMT',
          past_days: '1',
          forecast_days: '2',
        });
        const url = `${ENDPOINT}?${params.toString()}`;
        const fetched = await boundedFetch(url, {
          signal: context.signal,
          label: 'Open-Meteo air quality',
        });
        const parsed = JSON.parse(fetched.raw.toString('utf8')) as
          OpenMeteoLocation | OpenMeteoLocation[];
        const rows = Array.isArray(parsed) ? parsed : [parsed];

        const allValues = rows.flatMap((r) => r.hourly?.pm2_5 ?? []);
        const upstreamUnit = rows[0]?.hourly_units?.pm2_5 ?? null;
        const times = rows[0]?.hourly?.time ?? [];
        const pinned = pinEvidence({
          raw: fetched.raw,
          upstream: { system: 'open-meteo', id: 'air-quality/cams_global' },
          sourceId: OPEN_METEO_SOURCE_ID,
          sourceKind: 'modeled',
          title: `CAMS PM2.5/PM10 for ${chunk.length} places`,
          sourceOwner: 'Open-Meteo / Copernicus (CAMS)',
          locator: {
            kind: 'data',
            url,
            selection: `places ${chunk.map((l) => l.id).join(', ')}; hourly pm2_5, pm10`,
          },
          pollutant: 'pm25',
          unit: normaliseUnit(upstreamUnit),
          issuedAt: null,
          issuedAtReason:
            'The Open-Meteo response does not state which CAMS model run produced these values.',
          validInterval:
            times.length > 0
              ? {
                  start: `${times[0]}:00Z`,
                  end: `${times[times.length - 1]}:00Z`,
                }
              : null,
          retrievedAt: fetched.retrievedAt,
          nativeTemporalResolution: NATIVE_RESOLUTION,
          spatialSupport: 'Model grid cell nearest each city coordinate',
          licenceRef: spec.source.licenceNote,
          permittedUses: ['information_display'],
          limitations: [
            'Modeled all-source PM2.5, not a measurement and not fire attribution.',
            'Hourly values between 3-hourly model steps add no real detail.',
            'Not reviewed for any workplace or health decision.',
          ],
          coverageChecks: [
            unitCheck(upstreamUnit),
            valuesCheck(allValues),
            resolutionCheck(NATIVE_RESOLUTION, true),
            decisionTimeCheck(null, fetched.retrievedAt),
          ],
        });
        evidence.push(pinned);
        if (!pinned.record.unit) continue;

        chunk.forEach((location, i) => {
          const row = rows[i];
          const series = row?.hourly;
          if (!row || !series?.pm2_5) {
            excluded.push({
              id: location.id,
              reason: 'no pm2_5 series returned',
            });
            return;
          }
          const now = hourIndex(series.time, context.now);
          if (now < 0) {
            excluded.push({
              id: location.id,
              reason: 'current hour not in series',
            });
            return;
          }
          const value = series.pm2_5[now] ?? null;
          const pm10 = series.pm10?.[now] ?? null;
          const earlier = now >= 3 ? (series.pm2_5[now - 3] ?? null) : null;
          const observedAt = `${series.time[now]}:00Z`;
          facts.push({
            about: { type: 'location', id: location.id },
            predicate: 'pm25_modeled',
            value: {
              value,
              pm10,
              unit: 'µg/m³',
              observedAt,
              valueThreeHoursEarlier: earlier,
              gridLat: row.latitude,
              gridLon: row.longitude,
            },
            observedAt,
            evidenceId: pinned.record.evidenceId,
          });

          const next = series.pm2_5
            .slice(now + 1, now + 25)
            .filter((v): v is number => typeof v === 'number');
          const past = series.pm2_5
            .slice(Math.max(0, now - 24), now)
            .filter((v): v is number => typeof v === 'number');
          if (next.length > 0) {
            const nextMean = mean(next);
            const pastMean = mean(past);
            const direction =
              nextMean === null || pastMean === null || pastMean === 0
                ? 'steady'
                : nextMean > pastMean * 1.1
                  ? 'worsening'
                  : nextMean < pastMean * 0.9
                    ? 'improving'
                    : 'steady';
            facts.push({
              about: { type: 'location', id: location.id },
              predicate: 'pm25_forecast_24h',
              value: {
                validFrom: `${series.time[now + 1]}:00Z`,
                validTo: `${series.time[Math.min(now + 24, series.time.length - 1)]}:00Z`,
                maxPm25: Math.max(...next),
                meanPm25: nextMean,
                pastMeanPm25: pastMean,
                direction,
                unit: 'µg/m³',
              },
              observedAt,
              evidenceId: pinned.record.evidenceId,
            });
          }
        });
      }

      return {
        evidence,
        stations: [],
        facts,
        coverage: {
          requested: locations.length,
          covered: locations.length - excluded.length,
          excluded,
          gaps: [],
        },
      };
    },
  };
}
