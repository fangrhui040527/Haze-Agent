#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import {
  hourlySeries,
  hourlyTimes,
  isMain,
  nullableNumber,
  runSnapshotSource,
  validateLocationRow,
  type Location,
  type SnapshotRow,
  type SnapshotSource,
} from '../shared/snapshot.ts';

export const AIR_QUALITY_COLUMNS = [
  'location_id',
  'location_name',
  'requested_latitude',
  'requested_longitude',
  'observation_time',
  'pm2_5_ug_m3',
  'pm10_ug_m3',
  'ingested_utc',
  'issued_utc',
] as const;

export function airQualityRows(
  location: Location,
  response: Record<string, unknown>,
  receivedAt: string,
): SnapshotRow[] {
  const times = hourlyTimes(response);
  const pm25 = hourlySeries(response, 'pm2_5', times.length, 'ug/m3');
  const pm10 = hourlySeries(response, 'pm10', times.length, 'ug/m3');
  return times.map((time, index) => ({
    location_id: location.id,
    location_name: location.name,
    requested_latitude: location.latitude,
    requested_longitude: location.longitude,
    observation_time: time,
    pm2_5_ug_m3: pm25[index] ?? null,
    pm10_ug_m3: pm10[index] ?? null,
    ingested_utc: receivedAt,
    // This response does not supply provider model issuance.
    issued_utc: null,
  }));
}

export function validateAirQualityRow(row: SnapshotRow): void {
  validateLocationRow(row);
  if (
    !nullableNumber(row['pm2_5_ug_m3'], 0) ||
    !nullableNumber(row['pm10_ug_m3'], 0)
  )
    throw new Error(
      'The air-quality snapshot contains an invalid concentration.',
    );
}

export const airQualitySource: SnapshotSource = {
  id: 'Open-Meteo air quality',
  directory: fileURLToPath(new URL('.', import.meta.url)),
  endpoint: 'https://air-quality-api.open-meteo.com/v1/air-quality',
  parameters: { hourly: 'pm2_5,pm10', past_days: '1', forecast_days: '3' },
  columns: AIR_QUALITY_COLUMNS,
  keys: ['location_id', 'observation_time'],
  database: 'OPEN_METEO_AIR_QUALITY',
  container: 'air_quality',
  view: 'hourly_observations',
  viewSelect: `SELECT
  location_name,
  CAST(requested_latitude AS DOUBLE) AS requested_latitude,
  CAST(requested_longitude AS DOUBLE) AS requested_longitude,
  observation_time,
  CAST(pm2_5_ug_m3 AS DOUBLE) AS pm2_5_ug_m3,
  CAST(pm10_ug_m3 AS DOUBLE) AS pm10_ug_m3,
  ingested_utc,
  CAST(NULL AS TIMESTAMP) AS issued_utc
FROM OPEN_METEO_AIR_QUALITY.hourly_snapshot`,
  rows: airQualityRows,
  validateRow: validateAirQualityRow,
};

if (isMain(import.meta.url)) {
  runSnapshotSource(airQualitySource).catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : 'Air-quality ingestion failed.',
    );
    process.exitCode = 1;
  });
}
