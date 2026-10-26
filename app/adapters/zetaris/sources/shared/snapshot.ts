import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envFileCandidates } from '../../scripts/env-files.ts';

export interface Location {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface CliOptions {
  locationIds: string[];
  dryRun: boolean;
  skipApi: boolean;
}

export type Cell = string | number | null;
export type SnapshotRow = Record<string, Cell>;

interface Capture {
  received_at: string;
  requested_location: Location;
  response: Record<string, unknown>;
}

export interface Snapshot {
  schema_version: 'zetaris.source.snapshot.v1';
  source: string;
  columns: string[];
  rows: SnapshotRow[];
  captures: Record<string, Capture>;
}

export interface SnapshotSource {
  id: string;
  directory: string;
  endpoint: string;
  parameters: Record<string, string>;
  columns: readonly string[];
  keys: readonly string[];
  database: string;
  container: string;
  view: string;
  viewSelect: string;
  rows: (
    location: Location,
    response: Record<string, unknown>,
    receivedAt: string,
  ) => SnapshotRow[];
  validateRow: (row: SnapshotRow) => void;
}

export interface SourceRuntime {
  fetcher?: typeof fetch;
  execute?: (command: string, args: string[]) => Promise<void>;
  now?: () => string;
}

const ZETARIS_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LOCATIONS_PATH = fileURLToPath(
  new URL('../air_quality/locations.json', import.meta.url),
);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Defined process/root values, including empty settings, retain precedence. */
export async function loadEnvironment(): Promise<void> {
  for (const filename of envFileCandidates()) {
    let content: string;
    try {
      content = await readFile(filename, 'utf8');
    } catch (error) {
      if (isRecord(error) && error['code'] === 'ENOENT') continue;
      throw error;
    }
    for (const line of content.split(/\r?\n/u)) {
      const match =
        /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(
          line,
        );
      const key = match?.[1];
      let value = match?.[2];
      if (
        key === undefined ||
        value === undefined ||
        process.env[key] !== undefined
      )
        continue;
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      )
        value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/u, '').trim();
      process.env[key] = value;
    }
  }
}

export function parseCliOptions(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    locationIds: [],
    dryRun: false,
    skipApi: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--skip-api') options.skipApi = true;
    else if (argument === '--location' || argument?.startsWith('--location=')) {
      const id = argument === '--location' ? args[++index] : argument.slice(11);
      if (!id?.trim() || id.startsWith('--'))
        throw new Error('--location requires a canonical location id.');
      options.locationIds.push(id.trim());
    } else throw new Error(`Unknown option: ${String(argument)}`);
  }
  options.locationIds = [...new Set(options.locationIds)];
  return options;
}

export async function readLocations(
  ids: readonly string[] = [],
): Promise<Location[]> {
  const parsed: unknown = JSON.parse(await readFile(LOCATIONS_PATH, 'utf8'));
  if (!Array.isArray(parsed))
    throw new Error('Canonical locations must be an array.');
  const locations = new Map<string, Location>();
  for (const item of parsed) {
    if (!isRecord(item)) throw new Error('Invalid canonical location.');
    const { id, name } = item;
    const latitude = Number(item['latitude']);
    const longitude = Number(item['longitude']);
    if (
      typeof id !== 'string' ||
      !id.trim() ||
      typeof name !== 'string' ||
      !name.trim() ||
      item['latitude'] === '' ||
      item['latitude'] === null ||
      item['longitude'] === '' ||
      item['longitude'] === null ||
      !Number.isFinite(latitude) ||
      Math.abs(latitude) > 90 ||
      !Number.isFinite(longitude) ||
      Math.abs(longitude) > 180
    )
      throw new Error('Invalid canonical location fields.');
    if (locations.has(id))
      throw new Error(`Duplicate canonical location id: ${id}`);
    locations.set(id, { id, name: name.trim(), latitude, longitude });
  }
  if (ids.length === 0) return [...locations.values()];
  return ids.map((id) => {
    const location = locations.get(id);
    if (!location) throw new Error(`Unknown location id: ${id}`);
    return location;
  });
}

