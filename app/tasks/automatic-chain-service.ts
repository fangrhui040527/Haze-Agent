import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { artifactRefSchema, type ArtifactRef } from '../contracts/artifacts.js';
import { canonicalJson } from '../contracts/json.js';
import {
  automaticReadinessSchema,
  automaticReleaseBlocked,
  type AutomaticReadiness,
  type AutomaticReleasePolicy,
} from '../contracts/nightshift-automatic.js';
import type { NightshiftProgressRecord } from '../contracts/nightshift-chains.js';
import type { ModelRouteSnapshot } from '../contracts/model-routes.js';
import type {
  NightshiftChain,
  NightshiftJob,
} from '../contracts/nightshift-records.js';
import {
  TaskError,
  type TaskIdentity,
  type TaskRecord,
} from '../contracts/tasks.js';
import { boundedExecution } from '../orchestration/ports.js';
import type { TaskStore } from './store.js';

export interface AutomaticTransferredDependency {
  job_id: string;
  required: boolean;
  source_wait_id: string | null;
  delivery_id: string | null;
}
/** Server-owned authority only. This request is never accepted from HTTP or a model. */
export interface AutomaticSuccessorRequest {
  task_id: string;
  chain_id: string;
  predecessor_run_id: string;
  objective_revision: number;
  expected_chain_revision: number;
  trigger_cursor: number;
  delivery_ids: string[];
  dependencies: AutomaticTransferredDependency[];
  identity: TaskIdentity;
  actor: { kind: 'service'; id: 'Nightshift' };
  mode: 'automatic';
  purpose: NightshiftProgressRecord['progress']['purpose'];
  progress: NightshiftProgressRecord;
}
export type AutomaticAdmissionResult =
  | { run_id: string; reused: boolean; decision_id: string }
  | { waiting: true; sequence: number; reason: string };
export interface AutomaticChainOptions {
  releaseGate: AutomaticReleasePolicy;
  /** The shared lifecycle atomically owns capacity, enrollment, transfers and graph enqueue. */
  admitSuccessor(request: AutomaticSuccessorRequest): AutomaticAdmissionResult;
  routesAvailable(
    snapshot: ModelRouteSnapshot,
    signal: AbortSignal,
  ): Promise<boolean>;
  kick?(taskId: string): void;
  suspend?(reason: string): void;
  /** The task and grant fence share the decision transaction, before local abort. */
  fenceTask?(taskId: string, reason: string): void;
}

const decisionSchema = z.strictObject({
  schema_version: z.literal('haze.nightshift.automatic.decision.v1'),
  id: z.uuid(),
  chain_id: z.uuid(),
  task_id: z.uuid(),
  predecessor_run_id: z.uuid(),
  objective_revision: z.number().int().positive(),
  state: z.enum(['observing', 'waiting', 'admitted', 'stopped']),
  code: z.string().min(1).max(128),
  reason: z.string().max(2000),
  trigger_cursor: z.number().int().nonnegative(),
  delivery_ids: z.array(z.uuid()).max(64),
  dependencies: z
    .array(
      z.strictObject({
        job_id: z.uuid(),
        required: z.boolean(),
        source_wait_id: z.uuid().nullable(),
        delivery_id: z.uuid().nullable(),
      }),
    )
    .max(64),
  successor_run_id: z.uuid().nullable(),
  queue_sequence: z.number().int().positive().nullable(),
  actor: z.literal('service:Nightshift'),
  progress_fingerprint: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
});
export type AutomaticChainDecision = z.infer<typeof decisionSchema>;
type Row = { body: string };
type WaitRecord = {
  id: string;
  authority: {
    run_id: string;
    generation: number;
    objective_revision: number;
    assignment_id: string;
    assignment_revision: number;
  };
  after_cursor: number;
  dependencies: { job_id: string; required: boolean }[];
  state: string;
};
interface Batch {
  cursor: number;
  delivery_ids: string[];
  dependencies: AutomaticTransferredDependency[];
  refs: ArtifactRef[];
  hasNewResult: boolean;
}
const now = () => new Date().toISOString();
const decode = <T>(row: Row): T => JSON.parse(row.body) as T;
const active = (task: TaskRecord) =>
  ['queued', 'running', 'waiting'].includes(task.status);

