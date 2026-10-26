import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, string | number | null>;
interface Location {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}
interface Source {
  directory: string;
  columns: readonly string[];
  keys: readonly string[];
}
interface Runtime {
  fetcher?: typeof fetch;
  execute?: (command: string, args: string[]) => Promise<void>;
  now?: () => string;
}
interface SharedModule {
  runSnapshotSource(
    source: Source,
    args: string[],
    runtime?: Runtime,
  ): Promise<void>;
  mergeRows(previous: Row[], incoming: Row[], keys: readonly string[]): Row[];
  parseCliOptions(args: string[]): {
    locationIds: string[];
    dryRun: boolean;
    skipApi: boolean;
  };
  publicationSql(source: Source): string;
  snapshotCsv(columns: readonly string[], rows: Row[]): string;
}
interface AirModule {
  airQualitySource: Source;
  airQualityRows(
    location: Location,
    response: Record<string, unknown>,
    received: string,
  ): Row[];
  validateAirQualityRow(row: Row): void;
}
interface WindModule {
  windSource: Source;
  windRows(
    location: Location,
    response: Record<string, unknown>,
    received: string,
  ): Row[];
}

// Runtime URL imports keep directly executable ingestion scripts out of the app build.
const shared = (await import(
  new URL(
    '../../app/adapters/zetaris/sources/shared/snapshot.ts',
    import.meta.url,
  ).href
)) as SharedModule;
const air = (await import(
  new URL(
    '../../app/adapters/zetaris/sources/air_quality/fetch_air_quality.ts',
    import.meta.url,
  ).href
)) as AirModule;
const wind = (await import(
  new URL(
    '../../app/adapters/zetaris/sources/wind/fetch_wind.ts',
    import.meta.url,
  ).href
)) as WindModule;

const location: Location = {
  id: 'kuala-lumpur',
  name: 'Kuala Lumpur',
  latitude: 3.1412,
  longitude: 101.68653,
};
const received = '2026-10-26T01:00:00.000Z';
const created: string[] = [];

function airResponse(): Record<string, unknown> {
  return {
    latitude: 3.1,
    longitude: 101.7,
    utc_offset_seconds: 0,
    hourly_units: { time: 'iso8601', pm2_5: 'μg/m³', pm10: 'µg/m³' },
    hourly: {
      time: ['2026-10-26T00:00', '2026-10-26T01:00'],
      pm2_5: [0, null],
      pm10: [12, 13],
    },
  };
}

