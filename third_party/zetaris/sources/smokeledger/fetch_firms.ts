import { createHash } from 'node:crypto';
import {
  fetchText,
  insertRows,
  loadEnvironment,
  parseCliOptions,
  reportError,
  reportResult,
  withDatabase,
  type SqlValue,
} from './common.ts';

const ENDPOINT = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
const SOURCE = 'NASA FIRMS';
const FIRMS_SATELLITES = [
  'VIIRS_NOAA20_NRT',
  'VIIRS_NOAA21_NRT',
  'VIIRS_SNPP_NRT',
] as const;
const REGIONS = {
  peninsular_malaysia: [99.5, 1.0, 104.5, 7.5],
  east_malaysia: [109.5, 0.8, 119.5, 7.5],
} as const;

interface CsvRow {
  [column: string]: string;
}

function parseCsv(text: string): CsvRow[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      record.push(field);
      field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') {
        index += 1;
      }
      record.push(field);
      if (record.some((value) => value.length > 0)) {
        records.push(record);
      }
      record = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) {
    throw new Error(`${SOURCE} returned malformed CSV with an unterminated quote.`);
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  if (records.length === 0) {
    return [];
  }

  const headers = records[0];
  if (headers === undefined) {
    return [];
  }
  const normalizedHeaders = headers.map((header) => header.trim().replace(/^\uFEFF/u, ''));
  const required = [
    'latitude',
    'longitude',
    'frp',
    'acq_date',
    'acq_time',
    'satellite',
  ];
  for (const name of required) {
    if (!normalizedHeaders.includes(name)) {
      throw new Error(`${SOURCE} CSV is missing the "${name}" column.`);
    }
  }

  return records.slice(1).map((values, rowIndex) => {
    if (values.length !== normalizedHeaders.length) {
      throw new Error(`${SOURCE} CSV row ${rowIndex + 2} has the wrong number of columns.`);
    }
    const row: CsvRow = {};
    normalizedHeaders.forEach((header, index) => {
      row[header] = values[index] ?? '';
    });
    return row;
  });
}

function finiteValue(row: CsvRow, column: string, rowIndex: number): number {
  const rawValue = row[column];
  const value = rawValue === undefined || rawValue.trim() === '' ? Number.NaN : Number(rawValue);
  if (!Number.isFinite(value)) {
    throw new Error(`${SOURCE} CSV row ${rowIndex} has an invalid "${column}" value.`);
  }
  return value;
}

function acquisitionTime(row: CsvRow, rowIndex: number): Date {
  const date = row['acq_date'];
  const time = row['acq_time']?.trim().padStart(4, '0');
  if (
    date === undefined ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
    time === undefined ||
    !/^(?:[01]\d|2[0-3])[0-5]\d$/u.test(time)
  ) {
    throw new Error(`${SOURCE} CSV row ${rowIndex} has an invalid acquisition time.`);
  }
  const timestamp = new Date(
    `${date}T${time.slice(0, 2)}:${time.slice(2, 4)}:00Z`,
  );
  if (
    !Number.isFinite(timestamp.getTime()) ||
    timestamp.toISOString().slice(0, 10) !== date
  ) {
    throw new Error(`${SOURCE} CSV row ${rowIndex} has an invalid acquisition date.`);
  }
  return timestamp;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.locationIds.length > 0) {
    throw new Error('NASA FIRMS uses its configured Malaysia bounding boxes, not --location.');
  }
  await loadEnvironment();
  const key = process.env['FIRMS_MAP_KEY'];
  if (!key) {
    throw new Error(
      'FIRMS_MAP_KEY is not set. Add your NASA FIRMS map key to the project .env file.',
    );
  }

  const days = Number(process.env['FIRMS_DAYS'] ?? '1');
  if (!Number.isInteger(days) || days < 1 || days > 10) {
    throw new Error('FIRMS_DAYS must be an integer from 1 to 10.');
  }

  const records = await withDatabase(async (client) => {
    let totalRows = 0;
    for (const [region, bounds] of Object.entries(REGIONS)) {
      for (const satellite of FIRMS_SATELLITES) {
        const url = new URL(
          `${ENDPOINT}/${encodeURIComponent(key)}/${satellite}/${bounds.join(',')}/${days}`,
        );
        const csv = await fetchText(`${SOURCE} (${satellite}, ${region})`, url);
        const csvRows = parseCsv(csv);
        const rows: SqlValue[][] = csvRows.map((row, index) => {
          const latitude = finiteValue(row, 'latitude', index + 2);
          const longitude = finiteValue(row, 'longitude', index + 2);
          const frp = finiteValue(row, 'frp', index + 2);
          const acquiredAt = acquisitionTime(row, index + 2);
          const satelliteName = row['satellite'] ?? satellite;
          const stableId = createHash('sha256')
            .update(
              [
                satelliteName,
                acquiredAt.toISOString(),
                latitude.toFixed(5),
                longitude.toFixed(5),
                row['instrument'] ?? '',
                row['scan'] ?? '',
                row['track'] ?? '',
                row['version'] ?? '',
                row['bright_ti4'] ?? '',
              ].join('|'),
            )
            .digest('hex');
          return [
            stableId,
            latitude,
            longitude,
            acquiredAt,
            frp,
            row['confidence'] || null,
            satelliteName,
            row['daynight'] || null,
            `${satellite}:${region}`,
          ];
        });
        totalRows += rows.length;
        if (!options.dryRun) {
          await insertRows(
            client,
            'fires',
            [
              'fire_id',
              'lat',
              'lon',
              'acq_utc',
              'frp',
              'confidence',
              'satellite',
              'daynight',
              'source_file',
            ],
            rows,
            'ON CONFLICT (fire_id) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, acq_utc = EXCLUDED.acq_utc, frp = EXCLUDED.frp, confidence = EXCLUDED.confidence, satellite = EXCLUDED.satellite, daynight = EXCLUDED.daynight, source_file = EXCLUDED.source_file, ingested_utc = now()',
          );
        }
      }
    }
    return totalRows;
  });

  reportResult(SOURCE, records, options.dryRun);
}

main().catch((error: unknown) => reportError(SOURCE, error));
