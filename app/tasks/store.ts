import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { contractHash, parseContractJson } from '../contracts/json.js';
import {
  TaskError,
  taskRecordSchema,
  type TaskRecord,
  type TaskIdentity,
  type TaskEvent,
} from './contracts.js';

export interface TaskArtifact {
  id: string;
  version: 1;
  task_id: string;
  sha256: string;
  kind: string;
  producer: TaskEvent['actor'];
  objective_revision: 1;
  created_at: string;
  content: unknown;
}

/** Single local runtime, atomic admission/event transitions and immutable content-addressed artifacts. */
export class TaskStore {
  readonly db: DatabaseSync;
  private readonly lockPath: string;
  private readonly lockToken = randomUUID();
  constructor(directory: string) {
    const root = resolve(directory);
    mkdirSync(root, { recursive: true });
    this.lockPath = join(root, 'tasks.lock');
    try {
      const prior = JSON.parse(readFileSync(this.lockPath, 'utf8')) as {
        pid: number;
      };
      let alive = true;
      try {
        process.kill(prior.pid, 0);
      } catch {
        alive = false;
      }
      if (alive)
        throw new Error('Another task runtime owns this state directory.');
      unlinkSync(this.lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    writeFileSync(
      this.lockPath,
      JSON.stringify({ pid: process.pid, token: this.lockToken }),
      { flag: 'wx' },
    );
    this.db = new DatabaseSync(join(root, 'tasks.sqlite'));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, principal TEXT NOT NULL, workspace TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY(scope,key));
      CREATE TABLE IF NOT EXISTS events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_events ON events(task_id,cursor);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, body TEXT NOT NULL);`);
    const rows = this.db.prepare('SELECT body FROM tasks').all() as {
      body: string;
    }[];
    for (const row of rows) {
      const task = taskRecordSchema.parse(parseContractJson(row.body));
      if (task.status === 'queued' || task.status === 'running') {
        task.status = 'failed';
        task.error = {
          code: 'restart_interrupted',
          message:
            'The local runtime stopped during execution. No provider/tool retry was made; charged attempts and artifacts are preserved.',
        };
        this.transition(task, 'task_failed', 'Manager', task.error.message);
      }
    }
  }
  private atomic<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  read(id: string, identity: TaskIdentity): TaskRecord {
    const row = this.db
      .prepare(
        'SELECT body FROM tasks WHERE id=? AND principal=? AND workspace=?',
      )
      .get(id, identity.principal, identity.workspace) as
      { body: string } | undefined;
    if (!row)
      throw new TaskError(
        404,
        'task_not_found',
        'Task not found in this principal/workspace.',
      );
    return taskRecordSchema.parse(parseContractJson(row.body));
  }
  admit(
    task: TaskRecord,
    key: string,
    original: unknown,
  ): { task: TaskRecord; reused: boolean } {
    return this.atomic(() => {
      const scope = JSON.stringify([
        task.identity.principal,
        task.identity.workspace,
        'POST /api/tasks',
        'haze.task.request.v1',
      ]);
      const fingerprint = contractHash(original);
      const prior = this.db
        .prepare(
          'SELECT fingerprint,task_id FROM operations WHERE scope=? AND key=?',
        )
        .get(scope, key) as
        { fingerprint: string; task_id: string } | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new TaskError(
            409,
            'idempotency_conflict',
            'This idempotency key was already used for different content.',
          );
        return { task: this.read(prior.task_id, task.identity), reused: true };
      }
      this.db
        .prepare('INSERT INTO tasks VALUES(?,?,?,?)')
        .run(
          task.id,
          task.identity.principal,
          task.identity.workspace,
          JSON.stringify(task),
        );
      this.db
        .prepare('INSERT INTO operations VALUES(?,?,?,?)')
        .run(scope, key, fingerprint, task.id);
      this.append(
        task.id,
        'task_admitted',
        'Manager',
        'Request persisted; read-only evidence execution admitted.',
      );
      return { task, reused: false };
    });
  }
  private append(
    taskId: string,
    type: string,
    actor: TaskEvent['actor'],
    message: string,
    data?: unknown,
  ) {
    const event = {
      task_id: taskId,
      at: new Date().toISOString(),
      type,
      actor,
      message,
      ...(data === undefined ? {} : { data }),
    };
    const result = this.db
      .prepare('INSERT INTO events(task_id,body) VALUES(?,?)')
      .run(taskId, JSON.stringify(event));
    return { ...event, cursor: Number(result.lastInsertRowid) };
  }
  transition(
    task: TaskRecord,
    type: string,
    actor: TaskEvent['actor'],
    message: string,
    data?: unknown,
  ): void {
    this.atomic(() => {
      task.updated_at = new Date().toISOString();
      const parsed = taskRecordSchema.parse(task);
      this.db
        .prepare('UPDATE tasks SET body=? WHERE id=?')
        .run(JSON.stringify(parsed), task.id);
      this.append(task.id, type, actor, message, data);
    });
  }
  events(id: string, identity: TaskIdentity, after: number) {
    const task = this.read(id, identity);
    const rows = this.db
      .prepare(
        'SELECT cursor,body FROM events WHERE task_id=? AND cursor>? ORDER BY cursor LIMIT 100',
      )
      .all(id, after) as { cursor: number; body: string }[];
    const events = rows.map((row) => ({
      ...(JSON.parse(row.body) as Omit<TaskEvent, 'cursor'>),
      cursor: row.cursor,
    }));
    return {
      events,
      next_cursor: events.at(-1)?.cursor ?? after,
      status: task.status,
    };
  }
  artifact(id: string, identity: TaskIdentity): TaskArtifact {
    const row = this.db
      .prepare('SELECT task_id,body FROM artifacts WHERE id=?')
      .get(id) as { task_id: string; body: string } | undefined;
    if (!row)
      throw new TaskError(404, 'artifact_not_found', 'Artifact not found.');
    this.read(row.task_id, identity);
    const artifact = JSON.parse(row.body) as TaskArtifact;
    if (contractHash(artifact.content) !== artifact.sha256)
      throw new Error('Artifact integrity check failed.');
    return artifact;
  }
  saveArtifact(
    task: TaskRecord,
    kind: string,
    content: unknown,
    producer: TaskEvent['actor'] = 'HazeOps',
  ): TaskArtifact {
    if (task.usage.artifacts >= task.limits.max_artifacts)
      throw new TaskError(422, 'artifact_limit', 'Artifact budget exhausted.');
    const artifact: TaskArtifact = {
      id: randomUUID(),
      version: 1,
      task_id: task.id,
      sha256: contractHash(content),
      kind,
      producer,
      objective_revision: task.objective_revision,
      content,
      created_at: new Date().toISOString(),
    };
    this.atomic(() => {
      this.db
        .prepare('INSERT INTO artifacts VALUES(?,?,?)')
        .run(artifact.id, task.id, JSON.stringify(artifact));
      task.usage.artifacts++;
      this.db
        .prepare('UPDATE tasks SET body=? WHERE id=?')
        .run(JSON.stringify(task), task.id);
      this.append(
        task.id,
        'artifact_saved',
        producer,
        `Saved immutable ${kind}.`,
        { id: artifact.id, sha256: artifact.sha256, kind },
      );
    });
    return artifact;
  }
  close() {
    this.db.close();
    const lock = JSON.parse(readFileSync(this.lockPath, 'utf8')) as {
      token: string;
    };
    if (lock.token === this.lockToken) unlinkSync(this.lockPath);
  }
}
