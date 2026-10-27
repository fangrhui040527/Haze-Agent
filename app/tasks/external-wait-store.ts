import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  Artifact,
  ArtifactRef,
  JsonValue,
} from '../contracts/artifacts.js';
import { canonicalJson } from '../contracts/json.js';
import {
  externalAuthoritySchema,
  externalWaitSchema,
  externalDeliverySchema,
  externalWaitViewSchema,
  type ExternalAuthority,
  type ExternalWait,
  type ExternalDelivery,
  type ExternalWaitView,
} from '../contracts/external-waits.js';
import type {
  NightshiftJob,
  NightshiftChain,
} from '../contracts/nightshift-records.js';
import {
  TaskError,
  type TaskIdentity,
  type TaskRecord,
} from '../contracts/tasks.js';
import {
  graphThreadId,
  type GraphAuthority,
  type GraphLedger,
} from './graph-ledger.js';

export interface ExternalWaitAccess {
  atomic<T>(operation: () => T): T;
  read(taskId: string, identity: TaskIdentity): TaskRecord;
  emit(
    authority: GraphAuthority,
    type: string,
    message: string,
    data: JsonValue,
  ): number;
  graph: GraphLedger;
  job(id: string, identity: TaskIdentity): NightshiftJob;
  chain(id: string, identity: TaskIdentity): NightshiftChain;
  artifact(ref: ArtifactRef, identity: TaskIdentity): Artifact;
  delegated?(
    authority: GraphAuthority,
    job: NightshiftJob,
    identity: TaskIdentity,
  ): boolean;
  applicable?(
    taskId: string,
    ref: NightshiftJob['input_refs'][number],
    objective: number,
  ): boolean;
}
export interface ExternalWaitInput extends ExternalAuthority {
  thread_id: string;
  after_cursor: number;
  dependencies: ExternalWait['dependencies'];
}
export interface ExternalReadyEntry extends GraphAuthority {
  thread_id: string;
  cursor: number;
  sequence: number;
}
interface QueueRow extends ExternalReadyEntry {
  admission_mode?: 'continuation';
  chain_id?: string;
  status: 'eligible' | 'suspended' | 'dispatched' | 'removed';
  reason: string | null;
}
type Body = { body: string };
const parse = <T>(row: Body): T => JSON.parse(row.body) as T;
const at = () => new Date().toISOString();
const active = (status: string) =>
  ['queued', 'running', 'waiting'].includes(status);
const fail = (code: string, message: string, status = 409): never => {
  throw new TaskError(status, code, message);
};