/**
 * Decides only whether the existing lifecycle may admit a linked run. It never
 * submits a remote job, changes a grant, accepts evidence or invokes a graph.
 * The existing runtime calls tick while it owns the authoritative database.
 */
export class AutomaticChainService {
  private readonly stop = new AbortController();
  private running: Promise<void> | undefined;
  private closed = false;
  private scanOffset = 0;
  private latestReadiness = automaticReleaseBlocked(
    'Automatic chain release evidence has not been verified.',
  );
  constructor(
    private readonly store: TaskStore,
    private readonly options: AutomaticChainOptions,
  ) {
    store.transaction(() => {
      store.db.exec(`
        CREATE TABLE IF NOT EXISTS automatic_chain_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS automatic_chain_decisions(id TEXT PRIMARY KEY,chain_id TEXT NOT NULL,predecessor_run_id TEXT NOT NULL,objective_revision INTEGER NOT NULL,body TEXT NOT NULL,UNIQUE(chain_id,predecessor_run_id,objective_revision));
        CREATE TABLE IF NOT EXISTS automatic_chain_result_events(job_id TEXT PRIMARY KEY,event_cursor INTEGER NOT NULL,artifact_id TEXT,body TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS automatic_result_event_immutable_update BEFORE UPDATE ON automatic_chain_result_events BEGIN SELECT RAISE(ABORT,'Automatic result identity is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS automatic_result_event_immutable_delete BEFORE DELETE ON automatic_chain_result_events BEGIN SELECT RAISE(ABORT,'Automatic result identity is immutable'); END;
      `);
      const versions = store.db
        .prepare('SELECT version FROM automatic_chain_migrations')
        .all() as { version: number }[];
      if (versions.some((row) => row.version !== 1))
        throw new TaskError(
          409,
          'automatic_chain_schema_incompatible',
          'Unsupported automatic-chain decision migration.',
        );
      store.db
        .prepare('INSERT OR IGNORE INTO automatic_chain_migrations VALUES(1,?)')
        .run(now());
    });
  }
  async readiness(): Promise<AutomaticReadiness> {
    if (this.closed)
      return automaticReleaseBlocked(
        'The automatic chain supervisor is stopped.',
      );
    try {
      const signal = AbortSignal.any([
        this.stop.signal,
        AbortSignal.timeout(10_000),
      ]);
      this.latestReadiness = automaticReadinessSchema.parse(
        await boundedExecution(
          { signal, deadline: new Date(Date.now() + 10_000).toISOString() },
          () => this.options.releaseGate(),
        ),
      );
    } catch {
      this.latestReadiness = automaticReleaseBlocked(
        'The trusted server could not verify automatic-chain release evidence.',
      );
    }
    this.store.nightshift.configureAutomatic({
      enabled: this.latestReadiness.released && this.latestReadiness.ready,
      evidence_id: this.latestReadiness.evidence_id,
    });
    return structuredClone(this.latestReadiness);
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async run(): Promise<void> {
    const gate = await this.readiness();
    if (this.closed) return;
    if (!gate.released || !gate.ready) {
      this.options.suspend?.(
        gate.reason ?? 'Automatic chain release evidence is unavailable.',
      );
      return;
    }
    const contexts = this.store.nightshift.pendingAutomaticChains();
    const candidates = contexts.length
      ? Array.from(
          { length: Math.min(8, contexts.length) },
          (_, index) => contexts[(this.scanOffset + index) % contexts.length]!,
        )
      : [];
    this.scanOffset = contexts.length
      ? (this.scanOffset + candidates.length) % contexts.length
      : 0;
    for (const context of candidates) {
      if (this.closed) return;
      try {
        await this.consider(context.chain, context.identity, context.progress);
      } catch (error) {
        const chain = this.store.nightshift.chain(
          context.chain.id,
          context.identity,
        );
        if (chain.status !== 'active') continue;
        const task = this.store.read(chain.task_id, context.identity);
        const code =
          error instanceof TaskError
            ? error.code
            : 'automatic_validation_failed';
        this.stopChain(
          chain,
          task,
          {
            cursor: 0,
            delivery_ids: [],
            dependencies: [],
            refs: [],
            hasNewResult: false,
          },
          code,
          'Automatic continuation could not validate its retained records or current authority; explicit review is required.',
          ['permission_denied', 'artifact_read_denied'].includes(code)
            ? 'closed'
            : 'paused',
        );
      }
    }
  }
  private async consider(
    chain: NightshiftChain,
    identity: TaskIdentity,
    progress: NightshiftProgressRecord | null,
  ): Promise<void> {
    chain = this.store.nightshift.chain(chain.id, identity);
    if (chain.status !== 'active') return;
    progress = this.store.nightshift.progress(chain.id, identity);
    let task = this.store.read(chain.task_id, identity);
    const predecessor = task.current_run_id;
    const committed = this.store.db
      .prepare(
        'SELECT body FROM automatic_chain_decisions WHERE chain_id=? AND predecessor_run_id=? AND objective_revision=?',
      )
      .get(chain.id, predecessor, task.objective_revision) as Row | undefined;
    if (
      committed &&
      decisionSchema.parse(decode(committed)).state === 'admitted'
    )
      return;
    const snapshot = {
      run: predecessor,
      generation: task.generation,
      objective: task.objective_revision,
      chain: chain.revision,
      progress: progress?.revision ?? 0,
    };
    let batch = this.store.transaction(() => this.batch(chain, task, progress));
    if (task.objective_revision !== chain.objective_revision)
      return this.stopChain(
        chain,
        task,
        batch,
        'objective_invalidated',
        'The objective revision no longer matches the original automatic grant.',
        'closed',
      );
    if (Date.parse(chain.expires_at) <= Date.now())
      return this.stopChain(
        chain,
        task,
        batch,
        'absolute_expiry',
        'The original absolute chain expiry has passed.',
        'closed',
      );
    if (task.status === 'cancelled')
      return this.stopChain(
        chain,
        task,
        batch,
        'task_cancelled',
        'The owning task was cancelled.',
        'closed',
      );
    if (task.status === 'paused')
      return this.stopChain(
        chain,
        task,
        batch,
        'task_paused',
        'Explicit task Resume is required before automatic work can be considered.',
      );
    if (
      task.result?.currency === 'current' &&
      task.result.completion === 'full' &&
      ['supported', 'not_required'].includes(task.result.review.status)
    )
      return this.stopChain(
        chain,
        task,
        batch,
        'completed_deliverables',
        'Haze finalization accepted the requested deliverables; no further dispatch is authorized.',
        'closed',
      );
    const question = task.questions.find(
      (q) => q.run_id === predecessor && q.status === 'open',
    );
    if (question)
      return this.stopChain(
        chain,
        task,
        batch,
        'required_user_input',
        question.question,
      );
    if (this.hasUnknown(task, chain.id, !active(task)))
      return this.stopChain(
        chain,
        task,
        batch,
        'unknown_outcome',
        'An operation or job submission has an unresolved outcome. Its charge is retained; verified reconciliation is required.',
      );
    if (!progress || !progress.progress.unresolved_deliverables.length)
      return this.stopChain(
        chain,
        task,
        batch,
        'missing_purpose',
        'No validated outstanding purpose authorizes a successor.',
      );
    if (!task.permissions.tools.includes('nightshift.result'))
      return this.stopChain(
        chain,
        task,
        batch,
        'missing_permission',
        'The task no longer grants controlled Nightshift result consumption.',
        'closed',
      );
    if (active(task)) {
      this.store.transaction(() =>
        this.record(
          chain,
          task,
          batch,
          'observing',
          batch.hasNewResult ? 'active_run_inbox' : 'waiting_result',
          batch.hasNewResult
            ? 'The current run retains these results in its inbox; ordinary targeted delivery and capacity rules remain authoritative.'
            : 'The current run is active; no successor is created.',
        ),
      );
      return;
    }
    if (!['completed', 'timed_out', 'failed'].includes(task.status))
      return this.stopChain(
        chain,
        task,
        batch,
        'predecessor_not_quiescent',
        'The predecessor is not an eligible quiescent run.',
      );
    if (
      !chain.remaining.runs ||
      chain.remaining.model_calls < task.limits.reserved_model_calls + 1 ||
      !chain.remaining.tool_calls ||
      !chain.remaining.assignments ||
      chain.remaining.artifacts < 2
    )
      return this.stopChain(
        chain,
        task,
        batch,
        'resource_exhausted',
        'The original cumulative grant cannot reserve another bounded Haze run.',
        'closed',
      );
    const automaticUsed = (
      this.store.db
        .prepare(
          "SELECT count(*) n FROM ns_successors WHERE chain_id=? AND json_extract(body,'$.mode')='automatic'",
        )
        .get(chain.id) as { n: number }
    ).n;
    if (automaticUsed >= chain.grant.automatic_followup_runs)
      return this.stopChain(
        chain,
        task,
        batch,
        'automatic_followups_exhausted',
        'The separately authorized automatic allowance is exhausted; any remaining manual run grant still requires explicit user Continue.',
        'active',
      );
    if (!batch.hasNewResult) {
      this.store.transaction(() =>
        this.record(
          chain,
          task,
          batch,
          'observing',
          'waiting_result',
          'No new permitted terminal result is available for the outstanding purpose.',
        ),
      );
      return;
    }
    const previousDecision = this.store.db
      .prepare(
        "SELECT body FROM automatic_chain_decisions WHERE chain_id=? AND json_extract(body,'$.state')='admitted' ORDER BY rowid DESC LIMIT 1",
      )
      .get(chain.id) as Row | undefined;
    const previousAdmission = this.store.db
      .prepare(
        'SELECT body FROM linked_run_admissions WHERE chain_id=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(chain.id) as Row | undefined;
    const previous = previousDecision
      ? decisionSchema.parse(decode(previousDecision))
      : null;
    const admission = previousAdmission
      ? decode<{ trigger_cursor: number; progress_fingerprint?: string }>(
          previousAdmission,
        )
      : null;
    const previousCursor = Math.max(
      previous?.trigger_cursor ?? 0,
      admission?.trigger_cursor ?? 0,
    );
    const priorFingerprint =
      admission?.progress_fingerprint ?? previous?.progress_fingerprint ?? null;
    if (
      previousCursor >= batch.cursor &&
      priorFingerprint === progress.fingerprint
    )
      return this.stopChain(
        chain,
        task,
        batch,
        'no_progress',
        'The same retained result and unchanged semantic purpose already received a successor. A timer, new run ID or changed prose is not progress.',
      );
    let routes: ModelRouteSnapshot;
    try {
      this.store.graph.assertVersion(predecessor);
      const continuation = this.store.nightshift.continuation(
        predecessor,
        'automatic',
      );
      if (!continuation)
        throw new TaskError(
          409,
          'automatic_grant_missing',
          'The predecessor has no automatic chain enrollment.',
        );
      routes = continuation.routes;
    } catch (error) {
      const code =
        error instanceof TaskError
          ? error.code
          : 'automatic_authority_unavailable';
      return this.stopChain(
        chain,
        task,
        batch,
        code,
        'The original grant, remaining automatic quota or execution topology cannot authorize a successor.',
        code === 'nightshift_automatic_grant_exhausted'
          ? 'active'
          : code.includes('exhausted')
            ? 'closed'
            : 'paused',
      );
    }
    let available = false;
    try {
      const signal = AbortSignal.any([
        this.stop.signal,
        AbortSignal.timeout(10_000),
      ]);
      available = await boundedExecution(
        { signal, deadline: new Date(Date.now() + 10_000).toISOString() },
        () => this.options.routesAvailable(routes, signal),
      );
    } catch {
      /* No route failure authorizes a fallback or a different route. */
    }
    if (this.closed) return;
    if (!available)
      return this.stopChain(
        chain,
        task,
        batch,
        'route_unavailable',
        'An original pinned route is unavailable; automatic continuation cannot remap it.',
      );
    const currentGate = await this.readiness();
    if (this.closed || !currentGate.released || !currentGate.ready) {
      this.options.suspend?.(
        currentGate.reason ??
          'Automatic chain release evidence is unavailable.',
      );
      return;
    }
    this.store.transaction(() => {
      task = this.store.read(chain.task_id, identity);
      const currentChain = this.store.nightshift.chain(chain.id, identity);
      const currentProgress = this.store.nightshift.progress(
        chain.id,
        identity,
      );
      if (
        task.current_run_id !== snapshot.run ||
        task.generation !== snapshot.generation ||
        task.objective_revision !== snapshot.objective ||
        currentChain.revision !== snapshot.chain ||
        (currentProgress?.revision ?? 0) !== snapshot.progress ||
        currentChain.status !== 'active'
      )
        return;
      if (
        this.hasUnknown(task, chain.id) ||
        task.questions.some(
          (q) => q.run_id === predecessor && q.status === 'open',
        )
      )
        return;
      batch = this.batch(currentChain, task, currentProgress);
      if (!batch.hasNewResult || !currentProgress || active(task)) return;
      const admitted = this.options.admitSuccessor({
        task_id: task.id,
        chain_id: chain.id,
        predecessor_run_id: predecessor,
        objective_revision: task.objective_revision,
        expected_chain_revision: currentChain.revision,
        trigger_cursor: batch.cursor,
        delivery_ids: batch.delivery_ids,
        dependencies: batch.dependencies,
        identity,
        actor: { kind: 'service', id: 'Nightshift' },
        mode: 'automatic',
        purpose: currentProgress.progress.purpose,
        progress: currentProgress,
      });
      if ('waiting' in admitted)
        this.record(
          currentChain,
          task,
          batch,
          'waiting',
          'waiting_capacity',
          admitted.reason,
          { sequence: admitted.sequence },
        );
      else {
        this.record(
          currentChain,
          task,
          batch,
          'admitted',
          'successor_admitted',
          'One linked successor was admitted under the original cumulative grant.',
          { run_id: admitted.run_id },
        );
        this.store.afterCommit(() => this.options.kick?.(task.id));
      }
    });
  }
  private hasUnknown(
    task: TaskRecord,
    chainId: string,
    quiescent = true,
  ): boolean {
    const attempts = this.store.db
      .prepare('SELECT body FROM attempts WHERE task_id=?')
      .all(task.id) as Row[];
    if (
      attempts.some((row) => {
        const a = decode<{ run_id: string; status: string }>(row);
        return (
          a.run_id === task.current_run_id &&
          (a.status === 'unknown' || (quiescent && a.status === 'started'))
        );
      })
    )
      return true;
    const operations = this.store.db
      .prepare('SELECT body FROM graph_operations WHERE run_id=?')
      .all(task.current_run_id) as Row[];
    if (
      operations.some((row) => {
        const status = decode<{ status: string }>(row).status;
        return status === 'unknown' || (quiescent && status === 'dispatched');
      })
    )
      return true;
    return this.store.nightshift
      .jobsForChain(chainId, task.identity)
      .some(
        (job) =>
          job.chain_id === chainId &&
          (['submission_unknown', 'unresolved'].includes(job.execution_state) ||
            (quiescent && job.execution_state === 'submitting') ||
            (job.cancellation.requested &&
              !job.cancellation.remote_termination_confirmed &&
              !['completed', 'failed', 'rejected'].includes(
                job.execution_state,
              ))),
      );
  }
  private terminal(job: NightshiftJob): boolean {
    return (
      (job.execution_state === 'completed' && !!job.receipt) ||
      ['failed', 'rejected'].includes(job.execution_state) ||
      (job.execution_state === 'cancelled' &&
        job.cancellation.remote_termination_confirmed)
    );
  }
  private resultCursor(job: NightshiftJob): number {
    const existing = this.store.db
      .prepare(
        'SELECT event_cursor FROM automatic_chain_result_events WHERE job_id=?',
      )
      .get(job.id) as { event_cursor: number } | undefined;
    if (existing) return existing.event_cursor;
    const event = {
      schema_version: 'haze.task.event.v3',
      task_id: job.task_id,
      run_id: job.authority.run_id,
      objective_revision: job.authority.objective_revision,
      generation: job.authority.generation,
      ...(job.authority.assignment_id
        ? { assignment_id: job.authority.assignment_id }
        : {}),
      at: now(),
      type: 'automatic_result_retained',
      actor: 'Runtime',
      message:
        'A terminal Nightshift result remains in the original chain inbox; no execution or evidence acceptance is implied.',
      data: {
        job_id: job.id,
        chain_id: job.chain_id,
        artifact: job.receipt?.artifact ?? null,
        candidate: true,
      },
    };
    const inserted = this.store.db
      .prepare('INSERT INTO events(task_id,body) VALUES(?,?)')
      .run(job.task_id, JSON.stringify(event));
    const cursor = Number(inserted.lastInsertRowid);
    this.store.db
      .prepare('INSERT INTO automatic_chain_result_events VALUES(?,?,?,?)')
      .run(
        job.id,
        cursor,
        job.receipt?.artifact.id ?? null,
        JSON.stringify({
          job_id: job.id,
          original_authority: job.authority,
          artifact: job.receipt?.artifact ?? null,
        }),
      );
    return cursor;
  }
  /** Server-only historical audit identity; it grants no execution or acceptance. */
  retainResult(job: NightshiftJob): number {
    return this.store.transaction(() => {
      if (!this.terminal(job))
        throw new TaskError(
          409,
          'automatic_result_pending',
          'Only a verified terminal result can receive an automatic inbox cursor.',
        );
      return this.resultCursor(job);
    });
  }
  private batch(
    chain: NightshiftChain,
    task: TaskRecord,
    progress: NightshiftProgressRecord | null,
  ): Batch {
    const dependencies = new Map<string, AutomaticTransferredDependency>();
    const resolvedJobs = new Set<string>();
    const transferred = this.store.db
      .prepare('SELECT id,body FROM ns_run_transfers WHERE target_run_id=?')
      .all(task.current_run_id) as (Row & { id: string })[];
    const transferredJobs = new Set<string>();
    for (const row of transferred) {
      const transfer = decode<{
        chain_id: string;
        job_id: string;
        required: boolean;
        source_wait_id: string | null;
        delivery_id: string | null;
      }>(row);
      if (transfer.chain_id !== chain.id) continue;
      const resolution = this.store.db
        .prepare('SELECT body FROM ns_transfer_resolutions WHERE transfer_id=?')
        .get(row.id) as Row | undefined;
      if (
        resolution &&
        decode<{ decision: string }>(resolution).decision !==
          'reported_unresolved'
      ) {
        resolvedJobs.add(transfer.job_id);
        continue;
      }
      transferredJobs.add(transfer.job_id);
      dependencies.set(transfer.job_id, {
        job_id: transfer.job_id,
        required: transfer.required,
        source_wait_id: transfer.source_wait_id,
        delivery_id: transfer.delivery_id,
      });
    }
    const waits = (
      this.store.db
        .prepare(
          'SELECT body FROM external_waits WHERE task_id=? ORDER BY rowid DESC',
        )
        .all(task.id) as Row[]
    ).map(decode<WaitRecord>);
    const seen = new Set<string>();
    for (const wait of waits) {
      if (
        wait.authority.run_id !== task.current_run_id ||
        wait.authority.objective_revision !== task.objective_revision
      )
        continue;
      const key = `${wait.authority.assignment_id}:${wait.authority.assignment_revision}:${wait.after_cursor}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const dep of wait.dependencies) {
        const resolution = this.store.db
          .prepare(
            'SELECT body FROM external_dependency_resolutions WHERE wait_id=? AND job_id=?',
          )
          .get(wait.id, dep.job_id) as Row | undefined;
        if (
          resolution &&
          decode<{ decision: string }>(resolution).decision !==
            'reported_unresolved'
        ) {
          resolvedJobs.add(dep.job_id);
          continue;
        }
        const job = this.store.nightshift.job(dep.job_id, task.identity);
        if (job.chain_id !== chain.id) continue;
        const delivery = this.store.db
          .prepare(
            'SELECT id FROM external_result_deliveries WHERE wait_id=? AND job_id=?',
          )
          .get(wait.id, dep.job_id) as { id: string } | undefined;
        const prior = dependencies.get(job.id);
        dependencies.set(job.id, {
          job_id: job.id,
          required: dep.required || prior?.required === true,
          source_wait_id: wait.id,
          delivery_id: delivery?.id ?? job.receipt?.artifact.id ?? null,
        });
      }
    }
    const jobs = this.store.nightshift
      .jobsForChain(chain.id, task.identity)
      .filter(
        (job) =>
          job.chain_id === chain.id &&
          (job.authority.run_id === task.current_run_id ||
            transferredJobs.has(job.id)) &&
          job.authority.objective_revision === task.objective_revision,
      );
    const refs: ArtifactRef[] = [],
      deliveryIds: string[] = [];
    let cursor = 0,
      hasNewResult = false;
    for (const job of jobs) {
      if (resolvedJobs.has(job.id)) continue;
      if (
        this.store.db
          .prepare(
            'SELECT 1 FROM ns_result_consumptions WHERE chain_id=? AND job_id=? LIMIT 1',
          )
          .get(chain.id, job.id)
      )
        continue;
      // Enrollment records every acknowledged pending handle as well as the
      // terminal trigger. Optional work may complete while a successor runs.
      // Its original ownership stays intact and it must remain in that inbox.
      if (job.remote_id && !dependencies.has(job.id))
        dependencies.set(job.id, {
          job_id: job.id,
          required: false,
          source_wait_id: null,
          delivery_id: job.receipt?.artifact.id ?? null,
        });
      if (!this.terminal(job)) continue;
      if (job.receipt) {
        const artifact = this.store.artifact(
          job.receipt.artifact.id,
          task.identity,
          job.receipt.artifact,
        );
        artifactRefSchema.parse(job.receipt.artifact);
        if (
          artifact.task_id !== task.id ||
          artifact.run_id !== job.authority.run_id ||
          artifact.kind !== 'nightshift.candidate'
        )
          continue;
      }
      const eventCursor = this.resultCursor(job);
      cursor = Math.max(cursor, eventCursor);
      if (eventCursor > (progress?.progress.last_consumed_result_cursor ?? 0))
        hasNewResult = true;
      const dep = dependencies.get(job.id) ?? {
        job_id: job.id,
        required: false,
        source_wait_id: null,
        delivery_id: job.receipt?.artifact.id ?? null,
      };
      dependencies.set(job.id, dep);
      if (dep.delivery_id) deliveryIds.push(dep.delivery_id);
      if (job.receipt) refs.push(job.receipt.artifact);
    }
    return {
      cursor,
      delivery_ids: [...new Set(deliveryIds)].slice(0, 64),
      dependencies: [...dependencies.values()].slice(0, 64),
      refs,
      hasNewResult,
    };
  }
  private record(
    chain: NightshiftChain,
    task: TaskRecord,
    batch: Batch,
    state: AutomaticChainDecision['state'],
    code: string,
    reason: string,
    detail: { run_id?: string; sequence?: number } = {},
  ): AutomaticChainDecision {
    const existing = this.store.db
      .prepare(
        'SELECT body FROM automatic_chain_decisions WHERE chain_id=? AND predecessor_run_id=? AND objective_revision=?',
      )
      .get(chain.id, task.current_run_id, task.objective_revision) as
      Row | undefined;
    const prior = existing ? decisionSchema.parse(decode(existing)) : null;
    if (prior?.state === 'admitted') return prior;
    const value = decisionSchema.parse({
      schema_version: 'haze.nightshift.automatic.decision.v1',
      id: prior?.id ?? randomUUID(),
      chain_id: chain.id,
      task_id: task.id,
      predecessor_run_id: task.current_run_id,
      objective_revision: task.objective_revision,
      state,
      code,
      reason: reason.slice(0, 2000),
      trigger_cursor: batch.cursor,
      delivery_ids: batch.delivery_ids,
      dependencies: batch.dependencies,
      successor_run_id: detail.run_id ?? null,
      queue_sequence: detail.sequence ?? prior?.queue_sequence ?? null,
      actor: 'service:Nightshift',
      progress_fingerprint:
        this.store.nightshift.progress(chain.id, task.identity)?.fingerprint ??
        null,
      created_at: prior?.created_at ?? now(),
      updated_at: now(),
    });
    if (
      prior &&
      canonicalJson({ ...prior, updated_at: '' }) ===
        canonicalJson({ ...value, updated_at: '' })
    )
      return prior;
    this.store.db
      .prepare(
        'INSERT INTO automatic_chain_decisions VALUES(?,?,?,?,?) ON CONFLICT(chain_id,predecessor_run_id,objective_revision) DO UPDATE SET body=excluded.body',
      )
      .run(
        value.id,
        value.chain_id,
        value.predecessor_run_id,
        value.objective_revision,
        JSON.stringify(value),
      );
    return value;
  }
  private stopChain(
    chain: NightshiftChain,
    task: TaskRecord,
    batch: Batch,
    code: string,
    message: string,
    status: 'active' | 'paused' | 'closed' = 'paused',
  ): void {
    this.store.transaction(() => {
      const current = this.store.read(task.id, task.identity),
        currentChain = this.store.nightshift.chain(chain.id, task.identity);
      if (
        current.current_run_id !== task.current_run_id ||
        current.generation !== task.generation ||
        current.objective_revision !== task.objective_revision ||
        currentChain.revision !== chain.revision ||
        currentChain.status !== 'active'
      )
        return;
      this.store.nightshift.stopAutomatic(chain.id, {
        code,
        message,
        cursor: batch.cursor,
        refs: batch.refs,
        status,
      });
      this.record(chain, task, batch, 'stopped', code, message);
      if (status !== 'active')
        this.options.fenceTask?.(task.id, `${code}: ${message}`);
    });
  }
  decisions(chainId: string, identity: TaskIdentity): AutomaticChainDecision[] {
    this.store.nightshift.chain(chainId, identity);
    return (
      this.store.db
        .prepare(
          'SELECT body FROM automatic_chain_decisions WHERE chain_id=? ORDER BY rowid DESC LIMIT 100',
        )
        .all(chainId) as Row[]
    ).map((row) => decisionSchema.parse(decode(row)));
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stop.abort();
    await this.running;
    this.store.nightshift.configureAutomatic({
      enabled: false,
      evidence_id: null,
    });
  }
}
