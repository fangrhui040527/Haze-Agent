import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { envFileCandidates } from '../../scripts/env-files.ts';

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCATIONS_PATH = path.resolve(
  SOURCE_DIR,
  '../../sources/air_quality/locations.json',
);
const DEFAULT_DATABASE_URL =
  'postgres://smokeledger:smokeledger@localhost:5433/smokeledger';
const REQUEST_TIMEOUT_MS = 30_000;
const INSERT_BATCH_SIZE = 250;
const LOCATION_BATCH_SIZE = 50;

export interface Location {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface OpenMeteoLocation {
  hourly: Record<string, unknown>;
}

export interface CliOptions {
  locationIds: string[];
  dryRun: boolean;
}

export type SqlValue = string | number | boolean | Date | null;

export async function loadEnvironment(): Promise<void> {
  for (const envPath of envFileCandidates()) {
    let contents: string;
    try {
      contents = await readFile(envPath, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }

    for (const line of contents.split(/\r?\n/u)) {
      const match =
        /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(
          line,
        );
      if (!match) {
        continue;
      }

      const [, key, rawValue] = match;
      if (
        key === undefined ||
        rawValue === undefined ||
        process.env[key] !== undefined
      ) {
        continue;
      }

      let value = rawValue;
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/u, '').trim();
      }
      process.env[key] = value;
    }
  }
}

export function parseCliOptions(args: string[]): CliOptions {
  const locationIds: string[] = [];
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument === '--location') {
      const locationId = args[index + 1];
      if (locationId === undefined || locationId.startsWith('--')) {
        throw new Error('--location requires a location id.');
      }
      locationIds.push(locationId);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  return { locationIds, dryRun };
}

export async function readLocations(locationIds: string[] = []): Promise<Location[]> {
  const content = await readFile(LOCATIONS_PATH, 'utf8');
  const parsed: unknown = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error('The canonical location file must contain a JSON array.');
  }

  const locations = parsed.map((item: unknown, index: number): Location => {
    if (!isRecord(item)) {
      throw new Error(`Canonical location ${index + 1} is not an object.`);
    }
    const { id, name, latitude, longitude } = item;
    if (
      typeof id !== 'string' ||
      typeof name !== 'string' ||
      typeof latitude !== 'number' ||
      !Number.isFinite(latitude) ||
      typeof longitude !== 'number' ||
      !Number.isFinite(longitude)
    ) {
      throw new Error(`Canonical location ${index + 1} has invalid fields.`);
    }
    return { id, name, latitude, longitude };
  });

  if (locationIds.length === 0) {
    return locations;
  }

  const locationsById = new Map(locations.map((location) => [location.id, location]));
  const selected = locationIds.map((id) => {
    const location = locationsById.get(id);
    if (location === undefined) {
      throw new Error(`Unknown location id "${id}".`);
    }
    return location;
  });
  return [...new Map(selected.map((location) => [location.id, location])).values()];
}

