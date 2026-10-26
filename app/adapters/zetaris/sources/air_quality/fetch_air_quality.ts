#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ZETARIS_ROOT = path.resolve(SOURCE_DIR, '../..');
const LOCATIONS_FILE = path.join(SOURCE_DIR, 'locations.json');
const API_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const DATABASE = 'OPEN_METEO_AIR_QUALITY';
const CONTAINER = 'air_quality';
const VIEW = `${CONTAINER}.hourly_observations`;
const PYTHON_BIN =
  process.env['PYTHON_BIN'] ??
  (process.platform === 'win32' ? 'python' : 'python3');

export interface Location {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface CliOptions {
  locationIds: string[];
  dryRun: boolean;
  test: boolean;
}

export function parseCliOptions(args: string[]): CliOptions {
  const locationIds: string[] = [];
  let dryRun = false;
  let test = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument === '--test') {
      test = true;
    } else if (argument === '--location') {
      const id = args[index + 1];
      if (id === undefined || id.startsWith('--')) {
        throw new Error('--location requires a location id.');
      }
      locationIds.push(id);
      index += 1;
    } else if (argument?.startsWith('--location=')) {
      locationIds.push(argument.slice('--location='.length));
    } else {
      throw new Error(`Unknown option: ${String(argument)}`);
    }
  }

  if (test && locationIds.length > 0) {
    throw new Error('--test cannot be combined with --location.');
  }
  return { locationIds, dryRun, test };
}

export async function readLocations(
  filePath = LOCATIONS_FILE,
): Promise<Location[]> {
  const content = await readFile(filePath, 'utf8');
  const parsed: unknown = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error(`Location file must contain a JSON array: ${filePath}`);
  }

  const locations = parsed.map((item: unknown, index): Location => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`Location ${index + 1} is not an object.`);
    }
    const record = item as Record<string, unknown>;
    const { id, name, latitude, longitude } = record;
    if (
      typeof id !== 'string' ||
      !/^[a-z0-9-]+$/u.test(id) ||
      typeof name !== 'string' ||
      typeof latitude !== 'number' ||
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      typeof longitude !== 'number' ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw new Error(`Location ${index + 1} has invalid fields.`);
    }
    return { id, name, latitude, longitude };
  });

  const ids = new Set<string>();
  for (const location of locations) {
    if (ids.has(location.id)) {
      throw new Error(`Duplicate location id "${location.id}".`);
    }
    ids.add(location.id);
  }
  return locations;
}

export function selectLocations(
  locations: Location[],
  locationIds: string[],
  test: boolean,
): Location[] {
  const ids = test ? ['kuala-lumpur'] : locationIds;
  if (ids.length === 0) return locations;

  const byId = new Map(locations.map((location) => [location.id, location]));
  return [
    ...new Map(
      ids.map((id) => {
        const location = byId.get(id);
        if (location === undefined) {
          throw new Error(`Unknown location id "${id}".`);
        }
        return [location.id, location] as const;
      }),
    ).values(),
  ];
}

export function airQualityEndpoint(location: Location): string {
  const url = new URL(API_URL);
  url.searchParams.set('latitude', location.latitude.toFixed(5));
  url.searchParams.set('longitude', location.longitude.toFixed(5));
  url.searchParams.set('hourly', 'pm2_5,pm10');
  url.searchParams.set('past_days', '1');
  url.searchParams.set('forecast_days', '3');
  url.searchParams.set('timezone', 'GMT');
  return url.toString();
}

function tableName(location: Location): string {
  return `aq_${location.id.replace(/-/gu, '_')}`;
}

export function registrationSql(locations: Location[]): string {
  const statements = [
    `CREATE LIGHTNING DATABASE ${DATABASE}
DESCRIBE BY "Open-Meteo hourly air quality API";

CREATE SCHEMASTORE CONTAINER ${CONTAINER};`,
    ...locations.map(
      (location) => `CREATE LIGHTNING REST TABLE ${tableName(location)}
FROM ${DATABASE}
REQUEST(
    endpoint "${airQualityEndpoint(location)}",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER () BODY ();`,
    ),
  ];
  return `${statements.join('\n\n')}\n`;
}

export function viewSql(locations: Location[]): string {
  const selects = locations.map((location) => {
    const safeName = location.name.replace(/'/gu, "''");
    return `SELECT
    '${location.id}' AS location_id,
    '${safeName}' AS location_name,
    CAST(${location.latitude} AS DOUBLE) AS requested_latitude,
    CAST(${location.longitude} AS DOUBLE) AS requested_longitude,
    CAST(observation_time AS TIMESTAMP) AS observation_time,
    CAST(element_at(hourly.pm2_5, hour_index + 1) AS DOUBLE) AS pm2_5_ug_m3,
    CAST(element_at(hourly.pm10, hour_index + 1) AS DOUBLE) AS pm10_ug_m3,
    CAST(NULL AS TIMESTAMP) AS issued_utc,
    CAST(NULL AS TIMESTAMP) AS ingested_utc
FROM ${DATABASE}.${tableName(location)}
LATERAL VIEW posexplode(hourly.time) AS hour_index, observation_time`;
  });
  return `CREATE SCHEMASTORE VIEW hourly_observations WITH CONTAINER ${CONTAINER} AS
${selects.join('\nUNION ALL\n')};
`;
}

async function runSql(
  sql: string,
  options: { dryRun: boolean; skipExists?: boolean },
  tempPrefix: string,
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), tempPrefix));
  const sqlFile = path.join(tempDir, 'pipeline.sql');
  try {
    await writeFile(sqlFile, sql, 'utf8');
    const args = ['scripts/run_sql.py'];
    if (options.skipExists) args.push('--skip-exists');
    if (options.dryRun) args.push('--dry-run');
    args.push(sqlFile);
    await runCommand(PYTHON_BIN, args);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ZETARIS_ROOT,
      stdio: 'inherit',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${String(code)}.`));
    });
  });
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const locations = await readLocations();
  const selected = selectLocations(
    locations,
    options.locationIds,
    options.test,
  );
  console.log(
    `Preparing Open-Meteo air-quality REST source for ${selected.length} location(s)...`,
  );
  await runSql(
    registrationSql(selected),
    { dryRun: options.dryRun, skipExists: true },
    'zetaris-open-meteo-air-quality-',
  );
  await runSql(
    `DROP VIEW IF EXISTS ${VIEW};\n${viewSql(selected)}`,
    { dryRun: options.dryRun },
    'zetaris-open-meteo-air-quality-view-',
  );
  console.log(
    `${options.dryRun ? 'Dry run complete' : 'Zetaris REST source registered'} for ${selected.length} location(s).`,
  );
}

function isMain(): boolean {
  return (
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  );
}

if (isMain()) {
  main().catch((error: unknown) => {
    console.error(
      `Open-Meteo air-quality setup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
