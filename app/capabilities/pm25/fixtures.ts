import {
  PM25_SOURCE_ID,
  type EvidenceCapture,
  type EvidenceScope,
} from './evidence.js';

/** Explicit synthetic fixture; live factories never select this implementation. */
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
  return {
    source: PM25_SOURCE_ID,
    kind: 'modeled',
    units: 'µg/m³',
    location: scope.location,
    retrieved_at: scope.period.end,
    issued_at: null,
    rows,
    raw: JSON.stringify({
      data: rows.map((row) => ({
        town: row.location,
        valid_utc: row.start,
        kind: 'model',
        issued_utc: null,
        pm25: row.value,
        source: 'open-meteo-air-quality',
        ingested_utc: row.ingested_at,
        lat: row.latitude,
        lon: row.longitude,
      })),
    }),
    selection: {
      backend: 'zetaris-rest',
      query: 'FIXTURE: synthetic PM2.5 selection; no SQL was executed.',
      request_id: 'fixture-pm25-selection',
      row_limit: 1500,
      returned_rows: rows.length,
      truncated: false,
      source_filter: 'open-meteo-air-quality',
      selected_raw_row_indices: rows.map((_, index) => index),
    },
    limitations: [
      'Synthetic fixture; no live source was queried.',
      'Provider issuance, observation coverage and model grid support are unknown.',
    ],
    mode: 'fixture',
    evidence_origin: 'synthetic_fixture',
    temporal_support: 'instantaneous',
    sample_interval_minutes: 60,
    units_reference: 'https://open-meteo.com/en/docs/air-quality-api',
  };
}
