import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

class Output extends EventEmitter {
  isTTY = true;
  columns = 80;
  chunks: string[] = [];

  write(text: string) {
    this.chunks.push(text);
    return true;
  }
}

interface Display {
  update(index: number, status: string, detail?: string): void;
  urls(local?: string[], network?: string[], elapsedSeconds?: number): void;
  log(text: string): void;
  close(): void;
  skipPending(from?: number): void;
}

const { createStartupDisplay } = (await import(
  new URL('../../scripts/dev-status.mjs', import.meta.url).href
)) as {
  createStartupDisplay: (options: {
    output: Output;
    now?: () => number;
  }) => Display;
};

/** Model the cursor operations used by the panel to inspect the visible screen. */
function screen(output: Output) {
  const text = output.chunks.join('');
  let lines: string[] = [''];
  let row = 0;
  let column = 0;
  let offset = 0;
  while (offset < text.length) {
    const sequence = text.startsWith(String.fromCharCode(27), offset)
      ? /^\[(\d*)([AJ])/.exec(text.slice(offset + 1))
      : null;
    if (sequence) {
      if (sequence[2] === 'A')
        row = Math.max(0, row - Number(sequence[1] || 1));
      else {
        lines = lines.slice(0, row + 1);
        lines[row] = (lines[row] ?? '').slice(0, column);
      }
      offset += sequence[0].length + 1;
      continue;
    }
    const character = text[offset++];
    if (character === '\r') column = 0;
    else if (character === '\n') {
      row++;
      column = 0;
    } else {
      const line = lines[row] ?? '';
      lines[row] =
        line.slice(0, column).padEnd(column) +
        character +
        line.slice(column + 1);
      column++;
    }
  }
  return lines.join('\n').trimEnd();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('development startup status display', () => {
  it('shows elapsed time while checking World Model readiness and freezes it afterward', () => {
    vi.stubEnv('TERM', 'xterm');
    vi.useFakeTimers();
    let time = 0;
    const output = new Output();
    const display = createStartupDisplay({ output, now: () => time });
    display.update(4, 'CHECKING');
    time = 1700;
    vi.advanceTimersByTime(1700);
    expect(screen(output)).toMatch(
      /World Model \(SQLite\)[^\n]*CHECKING.*1\.7s/,
    );
    display.update(4, 'READY');
    expect(screen(output)).toMatch(/World Model \(SQLite\)[^\n]*READY.*1\.7s/);
    expect(vi.getTimerCount()).toBe(0);
    display.close();
  });

  it('advances each starting component timer and freezes it while the next component starts', () => {
    vi.stubEnv('TERM', 'xterm');
    vi.useFakeTimers();
    let time = 1000;
    const output = new Output();
    const display = createStartupDisplay({ output, now: () => time });
    const row = (label: string) =>
      screen(output)
        .split('\n')
        .find((line) => line.includes(label));

    display.update(0, 'STARTING');
    expect(row('Zetaris platform')).toMatch(/STARTING.*0\.0s/);
    expect(vi.getTimerCount()).toBe(1);

    time += 1200;
    vi.advanceTimersByTime(1200);
    expect(row('Zetaris platform')).toMatch(/STARTING.*1\.2s/);
    expect(row('Haze TypeScript build')).toContain('WAITING');
    expect(row('Haze TypeScript build')).not.toMatch(/\d+\.\ds/);

    display.update(0, 'STARTED');
    display.update(1, 'STARTING');
    expect(row('Haze TypeScript build')).toMatch(/STARTING.*0\.0s/);
    time += 2300;
    vi.advanceTimersByTime(2300);

    expect(row('Zetaris platform')).toMatch(/STARTED.*1\.2s/);
    expect(row('Haze TypeScript build')).toMatch(/STARTING.*2\.3s/);
    for (const label of [
      'Zetaris platform',
      'Haze TypeScript build',
      'Haze web app',
    ])
      expect(screen(output).split(label)).toHaveLength(2);

    display.update(1, 'READY');
    expect(row('Haze TypeScript build')).toMatch(/READY.*2\.3s/);
    expect(vi.getTimerCount()).toBe(0);
    const writes = output.chunks.length;
    time += 5000;
    vi.advanceTimersByTime(5000);
    expect(output.chunks).toHaveLength(writes);
    display.close();
  });

  it('preserves the start time on repeated starting updates and avoids duplicate final durations', () => {
    vi.stubEnv('TERM', 'xterm');
    vi.useFakeTimers();
    let time = 0;
    const output = new Output();
    const display = createStartupDisplay({ output, now: () => time });

    display.update(0, 'STARTING');
    time = 1000;
    vi.advanceTimersByTime(1000);
    display.update(0, 'STARTING');
    expect(screen(output)).toMatch(/Zetaris platform[^\n]*STARTING.*1\.0s/);
    time = 1500;
    vi.advanceTimersByTime(500);
    expect(screen(output)).toMatch(/Zetaris platform[^\n]*STARTING.*1\.5s/);

    display.update(0, 'READY', '4 healthy | 1.5s');
    const visible = screen(output);
    expect(visible).toContain('4 healthy | 1.5s');
    expect(visible.match(/1\.5s/g)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    display.close();
  });

  it('stops repainting and releases the active ticker when closed during startup', () => {
    vi.stubEnv('TERM', 'xterm');
    vi.useFakeTimers();
    const output = new Output();
    const display = createStartupDisplay({ output });

    display.update(0, 'STARTING');
    expect(vi.getTimerCount()).toBe(1);
    display.close();
    expect(vi.getTimerCount()).toBe(0);
    const writes = output.chunks.length;
    vi.advanceTimersByTime(1000);
    expect(output.chunks).toHaveLength(writes);
  });

  it.each([
    { isTTY: false, term: 'xterm' },
    { isTTY: true, term: 'dumb' },
  ])(
    'does not start a ticker when TTY=$isTTY and TERM=$term',
    ({ isTTY, term }) => {
      vi.stubEnv('TERM', term);
      vi.useFakeTimers();
      const output = new Output();
      output.isTTY = isTTY;
      const display = createStartupDisplay({ output });

      display.update(0, 'STARTING');
      expect(vi.getTimerCount()).toBe(0);
      const writes = output.chunks.length;
      vi.advanceTimersByTime(1000);
      expect(output.chunks).toHaveLength(writes);
      display.update(0, 'STARTED');
      expect(vi.getTimerCount()).toBe(0);
      display.close();
    },
  );

  it('replaces component statuses in one visible panel', () => {
    vi.stubEnv('TERM', 'xterm');
    const output = new Output();
    const display = createStartupDisplay({ output });

    display.update(0, 'STARTING');
    display.update(0, 'STARTED', '2.0s');
    display.update(1, 'STARTING');
    display.update(1, 'READY');
    display.update(2, 'READY');
    for (const [index, status] of [
      [3, 'READY'],
      [4, 'READY'],
      [5, 'RUNNING'],
      [6, 'UNVERIFIED'],
      [7, 'UNREACHABLE'],
      [8, 'BLOCKED'],
      [9, 'UNCONFIGURED'],
      [10, 'BLOCKED'],
    ] as const)
      display.update(index, status);
    display.urls(['http://localhost:5173/'], [], 3.5);

    const visible = screen(output);
    expect(visible.match(/Haze Agent/g)).toHaveLength(1);
    expect(visible.match(/Zetaris platform/g)).toHaveLength(1);
    expect(visible.match(/Haze TypeScript build/g)).toHaveLength(1);
    expect(visible.match(/Haze web app/g)).toHaveLength(1);
    expect(visible).toContain('STARTED  2.0s');
    expect(visible).not.toMatch(/STARTING|WAITING/);
    expect(visible).toMatch(/World Model \(SQLite\)[^\n]*READY/);
    expect(visible).not.toContain('H-MEM');
    expect(visible).toMatch(/Nightshift candidate jobs[^\n]*BLOCKED/);
    expect(visible).toContain('http://localhost:5173/');
    expect(visible).toContain('Started in 3.5s');
    display.close();
  });

  it('preserves a failed component when skipping checks after an interrupted startup', () => {
    vi.stubEnv('TERM', 'xterm');
    const output = new Output();
    const display = createStartupDisplay({ output });
    display.update(3, 'READY');
    display.update(4, 'FAILED', 'SQLite query failed');
    display.update(8, 'STARTING');
    display.skipPending(3);
    const visible = screen(output);
    expect(visible).toMatch(/Haze tasks \(LangGraph\)[^\n]*READY/);
    expect(visible).toMatch(/World Model \(SQLite\)[^\n]*FAILED/);
    expect(visible).toMatch(/Nightshift runtime[^\n]*SKIPPED/);
    display.close();
  });

  it('keeps diagnostics above the panel without leaving old status rows', () => {
    vi.stubEnv('TERM', 'xterm');
    const output = new Output();
    const display = createStartupDisplay({ output });

    display.update(0, 'STARTING');
    display.log('Docker could not connect');
    display.update(0, 'FAILED');

    const visible = screen(output);
    expect(visible.match(/Docker could not connect/g)).toHaveLength(1);
    expect(visible.match(/Zetaris platform/g)).toHaveLength(1);
    expect(visible.indexOf('Docker could not connect')).toBeLessThan(
      visible.indexOf('Haze Agent'),
    );
    expect(visible).toContain('FAILED');
    expect(visible).not.toContain('STARTING');
    display.close();
  });

  it('removes child cursor controls before writing diagnostics above the panel', () => {
    vi.stubEnv('TERM', 'xterm');
    const output = new Output();
    const display = createStartupDisplay({ output });

    display.update(0, 'STARTING');
    display.log('\u001b[2Jwarning\u001b[1A\n');
    display.update(0, 'FAILED');

    const visible = screen(output);
    expect(visible.match(/warning/g)).toHaveLength(1);
    expect(visible.match(/Haze Agent/g)).toHaveLength(1);
    expect(visible.match(/Zetaris platform/g)).toHaveLength(1);
    expect(visible).toContain('FAILED');
    expect(visible.indexOf('warning')).toBeLessThan(
      visible.indexOf('Haze Agent'),
    );
    expect(output.chunks).toContain('warning\n');
    expect(output.chunks).not.toContain('\u001b[2Jwarning\u001b[1A\n');
    display.close();
  });

  it('redraws within the new terminal width and releases its resize listener', () => {
    vi.stubEnv('TERM', 'xterm');
    const output = new Output();
    const display = createStartupDisplay({ output });
    expect(output.listenerCount('resize')).toBe(1);

    output.columns = 24;
    output.emit('resize');
    const lastDraw = output.chunks.at(-1) ?? '';
    expect(
      lastDraw
        .trimEnd()
        .split('\n')
        .every((line) => line.length <= 23),
    ).toBe(true);

    display.close();
    expect(output.listenerCount('resize')).toBe(0);
    const writes = output.chunks.length;
    output.emit('resize');
    display.close();
    expect(output.chunks).toHaveLength(writes);
  });

  it.each([false, true])(
    'emits only final plain rows when TTY=%s and TERM=dumb',
    (isTTY) => {
      vi.stubEnv('TERM', 'dumb');
      const output = new Output();
      output.isTTY = isTTY;
      const display = createStartupDisplay({ output });

      display.update(0, 'STARTING');
      display.update(0, 'STARTED');
      display.update(0, 'STARTED');
      display.update(1, 'STARTING');
      display.update(1, 'FAILED', 'compiler exited');
      display.update(2, 'SKIPPED');
      display.urls(['http://localhost:5173/'], [], 1);
      display.urls(['http://localhost:5173/'], [], 1);
      display.close();

      const text = output.chunks.join('');
      expect(text).not.toContain('\u001b');
      expect(text).not.toMatch(/STARTING|WAITING/);
      expect(text.match(/Zetaris platform/g)).toHaveLength(1);
      expect(text.match(/Haze TypeScript build/g)).toHaveLength(1);
      expect(text.match(/Haze web app/g)).toHaveLength(1);
      expect(text.match(/http:\/\/localhost:5173\//g)).toHaveLength(1);
      expect(output.listenerCount('resize')).toBe(0);
    },
  );

  it('uses the supplied clock for total startup time when none is provided', () => {
    const output = new Output();
    output.isTTY = false;
    let time = 1000;
    const display = createStartupDisplay({ output, now: () => time });
    time = 4250;

    display.urls();

    expect(output.chunks.join('')).toContain('Started in 3.3s');
    display.close();
  });
});
