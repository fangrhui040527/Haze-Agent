import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { taskRequestSchema } from '../../app/contracts/tasks.js';
import { TaskStore } from '../../app/tasks/store.js';
import { TraceProjectionService } from '../../app/tasks/trace-projection.js';

const identity = { principal: 'trace-test', workspace: 'trace-test' };
const roots: string[] = [];
const stores: TaskStore[] = [];
const projectors: TraceProjectionService[] = [];
afterEach(async () => {
  for (const projection of projectors.splice(0)) await projection.close();
  for (const store of stores.splice(0)) if (store.db.isOpen) store.close();
  for (const root of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (!rel || rel.startsWith('..')) throw new Error('Unsafe test cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'haze-trace-projection-'));
  roots.push(root);
  const store = new TaskStore(join(root, 'state'));
  stores.push(store);
  const task = store.admit(
    taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Explain fixture evidence.',
    }),
    identity,
    randomUUID(),
    { mode: 'fixture', tools: [] },
  ).task;
  const directory = join(root, 'logs');
  return {
    root,
    store,
    task,
    directory,
    path: join(directory, task.current_run_id, 'events.jsonl'),
  };
}
function projector(
  store: TaskStore,
  directory: string,
  stdout: (line: string) => void = () => {},
) {
  const service = new TraceProjectionService(store, {
    directory,
    env: {
      HAZE_TRACE_FILES: 'on',
      HAZE_TRACE_STDOUT: 'key',
      TEST_SECRET: 'private-secret',
    },
    stdout,
    batchSize: 3,
  });
  projectors.push(service);
  return service;
}
const records = (path: string) =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { event_id: string; cursor: number });

describe('trace file projection and recovery', () => {
  it('recovers pre-projection commits in batches, repairs a torn tail, and never duplicates appended IDs', async () => {
    const { store, task, directory, path } = setup();
    for (let i = 0; i < 107; i++)
      store.appendEvent(
        task.id,
        'assignment_completed',
        'HazeOps',
        `fixture ${i}`,
      );
    const output: string[] = [];
    const first = projector(store, directory, (line) => {
      output.push(line);
    });
    await first.close();
    const before = records(path);
    expect(before).toHaveLength(108);
    expect(output).toEqual([]); // Startup history is files-only.
    const bytes = readFileSync(path, 'utf8');
    writeFileSync(path, bytes + '{"event_id":"torn');
    store.appendEvent(
      task.id,
      'task_failed',
      'Manager',
      'A controlled failure.',
    );
    const second = projector(store, directory);
    await second.flush();
    const after = records(path);
    expect(after).toHaveLength(109);
    expect(new Set(after.map((r) => r.event_id)).size).toBe(109);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(second.health().pending_records).toBe(0);
    const manifest = JSON.parse(
      readFileSync(
        join(directory, task.current_run_id, 'manifest.json'),
        'utf8',
      ),
    ) as { record_count: number; snapshot_cursor: number };
    expect(manifest.record_count).toBe(109);
    expect(manifest.snapshot_cursor).toBe(after.at(-1)!.cursor);
    expect(
      readFileSync(join(directory, task.current_run_id, 'summary.md'), 'utf8'),
    ).toContain('A controlled failure.');
  });

  it('does not project rolled back work and sanitizes both files and stdout after commit', async () => {
    const { store, task, directory, path } = setup();
    const output: string[] = [];
    const service = projector(store, directory, (line) => {
      output.push(line);
    });
    await service.flush();
    expect(() =>
      store.transaction(() => {
        store.appendEvent(
          task.id,
          'task_failed',
          'Manager',
          'should roll back',
        );
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    store.appendEvent(
      task.id,
      'manager_decision',
      'Manager',
      'private-secret Bearer dangerous-token https://name:password@example.com/?api_key=bad',
    );
    await service.close();
    expect(readFileSync(path, 'utf8')).not.toContain('should roll back');
    for (const value of [readFileSync(path, 'utf8'), output.join('')]) {
      expect(value).not.toContain('private-secret');
      expect(value).not.toContain('dangerous-token');
      expect(value).not.toContain('name:password');
      expect(value).not.toContain('api_key=bad');
      expect(value).toContain('[redacted]');
    }
  });

  it('repairs missing complete lines and incorrect saved payloads using the exact SQLite prefix', async () => {
    const { store, task, directory, path } = setup();
    store.appendEvent(task.id, 'task_paused', 'Manager', 'first');
    store.appendEvent(task.id, 'task_resumed', 'Manager', 'second');
    await projector(store, directory).close();
    const original = readFileSync(path, 'utf8');
    const lines = original.trimEnd().split('\n');
    writeFileSync(path, [lines[0], lines[2]].join('\n') + '\n');
    await projector(store, directory).close();
    expect(readFileSync(path, 'utf8')).toBe(original);
    writeFileSync(path, original.replace('first', 'corrupt'));
    await projector(store, directory).close();
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('bounds a stuck stdout sink so shutdown still flushes all files', async () => {
    const { store, task, directory, path } = setup();
    const service = new TraceProjectionService(store, {
      directory,
      env: { HAZE_TRACE_FILES: 'on', HAZE_TRACE_STDOUT: 'key' },
      stdout: () => new Promise<void>(() => {}),
      stdoutTimeoutMs: 10,
    });
    projectors.push(service);
    store.appendEvent(task.id, 'task_failed', 'Manager', 'blocked stdout');
    await service.close();
    expect(records(path)).toHaveLength(2);
    expect(service.health().last_error).toBe('stdout sink failed');
  });

  it('keeps disk failure outside task work and retries from SQLite when the sink is repaired', async () => {
    const { store, task, directory, path } = setup();
    writeFileSync(directory, 'blocked path');
    const service = projector(store, directory);
    await service.flush();
    expect(service.health().failed_operations).toBeGreaterThan(0);
    expect(service.health().pending_records).toBeGreaterThan(0);
    store.appendEvent(
      task.id,
      'task_failed',
      'Manager',
      'Still committed while the sink is broken.',
    );
    expect(store.read(task.id, identity).id).toBe(task.id);
    rmSync(directory); // A verified temporary file, never a recursive computed delete.
    await service.flush();
    expect(existsSync(path)).toBe(true);
    expect(records(path)).toHaveLength(2);
    expect(service.health().pending_records).toBe(0);
  });

  it('reports stdout failure while preserving a committed file stream', async () => {
    const { store, task, directory, path } = setup();
    const service = projector(store, directory, () => {
      throw new Error('bad stdout');
    });
    store.appendEvent(
      task.id,
      'task_failed',
      'Manager',
      'fixture stdout failure',
    );
    await service.close();
    expect(records(path)).toHaveLength(2);
    expect(service.health().failed_operations).toBeGreaterThan(0);
    expect(service.health().pending_records).toBe(0);
  });
});
