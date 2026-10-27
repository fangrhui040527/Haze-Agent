import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../contracts/json.js';
import { TaskError } from '../contracts/tasks.js';
import type { JsonValue } from '../contracts/artifacts.js';

export const MANAGER_TOPOLOGY = 'manager.v3.automatic-chains';
export const SPECIALIST_TOPOLOGY = 'specialist.v3.automatic-chains';
export interface GraphAuthority {
  task_id: string;
  run_id: string;
  generation: number;
  objective_revision: number;
  assignment_id?: string;
  assignment_revision?: number;
}
export interface GraphJobInput extends GraphAuthority {
  thread_id: string;
  kind: 'manager' | 'assignment';
  cursor: number;
  payload?: JsonValue;
}
export interface GraphJob extends GraphJobInput {
  id: string;
  status: 'pending' | 'running' | 'done' | 'waiting' | 'cancelled';
  owner?: string;
}
export interface GraphWaitInput extends GraphJobInput {
  after_cursor: number;
  event_types?: string[];
}
export interface GraphWait extends GraphWaitInput {
  status: 'parked' | 'ready' | 'retired';
  wake_cursor?: number;
}
export interface GraphOperation extends GraphAuthority {
  id: string;
  key: string;
  kind: 'local' | 'model' | 'tool';
  fingerprint: string;
  status: 'prepared' | 'dispatched' | 'completed' | 'unknown';
  attempt_id?: string;
  result?: unknown;
}
export interface ExecutionVersion {
  run_id: string;
  engine: 'legacy' | 'langgraph';
  manager_topology: string;
  specialist_topology: string;
}

export function graphThreadId(
  kind: 'manager' | 'assignment',
  authority: GraphAuthority,
) {
  if (
    kind === 'assignment' &&
    (!authority.assignment_id || !authority.assignment_revision)
  )
    throw new Error(
      'Assignment graph requires an assignment identity and revision.',
    );
  return [
    'haze.graph.v1',
    kind === 'manager' ? MANAGER_TOPOLOGY : SPECIALIST_TOPOLOGY,
    authority.run_id,
    `g${authority.generation}`,
    ...(kind === 'assignment'
      ? [authority.assignment_id!, `r${authority.assignment_revision}`]
      : []),
  ].join(':');
}

type Body = { body: string };
const parse = <T>(row: Body): T => JSON.parse(row.body) as T;
const conflict = (code: string, message: string): never => {
  throw new TaskError(409, code, message);
};

