import type { Location } from '../../../contracts/haze-evidence.js';
import { nearestLocation } from '../locations.js';
import {
  decisionTimeCheck,
  resolutionCheck,
  unitCheck,
  valuesCheck,
} from '../checks.js';
import { bundleRaw, pinEvidence } from '../evidence.js';
import type { FetchedBytes } from '../../../adapters/haze-sources/http.js';
import {
  fetchOpenAqCatalogue,
  fetchOpenAqLatest,
  openAqCatalogueUrl,
} from '../../../adapters/haze-sources/openAq.js';
import type {
  AdapterContext,
  AdapterResult,
  FactDraft,
  SourceAdapter,
  StationDraft,
  WatcherSpec,
} from '../types.js';

/**
 * OpenAQ v3: ground stations reporting PM2.5 in Malaysia. Most Malaysian stations on
 * OpenAQ are low-cost AirGradient sensors (isMonitor=false), not official DOE monitors;
 * every item says which kind it is.
 */

/** OpenAQ's country id for Malaysia (checked against /v3/countries on 24 Oct 2026). */
const MALAYSIA_COUNTRY_ID = 2;
const PM25_PARAMETER_ID = 2;
const MAX_STATION_KM = 75;
const MAX_SILENCE_HOURS = 48;
/** Networks whose stations OpenAQ tags as Malaysia but which report from Thailand. */
const EXCLUDED_PROVIDERS = new Set(['Air4Thai']);

export const OPENAQ_SOURCE_ID = 'src-openaq';

export function openAqSpec(): WatcherSpec {
  return {
    id: 'openaq-my-pm25',
    source: {
      id: OPENAQ_SOURCE_ID,
      name: 'OpenAQ (Malaysia stations)',
      kind: 'low_cost_sensor',
      evidenceKind: 'observation',
      organisation:
        'OpenAQ, aggregating AirGradient, Clarity and other networks',
      cadence: 'Hourly per station; checked every 30 min',
      licenceNote:
        'OpenAQ API terms; each station keeps its provider licence. Key held on the server only.',
      reliabilityNote:
        'Mostly low-cost optical sensors, not reference monitors. Values can drift with humidity.',
      url: 'https://openaq.org',
    },
    requiresEnv: ['OPEN_AQ_KEY'],
    query: `GET /v3/locations?countries_id=${MALAYSIA_COUNTRY_ID}&parameters_id=${PM25_PARAMETER_ID}, then /v3/locations/{id}/latest`,
    placeSelector: `Malaysian stations within ${MAX_STATION_KM} km of a configured Malaysian city`,
    timeSelector: `latest hourly value; stations silent for ${MAX_SILENCE_HOURS} h are excluded`,
    cadenceSec: 30 * 60,
    rateLimit: '60 requests/min on the key; one request per station per run',
    freshnessMinutes: 3 * 60,
  };
}

interface OpenAqLocation {
  id: number;
  name: string;
  isMonitor: boolean;
  provider?: { name?: string };
  coordinates: { latitude: number; longitude: number };
  datetimeLast?: { utc: string } | null;
  sensors: { id: number; parameter: { id: number; units: string } }[];
}

interface OpenAqLatest {
  datetime: { utc: string };
  value: number | null;
  sensorsId: number;
}