export function hourlyTimes(response: Record<string, unknown>): string[] {
  if (response['utc_offset_seconds'] !== 0)
    throw new Error(
      'The source must return UTC timestamps (utc_offset_seconds=0).',
    );
  const hourly = response['hourly'];
  if (
    !isRecord(hourly) ||
    !Array.isArray(hourly['time']) ||
    !hourly['time'].length
  )
    throw new Error('The source returned no hourly timestamps.');
  const times = hourly['time'].map((value: unknown) => {
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/u.test(
        value,
      )
    )
      throw new Error('The source returned an invalid hourly timestamp.');
    const explicitOffset = /(?:Z|[+-]\d{2}:\d{2})$/u.test(value);
    const date = new Date(explicitOffset ? value : `${value}Z`);
    if (
      !Number.isFinite(date.getTime()) ||
      (!explicitOffset &&
        date.toISOString().slice(0, 16) !== value.slice(0, 16))
    )
      throw new Error('The source returned an invalid hourly timestamp.');
    return date.toISOString();
  });
  if (new Set(times).size !== times.length)
    throw new Error('The source returned duplicate hourly timestamps.');
  return times;
}

export function hourlySeries(
  response: Record<string, unknown>,
  variable: string,
  expectedLength: number,
  unit: string,
): Array<number | null> {
  const hourly = response['hourly'];
  const units = response['hourly_units'];
  if (
    !isRecord(hourly) ||
    !isRecord(units) ||
    typeof units[variable] !== 'string' ||
    (units[variable] as string).replace(/[µμ]/gu, 'u').replace(/³/gu, '3') !==
      unit
  )
    throw new Error(
      `The source returned missing or unexpected units for ${variable}.`,
    );
  const values = hourly[variable];
  if (!Array.isArray(values) || values.length !== expectedLength)
    throw new Error(`The source returned an incomplete ${variable} series.`);
  return values.map((value: unknown) => {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error(`The source returned an invalid ${variable} value.`);
    return value;
  });
}

export function isUtcInstant(value: Cell | undefined): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

export function validateLocationRow(row: SnapshotRow): void {
  if (
    typeof row['location_id'] !== 'string' ||
    !row['location_id'] ||
    typeof row['location_name'] !== 'string' ||
    !row['location_name'] ||
    typeof row['requested_latitude'] !== 'number' ||
    !Number.isFinite(row['requested_latitude']) ||
    Math.abs(row['requested_latitude']) > 90 ||
    typeof row['requested_longitude'] !== 'number' ||
    !Number.isFinite(row['requested_longitude']) ||
    Math.abs(row['requested_longitude']) > 180 ||
    !isUtcInstant(row['observation_time']) ||
    !isUtcInstant(row['ingested_utc']) ||
    row['issued_utc'] !== null
  )
    throw new Error(
      'The cached snapshot contains invalid location or time metadata.',
    );
}

export function nullableNumber(
  value: Cell | undefined,
  minimum = -Infinity,
): boolean {
  return (
    value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value >= minimum)
  );
}

export function snapshotKey(row: SnapshotRow, keys: readonly string[]): string {
  return JSON.stringify(keys.map((key) => row[key]));
}

/** Latest collection replaces matching samples, retaining other locations/hours. */
export function mergeRows(
  previous: readonly SnapshotRow[],
  incoming: readonly SnapshotRow[],
  keys: readonly string[],
): SnapshotRow[] {
  const rows = new Map(previous.map((row) => [snapshotKey(row, keys), row]));
  for (const row of incoming) rows.set(snapshotKey(row, keys), row);
  return [...rows.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, row]) => row);
}

export function snapshotCsv(
  columns: readonly string[],
  rows: readonly SnapshotRow[],
): string {
  const encode = (value: Cell) => {
    if (value === null) return '';
    const text = String(value);
    return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
  };
  return `${columns.join(',')}\n${rows
    .map((row) =>
      columns
        .map((column) => {
          const value = row[column];
          if (value === undefined)
            throw new Error(`Missing snapshot column: ${column}`);
          return encode(value);
        })
        .join(','),
    )
    .join('\n')}\n`;
}

export function publicationSql(source: SnapshotSource): string {
  const target = `/home/zetaris/customer-data/shared/${source.container}`;
  return `CREATE LIGHTNING DATABASE ${source.database} DESCRIBE BY "${source.id} stored snapshots";
CREATE SCHEMASTORE CONTAINER ${source.container};
CREATE LIGHTNING FILESTORE TABLE hourly_snapshot FROM ${source.database} FORMAT CSV OPTIONS (
  PATH "${target}/snapshot.csv", header "true", inferSchema "false", nullValue ""
);
UPDATE LIGHTNING FILESTORE TABLE hourly_snapshot FROM ${source.database} OPTIONS (
  PATH "${target}/snapshot.csv", header "true", inferSchema "false", nullValue ""
);
CREATE OR REPLACE SCHEMASTORE VIEW ${source.view} WITH CONTAINER ${source.container} AS
${source.viewSelect};`;
}

