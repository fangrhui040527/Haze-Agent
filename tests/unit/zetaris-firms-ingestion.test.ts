import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface FirmsModule {
  REGISTER_SQL: string;
  parseCliArgs(
    args: string[],
    env: NodeJS.ProcessEnv,
  ): { locationIds: string[]; dayRange: number; container: string };
  parseCsv(text: string): unknown[];
  fetchFirmsData(
    directory: string,
    locations: {
      id: string;
      name: string;
      latitude: number;
      longitude: number;
    }[],
    filtered: boolean,
    days: number,
    key: string,
    fetcher: typeof fetch,
  ): Promise<number>;
}

const script = resolve(
  'app/adapters/zetaris/sources/nasa_firms/fetch_nasa_firms.ts',
);
// Operator scripts run directly as TypeScript and are checked by tsconfig.zetaris.
const firms = (await import(pathToFileURL(script).href)) as FirmsModule;
const header =
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight';
const csv = `${header}\n3.1,101.6,300,1,1,2026-10-26,0330,N20,VIIRS,n,2,290,10,D\n`;
const location = {
  id: 'kuala-lumpur',
  name: 'Kuala Lumpur',
  latitude: 3.1412,
  longitude: 101.68653,
};
const temporary: string[] = [];
const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'haze-firms-test-'));
  temporary.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('canonical Zetaris FIRMS ingestion', () => {
  it('previews without credentials, Python, Docker, or local snapshot writes', () => {
    const data = resolve('app/adapters/zetaris/sources/nasa_firms/data');
    const before = existsSync(data)
      ? readdirSync(data, { recursive: true }).map(String).sort()
      : null;
    const output = execFileSync(
      process.execPath,
      [script, '--dry-run', '--location', 'kuala-lumpur'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          FIRMS_MAP_KEY: '',
          PYTHON_BIN: 'unavailable-python-for-dry-run-test',
          ZETARIS_DRIVER_CONTAINER: 'test-driver',
        },
      },
    );
    expect(output).toContain('Kuala Lumpur');
    expect(output).toContain('test-driver:');
    expect(output).toContain('UPDATE LIGHTNING FILESTORE TABLE active_fires');
    expect(output).not.toContain('DROP ');
    const after = existsSync(data)
      ? readdirSync(data, { recursive: true }).map(String).sort()
      : null;
    expect(after).toEqual(before);
  });

  it('rejects ambiguous options and uses the configured driver container', () => {
    expect(
      firms.parseCliArgs(['--location', 'kuala-lumpur', '--day-range=5'], {
        ZETARIS_DRIVER_CONTAINER: 'local-driver',
      }),
    ).toMatchObject({
      locationIds: ['kuala-lumpur'],
      dayRange: 5,
      container: 'local-driver',
    });
    for (const args of [
      ['--location'],
      ['--day-range=6'],
      ['--day-range=1.5'],
      ['--unexpected'],
    ])
      expect(() => firms.parseCliArgs(args, {})).toThrow();
  });

  it('fails before fetching when the source key is missing', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      firms.fetchFirmsData(
        temporaryDirectory(),
        [location],
        true,
        3,
        '',
        fetcher,
      ),
    ).rejects.toThrow('FIRMS_MAP_KEY is required');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects failed upstream batches and redacts credential-bearing network errors', async () => {
    const directory = temporaryDirectory();
    const existing = join(directory, 'previous-snapshot.csv');
    writeFileSync(existing, 'retained snapshot');
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(csv))
      .mockRejectedValueOnce(
        new Error('https://example.invalid/private-map-key/request'),
      );
    const error: unknown = await firms
      .fetchFirmsData(
        directory,
        [location],
        true,
        3,
        'private-map-key',
        fetcher,
      )
      .catch((failure: unknown) => failure);
    expect(String(error)).toContain('no new snapshot was published');
    expect(String(error)).not.toContain('private-map-key');
    expect(readFileSync(existing, 'utf8')).toBe('retained snapshot');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('distinguishes a successful header-only result from malformed CSV', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(new Response(`${header}\n`)));
    await expect(
      firms.fetchFirmsData(
        temporaryDirectory(),
        [location],
        true,
        3,
        'test-key',
        fetcher,
      ),
    ).resolves.toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(() => firms.parseCsv('upstream service error')).toThrow(
      'invalid CSV header',
    );
    expect(firms.REGISTER_SQL).toContain(
      'PATH "/home/zetaris/customer-data/shared/firms_flat"',
    );
  });
});
