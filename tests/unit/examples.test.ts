import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runner = join(root, 'scripts/run-example.mjs');

describe('repository example entrypoint', () => {
  it.each([
    '01-minimal.json',
    '02-single-artifact.json',
    '03-multiple-artifacts.json',
  ])('reproduces %s with a trace from outside the repository', async (name) => {
    const directory = await mkdtemp(join(tmpdir(), 'haze-example-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          runner,
          join(root, 'input_examples', name),
          '--output',
          'result.json',
          '--logs-dir',
          'traces',
        ],
        { cwd: directory, encoding: 'utf8', timeout: 5_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const expected = JSON.parse(
        await readFile(join(root, 'output_examples', name), 'utf8'),
      ) as unknown;
      expect(JSON.parse(result.stdout)).toEqual(expected);
      expect(
        JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')),
      ).toEqual(expected);
      const traces = await readdir(join(directory, 'traces'));
      expect(traces).toHaveLength(1);
      const events = (
        await readFile(join(directory, 'traces', traces[0]!), 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { event: string });
      expect(events.map(({ event }) => event)).toEqual([
        'started',
        'completed',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails incompatible versions without emitting a successful result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haze-example-invalid-'));
    try {
      await writeFile(
        join(directory, 'invalid.json'),
        JSON.stringify({ runId: 'invalid', schemaVersion: 0 }),
      );
      const result = spawnSync(
        process.execPath,
        [runner, 'invalid.json', '--logs-dir', 'traces'],
        { cwd: directory, encoding: 'utf8', timeout: 5_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Example failed.');
      const traces = await readdir(join(directory, 'traces'));
      const trace = await readFile(
        join(directory, 'traces', traces[0]!),
        'utf8',
      );
      expect(trace).toContain('"event":"failed"');
      expect(trace).not.toContain('"event":"completed"');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
