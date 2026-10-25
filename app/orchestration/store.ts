import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { contractHash, parseContractJson } from '../contracts/json.js';
import { TaskError, type TaskIdentity } from '../tasks/contracts.js';
import {
  assignmentSchema,
  orchestrationArtifactSchema,
  orchestrationTaskSchema,
  type ArtifactRef,
  type Assignment,
  type OrchestrationArtifact,
  type OrchestrationEvent,
  type OrchestrationTask,
} from './contracts.js';

const terminal = (status: string) => !['queued', 'running'].includes(status);

/** The task database owns admission, attempts and artifact acceptance; checkpoints only reference it. */
export class OrchestrationStore {
  // Persisted hybrid_* table names are stable identifiers from before the module rename.
  constructor(
    readonly db: DatabaseSync,
    private readonly validateExternalRef?: (
      ref: ArtifactRef,
      identity: TaskIdentity,
    ) => void,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS hybrid_tasks(id TEXT PRIMARY KEY,principal TEXT NOT NULL,workspace TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hybrid_operations(scope TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(scope,key));
      CREATE TABLE IF NOT EXISTS hybrid_assignments(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hybrid_events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS hybrid_task_events ON hybrid_events(task_id,cursor);
      CREATE TABLE IF NOT EXISTS hybrid_artifacts(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,body TEXT NOT NULL);`);
    for (const row of db.prepare('SELECT body FROM hybrid_tasks').all() as {
      body: string;
    }[]) {
      const body = parseContractJson(row.body) as OrchestrationTask;
      const task = this.read(body.id, body.identity);
      if (!terminal(task.status))
        this.stop(
          task,
          'failed',
          'restart_interrupted',
          'The runtime stopped during execution. Artifacts and charged attempts remain; no calls were replayed.',
        );
    }
  }
  private atomic<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  exists(id: string): boolean {
    return !!this.db.prepare('SELECT id FROM hybrid_tasks WHERE id=?').get(id);
  }
  read(id: string, identity: TaskIdentity): OrchestrationTask {
    const row = this.db
      .prepare(
        'SELECT body FROM hybrid_tasks WHERE id=? AND principal=? AND workspace=?',
      )
      .get(id, identity.principal, identity.workspace) as
      { body: string } | undefined;
    if (!row)
      throw new TaskError(
        404,
        'task_not_found',
        'Task not found in this principal/workspace.',
      );
    const assignments = (
      this.db
        .prepare(
          'SELECT body FROM hybrid_assignments WHERE task_id=? ORDER BY rowid',
        )
        .all(id) as { body: string }[]
    ).map((x) => assignmentSchema.parse(parseContractJson(x.body)));
    return orchestrationTaskSchema.parse({
      ...(parseContractJson(row.body) as object),
      assignments,
    });
  }
  private write(task: OrchestrationTask) {
    const parsed = orchestrationTaskSchema.parse(task);
    const { assignments, ...body } = parsed;
    this.db
      .prepare('UPDATE hybrid_tasks SET body=? WHERE id=?')
      .run(JSON.stringify(body), task.id);
    for (const assignment of assignments)
      this.db
        .prepare(
          'INSERT INTO hybrid_assignments VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
        )
        .run(assignment.id, task.id, JSON.stringify(assignment));
  }
  private append(
    task: OrchestrationTask,
    type: string,
    actor: OrchestrationEvent['actor'],
    message: string,
    data?: unknown,
    assignmentId?: string,
  ) {
    const body = {
      schema_version: 'haze.task.event.v2',
      task_id: task.id,
      at: new Date().toISOString(),
      type,
      actor,
      message,
      objective_revision: task.objective_revision,
      generation: task.generation,
      ...(data === undefined ? {} : { data }),
      ...(assignmentId ? { assignment_id: assignmentId } : {}),
    };
    this.db
      .prepare('INSERT INTO hybrid_events(task_id,body) VALUES(?,?)')
      .run(task.id, JSON.stringify(body));
  }
  assertActive(task: OrchestrationTask) {
    const current = this.read(task.id, task.identity);
    if (current.generation !== task.generation || terminal(current.status))
      throw new TaskError(
        409,
        'stale_execution',
        'This execution no longer owns the task generation.',
      );
    if (Date.now() >= Date.parse(task.limits.deadline))
      throw new TaskError(
        408,
        'deadline',
        'The absolute task deadline expired.',
      );
  }
  admit(task: OrchestrationTask, key: string, original: unknown) {
    return this.atomic(() => {
      const scope = JSON.stringify([
        task.identity.principal,
        task.identity.workspace,
        'POST /api/tasks',
        'haze.task.request.v2',
      ]);
      const fingerprint = contractHash(original);
      const prior = this.db
        .prepare(
          'SELECT fingerprint,task_id FROM hybrid_operations WHERE scope=? AND key=?',
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
        .prepare('INSERT INTO hybrid_tasks VALUES(?,?,?,?)')
        .run(
          task.id,
          task.identity.principal,
          task.identity.workspace,
          JSON.stringify(task),
        );
      this.db
        .prepare('INSERT INTO hybrid_operations VALUES(?,?,?,?)')
        .run(scope, key, fingerprint, task.id);
      this.append(
        task,
        'task_admitted',
        'Manager',
        'Persisted the bounded orchestration evidence request.',
      );
      return { task, reused: false };
    });
  }
  transition(
    task: OrchestrationTask,
    type: string,
    actor: OrchestrationEvent['actor'],
    message: string,
    data?: unknown,
    assignmentId?: string,
  ) {
    this.atomic(() => {
      this.assertActive(task);
      task.updated_at = new Date().toISOString();
      this.write(task);
      this.append(task, type, actor, message, data, assignmentId);
    });
  }
  saveArtifact(
    task: OrchestrationTask,
    assignment: Assignment,
    kind: string,
    content: unknown,
    dependencies: ArtifactRef[] = [],
  ): OrchestrationArtifact {
    return this.atomic(() => {
      this.assertActive(task);
      if (task.usage.artifacts >= task.limits.max_artifacts)
        throw new TaskError(
          422,
          'artifact_limit',
          'The aggregate artifact budget is exhausted.',
        );
      for (const ref of dependencies) {
        const local = this.db
          .prepare('SELECT id FROM hybrid_artifacts WHERE id=?')
          .get(ref.id);
        if (local || !this.validateExternalRef)
          this.artifact(ref.id, task.identity, ref);
        else this.validateExternalRef(ref, task.identity);
      }
      const artifact = orchestrationArtifactSchema.parse({
        schema_version: 'haze.artifact.v2',
        id: randomUUID(),
        version: 1,
        sha256: contractHash(content),
        task_id: task.id,
        assignment_id: assignment.id,
        producer: assignment.role,
        objective_revision: task.objective_revision,
        generation: task.generation,
        kind,
        dependencies,
        created_at: new Date().toISOString(),
        content,
      });
      this.db
        .prepare('INSERT INTO hybrid_artifacts VALUES(?,?,?)')
        .run(artifact.id, task.id, JSON.stringify(artifact));
      task.usage.artifacts++;
      assignment.outputs.push({
        id: artifact.id,
        version: 1,
        sha256: artifact.sha256,
      });
      this.write(task);
      this.append(
        task,
        'artifact_saved',
        assignment.role,
        `Saved immutable ${kind}.`,
        { id: artifact.id, sha256: artifact.sha256, kind },
        assignment.id,
      );
      return artifact;
    });
  }
  artifact(
    id: string,
    identity: TaskIdentity,
    ref?: ArtifactRef,
  ): OrchestrationArtifact {
    const row = this.db
      .prepare('SELECT task_id,body FROM hybrid_artifacts WHERE id=?')
      .get(id) as { task_id: string; body: string } | undefined;
    if (!row)
      throw new TaskError(404, 'artifact_not_found', 'Artifact not found.');
    this.read(row.task_id, identity);
    const artifact = orchestrationArtifactSchema.parse(
      parseContractJson(row.body),
    );
    if (
      contractHash(artifact.content) !== artifact.sha256 ||
      (ref &&
        (ref.sha256 !== artifact.sha256 || ref.version !== artifact.version))
    )
      throw new TaskError(
        409,
        'artifact_integrity',
        'The exact artifact version/hash does not match.',
      );
    return artifact;
  }
  events(id: string, identity: TaskIdentity, after: number) {
    const task = this.read(id, identity);
    const events = (
      this.db
        .prepare(
          'SELECT cursor,body FROM hybrid_events WHERE task_id=? AND cursor>? ORDER BY cursor LIMIT 100',
        )
        .all(id, after) as { cursor: number; body: string }[]
    ).map((row) => ({
      ...(JSON.parse(row.body) as Omit<OrchestrationEvent, 'cursor'>),
      cursor: row.cursor,
    }));
    return {
      events,
      next_cursor: events.at(-1)?.cursor ?? after,
      status: task.status,
    };
  }
  stop(
    task: OrchestrationTask,
    status: 'cancelled' | 'failed' | 'timed_out',
    code: string,
    message: string,
  ) {
    return this.atomic(() => {
      const current = this.read(task.id, task.identity);
      if (terminal(current.status)) return current;
      current.generation++;
      current.status = status;
      current.error = { code, message };
      delete current.result;
      current.updated_at = new Date().toISOString();
      for (const assignment of current.assignments)
        if (['queued', 'running'].includes(assignment.status)) {
          assignment.status = status;
          assignment.error = { code, message };
        }
      this.write(current);
      this.append(current, `task_${status}`, 'Runtime', message);
      return current;
    });
  }
  cancel(id: string, identity: TaskIdentity, key: string) {
    // Cancellation and its operation key commit together; repeats cannot advance the fence again.
    return this.atomic(() => {
      const task = this.read(id, identity);
      const scope = JSON.stringify([
        identity.principal,
        identity.workspace,
        'cancel',
        id,
      ]);
      const prior = this.db
        .prepare(
          'SELECT task_id FROM hybrid_operations WHERE scope=? AND key=?',
        )
        .get(scope, key);
      if (!prior) {
        if (!terminal(task.status)) {
          task.generation++;
          task.status = 'cancelled';
          task.updated_at = new Date().toISOString();
          task.error = {
            code: 'cancelled',
            message:
              'Server cancellation recorded. New work is fenced; remote termination or billing is not verified.',
          };
          for (const assignment of task.assignments)
            if (['queued', 'running'].includes(assignment.status))
              assignment.status = 'cancelled';
          this.write(task);
          this.append(task, 'task_cancelled', 'Runtime', task.error.message);
        }
        this.db
          .prepare('INSERT INTO hybrid_operations VALUES(?,?,?,?)')
          .run(scope, key, contractHash({}), id);
      }
      return { task_id: id, status: task.status, generation: task.generation };
    });
  }
}
