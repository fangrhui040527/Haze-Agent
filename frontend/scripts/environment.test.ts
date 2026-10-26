import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as envFiles from '../../app/adapters/zetaris/scripts/env-files.ts';

const candidatesForRoot = envFiles.envFileCandidates;
const { loadEnvironment } = envFiles;
const keys = [
  'HAZE_ENV_TEST_PROCESS',
  'HAZE_ENV_TEST_ROOT',
  'HAZE_ENV_TEST_EMPTY',
  'HAZE_ENV_TEST_LEGACY',
];
let root: string;

function writeEnv(path: string, values: Record<string, string>) {
  writeFileSync(
    path,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'haze-env-test-'));
  mkdirSync(join(root, 'app/adapters/zetaris'), { recursive: true });
  for (const key of keys) vi.stubEnv(key, undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('shared server environment configuration', () => {
  it('prefers the Haze root file over the legacy adapter configuration', () => {
    const paths = candidatesForRoot(root);
    expect(paths[0]).toBe(join(root, '.env'));
    expect(
      paths.indexOf(join(root, 'app/adapters/zetaris/.env.local')),
    ).toBeGreaterThan(paths.indexOf(join(root, '.env')));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('finds the main checkout through a relative Git worktree pointer', () => {
    const worktree = join(root, 'linked worktree');
    const main = join(root, 'main checkout');
    const gitdir = join(main, '.git/worktrees/local');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(
      join(worktree, '.git'),
      `gitdir: ${relative(worktree, gitdir)}\n`,
    );

    const paths = candidatesForRoot(worktree);
    expect(paths.slice(0, 2)).toEqual([
      join(worktree, '.env'),
      join(main, '.env'),
    ]);
    expect(paths).toContain(join(main, 'app/adapters/zetaris/.env.local'));
    expect(paths.indexOf(join(main, '.env'))).toBeLessThan(
      paths.indexOf(join(worktree, 'app/adapters/zetaris/.env.local')),
    );
  });

  it('preserves process settings and root values, including empty values, while filling missing legacy settings', async () => {
    vi.stubEnv('HAZE_ENV_TEST_PROCESS', 'process');
    writeEnv(join(root, '.env'), {
      HAZE_ENV_TEST_PROCESS: 'root',
      HAZE_ENV_TEST_ROOT: 'root',
      HAZE_ENV_TEST_EMPTY: '',
    });
    writeEnv(join(root, 'app/adapters/zetaris/.env.local'), {
      HAZE_ENV_TEST_PROCESS: 'legacy',
      HAZE_ENV_TEST_ROOT: 'legacy',
      HAZE_ENV_TEST_EMPTY: 'legacy',
      HAZE_ENV_TEST_LEGACY: 'legacy',
    });

    loadEnvironment(candidatesForRoot(root));

    expect(process.env.HAZE_ENV_TEST_PROCESS).toBe('process');
    expect(process.env.HAZE_ENV_TEST_ROOT).toBe('root');
    expect(process.env.HAZE_ENV_TEST_EMPTY).toBe('');
    expect(process.env.HAZE_ENV_TEST_LEGACY).toBe('legacy');
  });

  it('loads existing adapter settings when the root file is absent', async () => {
    writeEnv(join(root, 'app/adapters/zetaris/.env.local'), {
      HAZE_ENV_TEST_LEGACY: 'legacy',
    });

    loadEnvironment(candidatesForRoot(root));

    expect(process.env.HAZE_ENV_TEST_LEGACY).toBe('legacy');
    expect(process.env.HAZE_ENV_TEST_ROOT).toBeUndefined();
  });
});
