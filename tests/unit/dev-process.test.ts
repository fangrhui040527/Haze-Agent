import { describe, expect, it, vi } from 'vitest';

const { runDevTool, describeComposeStatus } = (await import(
  new URL('../../scripts/dev-process.mjs', import.meta.url).href
)) as {
  runDevTool: (
    command: string,
    args: string[],
    options?: {
      signal?: AbortSignal;
      timeout?: number;
      onOutput?: (text: string) => void;
    },
  ) => Promise<string>;
  describeComposeStatus: (
    containers: { Service: string; State: string; ExitCode?: number }[],
  ) => string;
};

describe('development command processes', () => {
  it('distinguishes completed setup jobs from stopped services and failed processes', () => {
    const result = describeComposeStatus([
      { Service: 'bootstrap', State: 'exited', ExitCode: 0 },
      { Service: 'postgres', State: 'exited', ExitCode: 0 },
      { Service: 'driver', State: 'exited', ExitCode: 137 },
    ]);
    expect(result).toContain('bootstrap: completed');
    expect(result).toContain('postgres: stopped');
    expect(result).toContain('driver: failed (exit 137)');
  });
  it('preserves output across chunks and does not expand shell arguments', async () => {
    const output: string[] = [];
    const value = '$(whoami); $HOME';
    const result = await runDevTool(
      process.execPath,
      [
        '-e',
        'process.stdout.write(process.argv[1].slice(0,4));setTimeout(()=>process.stdout.write(process.argv[1].slice(4)+"\\n"),20)',
        value,
      ],
      { onOutput: (text) => output.push(text) },
    );
    expect(result).toBe(value);
    expect(output).toEqual([`${value}\n`]);
  });

  it('cancels the owned child tree so a rebuild cannot keep running after Ctrl+C', async () => {
    const controller = new AbortController();
    let descendant: number | undefined;
    const command =
      'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});console.log(child.pid);setInterval(()=>{},1000);';
    try {
      await expect(
        runDevTool(process.execPath, ['-e', command], {
          signal: controller.signal,
          onOutput: (text) => {
            descendant = Number(text.trim());
            controller.abort(new Error('test cancellation'));
          },
        }),
      ).rejects.toThrow('test cancellation');
      expect(descendant).toBeGreaterThan(0);
      await vi.waitFor(
        () => {
          expect(() => process.kill(descendant!, 0)).toThrow();
        },
        { timeout: 5000 },
      );
    } finally {
      if (descendant) {
        try {
          process.kill(descendant, 'SIGKILL');
        } catch {
          /* already terminated */
        }
      }
    }
  });

  it('reports a bounded timeout instead of leaving a command busy', async () => {
    await expect(
      runDevTool(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        timeout: 250,
      }),
    ).rejects.toThrow('timed out');
  });
});
