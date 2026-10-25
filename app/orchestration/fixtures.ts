import {
  IntegrationPortError,
  createUnavailableHMemPort,
  createUnavailableWorldModelPort,
  runWithExecutionContext,
  validateModelCompletion,
  validateModelInput,
  type HMemPort,
  type IntegrationPorts,
  type NightShiftPort,
  type WorldModelPort,
  type ZetarisPort,
} from './ports.js';
import {
  PM25_SOURCE_ID,
  type EvidenceCapture,
  type EvidenceScope,
} from '../tasks/evidence.js';

/** Synthetic hourly modeled values. Never selected by a live factory or fallback. */
export function createFixtureCapture(scope: EvidenceScope): EvidenceCapture {
  const rows: EvidenceCapture['rows'] = [];
  for (
    let at = Math.ceil(Date.parse(scope.period.start) / 3_600_000) * 3_600_000;
    at < Date.parse(scope.period.end) && rows.length < 744;
    at += 3_600_000
  ) {
    const start = new Date(at).toISOString();
    rows.push({
      start,
      end: start,
      value: 12 + (rows.length % 8),
      issued_at: null,
      location: scope.location,
      ingested_at: scope.period.end,
      latitude: 3.0449,
      longitude: 101.4456,
    });
  }
  const data = rows.map((row) => ({
    town: row.location,
    valid_utc: row.start,
    kind: 'model',
    issued_utc: null,
    pm25: row.value,
    source: 'open-meteo-air-quality',
    ingested_utc: row.ingested_at,
    lat: row.latitude,
    lon: row.longitude,
  }));
  return {
    source: PM25_SOURCE_ID,
    kind: 'modeled',
    units: 'µg/m³',
    location: scope.location,
    retrieved_at: scope.period.end,
    issued_at: null,
    rows,
    raw: JSON.stringify({ data }),
    selection: {
      backend: 'zetaris-rest',
      query: 'FIXTURE: synthetic PM2.5 selection; no SQL was executed.',
      request_id: 'fixture-pm25-selection',
      row_limit: 1500,
      returned_rows: rows.length,
      truncated: false,
      source_filter: 'open-meteo-air-quality',
      selected_raw_row_indices: rows.map((_row, index) => index),
    },
    limitations: [
      'Synthetic integration fixture; no live source was queried.',
      'Provider issuance and model grid support are unknown in this fixture.',
    ],
    // This legacy domain field is fixed by EvidenceCapture. Port.mode is the
    // authoritative execution mode and must label fixture results as fixture.
    mode: 'live',
    temporal_support: 'instantaneous',
    sample_interval_minutes: 60,
    units_reference: 'https://open-meteo.com/en/docs/air-quality-api',
  };
}

export interface FixturePortOptions {
  execute?: NightShiftPort['execute'];
  retrieve?: ZetarisPort['retrieve'];
  hmem?: HMemPort;
  world?: WorldModelPort;
}

/** Explicit opt-in only; role payloads belong to the capability's test fixtures. */
export function createFixturePorts(
  options: FixturePortOptions = {},
): IntegrationPorts {
  return {
    nightshift: {
      id: 'fixture-nightshift',
      mode: 'fixture',
      selection: { provider: 'fixture', model: 'fixture-nightshift' },
      execute: (input, context) =>
        runWithExecutionContext(context, async (boundedContext) => {
          validateModelInput(input, boundedContext.modelLimits);
          if (!options.execute) {
            throw new IntegrationPortError(
              'unavailable',
              'An explicit fixture model executor is required.',
            );
          }
          return validateModelCompletion(
            await options.execute(input, boundedContext),
            boundedContext.modelLimits,
          );
        }),
    },
    zetaris: {
      id: PM25_SOURCE_ID,
      mode: 'fixture',
      retrieve: (scope, context) =>
        runWithExecutionContext(context, async (boundedContext) =>
          options.retrieve
            ? options.retrieve(scope, boundedContext)
            : createFixtureCapture(scope),
        ),
    },
    hmem: options.hmem ?? createUnavailableHMemPort(),
    world: options.world ?? createUnavailableWorldModelPort(),
  };
}