function validateSnapshot(value: unknown, source: SnapshotSource): Snapshot {
  if (
    !isRecord(value) ||
    value['schema_version'] !== 'zetaris.source.snapshot.v1' ||
    value['source'] !== source.id ||
    JSON.stringify(value['columns']) !== JSON.stringify(source.columns) ||
    !Array.isArray(value['rows']) ||
    !isRecord(value['captures'])
  )
    throw new Error('The cached source snapshot has an incompatible schema.');
  const rows = value['rows'].map((item: unknown) => {
    if (
      !isRecord(item) ||
      Object.keys(item).length !== source.columns.length ||
      source.columns.some((column) => !(column in item)) ||
      Object.values(item).some(
        (cell) =>
          cell !== null && typeof cell !== 'string' && typeof cell !== 'number',
      )
    )
      throw new Error('The cached source snapshot contains an invalid row.');
    const row = item as SnapshotRow;
    source.validateRow(row);
    return row;
  });
  if (
    new Set(rows.map((row) => snapshotKey(row, source.keys))).size !==
    rows.length
  )
    throw new Error(
      'The cached source snapshot contains duplicate sample keys.',
    );
  return { ...value, rows } as unknown as Snapshot;
}

async function readSnapshot(
  source: SnapshotSource,
  required: boolean,
): Promise<Snapshot> {
  try {
    const value: unknown = JSON.parse(
      await readFile(path.join(source.directory, 'data/snapshot.json'), 'utf8'),
    );
    return validateSnapshot(value, source);
  } catch (error) {
    if (!required && isRecord(error) && error['code'] === 'ENOENT')
      return {
        schema_version: 'zetaris.source.snapshot.v1',
        source: source.id,
        columns: [...source.columns],
        rows: [],
        captures: {},
      };
    if (isRecord(error) && error['code'] === 'ENOENT')
      throw new Error(
        'No cached snapshot exists. Run once without --skip-api first.',
      );
    throw error;
  }
}

