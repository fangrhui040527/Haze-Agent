import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  TaskError,
  type Assignment,
  type TaskIdentity,
  type TaskRecord,
} from '../contracts/tasks.js';
import type { GraphAuthority } from './graph-ledger.js';
import type { NightshiftJob } from '../contracts/nightshift-records.js';
import type { NightshiftStore } from './nightshift-store.js';
import type { LinkedRunRequest } from './linked-run-service.js';

interface Transfer {
  id: string;
  chain_id: string;
  task_id: string;
  predecessor_run_id: string;
  target_run_id: string;
  objective_revision: number;
  job_id: string;
  required: boolean;
  source_wait_id: string | null;
  delivery_id: string | null;
  cursor: number;
  purpose: string;
}
interface Access {
  atomic<T>(operation: () => T): T;
  read(taskId: string, identity: TaskIdentity): TaskRecord;
  nightshift: NightshiftStore;
}
/** Explicit inbox delegation; the original job and historical candidate never change owner. */
export class NightshiftTransferStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly access: Access,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS ns_transfer_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ns_run_transfers(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,target_run_id TEXT NOT NULL,job_id TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(target_run_id,job_id));
      CREATE TABLE IF NOT EXISTS ns_transfer_bindings(transfer_id TEXT NOT NULL,assignment_id TEXT NOT NULL,assignment_revision INTEGER NOT NULL,generation INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(transfer_id,assignment_id,assignment_revision,generation));
      CREATE TABLE IF NOT EXISTS ns_transfer_resolutions(transfer_id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS ns_transfer_immutable_update BEFORE UPDATE ON ns_run_transfers BEGIN SELECT RAISE(ABORT,'Transfer provenance is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ns_transfer_immutable_delete BEFORE DELETE ON ns_run_transfers BEGIN SELECT RAISE(ABORT,'Transfer provenance is immutable'); END;`);
    const versions = db
      .prepare('SELECT version FROM ns_transfer_migrations')
      .all() as { version: number }[];
    if (versions.some((row) => row.version !== 1))
      throw new TaskError(
        409,
        'nightshift_transfer_schema_incompatible',
        'Unsupported transfer migration.',
      );
    db.prepare('INSERT OR IGNORE INTO ns_transfer_migrations VALUES(1,?)').run(
      new Date().toISOString(),
    );
  }
  private rows(runId: string): Transfer[] {
    return (
      this.db
        .prepare(
          'SELECT body FROM ns_run_transfers WHERE target_run_id=? ORDER BY rowid',
        )
        .all(runId) as { body: string }[]
    ).map((row) => JSON.parse(row.body) as Transfer);
  }
  attach(request: LinkedRunRequest, runId: string) {
    return this.access.atomic(() => this.attachEffect(request, runId));
  }
  private attachEffect(request: LinkedRunRequest, runId: string) {
    if (!request.chain_id) return;
    const task = this.access.read(request.task_id, request.identity),
      chain = this.access.nightshift.chain(request.chain_id, request.identity);
    if (
      task.current_run_id !== runId ||
      task.objective_revision !== request.objective_revision ||
      chain.task_id !== task.id
    )
      throw new TaskError(
        409,
        'nightshift_transfer_authority',
        'Transfer target is not the admitted successor.',
      );
    const dependencies = new Map(
      (request.dependencies ?? []).map((item) => [item.job_id, item]),
    );
    // Carry every unresolved predecessor dependency, including required jobs not
    // yet terminal. A successor cannot silently satisfy them by changing runs.
    const waits = this.db
      .prepare(
        'SELECT id,body FROM external_waits WHERE task_id=? ORDER BY rowid DESC',
      )
      .all(task.id) as { id: string; body: string }[];
    const seen = new Set<string>();
    const resolvedJobs = new Set<string>();
    for (const row of waits) {
      const wait = JSON.parse(row.body) as {
        authority: { run_id: string };
        dependencies: { job_id: string; required: boolean }[];
      };
      if (wait.authority.run_id !== request.predecessor_run_id) continue;
      for (const dep of wait.dependencies) {
        if (seen.has(dep.job_id)) continue;
        seen.add(dep.job_id);
        if (
          this.db
            .prepare(
              'SELECT 1 FROM external_dependency_resolutions WHERE wait_id=? AND job_id=?',
            )
            .get(row.id, dep.job_id)
        ) {
          const resolution = this.db
            .prepare(
              'SELECT body FROM external_dependency_resolutions WHERE wait_id=? AND job_id=?',
            )
            .get(row.id, dep.job_id) as { body: string };
          if (
            (JSON.parse(resolution.body) as { decision: string }).decision !==
            'reported_unresolved'
          ) {
            resolvedJobs.add(dep.job_id);
            dependencies.delete(dep.job_id);
            continue;
          }
        }
        const delivery = this.db
          .prepare(
            'SELECT id FROM external_result_deliveries WHERE wait_id=? AND job_id=?',
          )
          .get(row.id, dep.job_id) as { id: string } | undefined;
        const supplied = dependencies.get(dep.job_id);
        dependencies.set(dep.job_id, {
          job_id: dep.job_id,
          required: dep.required || Boolean(supplied?.required),
          source_wait_id: row.id,
          delivery_id: delivery?.id ?? supplied?.delivery_id ?? null,
        });
      }
    }
    for (const job of this.access.nightshift.jobsForChain(
      chain.id,
      request.identity,
    )) {
      if (
        job.authority.run_id !== request.predecessor_run_id ||
        !job.remote_id ||
        resolvedJobs.has(job.id) ||
        dependencies.has(job.id) ||
        this.db
          .prepare(
            'SELECT 1 FROM ns_result_consumptions WHERE chain_id=? AND job_id=?',
          )
          .get(chain.id, job.id)
      )
        continue;
      dependencies.set(job.id, {
        job_id: job.id,
        required: false,
        source_wait_id: null,
        delivery_id: job.receipt?.artifact.id ?? null,
      });
    }
    for (const previous of this.rows(request.predecessor_run_id)) {
      const resolution = this.db
        .prepare('SELECT body FROM ns_transfer_resolutions WHERE transfer_id=?')
        .get(previous.id) as { body: string } | undefined;
      if (
        !resolution ||
        (JSON.parse(resolution.body) as { decision: string }).decision ===
          'reported_unresolved'
      ) {
        const supplied = dependencies.get(previous.job_id);
        dependencies.set(previous.job_id, {
          job_id: previous.job_id,
          required: previous.required || Boolean(supplied?.required),
          source_wait_id: previous.source_wait_id,
          delivery_id: previous.delivery_id,
        });
      }
    }
    if (dependencies.size > 4)
      throw new TaskError(
        422,
        'nightshift_transfer_limit',
        'The original four-job grant bounds successor dependencies.',
      );
    for (const dep of dependencies.values()) {
      const job = this.access.nightshift.job(dep.job_id, request.identity);
      if (
        job.task_id !== task.id ||
        job.chain_id !== chain.id ||
        job.authority.objective_revision !== task.objective_revision
      )
        throw new TaskError(
          403,
          'nightshift_transfer_authority',
          'The job is outside the original chain objective.',
        );
      if (
        job.authority.run_id !== request.predecessor_run_id &&
        !this.db
          .prepare(
            'SELECT 1 FROM ns_run_transfers WHERE target_run_id=? AND job_id=?',
          )
          .get(request.predecessor_run_id, job.id)
      )
        throw new TaskError(
          403,
          'nightshift_transfer_predecessor',
          'The predecessor did not own this outstanding dependency.',
        );
      if (
        !job.remote_id ||
        ['submitting', 'submission_unknown', 'unresolved', 'rejected'].includes(
          job.execution_state,
        )
      )
        throw new TaskError(
          409,
          'nightshift_outcome_unknown',
          'Unknown submissions cannot transfer execution authority.',
        );
      if (
        dep.delivery_id &&
        dep.delivery_id !== job.receipt?.artifact.id &&
        !this.db
          .prepare(
            'SELECT 1 FROM external_result_deliveries WHERE id=? AND job_id=?',
          )
          .get(dep.delivery_id, job.id)
      )
        throw new TaskError(
          403,
          'nightshift_transfer_receipt_mismatch',
          'The claimed receipt does not belong to this exact job.',
        );
      if (dep.source_wait_id) {
        const source = this.db
          .prepare('SELECT body FROM external_waits WHERE id=? AND task_id=?')
          .get(dep.source_wait_id, task.id) as { body: string } | undefined;
        if (
          !source ||
          !(
            JSON.parse(source.body) as { dependencies: { job_id: string }[] }
          ).dependencies.some((item) => item.job_id === job.id)
        )
          throw new TaskError(
            403,
            'nightshift_transfer_source_mismatch',
            'The source wait does not own this job dependency.',
          );
      }
      const canonical = this.db
        .prepare(
          "SELECT cursor FROM events WHERE task_id=? AND json_extract(body,'$.type')='automatic_result_retained' AND json_extract(body,'$.data.job_id')=? ORDER BY cursor DESC LIMIT 1",
        )
        .get(task.id, job.id) as { cursor: number } | undefined;
      const transfer: Transfer = {
        id: randomUUID(),
        chain_id: chain.id,
        task_id: task.id,
        predecessor_run_id: request.predecessor_run_id,
        target_run_id: runId,
        objective_revision: task.objective_revision,
        job_id: job.id,
        required: dep.required,
        source_wait_id: dep.source_wait_id,
        delivery_id: dep.delivery_id,
        cursor: canonical?.cursor ?? request.trigger_cursor,
        purpose: request.purpose ?? 'Explicit continuation of unresolved work.',
      };
      this.db
        .prepare('INSERT OR IGNORE INTO ns_run_transfers VALUES(?,?,?,?,?)')
        .run(transfer.id, task.id, runId, job.id, JSON.stringify(transfer));
    }
  }
  bindAssignment(assignment: Assignment) {
    return this.access.atomic(() => this.bindAssignmentEffect(assignment));
  }
  private bindAssignmentEffect(assignment: Assignment) {
    if (
      !assignment.input ||
      typeof assignment.input !== 'object' ||
      Array.isArray(assignment.input)
    )
      return;
    const proposed = assignment.input.nightshift_job_ids;
    if (proposed === undefined) return;
    const ids = z.array(z.uuid()).min(1).max(4).parse(proposed);
    if (
      !assignment.tools.includes('nightshift.result') ||
      assignment.role === 'Manager'
    )
      throw new TaskError(
        403,
        'nightshift_transfer_grant',
        'A specialist result-tool grant is required for explicit inbox assignment.',
      );
    const transfers = this.rows(assignment.run_id);
    for (const id of ids) {
      const transfer = transfers.find(
        (item) =>
          item.job_id === id &&
          item.objective_revision === assignment.objective_revision,
      );
      if (!transfer)
        throw new TaskError(
          403,
          'nightshift_transfer_missing',
          'The Manager named a job not delegated to this run.',
        );
      this.db
        .prepare('INSERT OR IGNORE INTO ns_transfer_bindings VALUES(?,?,?,?,?)')
        .run(
          transfer.id,
          assignment.id,
          assignment.revision,
          assignment.generation,
          JSON.stringify({
            purpose: transfer.purpose,
            created_at: new Date().toISOString(),
          }),
        );
    }
  }
  authorized(
    authority: GraphAuthority,
    job: NightshiftJob,
    identity: TaskIdentity,
  ): boolean {
    const task = this.access.read(authority.task_id, identity);
    if (
      task.current_run_id !== authority.run_id ||
      task.generation !== authority.generation ||
      task.objective_revision !== authority.objective_revision ||
      !['queued', 'running'].includes(task.status) ||
      Date.parse(task.limits.deadline) <= Date.now()
    )
      return false;
    const assignment = task.assignments.find(
      (a) =>
        a.id === authority.assignment_id &&
        a.revision === authority.assignment_revision,
    );
    if (
      !assignment ||
      assignment.status !== 'running' ||
      !assignment.lease_token ||
      assignment.acknowledged_revision !== assignment.revision ||
      !task.permissions.tools.includes('nightshift.result') ||
      !assignment.tools.includes('nightshift.result')
    )
      return false;
    const transfer = this.rows(authority.run_id).find(
      (row) =>
        row.job_id === job.id &&
        row.objective_revision === authority.objective_revision,
    );
    if (!transfer) return false;
    const chain = this.access.nightshift.chain(transfer.chain_id, identity);
    if (chain.status !== 'active' || Date.parse(chain.expires_at) <= Date.now())
      return false;
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 FROM ns_transfer_bindings WHERE transfer_id=? AND assignment_id=? AND assignment_revision=? AND generation=?',
        )
        .get(
          transfer.id,
          assignment.id,
          assignment.revision,
          authority.generation,
        ),
    );
  }
  resolve(
    authority: GraphAuthority,
    jobId: string,
    identity: TaskIdentity,
    decision: string,
  ) {
    return this.access.atomic(() =>
      this.resolveEffect(authority, jobId, identity, decision),
    );
  }
  private resolveEffect(
    authority: GraphAuthority,
    jobId: string,
    identity: TaskIdentity,
    decision: string,
  ) {
    z.enum([
      'use_candidate',
      'partial_result',
      'supported_failure',
      'replan',
    ]).parse(decision);
    const job = this.access.nightshift.job(jobId, identity);
    if (!this.authorized(authority, job, identity))
      throw new TaskError(
        403,
        'nightshift_transfer_authority',
        'Result resolution requires an exact current leased transfer binding.',
      );
    const transfer = this.rows(authority.run_id).find(
      (row) => row.job_id === jobId,
    )!;
    const proof = this.db
      .prepare(
        "SELECT r.body FROM external_dependency_resolutions r JOIN external_waits w ON w.id=r.wait_id WHERE w.task_id=? AND r.job_id=? AND json_extract(w.body,'$.authority.run_id')=? AND json_extract(w.body,'$.authority.generation')=? AND json_extract(w.body,'$.authority.assignment_id')=? AND json_extract(w.body,'$.authority.assignment_revision')=? ORDER BY w.rowid DESC LIMIT 1",
      )
      .get(
        authority.task_id,
        jobId,
        authority.run_id,
        authority.generation,
        authority.assignment_id!,
        authority.assignment_revision!,
      ) as { body: string } | undefined;
    if (
      !proof ||
      (JSON.parse(proof.body) as { decision: string }).decision !== decision
    )
      throw new TaskError(
        409,
        'nightshift_transfer_resolution_unverified',
        'A controlled terminal-result decision must precede dependency resolution.',
      );
    this.db
      .prepare('INSERT OR IGNORE INTO ns_transfer_resolutions VALUES(?,?)')
      .run(
        transfer.id,
        JSON.stringify({ decision, authority, at: new Date().toISOString() }),
      );
  }
  assertFinalizable(authority: GraphAuthority) {
    for (const transfer of this.rows(authority.run_id))
      if (
        transfer.required &&
        !this.db
          .prepare('SELECT 1 FROM ns_transfer_resolutions WHERE transfer_id=?')
          .get(transfer.id)
      )
        throw new TaskError(
          409,
          'nightshift_required_transfer_pending',
          'Required predecessor work remains unresolved; consume it or record an explicit supported replanning decision.',
        );
  }
  /** Accepted Manager finalization may report a gap without consuming a pending result. */
  reportUnresolved(
    authority: GraphAuthority,
    identity: TaskIdentity,
    jobIds: string[],
    reason: string,
  ) {
    return this.access.atomic(() =>
      this.reportUnresolvedEffect(authority, identity, jobIds, reason),
    );
  }
  private reportUnresolvedEffect(
    authority: GraphAuthority,
    identity: TaskIdentity,
    jobIds: string[],
    reason: string,
  ) {
    const ids = z.array(z.uuid()).min(1).max(4).parse(jobIds);
    const task = this.access.read(authority.task_id, identity);
    const manager = task.assignments.find(
      (a) =>
        a.run_id === authority.run_id &&
        a.definition_id === 'core.manager.coordinator',
    );
    if (
      task.current_run_id !== authority.run_id ||
      task.generation !== authority.generation ||
      task.objective_revision !== authority.objective_revision ||
      !manager ||
      manager.status !== 'running' ||
      !manager.lease_token ||
      manager.generation !== authority.generation ||
      manager.acknowledged_revision !== manager.revision ||
      !task.permissions.tools.includes('nightshift.result') ||
      Date.parse(task.limits.deadline) <= Date.now()
    )
      throw new TaskError(
        403,
        'nightshift_gap_authority',
        'Reporting an unresolved dependency requires current Manager authority.',
      );
    const transfers = this.rows(authority.run_id);
    for (const id of ids) {
      const job = this.access.nightshift.job(id, identity),
        chain = this.access.nightshift.chain(job.chain_id, identity);
      if (
        job.task_id !== task.id ||
        chain.status !== 'active' ||
        chain.objective_revision !== task.objective_revision ||
        Date.parse(chain.expires_at) <= Date.now()
      )
        throw new TaskError(
          403,
          'nightshift_gap_authority',
          'The job is outside this current chain objective.',
        );
      const transfer = transfers.find((t) => t.job_id === id && t.required);
      const waits = (
        this.db
          .prepare(
            'SELECT id,body FROM external_waits WHERE task_id=? ORDER BY rowid DESC',
          )
          .all(task.id) as { id: string; body: string }[]
      ).filter((row) => {
        const wait = JSON.parse(row.body) as {
          authority: GraphAuthority;
          dependencies: { job_id: string; required: boolean }[];
        };
        return (
          wait.authority.run_id === authority.run_id &&
          wait.authority.generation === authority.generation &&
          wait.authority.objective_revision === authority.objective_revision &&
          wait.dependencies.some((dep) => dep.job_id === id && dep.required)
        );
      });
      if (!transfer && !waits.length)
        throw new TaskError(
          403,
          'nightshift_gap_dependency_missing',
          'Only exact required jobs may be reported as unresolved deliverables.',
        );
      const body = JSON.stringify({
        decision: 'reported_unresolved',
        reason,
        authority,
        at: new Date().toISOString(),
      });
      if (transfer)
        this.db
          .prepare('INSERT OR IGNORE INTO ns_transfer_resolutions VALUES(?,?)')
          .run(transfer.id, body);
      for (const wait of waits)
        this.db
          .prepare(
            'INSERT OR IGNORE INTO external_dependency_resolutions VALUES(?,?,?)',
          )
          .run(wait.id, id, body);
    }
  }
  replanAssignments(taskId: string, assignmentIds: string[], reason: string) {
    return this.access.atomic(() =>
      this.replanAssignmentsEffect(taskId, assignmentIds, reason),
    );
  }
  private replanAssignmentsEffect(
    taskId: string,
    assignmentIds: string[],
    reason: string,
  ) {
    for (const id of assignmentIds)
      for (const row of this.db
        .prepare(
          'SELECT transfer_id FROM ns_transfer_bindings WHERE assignment_id=?',
        )
        .all(id) as { transfer_id: string }[]) {
        const target = this.db
          .prepare('SELECT task_id FROM ns_run_transfers WHERE id=?')
          .get(row.transfer_id) as { task_id: string } | undefined;
        if (target?.task_id === taskId)
          this.db
            .prepare(
              'INSERT OR IGNORE INTO ns_transfer_resolutions VALUES(?,?)',
            )
            .run(
              row.transfer_id,
              JSON.stringify({
                decision: 'replan',
                reason,
                at: new Date().toISOString(),
              }),
            );
      }
  }
  inbox(taskId: string, identity: TaskIdentity) {
    const task = this.access.read(taskId, identity);
    return this.rows(task.current_run_id).map((transfer) => {
      const job = this.access.nightshift.job(transfer.job_id, identity);
      return {
        ...transfer,
        execution_state: job.execution_state,
        candidate: job.receipt?.artifact ?? null,
        input_refs: job.input_refs,
        original_authority: job.authority,
        resolved: Boolean(
          this.db
            .prepare(
              'SELECT 1 FROM ns_transfer_resolutions WHERE transfer_id=?',
            )
            .get(transfer.id),
        ),
        requires_independent_review: true,
      };
    });
  }
}
