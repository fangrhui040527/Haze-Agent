import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { executeTraceCommand, parseTraceOptions, writeEvidenceBundle } =
  (await import(
    new URL('../../scripts/dev-trace.mjs', import.meta.url).href
  )) as {
    executeTraceCommand(
      this: void,
      tokens: string[],
      options: {
        request: (
          path: string,
          options?: { signal?: AbortSignal; maxBytes?: number },
        ) => Promise<unknown>;
        readTask?: (
          id: string,
          signal?: AbortSignal,
        ) => Promise<{ current_run_id: string }>;
        signal?: AbortSignal;
        write?: (line: string) => void;
        pollMs?: number;
      },
    ): Promise<string | void>;
    parseTraceOptions(this: void, tokens: string[]): { out?: string };
    writeEvidenceBundle(
      this: void,
      bundle: unknown,
      directory: string,
      signal?: AbortSignal,
    ): Promise<string>;
  };

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const record = (cursor: number) => ({
  task_id: 'task-1',
  run_id: 'run-1',
  cursor,
  event_id: `trace:${cursor}`,
  actor: 'Manager',
  action: 'decision',
  at: '2026-10-28T00:00:00Z',
  status: 'saved',
  summary: 'Checked evidence.',
});
describe('trace console commands', () => {
  it('pages beyond 100 events and pins follow to the selected historical run', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        schema_version: 'haze.trace.page.v1',
        task_id: 'task-1',
        run_id: 'run-1',
        records: Array.from({ length: 100 }, (_, i) => record(i + 1)),
        next_cursor: 100,
        has_more: true,
      })
      .mockResolvedValueOnce({
        schema_version: 'haze.trace.page.v1',
        task_id: 'task-1',
        run_id: 'run-1',
        records: [record(101)],
        next_cursor: 101,
        has_more: false,
      });
    const readTask = vi.fn();
    const write = vi.fn();
    await executeTraceCommand(['trace', 'task-1', '--run', 'run-1'], {
      request,
      readTask,
      write,
    });
    expect(write).toHaveBeenCalledTimes(101);
    expect(readTask).not.toHaveBeenCalled();
    expect(request.mock.calls[1]?.[0]).toBe(
      '/api/tasks/task-1/runs/run-1/trace?after=100&limit=100',
    );
  });
  it('cancels follow without repeating old records', async () => {
    const controller = new AbortController();
    const request = vi.fn().mockImplementation(() => {
      if (request.mock.calls.length === 2) controller.abort();
      return Promise.resolve({
        schema_version: 'haze.trace.page.v1',
        task_id: 'task-1',
        run_id: 'run-1',
        records: request.mock.calls.length === 1 ? [record(1)] : [],
        next_cursor: 1,
        has_more: false,
      });
    });
    const write = vi.fn();
    await executeTraceCommand(
      ['trace', 'task-1', '--run', 'run-1', '--follow'],
      { request, write, signal: controller.signal, pollMs: 1 },
    );
    expect(write).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[1]?.[0]).toContain('after=1');
  });
  it('rejects foreign runs and nonadvancing pages', async () => {
    await expect(
      executeTraceCommand(['trace', 'task-1', '--run', 'run-1'], {
        request: () =>
          Promise.resolve({
            schema_version: 'haze.trace.page.v1',
            task_id: 'task-2',
            run_id: 'run-1',
            records: [],
            next_cursor: 0,
            has_more: false,
          }),
      }),
    ).rejects.toThrow('identity or cursor');
    await expect(
      executeTraceCommand(['trace', 'task-1', '--run', 'run-1'], {
        request: () =>
          Promise.resolve({
            schema_version: 'haze.trace.page.v1',
            task_id: 'task-1',
            run_id: 'run-1',
            records: [],
            next_cursor: 0,
            has_more: true,
          }),
      }),
    ).rejects.toThrow('identity or cursor');
  });
  it('keeps Windows paths literal and refuses unknown or duplicate options', () => {
    expect(
      parseTraceOptions([
        'export',
        'task-1',
        '--out',
        'C:\\Trace output\\run 1',
      ]).out,
    ).toBe('C:\\Trace output\\run 1');
    expect(() =>
      parseTraceOptions(['trace', 'task-1', '--follow', '--follow']),
    ).toThrow('Usage');
    expect(() =>
      parseTraceOptions(['export', 'task-1', '--out', 'x', '--follow']),
    ).toThrow('Usage');
  });
  it('exports fixed filenames, verifies exported bytes, and refuses overwrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'haze-trace-cli-'));
    roots.push(root);
    const content = { safe: 'derived field' };
    const bundle = {
      schema_version: 'haze.evidence-bundle.v1',
      manifest: { task_id: 'task-1', run_id: 'run-1' },
      records: [record(1)],
      summary: '# Fixture trace\n',
      input: {},
      output: null,
      context: {},
      artifacts: [
        {
          filename: '../../escape.json',
          content,
          exported_sha256: createHash('sha256')
            .update(`${JSON.stringify(content)}\n`)
            .digest('hex'),
        },
      ],
    };
    const target = join(root, 'Run output');
    await writeEvidenceBundle(bundle, target);
    expect(await readdir(join(target, 'artifacts'))).toEqual([
      'artifact-0001.json',
    ]);
    expect(
      await readFile(join(target, 'artifacts', 'artifact-0001.json'), 'utf8'),
    ).toBe(`${JSON.stringify(content)}\n`);
    expect(
      JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8')),
    ).toEqual(bundle.manifest);
    await expect(writeEvidenceBundle(bundle, target)).rejects.toThrow(
      'refusing overwrite',
    );
    await expect(
      writeEvidenceBundle(
        {
          ...bundle,
          artifacts: [{ ...bundle.artifacts[0], exported_sha256: 'invalid' }],
        },
        join(root, 'bad'),
      ),
    ).rejects.toThrow('exported hash');
    expect(await readdir(root)).toEqual(['Run output']);
  });
});
