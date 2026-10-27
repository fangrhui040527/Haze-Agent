import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskError } from '../../app/contracts/tasks.js';
import { acquireRuntimeOwner } from '../../app/tasks/runtime-owner.js';

const directories: string[] = [];
const releases: (() => void)[] = [];

function stateDirectory() {
  const root = mkdtempSync(join(tmpdir(), 'haze-runtime-owner-'));
  directories.push(root);
  return join(root, 'state');
}

afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('runtime ownership diagnostics', () => {
  it('reports the active owner and effective state setting without disturbing the lock', () => {
    const directory = stateDirectory();
    releases.push(acquireRuntimeOwner(directory));
    const original = readFileSync(`${directory}.owner.lock`, 'utf8');

    let conflict: unknown;
    try {
      releases.push(acquireRuntimeOwner(directory));
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(TaskError);
    expect(conflict).toMatchObject({
      status: 409,
      code: 'runtime_owner_exists',
    });
    expect((conflict as Error).message).toContain(`PID ${process.pid}`);
    expect((conflict as Error).message).toContain(directory);
    expect((conflict as Error).message).toContain(
      'HAZE_TASK_STATE_DIR takes precedence over STATE_DIR',
    );
    expect(readFileSync(`${directory}.owner.lock`, 'utf8')).toBe(original);

    releases.pop()!();
    releases.push(acquireRuntimeOwner(directory));
  });

  it('allows startup when only a stale PID sidecar remains', () => {
    const directory = stateDirectory();
    // Even a live PID in a stale sidecar cannot establish SQLite ownership.
    writeFileSync(
      `${directory}.owner.lock`,
      JSON.stringify({ pid: process.pid, token: 'stale' }),
    );
    releases.push(acquireRuntimeOwner(directory));
    const owner = JSON.parse(
      readFileSync(`${directory}.owner.lock`, 'utf8'),
    ) as { pid: number; token: string };
    expect(owner.pid).toBe(process.pid);
    expect(owner.token).not.toBe('stale');
  });

  it('preserves ownership when the diagnostic sidecar cannot be parsed', () => {
    const directory = stateDirectory();
    releases.push(acquireRuntimeOwner(directory));
    const path = `${directory}.owner.lock`;
    const original = readFileSync(path, 'utf8');
    try {
      writeFileSync(path, 'invalid sidecar');
      expect(() => acquireRuntimeOwner(directory)).toThrow('runtime owner:');
    } finally {
      writeFileSync(path, original);
    }
  });

  it('does not report an invalid lock database as another owner', () => {
    const directory = stateDirectory();
    writeFileSync(`${directory}.owner.sqlite`, 'not a SQLite database');
    let failure: unknown;
    try {
      releases.push(acquireRuntimeOwner(directory));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(TaskError);
    expect((failure as Error).message).toMatch(/not a database/);
  });
});
