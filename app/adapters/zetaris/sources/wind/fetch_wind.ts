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

export const WIND_COLUMNS = [
  'location_id',
  'location_name',
  'requested_latitude',
  'requested_longitude',
  'observation_time',
  'level',
  'u',
  'v',
  'ingested_utc',
  'issued_utc',
] as const;

export function windRows(
  location: Location,
  response: Record<string, unknown>,
  receivedAt: string,
): SnapshotRow[] {
  const times = hourlyTimes(response);
  const rows: SnapshotRow[] = [];
  for (const [level, suffix] of [
    ['10m', '10m'],
    ['850hPa', '850hPa'],
  ] as const) {
    const speed = hourlySeries(
      response,
      `wind_speed_${suffix}`,
      times.length,
      'm/s',
    );
    const direction = hourlySeries(
      response,
      `wind_direction_${suffix}`,
      times.length,
      '°',
    );
    times.forEach((time, index) => {
      const magnitude = speed[index];
      const angle = direction[index];
      if (
        !nullableNumber(magnitude, 0) ||
        !nullableNumber(angle, 0) ||
        (typeof angle === 'number' && angle > 360)
      )
        throw new Error(
          'The wind source returned an invalid speed or direction.',
        );
      const radians =
        typeof angle === 'number' ? (angle * Math.PI) / 180 : null;
      rows.push({
        location_id: location.id,
        location_name: location.name,
        requested_latitude: location.latitude,
        requested_longitude: location.longitude,
        observation_time: time,
        level,
        u:
          typeof magnitude === 'number' && radians !== null
            ? -magnitude * Math.sin(radians)
            : null,
        v:
          typeof magnitude === 'number' && radians !== null
            ? -magnitude * Math.cos(radians)
            : null,
        ingested_utc: receivedAt,
        issued_utc: null,
      });
    });
  }
  return rows;
}

export function validateWindRow(row: SnapshotRow): void {
  validateLocationRow(row);
  if (
    !['10m', '850hPa'].includes(String(row['level'])) ||
    !nullableNumber(row['u']) ||
    !nullableNumber(row['v'])
  )
    throw new Error('The wind snapshot contains invalid components or level.');
}

export const windSource: SnapshotSource = {
  id: 'Open-Meteo wind',
  directory: fileURLToPath(new URL('.', import.meta.url)),
  endpoint: 'https://api.open-meteo.com/v1/forecast',
  parameters: {
    hourly:
      'wind_speed_10m,wind_direction_10m,wind_speed_850hPa,wind_direction_850hPa',
    wind_speed_unit: 'ms',
    past_days: '1',
    forecast_days: '3',
  },
  columns: WIND_COLUMNS,
  keys: ['location_id', 'observation_time', 'level'],
  database: 'OPEN_METEO_WIND',
  container: 'wind',
  view: 'hourly_observations',
  viewSelect: `SELECT
  location_name,
  CAST(requested_latitude AS DOUBLE) AS requested_latitude,
  CAST(requested_longitude AS DOUBLE) AS requested_longitude,
  observation_time,
  level,
  CAST(u AS DOUBLE) AS u,
  CAST(v AS DOUBLE) AS v,
  ingested_utc,
  CAST(NULL AS TIMESTAMP) AS issued_utc
FROM OPEN_METEO_WIND.hourly_snapshot`,
  rows: windRows,
  validateRow: validateWindRow,
};

if (isMain(import.meta.url)) {
  runSnapshotSource(windSource).catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : 'Wind ingestion failed.',
    );
    process.exitCode = 1;
  });
}
