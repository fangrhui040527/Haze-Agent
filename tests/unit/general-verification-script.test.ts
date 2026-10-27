import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    fork: () => {
      const child = Object.assign(new EventEmitter(), { exitCode: 1 });
      queueMicrotask(() =>
        child.emit(
          'error',
          new Error('Reproducible server bootstrap failure.'),
        ),
      );
      return child;
    },
  };
});

it.each([
  { mode: 'fixture', args: ['--fixture'] },
  {
    mode: 'live',
    args: [
      '--live',
      'Singapore',
      '2026-10-01T00:00:00Z',
      '2026-10-01T03:00:00Z',
    ],
  },
])(
  'retains an unsuccessful $mode trace when bootstrap fails',
  async (entry) => {
    const directory = await mkdtemp(
      join(tmpdir(), 'haze-general-verifier-failure-'),
    );
    const temporaryPath = relative(resolve(tmpdir()), resolve(directory));
    if (!temporaryPath.startsWith('haze-general-verifier-failure-'))
      throw new Error('Unexpected verification test cleanup path.');
    const previousArguments = process.argv;
    const previousDirectory = process.env.STATE_DIR;
    const previousExitCode = process.exitCode;
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      vi.resetModules();
      process.argv = ['node', 'verify-general.mjs', ...entry.args];
      process.env.STATE_DIR = directory;
      const script = '../../scripts/verify-general.mjs';
      await import(script);
      const reportDirectory = join(directory, 'general-verification');
      const [run] = await readdir(reportDirectory);
      if (!run) throw new Error('Verifier did not retain its run report.');
      const report: unknown = JSON.parse(
        await readFile(join(reportDirectory, run, 'report.json'), 'utf8'),
      );
      expect(report).toMatchObject({
        mode: entry.mode,
        passed: false,
        readiness: 'unverified',
        live_readiness_pass: false,
        verification_error: {
          stage: 'server_start',
          message: 'Reproducible server bootstrap failure.',
        },
        attempts: [],
        general: null,
        investigation: null,
      });
      expect(process.exitCode).toBe(2);
      expect(output).toHaveBeenCalledOnce();
    } finally {
      process.argv = previousArguments;
      process.exitCode = previousExitCode;
      if (previousDirectory === undefined) delete process.env.STATE_DIR;
      else process.env.STATE_DIR = previousDirectory;
      output.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