/** Application records own capacity and delivery. This class never executes a graph or provider. */
export class ExternalWaitStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly access: ExternalWaitAccess,
  ) {
    access.atomic(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS external_wait_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS external_waits(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,thread_id TEXT NOT NULL,body TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS external_wait_identity ON external_waits(thread_id,json_extract(body,'$.after_cursor'));
        CREATE TABLE IF NOT EXISTS external_result_deliveries(id TEXT PRIMARY KEY,wait_id TEXT NOT NULL,job_id TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(wait_id,job_id));
        CREATE TABLE IF NOT EXISTS external_delivery_targets(job_id TEXT NOT NULL,thread_id TEXT NOT NULL,delivery_id TEXT NOT NULL UNIQUE,PRIMARY KEY(job_id,thread_id));
        CREATE TABLE IF NOT EXISTS external_dependency_resolutions(wait_id TEXT NOT NULL,job_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(wait_id,job_id));
        CREATE TABLE IF NOT EXISTS task_capacity_permits(task_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,generation INTEGER NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS external_ready_queue(sequence INTEGER PRIMARY KEY AUTOINCREMENT,thread_id TEXT NOT NULL UNIQUE,task_id TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS external_ready_eligible ON external_ready_queue(status,sequence);
        CREATE TRIGGER IF NOT EXISTS external_wait_authority_immutable BEFORE UPDATE OF body ON external_waits WHEN json_extract(OLD.body,'$.authority') IS NOT json_extract(NEW.body,'$.authority') OR json_extract(OLD.body,'$.dependencies') IS NOT json_extract(NEW.body,'$.dependencies') OR json_extract(OLD.body,'$.after_cursor') IS NOT json_extract(NEW.body,'$.after_cursor') OR json_extract(OLD.body,'$.thread_id') IS NOT json_extract(NEW.body,'$.thread_id') BEGIN SELECT RAISE(ABORT,'External wait authority is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS external_delivery_identity_immutable BEFORE UPDATE OF body ON external_result_deliveries WHEN json_extract(OLD.body,'$.wait_id') IS NOT json_extract(NEW.body,'$.wait_id') OR json_extract(OLD.body,'$.job_id') IS NOT json_extract(NEW.body,'$.job_id') OR json_extract(OLD.body,'$.artifact') IS NOT json_extract(NEW.body,'$.artifact') OR json_extract(OLD.body,'$.event_cursor') IS NOT json_extract(NEW.body,'$.event_cursor') BEGIN SELECT RAISE(ABORT,'External delivery identity is immutable'); END;
      `);
      const versions = db
        .prepare('SELECT version FROM external_wait_migrations')
        .all() as { version: number }[];
      if (versions.some((row) => ![1, 2].includes(row.version)))
        fail(
          'external_wait_schema_incompatible',
          'Unsupported external wait migration.',
        );
      db.prepare(
        'INSERT OR IGNORE INTO external_wait_migrations VALUES(1,?)',
      ).run(at());
      if (
        db
          .prepare(
            'SELECT d.job_id,w.thread_id FROM external_result_deliveries d JOIN external_waits w ON w.id=d.wait_id GROUP BY d.job_id,w.thread_id HAVING count(*)>1 LIMIT 1',
          )
          .get()
      )
        fail(
          'external_wait_schema_incompatible',
          'Historical external deliveries repeat a terminal result for the same target; preserve state and use explicit linked continuation.',
        );
      db.exec(
        'INSERT OR IGNORE INTO external_delivery_targets SELECT d.job_id,w.thread_id,d.id FROM external_result_deliveries d JOIN external_waits w ON w.id=d.wait_id',
      );
      db.prepare(
        'INSERT OR IGNORE INTO external_wait_migrations VALUES(2,?)',
      ).run(at());
      // Preserve released rows on reopening; a public waiting status is not a permit.
      for (const row of db.prepare('SELECT body FROM tasks').all() as Body[]) {
        const task = parse<{ id: string; current_run_id: string }>(row);
        const runRow = db
          .prepare('SELECT body FROM runs WHERE id=?')
          .get(task.current_run_id) as Body | undefined;
        if (!runRow) continue;
        const run = parse<{ generation: number; status: string }>(runRow);
        if (active(run.status))
          db.prepare(
            'INSERT OR IGNORE INTO task_capacity_permits VALUES(?,?,?,?,?)',
          ).run(
            task.id,
            task.current_run_id,
            run.generation,
            'held',
            'migrated active run',
          );
      }
    });
  }
  private task(taskId: string, identity?: TaskIdentity): TaskRecord {
    if (identity) return this.access.read(taskId, identity);
    const row = this.db
      .prepare('SELECT body FROM tasks WHERE id=?')
      .get(taskId) as Body | undefined;
    if (!row) return fail('task_not_found', 'Task not found.', 404);
    return this.access.read(
      taskId,
      parse<{ identity: TaskIdentity }>(row).identity,
    );
  }
  private fenceReason(
    authority: GraphAuthority,
    checkAssignment = true,
  ): string | null {
    let task: TaskRecord;
    try {
      task = this.task(authority.task_id);
    } catch {
      return 'task unavailable';
    }
    if (task.current_run_id !== authority.run_id)
      return 'another run is current';
    if (task.objective_revision !== authority.objective_revision)
      return 'objective revision changed';
    if (task.generation !== authority.generation)
      return 'execution generation changed';
    if (Date.parse(task.limits.deadline) <= Date.now())
      return 'original run deadline expired; explicit Continue is required';
    if (task.status === 'paused') return 'task paused';
    if (!active(task.status)) return `task ${task.status}`;
    if (checkAssignment && authority.assignment_id) {
      const assignment = task.assignments.find(
        (item) => item.id === authority.assignment_id,
      );
      if (
        !assignment ||
        assignment.run_id !== authority.run_id ||
        assignment.revision !== authority.assignment_revision ||
        assignment.objective_revision !== authority.objective_revision ||
        assignment.generation !== authority.generation
      )
        return 'assignment revision changed';
      if (
        ['cancelled', 'stale', 'timed_out', 'failed'].includes(
          assignment.status,
        )
      )
        return `assignment ${assignment.status}`;
    }
    return null;
  }
  private assertAuthority(authority: GraphAuthority, identity?: TaskIdentity) {
    const task = this.task(authority.task_id, identity);
    const reason = this.fenceReason(authority);
    if (reason) fail('external_wait_fenced', reason);
    return task;
  }
  private dependencyFenceReason(
    wait: ExternalWait,
    task: TaskRecord,
  ): string | null {
    const authorityReason = this.fenceReason(wait.authority);
    if (authorityReason) return authorityReason;
    for (const dep of wait.dependencies) {
      const job = this.access.job(dep.job_id, task.identity),
        chain = this.access.chain(job.chain_id, task.identity);
      if (chain.status === 'paused') return 'external chain paused';
      if (chain.status !== 'active')
        return chain.stop_reason ?? `external chain ${chain.status}`;
      if (Date.parse(chain.expires_at) <= Date.now())
        return 'external chain absolute expiry passed';
    }
    return null;
  }
  private waits(taskId?: string): ExternalWait[] {
    const rows = taskId
      ? this.db
          .prepare(
            'SELECT body FROM external_waits WHERE task_id=? ORDER BY rowid',
          )
          .all(taskId)
      : this.db.prepare('SELECT body FROM external_waits ORDER BY rowid').all();
    return (rows as Body[]).map((row) => externalWaitSchema.parse(parse(row)));
  }
  private pendingWaits(): ExternalWait[] {
    return (
      this.db
        .prepare(
          `SELECT w.body FROM external_waits w WHERE
            (json_extract(w.body,'$.state')<>'consumed' AND
              (json_extract(w.body,'$.state')<>'fenced' OR
                EXISTS(SELECT 1 FROM json_each(w.body,'$.dependencies') dep
                  WHERE NOT EXISTS(SELECT 1 FROM external_result_deliveries d
                    WHERE d.wait_id=w.id AND d.job_id=json_extract(dep.value,'$.job_id')))))
            OR (json_extract(w.body,'$.state')='consumed' AND
              EXISTS(SELECT 1 FROM json_each(w.body,'$.dependencies') dep
                WHERE json_extract(dep.value,'$.required')=0 AND
                  NOT EXISTS(SELECT 1 FROM external_result_deliveries d
                    WHERE d.wait_id=w.id AND d.job_id=json_extract(dep.value,'$.job_id'))))
            ORDER BY w.rowid`,
        )
        .all() as Body[]
    ).map((row) => externalWaitSchema.parse(parse(row)));
  }
  private putWait(wait: ExternalWait) {
    this.db
      .prepare(
        'INSERT INTO external_waits VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(
        wait.id,
        wait.authority.task_id,
        wait.thread_id,
        JSON.stringify(wait),
      );
  }
  private queueRows(): QueueRow[] {
    return (
      this.db
        .prepare('SELECT body FROM external_ready_queue ORDER BY sequence')
        .all() as Body[]
    ).map(parse<QueueRow>);
  }
  private putQueue(row: QueueRow) {
    this.db
      .prepare(
        'UPDATE external_ready_queue SET thread_id=?,status=?,body=? WHERE sequence=?',
      )
      .run(row.thread_id, row.status, JSON.stringify(row), row.sequence);
  }
  private prune() {
    for (const row of this.queueRows()) {
      if (!['eligible', 'suspended'].includes(row.status)) continue;
      if (row.admission_mode === 'continuation') {
        const task = this.task(row.task_id);
        const chain = this.access.chain(row.chain_id!, task.identity);
        const reason =
          task.current_run_id !== row.run_id ||
          task.objective_revision !== row.objective_revision
            ? 'continuation authority changed'
            : task.generation !== row.generation
              ? 'continuation generation changed'
              : chain.status !== 'active' ||
                  Date.parse(chain.expires_at) <= Date.now()
                ? `chain ${chain.status}`
                : task.status === 'paused' || task.status === 'cancelled'
                  ? `task ${task.status}`
                  : null;
        if (reason) {
          row.status =
            reason === 'task paused' || reason === 'chain paused'
              ? 'suspended'
              : 'removed';
          row.reason = reason;
          this.putQueue(row);
        }
        continue;
      }
      const target = this.waits(row.task_id).find(
        (wait) => wait.thread_id === row.thread_id && wait.state !== 'consumed',
      );
      const reason = target
        ? this.dependencyFenceReason(target, this.task(row.task_id))
        : this.fenceReason(row, false);
      if (reason) {
        row.status =
          reason === 'task paused' || reason === 'external chain paused'
            ? 'suspended'
            : 'removed';
        row.reason = reason;
        this.putQueue(row);
      }
    }
    for (const row of this.db
      .prepare(
        "SELECT task_id,run_id,generation FROM task_capacity_permits WHERE status='held'",
      )
      .all() as { task_id: string; run_id: string; generation: number }[]) {
      const task = this.task(row.task_id);
      if (
        task.current_run_id !== row.run_id ||
        task.generation !== row.generation ||
        !active(task.status) ||
        Date.parse(task.limits.deadline) <= Date.now()
      )
        this.db
          .prepare(
            "UPDATE task_capacity_permits SET status='released',reason=? WHERE task_id=?",
          )
          .run('execution authority stopped', row.task_id);
    }
  }
  private hasPermit(authority: GraphAuthority) {
    return !!this.db
      .prepare(
        "SELECT task_id FROM task_capacity_permits WHERE task_id=? AND run_id=? AND generation=? AND status='held'",
      )
      .get(authority.task_id, authority.run_id, authority.generation);
  }
  private capacity() {
    return (
      this.db
        .prepare(
          "SELECT count(*) AS n FROM task_capacity_permits WHERE status='held'",
        )
        .get() as { n: number }
    ).n;
  }
  assertCanAdmit() {
    return this.access.atomic(() => {
      this.reconcileDeliveries();
      this.prune();
      if (
        this.capacity() >= 2 ||
        this.queueRows().some((row) => row.status === 'eligible')
      )
        fail(
          'active_task_limit',
          'Two active tasks or earlier eligible external work already hold admission priority.',
          429,
        );
    });
  }
  acquire(
    authority: GraphAuthority,
    reason = 'execution',
    queue = false,
  ): boolean {
    return this.access.atomic(() => {
      if (!queue) this.reconcileDeliveries();
      this.assertAuthority({
        task_id: authority.task_id,
        run_id: authority.run_id,
        generation: authority.generation,
        objective_revision: authority.objective_revision,
      });
      this.prune();
      if (this.hasPermit(authority)) return true;
      const eligible = this.queueRows().filter(
        (row) => row.status === 'eligible',
      );
      const first = eligible[0];
      if (
        this.capacity() >= 2 ||
        (first && first.task_id !== authority.task_id)
      ) {
        if (!queue)
          return fail(
            'active_task_limit',
            'Two active tasks or earlier eligible external work already hold admission priority.',
            429,
          );
        this.enqueue(authority);
        return false;
      }
      this.db
        .prepare(
          'INSERT INTO task_capacity_permits VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET run_id=excluded.run_id,generation=excluded.generation,status=excluded.status,reason=excluded.reason',
        )
        .run(
          authority.task_id,
          authority.run_id,
          authority.generation,
          'held',
          reason,
        );
      for (const row of eligible)
        if (row.task_id === authority.task_id) {
          row.status = 'dispatched';
          row.reason = null;
          this.putQueue(row);
        }
      return true;
    });
  }
  assertPermit(authority: GraphAuthority) {
    if (!this.hasPermit(authority))
      fail(
        'task_capacity_required',
        'Execution requires a current durable task permit.',
      );
  }
  /** Shared FIFO reservation for a server-validated, quiescent predecessor. */
  continuationCapacity(
    authority: GraphAuthority,
    chainId: string,
    cursor: number,
  ): { available: boolean; sequence: number } {
    return this.access.atomic(() => {
      this.reconcileDeliveries();
      this.prune();
      const task = this.task(authority.task_id);
      if (
        task.current_run_id !== authority.run_id ||
        task.generation !== authority.generation ||
        task.objective_revision !== authority.objective_revision
      )
        fail('stale_execution', 'Continuation predecessor changed.');
      const thread = `haze.continuation.v1:${chainId}:${authority.run_id}:g${authority.generation}:${authority.objective_revision}`;
      let row = this.queueRows().find((entry) => entry.thread_id === thread);
      if (!row || !['eligible', 'suspended'].includes(row.status)) {
        row = {
          ...this.enqueue(authority, thread, cursor),
          admission_mode: 'continuation',
          chain_id: chainId,
        };
        this.putQueue(row);
      }
      if (row.status === 'suspended') {
        const chain = this.access.chain(chainId, task.identity);
        if (
          chain.status === 'active' &&
          !['paused', 'cancelled'].includes(task.status) &&
          Date.parse(chain.expires_at) > Date.now()
        ) {
          row.status = 'eligible';
          row.reason = 'Validated release and authority restored.';
          this.putQueue(row);
        }
      }
      const first = this.queueRows().find(
        (entry) => entry.status === 'eligible',
      );
      return {
        available:
          row.status === 'eligible' &&
          this.capacity() < 2 &&
          first?.sequence === row.sequence,
        sequence: row.sequence,
      };
    });
  }
  claimContinuation(sequence: number) {
    const row = this.queueRows().find((entry) => entry.sequence === sequence);
    const first = this.queueRows().find((entry) => entry.status === 'eligible');
    if (
      !row ||
      row.admission_mode !== 'continuation' ||
      row.status !== 'eligible' ||
      first?.sequence !== sequence ||
      this.capacity() >= 2
    )
      return fail(
        'continuation_capacity_changed',
        'Continuation capacity ticket is no longer first and available.',
      );
    row.status = 'dispatched';
    row.reason = 'Continuation reservation pending commit';
    this.putQueue(row);
  }
  finishContinuation(
    sequence: number,
    runId: string,
    authority: GraphAuthority,
  ) {
    const row = this.queueRows().find((entry) => entry.sequence === sequence);
    if (
      !row ||
      row.admission_mode !== 'continuation' ||
      row.status !== 'dispatched' ||
      row.reason !== 'Continuation reservation pending commit' ||
      row.task_id !== authority.task_id ||
      this.capacity() >= 2
    )
      return fail(
        'continuation_capacity_changed',
        'Continuation reservation is no longer available.',
      );
    this.assertAuthority(authority);
    this.db
      .prepare(
        'INSERT INTO task_capacity_permits VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET run_id=excluded.run_id,generation=excluded.generation,status=excluded.status,reason=excluded.reason',
      )
      .run(
        authority.task_id,
        runId,
        authority.generation,
        'held',
        'FIFO automatic continuation',
      );
    row.status = 'dispatched';
    row.reason = `Successor ${runId} admitted.`;
    this.putQueue(row);
  }
  suspendContinuation(taskId: string, reason: string) {
    return this.access.atomic(() => {
      for (const row of this.queueRows())
        if (
          row.task_id === taskId &&
          row.admission_mode === 'continuation' &&
          row.status === 'eligible'
        ) {
          row.status = 'suspended';
          row.reason = reason;
          this.putQueue(row);
        }
    });
  }
  retainPermit(authority: GraphAuthority) {
    // A fence may transfer an already held local permit, never manufacture one.
    return this.access.atomic(() =>
      this.db
        .prepare(
          "UPDATE task_capacity_permits SET generation=? WHERE task_id=? AND run_id=? AND status='held'",
        )
        .run(authority.generation, authority.task_id, authority.run_id),
    );
  }
  release(authority: GraphAuthority, reason: string) {
    return this.access.atomic(() =>
      this.db
        .prepare(
          "UPDATE task_capacity_permits SET status='released',reason=? WHERE task_id=? AND run_id=?",
        )
        .run(reason, authority.task_id, authority.run_id),
    );
  }
  private enqueue(authority: GraphAuthority, threadId?: string, cursor = 0) {
    const target =
      threadId ??
      graphThreadId(
        authority.assignment_id ? 'assignment' : 'manager',
        authority,
      );
    const existing = this.db
      .prepare('SELECT body FROM external_ready_queue WHERE thread_id=?')
      .get(target) as Body | undefined;
    if (existing) {
      const row = parse<QueueRow>(existing);
      if (row.status === 'eligible') {
        row.cursor = Math.max(row.cursor, cursor);
        this.putQueue(row);
        return row;
      }
      // A completed queue entry cannot reserve priority for a later wake.
      this.db
        .prepare('DELETE FROM external_ready_queue WHERE thread_id=?')
        .run(target);
    }
    if (
      this.queueRows().filter(
        (row) => row.status === 'eligible' || row.status === 'suspended',
      ).length >= 256
    )
      fail(
        'external_ready_queue_full',
        'The bounded external ready queue is full.',
        429,
      );
    const inserted = this.db
      .prepare(
        'INSERT INTO external_ready_queue(thread_id,task_id,status,body) VALUES(?,?,?,?)',
      )
      .run(target, authority.task_id, 'eligible', '{}');
    const row: QueueRow = {
      ...authority,
      thread_id: target,
      cursor,
      sequence: Number(inserted.lastInsertRowid),
      status: 'eligible',
      reason: null,
    };
    this.putQueue(row);
    return row;
  }
  wait(input: ExternalWaitInput, identity: TaskIdentity): ExternalWait {
    return this.access.atomic(() => {
      const authority = externalAuthoritySchema.parse({
        task_id: input.task_id,
        run_id: input.run_id,
        generation: input.generation,
        objective_revision: input.objective_revision,
        assignment_id: input.assignment_id,
        assignment_revision: input.assignment_revision,
      });
      const task = this.assertAuthority(authority, identity);
      if (input.thread_id !== graphThreadId('assignment', authority))
        fail(
          'external_wait_thread_invalid',
          'Wait thread does not match its exact assignment authority.',
        );
      const assignment = task.assignments.find(
        (item) => item.id === authority.assignment_id,
      )!;
      if (
        !task.permissions.tools.includes('nightshift.result') ||
        !assignment.tools.includes('nightshift.result')
      )
        fail(
          'permission_denied',
          'External result consumption needs an explicit task and assignment grant.',
          403,
        );
      for (const dep of input.dependencies) {
        const job = this.access.job(dep.job_id, identity);
        const chain = this.access.chain(job.chain_id, identity);
        if (
          !this.access.delegated?.(authority, job, identity) &&
          (job.task_id !== task.id ||
            job.authority.run_id !== authority.run_id ||
            job.authority.generation !== authority.generation ||
            job.authority.objective_revision !== authority.objective_revision ||
            job.authority.assignment_id !== authority.assignment_id ||
            job.authority.assignment_revision !== authority.assignment_revision)
        )
          fail(
            'external_job_authority_mismatch',
            'External dependency belongs to a different task or assignment revision.',
          );
        if (
          !job.remote_id ||
          [
            'submitting',
            'submission_unknown',
            'unresolved',
            'rejected',
          ].includes(job.execution_state)
        )
          fail(
            'external_job_unacknowledged',
            'Only acknowledged external jobs can verify an external wait.',
          );
        if (
          chain.status !== 'active' ||
          Date.parse(chain.expires_at) <= Date.now()
        )
          fail(
            'nightshift_chain_stopped',
            'External wait requires the same active unexpired chain grant.',
          );
      }
      const existing = this.waits(task.id).find(
        (wait) =>
          wait.thread_id === input.thread_id &&
          wait.after_cursor === input.after_cursor,
      );
      if (existing) {
        if (
          canonicalJson(existing.dependencies) !==
            canonicalJson(input.dependencies) ||
          existing.after_cursor !== input.after_cursor
        )
          fail(
            'external_wait_conflict',
            'Persisted wait dependencies or cursor cannot be replaced.',
          );
        return existing;
      }
      if (
        this.waits(task.id).some(
          (wait) =>
            wait.thread_id === input.thread_id &&
            wait.dependencies.some((dep) =>
              input.dependencies.some((next) => next.job_id === dep.job_id),
            ),
        )
      )
        fail(
          'external_wait_repeated_target',
          'That exact assignment thread already has a wait for this job; consume its stored delivery instead.',
        );
      if (
        assignment.status !== 'running' ||
        !assignment.lease_token ||
        assignment.acknowledged_revision !== assignment.revision
      )
        fail(
          'specialist_lease_required',
          'Committing an external wait requires a current specialist execution lease.',
        );
      const wait = externalWaitSchema.parse({
        id: randomUUID(),
        thread_id: input.thread_id,
        authority,
        after_cursor: input.after_cursor,
        dependencies: input.dependencies,
        state: 'waiting',
        reason: null,
        created_at: at(),
      });
      this.putWait(wait);
      this.reconcileDeliveries();
      return this.waits(task.id).find((item) => item.id === wait.id)!;
    });
  }
  private terminal(job: NightshiftJob) {
    return (
      (job.execution_state === 'completed' && job.receipt !== null) ||
      job.execution_state === 'failed' ||
      job.execution_state === 'rejected' ||
      (job.execution_state === 'cancelled' &&
        job.cancellation.remote_termination_confirmed)
    );
  }
  private assertInputs(job: NightshiftJob, task: TaskRecord) {
    for (const ref of job.input_refs) {
      const artifact = this.access.artifact(ref, task.identity);
      if (
        artifact.required_tools.some(
          (tool) => !task.permissions.tools.includes(tool),
        )
      )
        fail(
          'permission_denied',
          'Original external inputs exceed current tool grants.',
          403,
        );
      if (
        this.access.applicable &&
        !this.access.applicable(task.id, ref, task.objective_revision)
      )
        fail(
          'external_input_inapplicable',
          'An exact original input no longer applies to the current objective.',
        );
    }
  }
  private assertCandidate(job: NightshiftJob, identity: TaskIdentity) {
    if (!job.receipt)
      return fail('external_result_missing', 'No retained candidate exists.');
    const artifact = this.access.artifact(job.receipt.artifact, identity);
    const content = artifact.content;
    if (
      artifact.kind !== 'nightshift.candidate' ||
      typeof content !== 'object' ||
      content === null ||
      Array.isArray(content) ||
      content['job_id'] !== job.id ||
      content['text'] !== job.receipt.output ||
      canonicalJson(content['authority']) !== canonicalJson(job.authority) ||
      canonicalJson(content['input_refs']) !== canonicalJson(job.input_refs)
    )
      fail(
        'external_result_integrity',
        'Retained candidate does not match its original receipt and inputs.',
      );
  }
  private deliveryRows(waitId: string): ExternalDelivery[] {
    return (
      this.db
        .prepare(
          'SELECT body FROM external_result_deliveries WHERE wait_id=? ORDER BY rowid',
        )
        .all(waitId) as Body[]
    ).map((row) => externalDeliverySchema.parse(parse(row)));
  }
  reconcileDeliveries(): number {
    return this.access.atomic(() => {
      let inserted = 0;
      for (const wait of this.pendingWaits()) {
        const consumed = wait.state === 'consumed';
        const task = this.task(wait.authority.task_id);
        let reason =
          wait.state === 'fenced'
            ? (wait.reason ?? this.fenceReason(wait.authority))
            : this.dependencyFenceReason(wait, task);
        const deliveries = this.deliveryRows(wait.id);
        for (const dep of wait.dependencies) {
          if (deliveries.some((item) => item.job_id === dep.job_id)) continue;
          const job = this.access.job(dep.job_id, task.identity);
          if (!this.terminal(job)) continue;
          const chain = this.access.chain(job.chain_id, task.identity);
          if (
            !reason &&
            (chain.status !== 'active' ||
              Date.parse(chain.expires_at) <= Date.now())
          )
            reason = chain.stop_reason ?? 'chain grant stopped';
          const id = randomUUID();
          if (
            this.db
              .prepare(
                'SELECT delivery_id FROM external_delivery_targets WHERE job_id=? AND thread_id=?',
              )
              .get(job.id, wait.thread_id)
          )
            fail(
              'external_wait_repeated_target',
              'A terminal delivery already exists for this exact job and target thread.',
            );
          this.db
            .prepare('INSERT INTO external_delivery_targets VALUES(?,?,?)')
            .run(job.id, wait.thread_id, id);
          const eventCursor = this.access.emit(
            wait.authority,
            'external_result',
            'A terminal external result was retained for its exact assignment target.',
            {
              delivery_id: id,
              wait_id: wait.id,
              job_id: job.id,
              recipient: wait.authority.assignment_id,
              recipient_revision: wait.authority.assignment_revision,
              target_generation: wait.authority.generation,
              thread_id: wait.thread_id,
              retained_only: reason !== null || consumed,
            },
          );
          const delivery: ExternalDelivery = {
            id,
            wait_id: wait.id,
            job_id: job.id,
            execution_state: job.execution_state,
            artifact: job.receipt?.artifact ?? null,
            event_cursor: eventCursor,
            state: reason ? 'fenced' : 'retained',
            reason,
          };
          this.db
            .prepare('INSERT INTO external_result_deliveries VALUES(?,?,?,?)')
            .run(id, wait.id, job.id, JSON.stringify(delivery));
          deliveries.push(delivery);
          inserted++;
        }
        // Optional dependencies never reopen completed required work. Their
        // late delivery remains auditable and explicitly readable under a live
        // assignment, but creates no new readiness event or execution wake.
        if (consumed) continue;
        if (reason) {
          wait.reason = reason;
          if (reason === 'external chain paused') wait.state = 'waiting';
          else if (reason !== 'task paused') wait.state = 'fenced';
          this.putWait(wait);
          continue;
        }
        if (wait.state === 'fenced') continue;
        if (wait.reason !== null) {
          wait.reason = null;
          this.putWait(wait);
        }
        const required = wait.dependencies.filter((dep) => dep.required);
        const ready = required.length
          ? required.every((dep) =>
              deliveries.some((item) => item.job_id === dep.job_id),
            )
          : deliveries.length > 0;
        if (ready && wait.state !== 'ready') {
          wait.state = 'ready';
          wait.reason = null;
          this.putWait(wait);
          const cursor = this.access.emit(
            wait.authority,
            'external_result_ready',
            'The exact required external dependencies are retained and eligible for controlled execution.',
            {
              wait_id: wait.id,
              recipient: wait.authority.assignment_id,
              recipient_revision: wait.authority.assignment_revision,
              target_generation: wait.authority.generation,
              thread_id: wait.thread_id,
              retained_only: false,
            },
          );
          this.enqueue(wait.authority, wait.thread_id, cursor);
        }
      }
      return inserted;
    });
  }
  drainReady(): ExternalReadyEntry[] {
    return this.access.atomic(() => {
      this.reconcileDeliveries();
      this.prune();
      const ready: ExternalReadyEntry[] = [];
      for (const row of this.queueRows()) {
        if (row.status !== 'eligible') continue;
        if (row.admission_mode === 'continuation') break;
        if (!this.acquire(row, 'external result delivery', true)) break;
        row.status = 'dispatched';
        row.reason = null;
        this.putQueue(row);
        ready.push(row);
      }
      return ready;
    });
  }
  tryReleaseExternalOnly(authority: GraphAuthority): boolean {
    return this.access.atomic(() => {
      const task = this.assertAuthority(authority);
      const manager = task.assignments.find(
        (item) =>
          item.run_id === authority.run_id &&
          item.definition_id === 'core.manager.coordinator',
      );
      if (!manager || manager.status !== 'waiting') return false;
      const managerWait = this.access.graph.wait(
        graphThreadId('manager', authority),
      );
      if (!managerWait || managerWait.status !== 'parked') return false;
      if (
        task.questions.some(
          (item) => item.run_id === authority.run_id && item.status === 'open',
        )
      )
        return false;
      const assignments = task.assignments.filter(
        (item) =>
          item.run_id === authority.run_id &&
          item.id !== manager.id &&
          !['completed', 'failed', 'cancelled', 'timed_out', 'stale'].includes(
            item.status,
          ),
      );
      if (!assignments.length) return false;
      const waits = this.waits(task.id);
      const blockedOnlyExternal = (
        assignment: TaskRecord['assignments'][number],
        visiting = new Set<string>(),
      ): boolean => {
        if (assignment.lease_token || visiting.has(assignment.id)) return false;
        if (assignment.status === 'queued') {
          if (!assignment.dependencies.length) return false;
          const dependencies = assignment.dependencies.map((id) =>
            task.assignments.find(
              (item) =>
                item.id === id &&
                item.run_id === authority.run_id &&
                item.objective_revision === authority.objective_revision,
            ),
          );
          if (dependencies.some((item) => !item)) return false;
          const pending = dependencies.filter(
            (item) =>
              item!.status !== 'completed' ||
              ['rejected', 'stale'].includes(item!.usability),
          );
          if (!pending.length) return false;
          const next = new Set(visiting).add(assignment.id);
          return pending.every(
            (item) => !!item && blockedOnlyExternal(item, next),
          );
        }
        if (assignment.status !== 'waiting') return false;
        const wait = waits.find(
          (item) =>
            item.authority.run_id === authority.run_id &&
            item.authority.generation === authority.generation &&
            item.authority.assignment_id === assignment.id &&
            item.authority.assignment_revision === assignment.revision &&
            item.state === 'waiting',
        );
        if (!wait) return false;
        const graphWait = this.access.graph.wait(wait.thread_id);
        if (
          !graphWait ||
          graphWait.status !== 'parked' ||
          !graphWait.event_types?.length ||
          graphWait.event_types.some(
            (type) =>
              !['external_result', 'external_result_ready'].includes(type),
          )
        )
          return false;
        for (const dep of wait.dependencies) {
          const job = this.access.job(dep.job_id, task.identity);
          const chain = this.access.chain(job.chain_id, task.identity);
          if (
            !job.remote_id ||
            ['submitting', 'submission_unknown', 'unresolved'].includes(
              job.execution_state,
            ) ||
            chain.status !== 'active' ||
            Date.parse(chain.expires_at) <= Date.now()
          )
            return false;
          try {
            this.assertInputs(job, task);
          } catch {
            return false;
          }
        }
        return true;
      };
      if (!assignments.every((assignment) => blockedOnlyExternal(assignment)))
        return false;
      const operation = (
        this.db
          .prepare('SELECT body FROM graph_operations WHERE run_id=?')
          .all(authority.run_id) as Body[]
      )
        .map(parse<{ status: string }>)
        .some((item) => ['dispatched', 'unknown'].includes(item.status));
      const attempts = (
        this.db
          .prepare('SELECT body FROM attempts WHERE task_id=?')
          .all(task.id) as Body[]
      )
        .map(parse<{ run_id: string; status: string }>)
        .some(
          (item) =>
            item.run_id === authority.run_id &&
            ['started', 'unknown'].includes(item.status),
        );
      const executing = (
        this.db
          .prepare(
            "SELECT body FROM graph_jobs WHERE task_id=? AND status='running'",
          )
          .all(task.id) as Body[]
      )
        .map(parse<{ run_id: string; generation: number }>)
        .some(
          (item) =>
            item.run_id === authority.run_id &&
            item.generation === authority.generation,
        );
      if (operation || attempts || executing) return false;
      this.release(authority, 'verified external-only wait');
      return true;
    });
  }
  resolve(
    jobId: string,
    authority: ExternalAuthority,
    identity: TaskIdentity,
    input: {
      decision:
        'use_candidate' | 'partial_result' | 'replan' | 'supported_failure';
      reason?: string;
    },
  ): ExternalDelivery {
    return this.access.atomic(() => {
      const task = this.assertAuthority(authority, identity);
      this.assertPermit(authority);
      const assignment = task.assignments.find(
        (item) => item.id === authority.assignment_id,
      )!;
      if (
        !task.permissions.tools.includes('nightshift.result') ||
        !assignment.tools.includes('nightshift.result')
      )
        fail(
          'permission_denied',
          'External result use requires current task and assignment grants.',
          403,
        );
      const wait = this.waits(task.id).find(
        (item) =>
          canonicalJson(item.authority) === canonicalJson(authority) &&
          item.dependencies.some((dep) => dep.job_id === jobId),
      );
      if (!wait)
        return fail(
          'external_dependency_missing',
          'No current dependency grants access to that external result.',
        );
      const job = this.access.job(jobId, identity),
        chain = this.access.chain(job.chain_id, identity);
      if (
        input.decision === 'use_candidate' &&
        (wait.state === 'fenced' ||
          chain.status !== 'active' ||
          Date.parse(chain.expires_at) <= Date.now())
      )
        fail(
          'nightshift_chain_stopped',
          'The original chain grant no longer authorizes local consumption.',
        );
      if (!this.terminal(job))
        fail(
          'external_result_pending',
          'A pending or unknown job cannot satisfy a dependency.',
        );
      if (
        input.decision === 'use_candidate' &&
        (job.execution_state !== 'completed' || !job.receipt)
      )
        fail(
          'external_result_missing',
          'No complete retained candidate exists.',
        );
      if (
        input.decision === 'use_candidate' &&
        this.db
          .prepare('SELECT job_id FROM ns_policy_violations WHERE job_id=?')
          .get(job.id)
      )
        fail(
          'nightshift_policy_violation',
          'The retained result does not satisfy its original admitted execution policy.',
        );
      if (
        input.decision !== 'use_candidate' &&
        (!input.reason || input.reason.length > 4096)
      )
        fail(
          'external_resolution_reason_required',
          'A bounded reason is required for failure, partial result or replanning.',
        );
      if (input.decision === 'use_candidate') {
        this.assertInputs(job, task);
        this.assertCandidate(job, identity);
      }
      if (
        assignment.status !== 'running' ||
        !assignment.lease_token ||
        assignment.acknowledged_revision !== assignment.revision
      )
        fail(
          'specialist_lease_required',
          'Controlled result consumption requires a current specialist execution lease.',
        );
      this.reconcileDeliveries();
      const delivery = this.deliveryRows(wait.id).find(
        (item) => item.job_id === jobId,
      )!;
      if (!delivery)
        return fail(
          'external_result_missing',
          'Terminal receipt delivery has not been committed.',
        );
      const existing = this.db
        .prepare(
          'SELECT body FROM external_dependency_resolutions WHERE wait_id=? AND job_id=?',
        )
        .get(wait.id, jobId) as Body | undefined;
      if (existing && canonicalJson(parse(existing)) !== canonicalJson(input))
        fail(
          'external_resolution_conflict',
          'The accepted external dependency decision cannot be changed.',
        );
      this.db
        .prepare(
          'INSERT OR IGNORE INTO external_dependency_resolutions VALUES(?,?,?)',
        )
        .run(wait.id, jobId, JSON.stringify(input));
      delivery.state = 'consumed';
      delivery.reason = input.decision;
      this.db
        .prepare('UPDATE external_result_deliveries SET body=? WHERE id=?')
        .run(JSON.stringify(delivery), delivery.id);
      if (
        wait.dependencies
          .filter((dep) => dep.required)
          .every(
            (dep) =>
              !!this.db
                .prepare(
                  'SELECT 1 FROM external_dependency_resolutions WHERE wait_id=? AND job_id=?',
                )
                .get(wait.id, dep.job_id),
          )
      ) {
        wait.state = 'consumed';
        this.putWait(wait);
      }
      return delivery;
    });
  }
  assertFinalizable(authority: GraphAuthority) {
    const task = this.task(authority.task_id);
    for (const wait of this.waits(authority.task_id))
      if (
        wait.authority.run_id === authority.run_id &&
        wait.authority.generation === authority.generation &&
        wait.authority.objective_revision === authority.objective_revision &&
        (!authority.assignment_id ||
          (wait.authority.assignment_id === authority.assignment_id &&
            wait.authority.assignment_revision ===
              authority.assignment_revision)) &&
        task.assignments.some(
          (item) =>
            item.id === wait.authority.assignment_id &&
            item.revision === wait.authority.assignment_revision,
        )
      )
        for (const dep of wait.dependencies)
          if (
            dep.required &&
            !this.db
              .prepare(
                'SELECT 1 FROM external_dependency_resolutions WHERE wait_id=? AND job_id=?',
              )
              .get(wait.id, dep.job_id)
          )
            fail(
              'external_dependency_pending',
              'Required external work needs an explicit result, supported failure, partial result or replanning decision.',
            );
  }
  replanAssignments(taskId: string, assignmentIds: string[], reason: string) {
    return this.access.atomic(() => {
      const task = this.task(taskId);
      for (const wait of this.waits(taskId)) {
        if (
          wait.authority.run_id !== task.current_run_id ||
          wait.authority.generation !== task.generation ||
          wait.authority.objective_revision !== task.objective_revision ||
          !assignmentIds.includes(wait.authority.assignment_id) ||
          !task.assignments.some(
            (item) =>
              item.id === wait.authority.assignment_id &&
              item.revision === wait.authority.assignment_revision,
          )
        )
          continue;
        for (const dep of wait.dependencies)
          this.db
            .prepare(
              'INSERT OR IGNORE INTO external_dependency_resolutions VALUES(?,?,?)',
            )
            .run(
              wait.id,
              dep.job_id,
              JSON.stringify({
                decision: 'replan',
                reason: reason.slice(0, 4096),
                actor: 'Manager',
              }),
            );
        wait.state = 'fenced';
        wait.reason = reason.slice(0, 512);
        this.putWait(wait);
        for (const delivery of this.deliveryRows(wait.id)) {
          if (delivery.state === 'consumed') continue;
          delivery.state = 'fenced';
          delivery.reason = reason.slice(0, 512);
          this.db
            .prepare('UPDATE external_result_deliveries SET body=? WHERE id=?')
            .run(JSON.stringify(delivery), delivery.id);
        }
        for (const row of this.queueRows())
          if (
            row.thread_id === wait.thread_id &&
            ['eligible', 'suspended'].includes(row.status)
          ) {
            row.status = 'removed';
            row.reason = reason.slice(0, 512);
            this.putQueue(row);
          }
      }
    });
  }
  onChainControl(
    chainId: string,
    action: 'pause' | 'resume' | 'cancel' | 'close',
  ) {
    return this.access.atomic(() => {
      for (const wait of this.waits()) {
        const task = this.task(wait.authority.task_id);
        if (
          !wait.dependencies.some(
            (dep) =>
              this.access.job(dep.job_id, task.identity).chain_id === chainId,
          )
        )
          continue;
        if (action === 'resume') {
          if (
            wait.reason !== 'external chain paused' ||
            this.dependencyFenceReason(wait, task)
          )
            continue;
          wait.reason = null;
          const deliveries = this.deliveryRows(wait.id);
          for (const delivery of deliveries)
            if (delivery.reason === 'external chain paused') {
              const resolved = this.db
                .prepare(
                  'SELECT body FROM external_dependency_resolutions WHERE wait_id=? AND job_id=?',
                )
                .get(wait.id, delivery.job_id) as Body | undefined;
              delivery.state = resolved ? 'consumed' : 'retained';
              delivery.reason = resolved
                ? parse<{ decision: string }>(resolved).decision
                : null;
              this.db
                .prepare(
                  'UPDATE external_result_deliveries SET body=? WHERE id=?',
                )
                .run(JSON.stringify(delivery), delivery.id);
            }
          const required = wait.dependencies.filter((dep) => dep.required);
          const ready = required.length
            ? required.every((dep) =>
                deliveries.some((delivery) => delivery.job_id === dep.job_id),
              )
            : deliveries.length > 0;
          if (wait.state !== 'consumed' && ready) {
            wait.state = 'ready';
            const cursor = this.access.emit(
              wait.authority,
              'external_result_ready',
              'Explicit chain Resume made retained results eligible for the same assignment target.',
              {
                wait_id: wait.id,
                recipient: wait.authority.assignment_id,
                recipient_revision: wait.authority.assignment_revision,
                target_generation: wait.authority.generation,
                thread_id: wait.thread_id,
                retained_only: false,
              },
            );
            this.enqueue(wait.authority, wait.thread_id, cursor);
          }
          this.putWait(wait);
        } else {
          const reason =
            action === 'pause'
              ? 'external chain paused'
              : `external chain ${action}`;
          if (wait.state !== 'consumed')
            wait.state = action === 'pause' ? 'waiting' : 'fenced';
          wait.reason = reason;
          this.putWait(wait);
          for (const delivery of this.deliveryRows(wait.id)) {
            if (delivery.state === 'consumed') continue;
            delivery.state = 'fenced';
            delivery.reason = reason;
            this.db
              .prepare(
                'UPDATE external_result_deliveries SET body=? WHERE id=?',
              )
              .run(JSON.stringify(delivery), delivery.id);
          }
          for (const row of this.queueRows())
            if (
              row.thread_id === wait.thread_id &&
              ['eligible', 'suspended'].includes(row.status)
            ) {
              row.status = action === 'pause' ? 'suspended' : 'removed';
              row.reason = reason;
              this.putQueue(row);
            }
        }
      }
      this.prune();
      this.reconcileDeliveries();
    });
  }
  onAuthorityChange(taskId: string, reason: string, releasePermit = true) {
    return this.access.atomic(() => {
      for (const wait of this.waits(taskId)) {
        if (wait.state !== 'consumed') {
          wait.reason = reason;
          wait.state = 'fenced';
          this.putWait(wait);
        }
        for (const delivery of this.deliveryRows(wait.id)) {
          if (delivery.state === 'consumed') continue;
          delivery.state = 'fenced';
          delivery.reason = reason;
          this.db
            .prepare('UPDATE external_result_deliveries SET body=? WHERE id=?')
            .run(JSON.stringify(delivery), delivery.id);
        }
      }
      for (const row of this.queueRows())
        if (
          row.task_id === taskId &&
          ['eligible', 'suspended'].includes(row.status)
        ) {
          row.status = reason.includes('pause') ? 'suspended' : 'removed';
          row.reason = reason;
          this.putQueue(row);
        }
      if (releasePermit)
        this.db
          .prepare(
            "UPDATE task_capacity_permits SET status='released',reason=? WHERE task_id=?",
          )
          .run(reason, taskId);
    });
  }
  rebind(authority: GraphAuthority, reason: string, preservePriority = false) {
    return this.access.atomic(() => {
      const task = this.assertAuthority(authority);
      for (const row of this.queueRows())
        if (
          row.admission_mode === 'continuation' &&
          row.task_id === task.id &&
          row.run_id === authority.run_id &&
          row.objective_revision === authority.objective_revision &&
          row.generation !== authority.generation &&
          row.status === 'eligible' &&
          preservePriority &&
          reason === 'recovery'
        ) {
          row.generation = authority.generation;
          row.thread_id = `haze.continuation.v1:${row.chain_id!}:${row.run_id}:g${authority.generation}:${row.objective_revision}`;
          row.reason = 'Recovered eligibility retains first ready sequence';
          this.putQueue(row);
        }
      const seen = new Set<string>();
      for (const old of this.waits(task.id).sort(
        (a, b) =>
          b.authority.generation - a.authority.generation ||
          b.after_cursor - a.after_cursor,
      )) {
        if (
          old.authority.run_id !== authority.run_id ||
          old.authority.objective_revision !== authority.objective_revision
        )
          continue;
        const targetKey = `${old.authority.assignment_id}:${old.authority.assignment_revision}`;
        if (seen.has(targetKey)) continue;
        seen.add(targetKey);
        if (
          old.authority.run_id !== authority.run_id ||
          old.authority.objective_revision !== authority.objective_revision ||
          old.authority.generation === authority.generation ||
          old.state === 'consumed' ||
          (old.state === 'fenced' &&
            !['pause', 'paused', 'recovery'].includes(old.reason ?? ''))
        )
          continue;
        const assignment = task.assignments.find(
          (item) =>
            item.id === old.authority.assignment_id &&
            item.revision === old.authority.assignment_revision &&
            item.run_id === authority.run_id &&
            item.objective_revision === authority.objective_revision,
        );
        if (!assignment) continue;
        const target: ExternalAuthority = {
          ...old.authority,
          generation: authority.generation,
        };
        const thread = graphThreadId('assignment', target);
        if (
          this.waits(task.id).some(
            (item) =>
              item.thread_id === thread &&
              item.after_cursor === old.after_cursor,
          )
        )
          continue;
        old.state = 'fenced';
        old.reason = reason;
        this.putWait(old);
        this.putWait({
          ...old,
          id: randomUUID(),
          authority: target,
          thread_id: thread,
          state: 'waiting',
          reason: null,
          created_at: at(),
        });
        if (preservePriority && reason === 'recovery') {
          const prior = this.queueRows().find(
            (row) =>
              row.thread_id === old.thread_id &&
              row.run_id === authority.run_id &&
              row.objective_revision === authority.objective_revision &&
              row.assignment_id === old.authority.assignment_id &&
              row.assignment_revision === old.authority.assignment_revision &&
              (row.status === 'eligible' ||
                row.status === 'dispatched' ||
                (row.status === 'removed' && row.reason === 'recovery')),
          );
          if (
            prior &&
            !this.queueRows().some((row) => row.thread_id === thread)
          ) {
            this.putQueue({
              ...prior,
              ...target,
              thread_id: thread,
              status: 'eligible',
              reason: 'recovered eligibility retains first ready sequence',
            });
          }
        }
      }
      this.reconcileDeliveries();
    });
  }
  recover() {
    return this.access.atomic(() => {
      this.prune();
      this.reconcileDeliveries();
      for (const row of this.queueRows())
        if (row.status === 'dispatched' && !this.fenceReason(row)) {
          const wait = this.waits(row.task_id).find(
            (item) =>
              item.thread_id === row.thread_id && item.state === 'ready',
          );
          if (wait) {
            row.status = 'eligible';
            row.reason = 'recovered before graph dispatch';
            this.putQueue(row);
          }
        }
    });
  }
  candidateContext(authority: GraphAuthority, identity: TaskIdentity) {
    const task = this.assertAuthority(authority, identity);
    this.assertPermit(authority);
    if (!authority.assignment_id || !authority.assignment_revision) return [];
    const assignment = task.assignments.find(
      (item) => item.id === authority.assignment_id,
    )!;
    if (
      assignment.status !== 'running' ||
      !assignment.lease_token ||
      assignment.acknowledged_revision !== assignment.revision
    )
      return [];
    if (
      !task.permissions.tools.includes('nightshift.result') ||
      !assignment.tools.includes('nightshift.result')
    )
      return [];
    // Accepted consumption remains material input after same-run generation
    // recovery. A checkpoint cannot grant it: require the application's exact
    // rebound wait link, then recheck current grant, source rights and hashes.
    const currentThread = graphThreadId('assignment', authority);
    const rebound = this.access.graph.wait(currentThread);
    const payload = rebound?.payload;
    const sourceId =
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      typeof payload.source_thread_id === 'string'
        ? payload.source_thread_id
        : null;
    const source = sourceId ? this.access.graph.wait(sourceId) : undefined;
    const acceptedGraphRecoveryLink = Boolean(
      rebound &&
      source &&
      rebound.task_id === authority.task_id &&
      rebound.run_id === authority.run_id &&
      rebound.generation === authority.generation &&
      rebound.objective_revision === authority.objective_revision &&
      rebound.assignment_id === authority.assignment_id &&
      rebound.assignment_revision === authority.assignment_revision &&
      source.task_id === authority.task_id &&
      source.run_id === authority.run_id &&
      source.generation < authority.generation &&
      source.objective_revision === authority.objective_revision &&
      source.assignment_id === authority.assignment_id &&
      source.assignment_revision === authority.assignment_revision &&
      source.thread_id === graphThreadId('assignment', source),
    );
    const recoveryEvent = this.db
      .prepare(
        "SELECT cursor FROM events WHERE task_id=? AND json_extract(body,'$.run_id')=? AND json_extract(body,'$.generation')=? AND json_extract(body,'$.objective_revision')=? AND json_extract(body,'$.type') IN ('restart_recovered','control_resume') ORDER BY cursor DESC LIMIT 1",
      )
      .get(
        authority.task_id,
        authority.run_id,
        authority.generation,
        authority.objective_revision,
      ) as { cursor: number } | undefined;
    const acceptedRecoveryLink =
      acceptedGraphRecoveryLink || Boolean(recoveryEvent);
    const candidates = [];
    for (const wait of this.waits(task.id)) {
      const recoveredConsumption =
        acceptedRecoveryLink &&
        wait.state === 'consumed' &&
        wait.authority.generation < authority.generation;
      if (
        wait.authority.run_id !== authority.run_id ||
        (wait.authority.generation !== authority.generation &&
          !recoveredConsumption) ||
        wait.authority.objective_revision !== authority.objective_revision ||
        wait.authority.assignment_id !== authority.assignment_id ||
        wait.authority.assignment_revision !== authority.assignment_revision ||
        wait.state === 'fenced'
      )
        continue;
      for (const delivery of this.deliveryRows(wait.id)) {
        if (
          delivery.state !== 'consumed' ||
          delivery.reason !== 'use_candidate'
        )
          continue;
        if (recoveredConsumption) {
          const accepted = this.db
            .prepare(
              'SELECT body FROM external_dependency_resolutions WHERE wait_id=? AND job_id=?',
            )
            .get(wait.id, delivery.job_id) as { body: string } | undefined;
          if (
            !accepted ||
            (JSON.parse(accepted.body) as { decision?: string }).decision !==
              'use_candidate' ||
            (!acceptedGraphRecoveryLink &&
              (!recoveryEvent || recoveryEvent.cursor <= delivery.event_cursor))
          )
            continue;
        }
        const job = this.access.job(delivery.job_id, identity),
          chain = this.access.chain(job.chain_id, identity);
        if (
          chain.status !== 'active' ||
          Date.parse(chain.expires_at) <= Date.now() ||
          job.execution_state !== 'completed' ||
          !job.receipt ||
          canonicalJson(job.receipt.artifact) !==
            canonicalJson(delivery.artifact)
        )
          continue;
        if (
          this.db
            .prepare('SELECT job_id FROM ns_policy_violations WHERE job_id=?')
            .get(job.id)
        )
          continue;
        this.assertInputs(job, task);
        this.assertCandidate(job, identity);
        candidates.push({
          job_id: job.id,
          artifact: job.receipt.artifact,
          text: job.receipt.output,
          input_refs: job.input_refs,
          original_authority: job.authority,
          candidate: true as const,
          independent_review: 'required' as const,
          judge_is_not_review: true as const,
        });
      }
    }
    return [
      ...new Map(
        candidates.map((candidate) => [candidate.job_id, candidate]),
      ).values(),
    ].slice(-4);
  }
  view(taskId: string, identity: TaskIdentity): ExternalWaitView {
    const task = this.task(taskId, identity),
      waits = this.waits(taskId)
        .slice(-256)
        .map((wait) => {
          const reason = this.dependencyFenceReason(wait, task);
          return reason
            ? {
                ...wait,
                state:
                  wait.state === 'consumed'
                    ? ('consumed' as const)
                    : ('fenced' as const),
                reason,
              }
            : wait;
        });
    const queue = this.queueRows()
      .filter(
        (row) =>
          row.task_id === taskId &&
          row.run_id === task.current_run_id &&
          row.generation === task.generation &&
          row.objective_revision === task.objective_revision,
      )
      .at(-1);
    const permit = this.hasPermit({
      task_id: task.id,
      run_id: task.current_run_id,
      generation: task.generation,
      objective_revision: task.objective_revision,
    });
    const current = waits.filter(
      (wait) =>
        wait.authority.run_id === task.current_run_id &&
        wait.authority.generation === task.generation,
    );
    const stopped =
      !active(task.status) ||
      Date.parse(task.limits.deadline) <= Date.now() ||
      current.some(
        (wait) =>
          wait.state !== 'consumed' &&
          wait.reason !== null &&
          wait.reason !== 'execution generation changed',
      );
    const human = task.questions.some(
      (question) =>
        question.run_id === task.current_run_id && question.status === 'open',
    );
    const waitReason: ExternalWaitView['capacity']['wait_reason'] = stopped
      ? 'stopped'
      : human
        ? 'human'
        : queue?.status === 'eligible' && !permit
          ? 'capacity'
          : current.some(
                (wait) =>
                  wait.state === 'waiting' && !this.fenceReason(wait.authority),
              )
            ? 'compute'
            : null;
    return externalWaitViewSchema.parse({
      schema_version: 'haze.external.wait.view.v1',
      task_id: taskId,
      capacity: {
        permit: permit ? 'held' : 'released',
        wait_reason: waitReason,
        queue: queue
          ? {
              sequence: queue.sequence,
              thread_id: queue.thread_id,
              status: queue.status,
              reason: queue.reason,
            }
          : null,
      },
      waits,
      deliveries: waits
        .flatMap((wait) =>
          this.deliveryRows(wait.id).map((delivery) =>
            wait.reason && delivery.state !== 'consumed'
              ? { ...delivery, state: 'fenced' as const, reason: wait.reason }
              : delivery,
          ),
        )
        .slice(-1024),
    });
  }
}
