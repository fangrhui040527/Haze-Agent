import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  TaskError,
  type TaskIdentity,
  type TaskRecord,
  type RunRecord,
} from '../contracts/tasks.js';
import type { ModelRouteSnapshot } from '../contracts/model-routes.js';
import { createOfflineRouteSnapshot } from '../contracts/model-routes.js';
import type { GraphLedger } from './graph-ledger.js';
import { graphThreadId } from './graph-ledger.js';
import type { ExternalWaitStore } from './external-wait-store.js';
import type { ModelRouteStore } from './model-route-store.js';
import type { NightshiftStore } from './nightshift-store.js';
import type { NightshiftProgressRecord } from '../contracts/nightshift-chains.js';

export interface LinkedRunDependency {
  job_id: string;
  required: boolean;
  source_wait_id: string | null;
  delivery_id: string | null;
}
export interface LinkedRunRequest {
  task_id: string;
  identity: TaskIdentity;
  predecessor_run_id: string;
  objective_revision: number;
  chain_id?: string;
  expected_chain_revision?: number;
  actor: { kind: 'user' | 'service'; id: string };
  mode: 'manual' | 'automatic';
  trigger_cursor: number;
  delivery_ids: string[];
  dependencies?: LinkedRunDependency[];
  purpose?: string;
  reason?: string;
  routeSnapshot?: ModelRouteSnapshot;
  progress?: NightshiftProgressRecord;
}
export type LinkedRunResult =
  | { run_id: string; reused: boolean; decision_id: string }
  | { waiting: true; sequence: number; reason: string };
interface LifecycleAccess {
  atomic<T>(operation: () => T): T;
  read(id: string, identity: TaskIdentity): TaskRecord;
  preparePredecessor(task: TaskRecord, automatic: boolean): void;
  initialize(taskId: string, runId: string): void;
  staleSources(taskId: string, identity: TaskIdentity): void;
  emit(
    taskId: string,
    type: string,
    actor: 'User' | 'Runtime',
    message: string,
    data: Record<string, string | number>,
  ): number;
  attach(request: LinkedRunRequest, runId: string): void;
  graph: GraphLedger;
  capacity: ExternalWaitStore;
  routes: ModelRouteStore;
  nightshift: NightshiftStore;
}