async function isolatedSource(): Promise<Source> {
  const directory = await mkdtemp(path.join(tmpdir(), 'zetaris-source-test-'));
  created.push(directory);
  return { ...air.airQualitySource, directory };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of created.splice(0)) {
    if (
      path.dirname(directory) !== path.resolve(tmpdir()) ||
      !path.basename(directory).startsWith('zetaris-source-test-')
    )
      throw new Error('Refusing to remove an unexpected test directory.');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('Zetaris source snapshot ingestion', () => {
  it('normalizes samples to UTC, retains true zero/null, and never invents issuance', () => {
    const rows = air.airQualityRows(location, airResponse(), received);
    rows.forEach((row) => air.validateAirQualityRow(row));
    expect(rows).toEqual([
      {
        location_id: location.id,
        location_name: location.name,
        requested_latitude: location.latitude,
        requested_longitude: location.longitude,
        observation_time: '2026-10-26T00:00:00.000Z',
        pm2_5_ug_m3: 0,
        pm10_ug_m3: 12,
        ingested_utc: received,
        issued_utc: null,
      },
      {
        location_id: location.id,
        location_name: location.name,
        requested_latitude: location.latitude,
        requested_longitude: location.longitude,
        observation_time: '2026-10-26T01:00:00.000Z',
        pm2_5_ug_m3: null,
        pm10_ug_m3: 13,
        ingested_utc: received,
        issued_utc: null,
      },
    ]);
  });

  it('rejects non-UTC, invalid timestamps, unit mismatches and inconsistent arrays', () => {
    expect(() =>
      air.airQualityRows(
        location,
        { ...airResponse(), utc_offset_seconds: 28_800 },
        received,
      ),
    ).toThrow('UTC');
    expect(() =>
      air.airQualityRows(
        location,
        { ...airResponse(), hourly_units: { pm2_5: 'mg/m³', pm10: 'µg/m³' } },
        received,
      ),
    ).toThrow('units');
    expect(() =>
      air.airQualityRows(
        location,
        {
          ...airResponse(),
          hourly: { time: ['2026-02-30T00:00'], pm2_5: [1], pm10: [2] },
        },
        received,
      ),
    ).toThrow('timestamp');
    expect(() =>
      air.airQualityRows(
        location,
        {
          ...airResponse(),
          hourly: { time: ['2026-10-26T00:00'], pm2_5: [1, 2], pm10: [2] },
        },
        received,
      ),
    ).toThrow('incomplete');
    const invalid = air.airQualityRows(location, airResponse(), received)[0]!;
    expect(() =>
      air.validateAirQualityRow({ ...invalid, pm2_5_ug_m3: -1 }),
    ).toThrow('concentration');
    expect(() =>
      air.validateAirQualityRow({
        ...invalid,
        ingested_utc: '2026-10-26T01:00:00Z',
      }),
    ).toThrow('metadata');
  });

  it('converts meteorological wind direction to m/s u/v at both levels and preserves missing vectors', () => {
    const response = {
      utc_offset_seconds: 0,
      hourly_units: {
        wind_speed_10m: 'm/s',
        wind_direction_10m: '°',
        wind_speed_850hPa: 'm/s',
        wind_direction_850hPa: '°',
      },
      hourly: {
        time: ['2026-10-26T00:00', '2026-10-26T01:00'],
        wind_speed_10m: [5, null],
        wind_direction_10m: [90, 180],
        wind_speed_850hPa: [10, 0],
        wind_direction_850hPa: [0, 270],
      },
    };
    const rows = wind.windRows(location, response, received);
    expect(rows).toHaveLength(4);
    expect(rows[0]?.['u']).toBeCloseTo(-5);
    expect(rows[0]?.['v']).toBeCloseTo(0);
    expect(rows[1]).toMatchObject({ level: '10m', u: null, v: null });
    expect(rows[2]).toMatchObject({ level: '850hPa', v: -10 });
    expect(rows[3]?.['u']).toBeCloseTo(0);
    expect(rows[3]?.['v']).toBeCloseTo(0);
  });

  it('replaces matching samples while retaining older hours and other locations', () => {
    const previous = air.airQualityRows(location, airResponse(), received);
    const other = {
      ...previous[0]!,
      location_id: 'other',
      location_name: 'Other',
    };
    const replacement = {
      ...previous[0]!,
      pm2_5_ug_m3: 22,
      ingested_utc: '2026-10-26T02:00:00.000Z',
    };
    const merged = shared.mergeRows(
      [...previous, other],
      [replacement],
      air.airQualitySource.keys,
    );
    expect(merged).toHaveLength(3);
    expect(merged).toContainEqual(replacement);
    expect(merged).toContainEqual(previous[1]);
    expect(merged).toContainEqual(other);
    expect(
      shared.snapshotCsv(
        ['name', 'value'],
        [{ name: 'Town, "A"', value: null }],
      ),
    ).toBe('name,value\n"Town, ""A""",\n');
  });

  it('provides a fully offline dry-run and validates canonical selection', async () => {
    const source = await isolatedSource();
    const fetcher = vi.fn<typeof fetch>();
    const execute = vi.fn<NonNullable<Runtime['execute']>>();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubEnv('ZETARIS_DRIVER_CONTAINER', 'invalid/name');
    await shared.runSnapshotSource(
      source,
      ['--location', 'kuala-lumpur', '--skip-api', '--dry-run'],
      { fetcher, execute },
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(await readdir(source.directory)).toEqual([]);
    await expect(
      shared.runSnapshotSource(
        source,
        ['--location', 'unknown-town', '--dry-run'],
        { fetcher, execute },
      ),
    ).rejects.toThrow('Unknown location');
    expect(() => shared.parseCliOptions(['--location', '--dry-run'])).toThrow(
      'requires',
    );
    expect(() => shared.parseCliOptions(['--invalid'])).toThrow(
      'Unknown option',
    );
  });

  it('publishes one complete CSV before registering/updating FileStore and republishes without API access', async () => {
    const source = await isolatedSource();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(airResponse()));
    const commands: string[][] = [];
    let published = '';
    let sql = '';
    const execute = vi.fn<NonNullable<Runtime['execute']>>(
      async (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === 'cp') published = await readFile(args[1]!, 'utf8');
        if (args[0] === 'scripts/run_sql.py')
          sql = await readFile(args[2]!, 'utf8');
      },
    );
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await shared.runSnapshotSource(source, ['--location', 'kuala-lumpur'], {
      fetcher,
      execute,
      now: () => received,
    });
    const url = fetcher.mock.calls[0]?.[0];
    if (!(url instanceof URL))
      throw new Error('Expected the source to send a URL.');
    expect(url.searchParams.get('hourly')).toBe('pm2_5,pm10');
    expect(url.searchParams.get('timezone')).toBe('GMT');
    expect(published).toContain(
      '2026-10-26T00:00:00.000Z,0,12,2026-10-26T01:00:00.000Z,',
    );
    expect(commands[3]).toContain('mv');
    expect(commands[4]?.[1]).toBe('scripts/run_sql.py');
    expect(sql).toContain('UPDATE LIGHTNING FILESTORE TABLE hourly_snapshot');
    expect(sql).toContain('inferSchema "false"');
    expect(sql).toContain(
      'CREATE OR REPLACE SCHEMASTORE VIEW hourly_observations',
    );
    expect(sql).not.toContain('DROP ');
    const cached: unknown = JSON.parse(
      await readFile(path.join(source.directory, 'data/snapshot.json'), 'utf8'),
    );
    expect(cached).toMatchObject({
      captures: {
        'kuala-lumpur': { received_at: received, response: airResponse() },
      },
    });
    fetcher.mockClear();
    await shared.runSnapshotSource(
      source,
      ['--skip-api', '--location', 'kuala-lumpur'],
      { fetcher, execute },
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps the existing complete cache untouched after malformed upstream data', async () => {
    const source = await isolatedSource();
    const execute = vi
      .fn<NonNullable<Runtime['execute']>>()
      .mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await shared.runSnapshotSource(source, ['--location', 'kuala-lumpur'], {
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(airResponse())),
      execute,
      now: () => received,
    });
    const cacheFile = path.join(source.directory, 'data/snapshot.json');
    const before = await readFile(cacheFile, 'utf8');
    execute.mockClear();
    await expect(
      shared.runSnapshotSource(source, ['--location', 'kuala-lumpur'], {
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({ error: true })),
        execute,
      }),
    ).rejects.toThrow('invalid location response');
    expect(await readFile(cacheFile, 'utf8')).toBe(before);
    expect(execute).not.toHaveBeenCalled();
  });

  it('stops after a publication command fails and never registers a partial file', async () => {
    const source = await isolatedSource();
    const execute = vi
      .fn<NonNullable<Runtime['execute']>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('copy failed'));
    await expect(
      shared.runSnapshotSource(source, ['--location', 'kuala-lumpur'], {
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json(airResponse())),
        execute,
        now: () => received,
      }),
    ).rejects.toThrow('copy failed');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      execute.mock.calls.some(([, args]) => args[0] === 'scripts/run_sql.py'),
    ).toBe(false);
  });

  it('serializes source writers and releases the lock after a failed collection', async () => {
    const source = await isolatedSource();
    let started: () => void = () => undefined;
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: (response: Response) => void = () => {
      throw new Error('Fetch has not started.');
    };
    const delayed = vi.fn<typeof fetch>().mockImplementation(async () => {
      started();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const execute = vi
      .fn<NonNullable<Runtime['execute']>>()
      .mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const first = shared.runSnapshotSource(
      source,
      ['--location', 'kuala-lumpur'],
      { fetcher: delayed, execute },
    );
    const firstFailure = expect(first).rejects.toThrow(
      'invalid location response',
    );
    await fetching;
    const secondFetch = vi.fn<typeof fetch>();
    await expect(
      shared.runSnapshotSource(source, ['--location', 'petaling-jaya'], {
        fetcher: secondFetch,
        execute,
      }),
    ).rejects.toThrow('source cache lock');
    expect(secondFetch).not.toHaveBeenCalled();
    release(Response.json({ error: true }));
    await firstFailure;
    await expect(
      shared.runSnapshotSource(source, ['--location', 'kuala-lumpur'], {
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json(airResponse())),
        execute,
        now: () => received,
      }),
    ).resolves.toBeUndefined();
    expect(await readdir(path.join(source.directory, 'data'))).toEqual([
      'snapshot.json',
    ]);
  });
});