/** Durable delivery and receipts only; graph nodes own routing and dependency selection. */
export class GraphLedger {
  constructor(
    private readonly db: DatabaseSync,
    private readonly atomic: <T>(operation: () => T) => T,
    private readonly assertAuthority: (authority: GraphAuthority) => void,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS run_execution(run_id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS graph_jobs(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,task_id TEXT NOT NULL,cursor INTEGER NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(thread_id,cursor));
      CREATE INDEX IF NOT EXISTS graph_jobs_delivery ON graph_jobs(status,thread_id);
      CREATE TABLE IF NOT EXISTS graph_waits(thread_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS graph_operations(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(run_id,key));
      CREATE TABLE IF NOT EXISTS graph_operation_attempts(operation_id TEXT NOT NULL,attempt_id TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(operation_id,attempt_id));
      CREATE TABLE IF NOT EXISTS graph_effect_receipts(operation_id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS legacy_checkpoint_archive(run_id TEXT PRIMARY KEY,body TEXT NOT NULL);
    `);
  }
  transaction<T>(operation: () => T): T {
    return this.atomic(operation);
  }
  version(runId: string): ExecutionVersion | undefined {
    const row = this.db
      .prepare('SELECT body FROM run_execution WHERE run_id=?')
      .get(runId) as Body | undefined;
    return row ? parse<ExecutionVersion>(row) : undefined;
  }
  register(runId: string, engine: ExecutionVersion['engine'] = 'langgraph') {
    const version: ExecutionVersion = {
      run_id: runId,
      engine,
      manager_topology: engine === 'legacy' ? 'legacy' : MANAGER_TOPOLOGY,
      specialist_topology: engine === 'legacy' ? 'legacy' : SPECIALIST_TOPOLOGY,
    };
    this.db
      .prepare('INSERT INTO run_execution VALUES(?,?)')
      .run(runId, JSON.stringify(version));
    return version;
  }
  assertVersion(runId: string) {
    const version = this.version(runId);
    if (!version || version.engine !== 'langgraph')
      return conflict(
        'manager_upgrade_required',
        'Legacy execution is retired. Explicitly Continue to create a linked LangGraph run.',
      );
    if (
      version.manager_topology !== MANAGER_TOPOLOGY ||
      version.specialist_topology !== SPECIALIST_TOPOLOGY
    )
      conflict(
        'graph_topology_incompatible',
        'Persisted graph topology is unavailable; explicit continuation is required.',
      );
    return version;
  }
  enqueue(input: GraphJobInput): GraphJob {
    return this.atomic(() => {
      this.assertVersion(input.run_id);
      if (input.thread_id !== graphThreadId(input.kind, input))
        conflict(
          'graph_thread_invalid',
          'Graph thread identity does not match its versioned execution authority.',
        );
      const prior = this.db
        .prepare('SELECT body FROM graph_jobs WHERE thread_id=? AND cursor=?')
        .get(input.thread_id, input.cursor) as Body | undefined;
      if (prior) return parse<GraphJob>(prior);
      const job: GraphJob = { ...input, id: randomUUID(), status: 'pending' };
      this.db
        .prepare('INSERT INTO graph_jobs VALUES(?,?,?,?,?,?)')
        .run(
          job.id,
          job.thread_id,
          job.task_id,
          job.cursor,
          job.status,
          JSON.stringify(job),
        );
      return job;
    });
  }
  pending(): GraphJob[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM graph_jobs WHERE status IN ('pending','running') ORDER BY rowid",
        )
        .all() as Body[]
    ).map(parse<GraphJob>);
  }
  claim(owner: string, excludedThreads: string[] = []): GraphJob | undefined {
    return this.atomic(() => {
      const row = (
        this.db
          .prepare(
            "SELECT body FROM graph_jobs p WHERE p.status='pending' AND NOT EXISTS(SELECT 1 FROM graph_jobs r WHERE r.thread_id=p.thread_id AND r.status='running') ORDER BY p.rowid",
          )
          .all() as Body[]
      ).find(
        (item) => !excludedThreads.includes(parse<GraphJob>(item).thread_id),
      );
      if (!row) return undefined;
      const job = {
        ...parse<GraphJob>(row),
        owner,
        status: 'running' as const,
      };
      this.putJob(job);
      return job;
    });
  }
  private putJob(job: GraphJob) {
    this.db
      .prepare('UPDATE graph_jobs SET status=?,body=? WHERE id=?')
      .run(job.status, JSON.stringify(job), job.id);
  }
  finish(id: string, status: 'done' | 'waiting' | 'cancelled' = 'done') {
    return this.atomic(() => {
      const row = this.db
        .prepare('SELECT body FROM graph_jobs WHERE id=?')
        .get(id) as Body | undefined;
      if (!row) return;
      const job = parse<GraphJob>(row);
      job.status = status;
      delete job.owner;
      this.putJob(job);
    });
  }
  retry(id: string) {
    return this.atomic(() => {
      const row = this.db
        .prepare('SELECT body FROM graph_jobs WHERE id=?')
        .get(id) as Body | undefined;
      if (!row) return;
      const job = parse<GraphJob>(row);
      if (job.status !== 'running') return;
      job.status = 'pending';
      delete job.owner;
      this.putJob(job);
    });
  }
  park(input: GraphWaitInput): GraphWait {
    return this.atomic(() => {
      this.assertVersion(input.run_id);
      const payload =
        typeof input.payload === 'object' &&
        input.payload !== null &&
        !Array.isArray(input.payload)
          ? input.payload
          : {};
      const wait: GraphWait = {
        ...input,
        status: 'parked',
        payload: { ...payload, source_thread_id: input.thread_id },
      };
      this.db
        .prepare(
          'INSERT INTO graph_waits VALUES(?,?,?) ON CONFLICT(thread_id) DO UPDATE SET body=excluded.body',
        )
        .run(wait.thread_id, wait.task_id, JSON.stringify(wait));
      // Event commit may precede parking: inspect the durable log in this same transaction.
      const events = this.db
        .prepare(
          'SELECT cursor,body FROM events WHERE task_id=? AND cursor>? ORDER BY cursor',
        )
        .all(wait.task_id, wait.after_cursor) as (Body & { cursor: number })[];
      for (const event of events) {
        this.wake(
          wait.task_id,
          event.cursor,
          parse<{ type: string }>(event).type,
        );
      }
      return this.wait(wait.thread_id)!;
    });
  }
  wait(threadId: string): GraphWait | undefined {
    const row = this.db
      .prepare('SELECT body FROM graph_waits WHERE thread_id=?')
      .get(threadId) as Body | undefined;
    return row ? parse<GraphWait>(row) : undefined;
  }
  latestAssignmentWait(
    runId: string,
    assignmentId: string,
    revision: number,
  ): GraphWait | undefined {
    return (this.db.prepare('SELECT body FROM graph_waits').all() as Body[])
      .map(parse<GraphWait>)
      .filter(
        (wait) =>
          wait.run_id === runId &&
          wait.assignment_id === assignmentId &&
          wait.assignment_revision === revision,
      )
      .sort(
        (a, b) =>
          b.generation - a.generation || b.after_cursor - a.after_cursor,
      )[0];
  }
  rebindWaits(authority: GraphAuthority, deliverReady = true) {
    return this.atomic(() => {
      this.assertVersion(authority.run_id);
      const waits = (
        this.db
          .prepare('SELECT body FROM graph_waits WHERE task_id=?')
          .all(authority.task_id) as Body[]
      ).map(parse<GraphWait>);
      for (const wait of waits) {
        if (
          wait.status === 'retired' ||
          wait.run_id !== authority.run_id ||
          wait.generation === authority.generation ||
          wait.objective_revision !== authority.objective_revision
        )
          continue;
        const previousPayload =
          typeof wait.payload === 'object' &&
          wait.payload !== null &&
          !Array.isArray(wait.payload)
            ? wait.payload
            : {};
        const rebound: GraphWait = {
          ...wait,
          ...authority,
          thread_id: graphThreadId(wait.kind, { ...wait, ...authority }),
          payload: {
            ...previousPayload,
            source_thread_id:
              typeof previousPayload['source_thread_id'] === 'string'
                ? previousPayload['source_thread_id']
                : wait.thread_id,
          },
        };
        this.db
          .prepare(
            'INSERT INTO graph_waits VALUES(?,?,?) ON CONFLICT(thread_id) DO UPDATE SET body=excluded.body',
          )
          .run(rebound.thread_id, rebound.task_id, JSON.stringify(rebound));
        wait.status = 'retired';
        this.db
          .prepare('UPDATE graph_waits SET body=? WHERE thread_id=?')
          .run(JSON.stringify(wait), wait.thread_id);
        if (
          rebound.status === 'ready' &&
          deliverReady &&
          rebound.wake_cursor !== undefined
        )
          this.enqueue({ ...rebound, cursor: rebound.wake_cursor });
      }
      for (const job of this.pending())
        if (
          job.run_id === authority.run_id &&
          job.generation !== authority.generation
        ) {
          job.status = 'cancelled';
          delete job.owner;
          this.putJob(job);
        }
    });
  }
  wake(taskId: string, cursor: number, eventType?: string) {
    return this.atomic(() => {
      // Terminal receipts are retained independently. Only complete dependency
      // readiness creates an executable targeted wake.
      if (eventType === 'external_result') return;
      const eventRow = this.db
        .prepare('SELECT body FROM events WHERE task_id=? AND cursor=?')
        .get(taskId, cursor) as Body | undefined;
      const event = eventRow
        ? parse<{
            run_id: string;
            objective_revision: number;
            generation: number;
            data?: {
              recipient?: string;
              recipient_revision?: number;
              retained_only?: boolean;
            };
          }>(eventRow)
        : undefined;
      for (const row of this.db
        .prepare('SELECT body FROM graph_waits WHERE task_id=?')
        .all(taskId) as Body[]) {
        const wait = parse<GraphWait>(row);
        if (
          ['external_result', 'external_result_ready'].includes(
            eventType ?? '',
          ) &&
          event?.data?.retained_only
        )
          continue;
        if (eventType === 'external_result_ready' && !wait.assignment_id)
          continue;
        if (
          eventType === 'external_result_ready' &&
          event?.data?.recipient_revision !== wait.assignment_revision
        )
          continue;
        if (wait.status === 'retired') continue;
        if (
          wait.after_cursor >= cursor ||
          (wait.event_types &&
            eventType &&
            !wait.event_types.includes(eventType))
        )
          continue;
        if (
          event &&
          (event.run_id !== wait.run_id ||
            event.objective_revision !== wait.objective_revision)
        )
          continue;
        if (
          (eventType === 'peer_message_sent' ||
            eventType === 'external_result' ||
            eventType === 'external_result_ready') &&
          wait.assignment_id &&
          (event?.data?.recipient !== wait.assignment_id ||
            (event.data.recipient_revision !== undefined &&
              event.data.recipient_revision !== wait.assignment_revision))
        )
          continue;
        if (
          ['external_result', 'external_result_ready'].includes(
            eventType ?? '',
          ) &&
          event?.generation !== wait.generation
        )
          continue;
        if (this.version(wait.run_id)?.engine !== 'langgraph') continue;
        wait.status = 'ready';
        wait.wake_cursor = Math.max(wait.wake_cursor ?? 0, cursor);
        const payload =
          typeof wait.payload === 'object' &&
          wait.payload !== null &&
          !Array.isArray(wait.payload)
            ? wait.payload
            : {};
        const delivery = {
          ...wait,
          cursor,
          payload: { ...payload, resume: { cursor } },
        };
        const pending =
          eventType === 'external_result_ready'
            ? (this.db
                .prepare(
                  "SELECT body FROM graph_jobs WHERE thread_id=? AND status='pending' ORDER BY rowid LIMIT 1",
                )
                .get(wait.thread_id) as Body | undefined)
            : undefined;
        if (pending) {
          const prior = parse<GraphJob>(pending);
          const merged = {
            ...prior,
            cursor: Math.max(prior.cursor, cursor),
            payload: delivery.payload,
          };
          this.db
            .prepare('UPDATE graph_jobs SET cursor=?,body=? WHERE id=?')
            .run(merged.cursor, JSON.stringify(merged), merged.id);
        } else this.enqueue(delivery);
        this.db
          .prepare('UPDATE graph_waits SET body=? WHERE thread_id=?')
          .run(JSON.stringify(wait), wait.thread_id);
      }
    });
  }
  prepare(
    key: string,
    input: unknown,
    authority: GraphAuthority,
    kind: GraphOperation['kind'],
    linkAuthority?: (operation: GraphOperation) => void,
  ): GraphOperation {
    return this.atomic(() => {
      this.assertAuthority(authority);
      const fingerprint = createHash('sha256')
        .update(canonicalJson(input))
        .digest('hex');
      const row = this.db
        .prepare('SELECT body FROM graph_operations WHERE run_id=? AND key=?')
        .get(authority.run_id, key) as Body | undefined;
      if (row) {
        const prior = parse<GraphOperation>(row);
        if (
          prior.fingerprint !== fingerprint ||
          prior.kind !== kind ||
          prior.assignment_id !== authority.assignment_id ||
          prior.assignment_revision !== authority.assignment_revision
        )
          conflict(
            'graph_operation_conflict',
            'Stable operation key was reused for a different effect.',
          );
        if (prior.status === 'dispatched' || prior.status === 'unknown')
          conflict(
            'graph_operation_unknown',
            'Dispatched operation has no accepted receipt. Explicit Resume or Continue is required.',
          );
        if (prior.status === 'prepared') {
          prior.generation = authority.generation;
          this.putOperation(prior);
        }
        linkAuthority?.(prior);
        return prior;
      }
      const operation: GraphOperation = {
        ...authority,
        id: randomUUID(),
        key,
        kind,
        fingerprint,
        status: 'prepared',
      };
      this.db
        .prepare('INSERT INTO graph_operations VALUES(?,?,?,?,?)')
        .run(
          operation.id,
          operation.run_id,
          key,
          fingerprint,
          JSON.stringify(operation),
        );
      linkAuthority?.(operation);
      return operation;
    });
  }
  operation(id: string): GraphOperation {
    const row = this.db
      .prepare('SELECT body FROM graph_operations WHERE id=?')
      .get(id) as Body | undefined;
    if (!row)
      return conflict(
        'graph_operation_missing',
        'Operation identity must be persisted before dispatch.',
      );
    return parse<GraphOperation>(row);
  }
  private putOperation(operation: GraphOperation) {
    this.db
      .prepare('UPDATE graph_operations SET body=? WHERE id=?')
      .run(JSON.stringify(operation), operation.id);
  }
  dispatch(id: string, generation: number, attemptId?: string) {
    return this.atomic(() => {
      const operation = this.operation(id);
      this.assertAuthority({ ...operation, generation });
      if (
        operation.status !== 'prepared' ||
        operation.generation !== generation
      )
        conflict(
          'graph_operation_unknown',
          'Operation cannot be automatically dispatched again.',
        );
      operation.status = 'dispatched';
      if (attemptId) {
        operation.attempt_id = attemptId;
        this.db
          .prepare('INSERT INTO graph_operation_attempts VALUES(?,?,?)')
          .run(id, attemptId, generation);
      }
      this.putOperation(operation);
      return operation;
    });
  }
  complete(id: string, generation: number, result: unknown): GraphOperation {
    return this.atomic(() => {
      const operation = this.operation(id);
      if (operation.status === 'completed') return operation;
      this.assertAuthority({ ...operation, generation });
      if (operation.generation !== generation || operation.status === 'unknown')
        conflict(
          'stale_execution',
          'Operation response belongs to fenced execution.',
        );
      operation.status = 'completed';
      operation.result = result;
      this.putOperation(operation);
      this.db
        .prepare('INSERT INTO graph_effect_receipts VALUES(?,?)')
        .run(id, JSON.stringify({ result }));
      return operation;
    });
  }
  localEffect<T>(
    key: string,
    input: unknown,
    authority: GraphAuthority,
    effect: () => T,
  ): T {
    return this.atomic(() => {
      const operation = this.prepare(key, input, authority, 'local');
      if (operation.status === 'completed') return operation.result as T;
      const result = effect();
      if (result instanceof Promise)
        throw new Error(
          'Local ledger effects must complete synchronously in the application transaction.',
        );
      // The effect may itself complete or park the assignment. Authority was checked before it.
      operation.status = 'completed';
      operation.result = result;
      this.putOperation(operation);
      this.db
        .prepare('INSERT INTO graph_effect_receipts VALUES(?,?)')
        .run(operation.id, JSON.stringify({ result }));
      return result;
    });
  }
  fence(runId: string) {
    for (const row of this.db
      .prepare('SELECT body FROM graph_operations WHERE run_id=?')
      .all(runId) as Body[]) {
      const operation = parse<GraphOperation>(row);
      if (operation.status === 'dispatched') {
        operation.status = 'unknown';
        this.putOperation(operation);
      }
    }
  }
  replaceUnknown(runId: string, generation: number) {
    for (const row of this.db
      .prepare('SELECT body FROM graph_operations WHERE run_id=?')
      .all(runId) as Body[]) {
      const operation = parse<GraphOperation>(row);
      if (operation.status === 'unknown') {
        operation.status = 'prepared';
        operation.generation = generation;
        delete operation.attempt_id;
        this.putOperation(operation);
      }
    }
  }
  recover() {
    return this.atomic(() => {
      for (const job of this.pending())
        if (job.status === 'running') {
          job.status = 'pending';
          delete job.owner;
          this.putJob(job);
        }
      for (const row of this.db
        .prepare('SELECT body FROM graph_operations')
        .all() as Body[]) {
        const operation = parse<GraphOperation>(row);
        if (operation.status === 'dispatched') {
          operation.status = 'unknown';
          this.putOperation(operation);
        }
      }
    });
  }
}