async function atomicWrite(filename: string, content: string): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isRecord(error) || error['code'] !== 'ENOENT') throw error;
    });
  }
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ZETARIS_ROOT,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} failed (exit ${String(code)}).`)),
    );
  });
}

async function fetchBatch(
  source: SnapshotSource,
  locations: readonly Location[],
  fetcher: typeof fetch,
): Promise<unknown> {
  const url = new URL(source.endpoint);
  for (const [key, value] of Object.entries({
    ...source.parameters,
    latitude: locations.map((location) => location.latitude).join(','),
    longitude: locations.map((location) => location.longitude).join(','),
    timezone: 'GMT',
  }))
    url.searchParams.set(key, value);
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(`${source.id} returned HTTP ${response.status}.`);
  return response.json() as Promise<unknown>;
}

export async function runSnapshotSource(
  source: SnapshotSource,
  args = process.argv.slice(2),
  runtime: SourceRuntime = {},
): Promise<void> {
  const options = parseCliOptions(args);
  const locations = await readLocations(options.locationIds);
  if (options.dryRun) {
    console.log(
      `[DRY-RUN] ${options.skipApi ? 'Republish cached' : 'Fetch and merge'} ${source.id} for ${locations.length} selected location(s).`,
    );
    console.log(
      `[DRY-RUN] ${source.endpoint} — ${JSON.stringify({ ...source.parameters, timezone: 'GMT' })}`,
    );
    console.log(
      '[DRY-RUN] Publish one complete snapshot.csv to the Zetaris driver; retain other cached locations and sample times.',
    );
    console.log(publicationSql(source));
    return;
  }
  await loadEnvironment();
  const dataDirectory = path.join(source.directory, 'data');
  await mkdir(dataDirectory, { recursive: true });
  const lockFile = path.join(dataDirectory, '.ingestion.lock');
  const lock = await open(lockFile, 'wx').catch((error: unknown) => {
    if (isRecord(error) && error['code'] === 'EEXIST') {
      throw new Error(
        'Another ingestion holds this source cache lock. Wait for it to finish; inspect data/.ingestion.lock manually if a previous process stopped unexpectedly.',
      );
    }
    throw error;
  });
  try {
    await lock.writeFile(
      `${JSON.stringify({ pid: process.pid, source: source.id })}\n`,
      'utf8',
    );
    await collectAndPublish(source, options, locations, runtime);
  } finally {
    await lock.close();
    await unlink(lockFile);
  }
}

async function collectAndPublish(
  source: SnapshotSource,
  options: CliOptions,
  locations: Location[],
  runtime: SourceRuntime,
): Promise<void> {
  const execute = runtime.execute ?? runCommand;
  let snapshot = await readSnapshot(source, options.skipApi);
  if (!options.skipApi) {
    const rows: SnapshotRow[] = [];
    const captures = { ...snapshot.captures };
    for (let offset = 0; offset < locations.length; offset += 50) {
      const batch = locations.slice(offset, offset + 50);
      const payload = await fetchBatch(source, batch, runtime.fetcher ?? fetch);
      const receivedAt = (runtime.now ?? (() => new Date().toISOString()))();
      const responses = Array.isArray(payload) ? payload : [payload];
      if (responses.length !== batch.length)
        throw new Error('The source returned an unexpected location count.');
      responses.forEach((response: unknown, index) => {
        const location = batch[index];
        if (!location || !isRecord(response) || response['error'])
          throw new Error('The source returned an invalid location response.');
        const incoming = source.rows(location, response, receivedAt);
        incoming.forEach(source.validateRow);
        rows.push(...incoming);
        captures[location.id] = {
          received_at: receivedAt,
          requested_location: location,
          response,
        };
      });
    }
    snapshot = {
      ...snapshot,
      rows: mergeRows(snapshot.rows, rows, source.keys),
      captures,
    };
    const dataDirectory = path.join(source.directory, 'data');
    await atomicWrite(
      path.join(dataDirectory, 'snapshot.json'),
      `${JSON.stringify(snapshot)}\n`,
    );
  }
  if (!snapshot.rows.length)
    throw new Error('The source snapshot is empty; nothing was published.');
  const localStage = await mkdtemp(path.join(tmpdir(), 'zetaris-snapshot-'));
  const csvFile = path.join(localStage, 'snapshot.csv');
  const sqlFile = path.join(localStage, 'register.sql');
  try {
    await writeFile(
      csvFile,
      snapshotCsv(source.columns, snapshot.rows),
      'utf8',
    );
    await writeFile(sqlFile, publicationSql(source), 'utf8');
    const container =
      process.env['ZETARIS_DRIVER_CONTAINER'] || 'zetaris-driver-1';
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(container))
      throw new Error('Invalid ZETARIS_DRIVER_CONTAINER.');
    const target = `/home/zetaris/customer-data/shared/${source.container}`;
    const temporary = `${target}/.snapshot-${randomUUID()}.tmp`;
    await execute('docker', [
      'exec',
      '-u',
      'root',
      container,
      'mkdir',
      '-p',
      target,
    ]);
    await execute('docker', ['cp', csvFile, `${container}:${temporary}`]);
    await execute('docker', [
      'exec',
      '-u',
      'root',
      container,
      'chmod',
      '644',
      temporary,
    ]);
    await execute('docker', [
      'exec',
      '-u',
      'root',
      container,
      'mv',
      '-f',
      temporary,
      `${target}/snapshot.csv`,
    ]);
    const python =
      process.env['PYTHON_BIN'] ||
      (process.platform === 'win32' ? 'python' : 'python3');
    await execute(python, ['scripts/run_sql.py', '--skip-exists', sqlFile]);
    console.log(
      `${source.id}: published ${snapshot.rows.length} stored samples to ${source.container}.${source.view}.`,
    );
  } finally {
    await unlink(csvFile).catch(() => undefined);
    await unlink(sqlFile).catch(() => undefined);
    await rmdir(localStage);
  }
}

export function isMain(moduleUrl: string): boolean {
  if (!process.argv[1]) return false;
  const filename = fileURLToPath(moduleUrl);
  const argument = path.resolve(process.argv[1]);
  return process.platform === 'win32'
    ? filename.toLowerCase() === argument.toLowerCase()
    : filename === argument;
}