export function openAqAdapter(
  locations: readonly Location[],
  apiKey: string,
): SourceAdapter {
  const spec = openAqSpec();
  const malaysian = locations.filter((l) => l.countryCode === 'MY');

  return {
    spec,
    async run(context: AdapterContext): Promise<AdapterResult> {
      const catalogueUrl = openAqCatalogueUrl(
        MALAYSIA_COUNTRY_ID,
        PM25_PARAMETER_ID,
      );
      const catalogue = await fetchOpenAqCatalogue(
        MALAYSIA_COUNTRY_ID,
        PM25_PARAMETER_ID,
        apiKey,
        context.signal,
      );
      const listed = (
        JSON.parse(catalogue.raw.toString('utf8')) as {
          results: OpenAqLocation[];
        }
      ).results;

      const excluded: { id: string; reason: string }[] = [];
      const candidates: { station: StationDraft; unit: string }[] = [];
      for (const loc of listed) {
        const id = `openaq-${loc.id}`;
        const sensor = loc.sensors.find(
          (s) => s.parameter.id === PM25_PARAMETER_ID,
        );
        const last = loc.datetimeLast?.utc;
        const provider = loc.provider?.name ?? 'unknown provider';
        if (EXCLUDED_PROVIDERS.has(provider)) {
          excluded.push({
            id,
            reason: `${provider} station (reports from Thailand)`,
          });
          continue;
        }
        if (!sensor) {
          excluded.push({ id, reason: 'no PM2.5 sensor' });
          continue;
        }
        if (
          !last ||
          context.now.getTime() - Date.parse(last) >
            MAX_SILENCE_HOURS * 3600_000
        ) {
          excluded.push({ id, reason: `silent since ${last ?? 'never'}` });
          continue;
        }
        const point = {
          lat: loc.coordinates.latitude,
          lon: loc.coordinates.longitude,
        };
        const nearest = nearestLocation(point, malaysian);
        if (!nearest || nearest.km > MAX_STATION_KM) {
          excluded.push({
            id,
            reason: `more than ${MAX_STATION_KM} km from a configured city`,
          });
          continue;
        }
        candidates.push({
          station: {
            stationId: id,
            name: loc.name,
            lat: point.lat,
            lon: point.lon,
            provider,
            isMonitor: loc.isMonitor,
            sensorId: sensor.id,
            nearestLocationId: nearest.location.id,
            distanceKm: Math.round(nearest.km * 10) / 10,
          },
          unit: sensor.parameter.units,
        });
      }

      // One call per station, two at a time, to stay well inside 60 requests/min.
      const responses = new Map<string, FetchedBytes>();
      const failures: string[] = [];
      for (let i = 0; i < candidates.length; i += 2) {
        await Promise.all(
          candidates.slice(i, i + 2).map(async ({ station }) => {
            try {
              const id = station.stationId.replace('openaq-', '');
              responses.set(
                station.stationId,
                await fetchOpenAqLatest(
                  id,
                  station.name,
                  apiKey,
                  context.signal,
                ),
              );
            } catch (error) {
              failures.push(station.stationId);
              excluded.push({
                id: station.stationId,
                reason: error instanceof Error ? error.message : String(error),
              });
            }
          }),
        );
      }

      const raw = bundleRaw([
        {
          label: 'catalogue',
          status: catalogue.status,
          sha256: catalogue.sha256,
          body: JSON.parse(catalogue.raw.toString('utf8')) as unknown,
        },
        ...[...responses.entries()].map(([stationId, r]) => ({
          label: `latest ${stationId}`,
          status: r.status,
          sha256: r.sha256,
          body: JSON.parse(r.raw.toString('utf8')) as unknown,
        })),
      ]);

      const facts: FactDraft[] = [];
      const stations: StationDraft[] = [];
      const values: (number | null)[] = [];
      const units = new Set(candidates.map((c) => c.unit));
      const pending: { station: StationDraft; latest: OpenAqLatest }[] = [];
      for (const { station } of candidates) {
        const response = responses.get(station.stationId);
        if (!response) continue;
        const results = (
          JSON.parse(response.raw.toString('utf8')) as {
            results: OpenAqLatest[];
          }
        ).results;
        const latest = results.find((r) => r.sensorsId === station.sensorId);
        if (!latest) {
          excluded.push({
            id: station.stationId,
            reason: 'no latest PM2.5 value',
          });
          continue;
        }
        values.push(latest.value);
        pending.push({ station, latest });
      }

      const unit = units.size === 1 ? [...units][0] : null;
      const pinned = pinEvidence({
        raw,
        upstream: {
          system: 'openaq',
          id: `v3/countries/${MALAYSIA_COUNTRY_ID}/pm25`,
        },
        sourceId: OPENAQ_SOURCE_ID,
        sourceKind: 'observation',
        title: `Latest PM2.5 from ${pending.length} Malaysian stations`,
        sourceOwner: 'OpenAQ and station providers',
        locator: {
          kind: 'data',
          url: catalogueUrl,
          selection: `stations ${pending.map((p) => p.station.stationId).join(', ')}`,
        },
        pollutant: 'pm25',
        unit: unit === 'µg/m³' ? 'µg/m³' : null,
        issuedAt: null,
        issuedAtReason:
          'Observations have measurement times per station, not an issue time.',
        validInterval: null,
        retrievedAt: catalogue.retrievedAt,
        nativeTemporalResolution: 'Hourly values per station',
        spatialSupport:
          'Point sensors; each mapped to the nearest configured city',
        licenceRef: spec.source.licenceNote,
        permittedUses: ['information_display'],
        limitations: [
          'Mostly low-cost sensors, not reference-grade monitors.',
          'A station near a city is not the whole city.',
          'Not reviewed for any workplace or health decision.',
        ],
        coverageChecks: [
          unitCheck(unit),
          valuesCheck(values),
          resolutionCheck('Hourly point measurements', false),
          decisionTimeCheck(null, catalogue.retrievedAt),
        ],
      });

      if (pinned.record.unit) {
        for (const { station, latest } of pending) {
          stations.push(station);
          facts.push({
            about: { type: 'station', id: station.stationId },
            predicate: 'pm25_observed',
            value: {
              value: latest.value,
              unit: 'µg/m³',
              averaging: '1h',
              observedAt: latest.datetime.utc,
              sensorId: station.sensorId,
            },
            observedAt: latest.datetime.utc,
            evidenceId: pinned.record.evidenceId,
          });
        }
      }

      return {
        evidence: [pinned],
        stations,
        facts,
        coverage: {
          requested: listed.length,
          covered: facts.length,
          excluded,
          gaps: failures.length
            ? [`${failures.length} station request(s) failed this run`]
            : [],
        },
      };
    },
  };
}