export async function openDatabase(): Promise<Pool> {
  await loadEnvironment();
  const connectionString =
    process.env['SMOKELEDGER_DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
  const pool = new Pool({ connectionString, max: 5 });
  try {
    await pool.query('SELECT 1 FROM towns LIMIT 0');
    return pool;
  } catch (error) {
    await pool.end();
    throw new Error(
      'Cannot access the SmokeLedger schema. Start it with "npm run db:init" and check SMOKELEDGER_DATABASE_URL.',
      { cause: error },
    );
  }
}

export async function seedTowns(
  client: PoolClient,
  locations: Location[],
  dryRun: boolean,
): Promise<void> {
  if (dryRun || locations.length === 0) {
    return;
  }

  const rows = locations.map((location) => [
    location.name,
    location.latitude,
    location.longitude,
  ]);
  await insertRows(
    client,
    'towns',
    ['town', 'lat', 'lon'],
    rows,
    'ON CONFLICT (town) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon',
  );
}

export async function fetchJson(
  label: string,
  url: URL,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new Error(`${label} request failed or timed out.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    throw new Error(`${label} request failed (HTTP ${response.status}).`);
  }
  if (isRecord(payload) && payload['error'] === true) {
    const reason =
      typeof payload['reason'] === 'string' ? `: ${payload['reason']}` : '';
    throw new Error(`${label} rejected the request${reason}`);
  }
  return payload;
}

export async function fetchText(label: string, url: URL): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new Error(`${label} request failed or timed out.`);
  }
  if (!response.ok) {
    throw new Error(`${label} request failed (HTTP ${response.status}).`);
  }
  return response.text();
}

export function normalizeOpenMeteoResponse(
  payload: unknown,
  expectedLocations: number,
  label: string,
): OpenMeteoLocation[] {
  const results = Array.isArray(payload) ? payload : [payload];
  if (results.length !== expectedLocations) {
    throw new Error(
      `${label} returned ${results.length} locations; expected ${expectedLocations}.`,
    );
  }
  return results.map((result, index) => {
    if (!isRecord(result) || !isRecord(result['hourly'])) {
      throw new Error(`${label} response for location ${index + 1} has no hourly data.`);
    }
    return { hourly: result['hourly'] };
  });
}

export function hourlyTimes(hourly: Record<string, unknown>, label: string): Date[] {
  const time = hourly['time'];
  if (!Array.isArray(time) || time.length === 0) {
    throw new Error(`${label} response has no hourly timestamps.`);
  }
  return time.map((value, index) => {
    if (typeof value !== 'string') {
      throw new Error(`${label} timestamp ${index + 1} is invalid.`);
    }
    const timestamp = new Date(/[zZ]|[+-]\d\d:\d\d$/u.test(value) ? value : `${value}Z`);
    if (!Number.isFinite(timestamp.getTime())) {
      throw new Error(`${label} timestamp ${index + 1} is invalid.`);
    }
    return timestamp;
  });
}

export function numericHourlySeries(
  hourly: Record<string, unknown>,
  variable: string,
  expectedLength: number,
  label: string,
): Array<number | null> {
  const series = hourly[variable];
  if (!Array.isArray(series) || series.length !== expectedLength) {
    throw new Error(`${label} did not return a complete "${variable}" series.`);
  }
  return series.map((value, index) => {
    if (value === null) {
      return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${label} returned an invalid "${variable}" value at hour ${index + 1}.`);
    }
    return value;
  });
}

export function locationBatches(locations: Location[]): Location[][] {
  const batches: Location[][] = [];
  for (let index = 0; index < locations.length; index += LOCATION_BATCH_SIZE) {
    batches.push(locations.slice(index, index + LOCATION_BATCH_SIZE));
  }
  return batches;
}

export async function insertRows(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: SqlValue[][],
  conflictClause: string,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  await client.query('BEGIN');
  try {
    for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
      const batch = rows.slice(offset, offset + INSERT_BATCH_SIZE);
      const values: SqlValue[] = [];
      const tuples = batch.map((row) => {
        if (row.length !== columns.length) {
          throw new Error(`Invalid row width while inserting into ${table}.`);
        }
        const placeholders = row.map((value) => {
          values.push(value);
          return `$${values.length}`;
        });
        return `(${placeholders.join(', ')})`;
      });
      const columnList = columns.map((column) => `"${column}"`).join(', ');
      await client.query(
        `INSERT INTO "${table}" (${columnList}) VALUES ${tuples.join(', ')} ${conflictClause}`,
        values,
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function withDatabase<T>(
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = await openDatabase();
  const client = await pool.connect();
  try {
    return await action(client);
  } finally {
    client.release();
    await pool.end();
  }
}

export function reportResult(
  source: string,
  rows: number,
  dryRun: boolean,
): void {
  const mode = dryRun ? 'dry run; not written' : 'upserted';
  console.log(`${source}: ${rows} rows ${mode}.`);
}

export function reportError(source: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${source} ingestion failed: ${message}`);
  process.exitCode = 1;
}

export function chunkedLocationUrl(
  endpoint: string,
  locations: Location[],
  parameters: Record<string, string>,
): URL {
  const url = new URL(endpoint);
  url.searchParams.set(
    'latitude',
    locations.map((location) => location.latitude.toFixed(5)).join(','),
  );
  url.searchParams.set(
    'longitude',
    locations.map((location) => location.longitude.toFixed(5)).join(','),
  );
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, value);
  }
  return url;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
