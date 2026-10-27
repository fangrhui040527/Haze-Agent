import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { TaskError } from '../contracts/tasks.js';

/** An OS-released SQLite exclusive lock avoids stale PID takeover races after a kill. */
export function acquireRuntimeOwner(directory: string) {
  const path = `${resolve(directory)}.owner.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const token = randomUUID();
  const lock = new DatabaseSync(`${resolve(directory)}.owner.sqlite`);
  try {
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  } catch (error) {
    lock.close();
    if (
      !(error instanceof Error) ||
      !('errcode' in error) ||
      typeof error.errcode !== 'number' ||
      ![5, 6].includes(error.errcode & 0xff)
    )
      throw error;
    let owner = '';
    try {
      const { pid } = JSON.parse(readFileSync(path, 'utf8')) as {
        pid?: unknown;
      };
      if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0)
        owner = ` (PID ${pid})`;
    } catch {
      // The sidecar is diagnostic only; SQLite remains the ownership authority.
    }
    throw new TaskError(
      409,
      'runtime_owner_exists',
      `This state directory already has a runtime owner${owner}: ${resolve(directory)}. Stop the existing server with Ctrl+C in its terminal, or set HAZE_TASK_STATE_DIR to a separate directory. HAZE_TASK_STATE_DIR takes precedence over STATE_DIR.`,
    );
  }
  try {
    writeFileSync(path, JSON.stringify({ pid: process.pid, token }));
  } catch (error) {
    lock.exec('ROLLBACK');
    lock.close();
    throw error;
  }
  return () => {
    try {
      if (
        existsSync(path) &&
        (JSON.parse(readFileSync(path, 'utf8')) as { token?: string }).token ===
          token
      )
        unlinkSync(path);
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
    }
  };
}