/** One server-owned admission path for user Continue and automatic successors. */
export class LinkedRunService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly access: LifecycleAccess,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS linked_run_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS linked_run_admissions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,chain_id TEXT,predecessor_run_id TEXT NOT NULL,objective_revision INTEGER NOT NULL,successor_run_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL,UNIQUE(task_id,predecessor_run_id,objective_revision));
      CREATE TRIGGER IF NOT EXISTS linked_run_admission_immutable_update BEFORE UPDATE ON linked_run_admissions BEGIN SELECT RAISE(ABORT,'Linked admission is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS linked_run_admission_immutable_delete BEFORE DELETE ON linked_run_admissions BEGIN SELECT RAISE(ABORT,'Linked admission is immutable'); END;`);
    const versions = db
      .prepare('SELECT version FROM linked_run_migrations')
      .all() as { version: number }[];
    if (versions.some((row) => row.version !== 1))
      throw new TaskError(
        409,
        'linked_run_schema_incompatible',
        'Unsupported linked-run migration.',
      );
    db.prepare('INSERT OR IGNORE INTO linked_run_migrations VALUES(1,?)').run(
      new Date().toISOString(),
    );
  }
  admit(request: LinkedRunRequest): LinkedRunResult {
    return this.access.atomic(() => {
      const task = this.access.read(request.task_id, request.identity);
      const prior = this.db
        .prepare(
          'SELECT body FROM linked_run_admissions WHERE task_id=? AND predecessor_run_id=? AND objective_revision=?',
        )
        .get(
          task.id,
          request.predecessor_run_id,
          request.objective_revision,
        ) as { body: string } | undefined;
      if (prior) {
        const value = JSON.parse(prior.body) as {
          run_id: string;
          decision_id: string;
          chain_id: string | null;
        };
        if (request.chain_id && value.chain_id !== request.chain_id)
          throw new TaskError(
            409,
            'linked_run_conflict',
            'A different chain owns this predecessor decision.',
          );
        return {
          run_id: value.run_id,
          decision_id: value.decision_id,
          reused: true,
        };
      }
      if (
        task.current_run_id !== request.predecessor_run_id ||
        task.objective_revision !== request.objective_revision
      )
        throw new TaskError(
          409,
          'stale_execution',
          'The linked-run predecessor or objective changed.',
        );
      const predecessor = task.runs.find(
        (run) => run.id === request.predecessor_run_id,
      )!;
      const automatic = request.mode === 'automatic';
      const continuation = this.access.nightshift.continuation(
        predecessor.id,
        automatic ? 'automatic' : 'manual',
      );
      if (request.chain_id && continuation?.chain_id !== request.chain_id)
        throw new TaskError(
          409,
          'nightshift_chain_mismatch',
          'The predecessor is not enrolled in this chain.',
        );
      if (continuation) {
        const chain = this.access.nightshift.chain(
          continuation.chain_id,
          request.identity,
        );
        if (
          request.expected_chain_revision !== undefined &&
          chain.revision !== request.expected_chain_revision
        )
          throw new TaskError(
            409,
            'nightshift_stale_chain',
            'Chain authority changed before linked admission.',
          );
        const attempts = this.db
          .prepare('SELECT body FROM attempts WHERE task_id=?')
          .all(task.id) as { body: string }[];
        const unknown = attempts.some((row) => {
          const a = JSON.parse(row.body) as { status: string };
          return ['started', 'unknown'].includes(a.status);
        });
        const unknownJob = this.access.nightshift
          .jobsForChain(chain.id, task.identity)
          .some((job) =>
            ['submitting', 'submission_unknown', 'unresolved'].includes(
              job.execution_state,
            ),
          );
        if (unknown || unknownJob)
          throw new TaskError(
            409,
            'nightshift_outcome_unknown',
            'Dispatched unknown outcomes remain charged; verified reconciliation is required.',
          );
        if (
          task.questions.some(
            (question) =>
              question.status === 'open' && question.run_id === predecessor.id,
          )
        )
          throw new TaskError(
            409,
            'question_unanswered',
            'Required user input blocks linked admission.',
          );
      }
      if (automatic) {
        if (request.actor.kind !== 'service' || !continuation)
          throw new TaskError(
            403,
            'automatic_authority_required',
            'Automatic admission requires server service authority and an opted-in chain.',
          );
        this.access.graph.assertVersion(predecessor.id);
        const progress = this.access.nightshift.progress(
          continuation.chain_id,
          task.identity,
        );
        if (
          !progress ||
          !request.progress ||
          progress.revision !== request.progress.revision ||
          progress.fingerprint !== request.progress.fingerprint ||
          request.purpose !== progress.progress.purpose
        )
          throw new TaskError(
            409,
            'nightshift_progress_stale',
            'The validated outstanding purpose changed before linked admission.',
          );
        const event = this.db
          .prepare(
            'SELECT job_id FROM automatic_chain_result_events WHERE event_cursor=?',
          )
          .get(request.trigger_cursor) as { job_id: string } | undefined;
        if (
          !event ||
          request.trigger_cursor <=
            progress.progress.last_consumed_result_cursor ||
          !request.dependencies?.some((dep) => dep.job_id === event.job_id)
        )
          throw new TaskError(
            409,
            'nightshift_new_result_required',
            'A new canonical terminal-result delivery is required before automatic admission.',
          );
        const resultJob = this.access.nightshift.job(
          event.job_id,
          task.identity,
        );
        const terminal =
          (resultJob.execution_state === 'completed' &&
            Boolean(resultJob.receipt)) ||
          ['failed', 'rejected'].includes(resultJob.execution_state) ||
          (resultJob.execution_state === 'cancelled' &&
            resultJob.cancellation.remote_termination_confirmed);
        const delegated = this.db
          .prepare(
            'SELECT 1 FROM ns_run_transfers WHERE target_run_id=? AND job_id=?',
          )
          .get(predecessor.id, resultJob.id);
        if (
          !terminal ||
          resultJob.chain_id !== continuation.chain_id ||
          resultJob.authority.objective_revision !== task.objective_revision ||
          (resultJob.authority.run_id !== predecessor.id && !delegated) ||
          this.db
            .prepare(
              'SELECT 1 FROM ns_result_consumptions WHERE chain_id=? AND job_id=?',
            )
            .get(continuation.chain_id, resultJob.id)
        )
          throw new TaskError(
            409,
            'nightshift_result_authority_invalid',
            'The terminal result is not outstanding for this exact predecessor.',
          );
        const previousAdmission = this.db
          .prepare(
            'SELECT body FROM linked_run_admissions WHERE chain_id=? ORDER BY rowid DESC LIMIT 1',
          )
          .get(continuation.chain_id) as { body: string } | undefined;
        if (previousAdmission) {
          const accepted = JSON.parse(previousAdmission.body) as {
            trigger_cursor: number;
            progress_fingerprint?: string;
          };
          if (
            accepted.trigger_cursor >= request.trigger_cursor &&
            accepted.progress_fingerprint === progress.fingerprint
          )
            throw new TaskError(
              409,
              'no_progress',
              'A repeated result and unchanged purpose cannot create another successor.',
            );
        }
        if (['paused', 'cancelled'].includes(predecessor.status))
          throw new TaskError(
            409,
            'automatic_predecessor_stopped',
            'Paused or cancelled authority cannot create an automatic successor.',
          );
        const withinDeadline =
          Date.now() < Date.parse(predecessor.limits.deadline);
        if (
          ['queued', 'running', 'waiting'].includes(predecessor.status) &&
          withinDeadline
        )
          throw new TaskError(
            409,
            'predecessor_active',
            'Keep results in the active run inbox.',
          );
        if (
          task.result?.currency === 'current' &&
          task.result.completion === 'full' &&
          ['supported', 'not_required'].includes(task.result.review.status)
        )
          throw new TaskError(
            409,
            'deliverables_completed',
            'Accepted requested deliverables close automatic admission.',
          );
        if (
          task.assignments.some(
            (a) =>
              a.run_id === predecessor.id &&
              (a.status === 'running' || Boolean(a.lease_token)),
          )
        )
          throw new TaskError(
            409,
            'predecessor_executing',
            'The predecessor still owns execution.',
          );
        if (
          this.access.graph
            .pending()
            .some(
              (job) =>
                job.run_id === predecessor.id && job.status === 'running',
            )
        )
          throw new TaskError(
            409,
            'predecessor_executing',
            'The predecessor graph is executing.',
          );
      } else if (
        !['completed', 'failed', 'timed_out', 'cancelled', 'paused'].includes(
          predecessor.status,
        )
      )
        throw new TaskError(
          409,
          'run_still_active',
          'Pause or finish predecessor before continuation.',
        );
      let ticket: number | undefined;
      if (automatic) {
        const capacity = this.access.capacity.continuationCapacity(
          {
            task_id: task.id,
            run_id: predecessor.id,
            generation: task.generation,
            objective_revision: task.objective_revision,
          },
          continuation!.chain_id,
          request.trigger_cursor,
        );
        if (!capacity.available)
          return {
            waiting: true,
            sequence: capacity.sequence,
            reason: 'Waiting for Haze capacity.',
          };
        ticket = capacity.sequence;
      } else this.access.capacity.assertCanAdmit();
      const createdAt = new Date().toISOString(),
        runId = randomUUID(),
        decisionId = randomUUID();
      if (ticket !== undefined) this.access.capacity.claimContinuation(ticket);
      this.access.preparePredecessor(task, automatic);
      const run: RunRecord = {
        id: runId,
        task_id: task.id,
        predecessor_run_id: predecessor.id,
        objective_revision: task.objective_revision,
        generation: task.generation + 1,
        state_revision: 1,
        status: 'queued',
        limits: continuation?.limits ?? {
          ...predecessor.limits,
          deadline: new Date(
            Date.now() +
              Math.max(
                1,
                Date.parse(predecessor.limits.deadline) -
                  Date.parse(predecessor.created_at),
              ),
          ).toISOString(),
        },
        usage: { model_calls: 0, tool_calls: 0, assignments: 0, artifacts: 0 },
        created_at: createdAt,
        updated_at: createdAt,
      };
      this.db
        .prepare('INSERT INTO runs VALUES(?,?,?)')
        .run(run.id, task.id, JSON.stringify(run));
      this.access.graph.register(run.id);
      this.access.routes.admit(
        task.id,
        run.id,
        continuation?.routes ??
          request.routeSnapshot ??
          this.access.routes.snapshot(predecessor.id) ??
          createOfflineRouteSnapshot(),
      );
      if (continuation)
        this.access.nightshift.enrollSuccessor(continuation.chain_id, run.id, {
          predecessor_run_id: predecessor.id,
          objective_revision: task.objective_revision,
          actor: request.actor.kind,
          mode: request.mode,
          reason: request.reason ?? request.purpose ?? 'Explicit continuation.',
          cursor: request.trigger_cursor,
          delivery_ids: request.delivery_ids,
        });
      const coreRow = this.db
        .prepare('SELECT body FROM tasks WHERE id=?')
        .get(task.id) as { body: string };
      const core = JSON.parse(coreRow.body) as {
        current_run_id: string;
        result?: { currency: string };
        updated_at: string;
      };
      core.current_run_id = run.id;
      core.updated_at = createdAt;
      if (core.result) core.result.currency = 'stale';
      this.db
        .prepare('UPDATE tasks SET body=? WHERE id=?')
        .run(JSON.stringify(core), task.id);
      this.access.initialize(task.id, run.id);
      this.access.staleSources(task.id, task.identity);
      if (ticket !== undefined)
        this.access.capacity.finishContinuation(ticket, run.id, {
          task_id: task.id,
          run_id: run.id,
          generation: run.generation,
          objective_revision: task.objective_revision,
        });
      this.access.capacity.acquire(
        {
          task_id: task.id,
          run_id: run.id,
          generation: run.generation,
          objective_revision: task.objective_revision,
        },
        `${request.mode} linked admission`,
      );
      this.access.attach(
        {
          ...request,
          ...(continuation ? { chain_id: continuation.chain_id } : {}),
        },
        run.id,
      );
      this.db
        .prepare('INSERT INTO linked_run_admissions VALUES(?,?,?,?,?,?,?)')
        .run(
          decisionId,
          task.id,
          continuation?.chain_id ?? null,
          predecessor.id,
          task.objective_revision,
          run.id,
          JSON.stringify({
            run_id: run.id,
            decision_id: decisionId,
            chain_id: continuation?.chain_id ?? null,
            actor: request.actor,
            mode: request.mode,
            trigger_cursor: request.trigger_cursor,
            delivery_ids: request.delivery_ids,
            purpose: request.purpose ?? null,
            progress_fingerprint: continuation
              ? (this.access.nightshift.progress(
                  continuation.chain_id,
                  task.identity,
                )?.fingerprint ?? null)
              : null,
            created_at: createdAt,
          }),
        );
      const cursor = this.access.emit(
        task.id,
        automatic ? 'chain_successor_admitted' : 'control_continue',
        automatic ? 'Runtime' : 'User',
        request.reason ?? 'Linked run admitted within existing authority.',
        {
          predecessor_run_id: predecessor.id,
          decision_id: decisionId,
          actor_kind: request.actor.kind,
          actor_id: request.actor.id,
          admission_mode: request.mode,
        },
      );
      this.access.graph.enqueue({
        task_id: task.id,
        run_id: run.id,
        generation: run.generation,
        objective_revision: task.objective_revision,
        kind: 'manager',
        thread_id: graphThreadId('manager', {
          task_id: task.id,
          run_id: run.id,
          generation: run.generation,
          objective_revision: task.objective_revision,
        }),
        cursor,
      });
      return { run_id: run.id, reused: false, decision_id: decisionId };
    });
  }
}
