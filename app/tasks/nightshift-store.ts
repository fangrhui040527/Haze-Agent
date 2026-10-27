import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  artifactSchema,
  type Artifact,
  type ArtifactRef,
  type JsonValue,
} from '../contracts/artifacts.js';
import { canonicalJson, contractHash } from '../contracts/json.js';
import type { ModelRouteSnapshot } from '../contracts/model-routes.js';
import type { AutomaticScope } from '../contracts/nightshift-automatic.js';
import {
  chainAdmissionSchema,
  chainControlSchema,
  chainProgressProposalSchema,
  jobSubmitSchema,
  jobCancelSchema,
  jobReconcileSchema,
  jobSelectSchema,
  NIGHTSHIFT_LIMITS,
  type NightshiftRemoteJob,
  type NightshiftRemoteOutcome,
  type NightshiftRemoteResult,
} from '../contracts/nightshift.js';
import {
  nightshiftChainSchema,
  nightshiftJobSchema,
  nightshiftSelectionSchema,
  type NightshiftChain,
  type NightshiftJob,
  type NightshiftSelection,
  type NightshiftEventPage,
} from '../contracts/nightshift-records.js';
import {
  nightshiftProgressSchema,
  nightshiftProgressRecordSchema,
  chainAutomationViewSchema,
  nightshiftSuccessorSchema,
  nightshiftStopSchema,
  type NightshiftProgress,
  type NightshiftProgressRecord,
  type NightshiftSuccessor,
  type NightshiftChainAutomationView,
} from '../contracts/nightshift-chains.js';
import { summarizeNightshiftJob } from '../contracts/nightshift-list.js';
import {
  TaskError,
  type TaskIdentity,
  type TaskRecord,
  type ResourceLimits,
  type RunRecord,
  type Assignment,
} from '../contracts/tasks.js';

interface TaskAccess {
  atomic<T>(operation: () => T): T;
  read(taskId: string, identity: TaskIdentity): TaskRecord;
  artifact(ref: ArtifactRef, identity: TaskIdentity): Artifact;
  historicalArtifact(ref: ArtifactRef, identity: TaskIdentity): Artifact;
  insertHistoricalArtifact(artifact: Artifact): void;
  routes(runId: string): ModelRouteSnapshot | null;
  applicable(taskId: string, ref: ArtifactRef, objective: number): boolean;
}
interface Authority {
  expected_run_id: string;
  expected_generation: number;
  expected_objective_revision: number;
  expected_state_revision: number;
  expected_assignment_id?: string | undefined;
  expected_assignment_revision?: number | undefined;
}
interface ServerGrant {
  identity: TaskIdentity;
  routes: ModelRouteSnapshot;
  run_limits: ResourceLimits;
  required_tools: string[];
  envelope: NightshiftChain['grant'];
  created_at: string;
  expires_at: string;
  original_run_id: string;
  objective_revision: number;
  run_duration_ms: number;
  admitted_actor?: { kind: 'user'; id: string };
  automatic_release_evidence_id?: string | null;
  previous_chain_id?: string;
}
export interface NightshiftAdapterIdentity {
  adapter_version: string;
  runtime_version: string | null;
  schema_hash: string;
}
export interface NightshiftSelectedDependency {
  selection_id: string;
  job_id: string;
  artifact: ArtifactRef;
  input_refs: ArtifactRef[];
  original_authority: NightshiftJob['authority'];
  requires_independent_review: true;
  candidate: true;
  judge_is_not_review: true;
  text?: string;
}
const at = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const semanticSet = (values: unknown[]) =>
  [
    ...new Map(values.map((value) => [canonicalJson(value), value])).values(),
  ].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
const refOf = ({ id, version, sha256 }: Artifact): ArtifactRef => ({
  id,
  version,
  sha256,
});
function legacyPolicyRequest(normalized: object, original: unknown) {
  if (
    original === null ||
    typeof original !== 'object' ||
    Object.hasOwn(original, 'privacy') ||
    Object.hasOwn(original, 'max_spend_usd')
  )
    return undefined;
  return { ...normalized, privacy: 'local-only', max_spend_usd: 0 };
}
function fail(code: string, message: string, status = 409): never {
  throw new TaskError(status, code, message);
}
const OPEN = ['active', 'paused'];
const TERMINAL = ['completed', 'failed', 'cancelled', 'rejected'];
const unknownOutcome = (): NightshiftRemoteOutcome => ({
  status: 'unknown',
  basis: null,
  explanation: null,
});

/** Task-owned durable grants and job inbox; it never invokes a provider or wakes a graph. */
export class NightshiftStore {
  private maximumJobs = 2;
  private maximumChains = 8;
  private automaticPolicy = {
    enabled: false,
    evidence_id: null as string | null,
    scope: null as AutomaticScope | null,
  };
  constructor(
    private readonly db: DatabaseSync,
    private readonly access: TaskAccess,
  ) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(
        'CREATE TABLE IF NOT EXISTS nightshift_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)',
      );
      const versions = db
        .prepare('SELECT version FROM nightshift_migrations')
        .all() as { version: number }[];
      if (versions.some((row) => row.version !== 1 && row.version !== 2))
        fail(
          'nightshift_schema_incompatible',
          'Unsupported Nightshift migration version.',
        );
      db.exec(`
        CREATE TABLE IF NOT EXISTS ns_chains(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,principal TEXT NOT NULL,workspace TEXT NOT NULL,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ns_grants(chain_id TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ns_chain_runs(run_id TEXT PRIMARY KEY,chain_id TEXT NOT NULL,ordinal INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ns_jobs(id TEXT PRIMARY KEY,chain_id TEXT NOT NULL,task_id TEXT NOT NULL,principal TEXT NOT NULL,workspace TEXT NOT NULL,remote_id TEXT UNIQUE,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ns_submission_attempts(job_id TEXT PRIMARY KEY,state TEXT NOT NULL,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ns_reservations(job_id TEXT PRIMARY KEY,chain_id TEXT NOT NULL,run_id TEXT NOT NULL,requested_attempts INTEGER NOT NULL,retention INTEGER NOT NULL,capacity_held INTEGER NOT NULL,charged INTEGER NOT NULL,consumed INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ns_observations(job_id TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(job_id,fingerprint));
        CREATE TABLE IF NOT EXISTS ns_deliveries(job_id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ns_selections(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,task_id TEXT NOT NULL,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ns_operations(scope TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(scope,key));
        CREATE TABLE IF NOT EXISTS ns_events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,chain_id TEXT NOT NULL,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ns_cancel_attempts(job_id TEXT PRIMARY KEY,attempted_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ns_policy_violations(job_id TEXT PRIMARY KEY,reason TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ns_successors(chain_id TEXT NOT NULL,predecessor_run_id TEXT NOT NULL,objective_revision INTEGER NOT NULL,run_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL,PRIMARY KEY(chain_id,predecessor_run_id,objective_revision));
        CREATE TABLE IF NOT EXISTS ns_progress(chain_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(chain_id,revision));
        CREATE TABLE IF NOT EXISTS ns_job_progress(job_id TEXT PRIMARY KEY,chain_id TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ns_result_consumptions(chain_id TEXT NOT NULL,run_id TEXT NOT NULL,job_id TEXT NOT NULL,cursor INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(chain_id,run_id,job_id));
        CREATE TABLE IF NOT EXISTS ns_chain_stops(id INTEGER PRIMARY KEY AUTOINCREMENT,chain_id TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(chain_id,fingerprint));
        CREATE TRIGGER IF NOT EXISTS ns_successors_immutable_update BEFORE UPDATE ON ns_successors BEGIN SELECT RAISE(ABORT,'Nightshift successor is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ns_successors_immutable_delete BEFORE DELETE ON ns_successors BEGIN SELECT RAISE(ABORT,'Nightshift successor is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ns_progress_immutable_update BEFORE UPDATE ON ns_progress BEGIN SELECT RAISE(ABORT,'Nightshift progress is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ns_progress_immutable_delete BEFORE DELETE ON ns_progress BEGIN SELECT RAISE(ABORT,'Nightshift progress is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ns_job_progress_immutable_update BEFORE UPDATE ON ns_job_progress BEGIN SELECT RAISE(ABORT,'Nightshift job progress is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ns_job_progress_immutable_delete BEFORE DELETE ON ns_job_progress BEGIN SELECT RAISE(ABORT,'Nightshift job progress is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ns_consumptions_immutable_update BEFORE UPDATE ON ns_result_consumptions BEGIN SELECT RAISE(ABORT,'Nightshift consumption is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ns_consumptions_immutable_delete BEFORE DELETE ON ns_result_consumptions BEGIN SELECT RAISE(ABORT,'Nightshift consumption is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ns_stops_immutable_update BEFORE UPDATE ON ns_chain_stops BEGIN SELECT RAISE(ABORT,'Nightshift stop record is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ns_stops_immutable_delete BEFORE DELETE ON ns_chain_stops BEGIN SELECT RAISE(ABORT,'Nightshift stop record is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ns_grants_immutable_update BEFORE UPDATE ON ns_grants BEGIN SELECT RAISE(ABORT,'Nightshift grant is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ns_grants_immutable_delete BEFORE DELETE ON ns_grants BEGIN SELECT RAISE(ABORT,'Nightshift grant is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ns_runs_immutable_update BEFORE UPDATE ON ns_chain_runs BEGIN SELECT RAISE(ABORT,'Nightshift run enrollment is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ns_runs_immutable_delete BEFORE DELETE ON ns_chain_runs BEGIN SELECT RAISE(ABORT,'Nightshift run enrollment is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ns_deliveries_immutable_update BEFORE UPDATE ON ns_deliveries BEGIN SELECT RAISE(ABORT,'Nightshift receipt is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ns_deliveries_immutable_delete BEFORE DELETE ON ns_deliveries BEGIN SELECT RAISE(ABORT,'Nightshift receipt is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ns_selections_immutable_update BEFORE UPDATE ON ns_selections BEGIN SELECT RAISE(ABORT,'Nightshift selection is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ns_selections_immutable_delete BEFORE DELETE ON ns_selections BEGIN SELECT RAISE(ABORT,'Nightshift selection is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ns_submission_body_immutable BEFORE UPDATE OF body ON ns_submission_attempts BEGIN SELECT RAISE(ABORT,'Nightshift original submission is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ns_submission_delete_immutable BEFORE DELETE ON ns_submission_attempts BEGIN SELECT RAISE(ABORT,'Nightshift original submission is immutable'); END;
      `);
      const tables: Record<string, string[]> = {
        nightshift_migrations: ['version', 'applied_at'],
        ns_chains: ['id', 'task_id', 'principal', 'workspace', 'body'],
        ns_grants: ['chain_id', 'body'],
        ns_chain_runs: ['run_id', 'chain_id', 'ordinal'],
        ns_jobs: [
          'id',
          'chain_id',
          'task_id',
          'principal',
          'workspace',
          'remote_id',
          'body',
        ],
        ns_submission_attempts: ['job_id', 'state', 'body'],
        ns_reservations: [
          'job_id',
          'chain_id',
          'run_id',
          'requested_attempts',
          'retention',
          'capacity_held',
          'charged',
          'consumed',
        ],
        ns_observations: ['job_id', 'fingerprint', 'body'],
        ns_deliveries: ['job_id', 'artifact_id', 'fingerprint', 'body'],
        ns_selections: ['id', 'job_id', 'task_id', 'body'],
        ns_operations: ['scope', 'key', 'fingerprint', 'receipt'],
        ns_events: ['cursor', 'job_id', 'chain_id', 'body'],
        ns_cancel_attempts: ['job_id', 'attempted_at'],
        ns_policy_violations: ['job_id', 'reason'],
        ns_successors: [
          'chain_id',
          'predecessor_run_id',
          'objective_revision',
          'run_id',
          'body',
        ],
        ns_progress: ['chain_id', 'revision', 'body'],
        ns_job_progress: ['job_id', 'chain_id', 'fingerprint', 'body'],
        ns_result_consumptions: [
          'chain_id',
          'run_id',
          'job_id',
          'cursor',
          'body',
        ],
        ns_chain_stops: ['id', 'chain_id', 'fingerprint', 'body'],
      };
      for (const [table, expected] of Object.entries(tables)) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
          name: string;
          type: string;
          pk: number;
          notnull: number;
        }[];
        if (
          columns.length !== expected.length ||
          columns.some(
            (column, index) =>
              column.name !== expected[index] ||
              !['TEXT', 'INTEGER'].includes(column.type.toUpperCase()) ||
              (index === 0 && column.pk !== 1) ||
              (index > 0 &&
                column.name !== 'remote_id' &&
                column.notnull !== 1),
          )
        )
          fail(
            'nightshift_schema_incompatible',
            'The Nightshift database schema is incompatible. Preserve this state for inspection.',
          );
      }
      db.prepare('INSERT OR IGNORE INTO nightshift_migrations VALUES(1,?)').run(
        at(),
      );
      db.prepare('INSERT OR IGNORE INTO nightshift_migrations VALUES(2,?)').run(
        at(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  configure(limits: { maxNonterminalJobs?: number; maxOpenChains?: number }) {
    for (const value of Object.values(limits))
      if (!Number.isSafeInteger(value) || value < 1 || value > 128)
        fail(
          'nightshift_invalid_limits',
          'External admission bounds must be integers from 1 to 128.',
          400,
        );
    this.maximumJobs = limits.maxNonterminalJobs ?? 2;
    this.maximumChains = limits.maxOpenChains ?? 8;
  }
  /** Server composition only. Browser and agent contracts cannot set this gate. */
  configureAutomatic(policy: {
    enabled: boolean;
    evidence_id: string | null;
    /** Released ceilings; absent only for trusted pre-scope (v1) injections. */
    scope?: AutomaticScope | null;
  }): void {
    if (
      policy.enabled &&
      (!policy.evidence_id || policy.evidence_id.length > 256)
    )
      fail(
        'nightshift_automatic_release_blocked',
        'Automatic mode requires trusted release evidence.',
        503,
      );
    this.automaticPolicy = clone({ ...policy, scope: policy.scope ?? null });
  }
  private requireAutomaticRelease() {
    if (!this.automaticPolicy.enabled || !this.automaticPolicy.evidence_id)
      fail(
        'nightshift_automatic_release_blocked',
        'Automatic mode is not released: prior live gates remain unmet.',
        503,
      );
  }
  /** Admission and successor dispatch both stay inside the released ceilings. */
  private requireAutomaticScope(grant: {
    privacy: string;
    total_runs: number;
    automatic_followup_runs: number;
    max_jobs: number;
    max_attempts: number;
    lifetime_seconds: number;
  }) {
    const scope = this.automaticPolicy.scope;
    if (!scope) return;
    const exceeded = [
      !(scope.privacy as string[]).includes(grant.privacy) && 'privacy',
      grant.total_runs > scope.max_total_runs && 'total_runs',
      grant.automatic_followup_runs > scope.max_automatic_followups &&
        'automatic_followup_runs',
      grant.max_jobs > scope.max_jobs && 'max_jobs',
      grant.max_attempts > scope.max_jobs * scope.max_attempts_per_job &&
        'max_attempts',
      grant.lifetime_seconds > scope.max_lifetime_seconds && 'lifetime_seconds',
    ].filter((item): item is string => !!item);
    if (exceeded.length)
      fail(
        'nightshift_automatic_scope_exceeded',
        `The released automatic scope does not cover: ${exceeded.join(', ')}.`,
        422,
      );
  }
  private operation<T>(
    identity: TaskIdentity,
    scope: string,
    key: string,
    input: unknown,
    execute: () => T,
  ): { value: T; reused: boolean } {
    if (!key || key.length > 256)
      fail(
        'idempotency_key_required',
        'Provide an idempotency key of at most 256 characters.',
        400,
      );
    const owner = canonicalJson([
      identity.principal,
      identity.workspace,
      scope,
    ]);
    const fingerprint = contractHash(input);
    const prior = this.db
      .prepare(
        'SELECT fingerprint,receipt FROM ns_operations WHERE scope=? AND key=?',
      )
      .get(owner, key) as { fingerprint: string; receipt: string } | undefined;
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        fail(
          'idempotency_conflict',
          'This key was used with different content.',
        );
      return { value: JSON.parse(prior.receipt) as T, reused: true };
    }
    const value = execute();
    this.db
      .prepare('INSERT INTO ns_operations VALUES(?,?,?,?)')
      .run(owner, key, fingerprint, JSON.stringify(value));
    return { value, reused: false };
  }
  private replay<T>(
    identity: TaskIdentity,
    scope: string,
    key: string,
    input: unknown,
    legacyInput?: unknown,
  ): T | null {
    if (!key || key.length > 256)
      fail(
        'idempotency_key_required',
        'Provide an idempotency key of at most 256 characters.',
        400,
      );
    const owner = canonicalJson([
      identity.principal,
      identity.workspace,
      scope,
    ]);
    const row = this.db
      .prepare(
        'SELECT fingerprint,receipt FROM ns_operations WHERE scope=? AND key=?',
      )
      .get(owner, key) as { fingerprint: string; receipt: string } | undefined;
    if (!row) return null;
    if (
      row.fingerprint !== contractHash(input) &&
      (legacyInput === undefined ||
        row.fingerprint !== contractHash(legacyInput))
    )
      fail('idempotency_conflict', 'This key was used with different content.');
    return JSON.parse(row.receipt) as T;
  }
  admissionForKey(
    value: unknown,
    key: string,
    identity: TaskIdentity,
    originalRaw: unknown = value,
  ): { chain: NightshiftChain; reused: true } | null {
    const request = chainAdmissionSchema.parse(value);
    const prior = this.replay<NightshiftChain>(
      identity,
      'nightshift-chain-admission',
      key,
      request,
      legacyPolicyRequest(request, originalRaw),
    );
    return prior
      ? { chain: this.chain(prior.id, identity), reused: true }
      : null;
  }
  submissionForKey(
    value: unknown,
    key: string,
    identity: TaskIdentity,
    originalRaw: unknown = value,
  ): { job: NightshiftJob; reused: true } | null {
    const request = jobSubmitSchema.parse(value);
    const prior = this.replay<NightshiftJob>(
      identity,
      `nightshift-job-submit:${request.chain_id}`,
      key,
      request,
      legacyPolicyRequest(request, originalRaw),
    );
    return prior ? { job: this.job(prior.id, identity), reused: true } : null;
  }
  reconciliationForKey(
    value: unknown,
    key: string,
    identity: TaskIdentity,
    id: string,
  ): NightshiftJob | null {
    const request = jobReconcileSchema.parse(value);
    const prior = this.replay<NightshiftJob>(
      identity,
      `nightshift-job-reconcile:${id}`,
      key,
      request,
    );
    return prior ? this.job(prior.id, identity) : null;
  }
  private rawChain(id: string, identity?: TaskIdentity): NightshiftChain {
    const row = this.db
      .prepare('SELECT principal,workspace,body FROM ns_chains WHERE id=?')
      .get(id) as
      { principal: string; workspace: string; body: string } | undefined;
    if (
      !row ||
      (identity &&
        (identity.principal !== row.principal ||
          identity.workspace !== row.workspace))
    )
      fail(
        'nightshift_chain_not_found',
        'Chain not found in this principal/workspace.',
        404,
      );
    return nightshiftChainSchema.parse(JSON.parse(row.body));
  }
  private serverGrant(id: string): ServerGrant {
    const row = this.db
      .prepare('SELECT body FROM ns_grants WHERE chain_id=?')
      .get(id) as { body: string };
    return JSON.parse(row.body) as ServerGrant;
  }
  private putChain(chain: NightshiftChain) {
    const grant = this.serverGrant(chain.id);
    if (
      canonicalJson(chain.grant) !== canonicalJson(grant.envelope) ||
      chain.expires_at !== grant.expires_at ||
      chain.original_run_id !== grant.original_run_id ||
      chain.objective_revision !== grant.objective_revision
    )
      fail(
        'nightshift_grant_immutable',
        'Immutable chain authority cannot be edited.',
      );
    this.db
      .prepare('UPDATE ns_chains SET body=? WHERE id=?')
      .run(JSON.stringify(chain), chain.id);
  }
  private rawJob(id: string, identity?: TaskIdentity): NightshiftJob {
    const row = this.db
      .prepare('SELECT principal,workspace,body FROM ns_jobs WHERE id=?')
      .get(id) as
      { principal: string; workspace: string; body: string } | undefined;
    if (
      !row ||
      (identity &&
        (identity.principal !== row.principal ||
          identity.workspace !== row.workspace))
    )
      fail(
        'nightshift_job_not_found',
        'Job not found in this principal/workspace.',
        404,
      );
    const job = nightshiftJobSchema.parse(JSON.parse(row.body));
    const original = this.db
      .prepare('SELECT body FROM ns_submission_attempts WHERE job_id=?')
      .get(id) as { body: string } | undefined;
    if (original) {
      const pinned = JSON.parse(original.body) as { original_job: unknown };
      if (
        canonicalJson(pinned.original_job) !==
        canonicalJson(this.immutableJob(job))
      )
        fail(
          'nightshift_job_authority_invalid',
          'Stored job authority differs from its immutable submission.',
        );
    }
    return job;
  }
  private immutableJob(job: NightshiftJob): unknown {
    return {
      id: job.id,
      task_id: job.task_id,
      chain_id: job.chain_id,
      authority: job.authority,
      prompt: job.prompt,
      input_refs: job.input_refs,
      route_id: job.route_id,
      options: job.options,
      request_fingerprint: job.request_fingerprint,
      adapter_version: job.adapter_version,
      runtime_version: job.runtime_version,
      schema_hash: job.schema_hash,
    };
  }
  private putJob(job: NightshiftJob) {
    nightshiftJobSchema.parse(job);
    const prior = this.rawJob(job.id);
    if (
      canonicalJson(this.immutableJob(prior)) !==
        canonicalJson(this.immutableJob(job)) ||
      (prior.remote_id !== null && prior.remote_id !== job.remote_id)
    )
      fail(
        'nightshift_job_authority_invalid',
        'Original submission and acknowledged mapping cannot be rewritten.',
      );
    job.revision++;
    job.updated_at = at();
    this.db
      .prepare('UPDATE ns_jobs SET remote_id=?,body=? WHERE id=?')
      .run(job.remote_id, JSON.stringify(job), job.id);
  }
  private event(
    job: NightshiftJob,
    type: string,
    message: string,
    data: JsonValue | null = null,
  ) {
    const body = {
      job_id: job.id,
      chain_id: job.chain_id,
      at: at(),
      type,
      message,
      data,
    };
    this.db
      .prepare('INSERT INTO ns_events(job_id,chain_id,body) VALUES(?,?,?)')
      .run(job.id, job.chain_id, JSON.stringify(body));
  }
  private current(
    taskId: string,
    identity: TaskIdentity,
    expected: Authority,
    deadline = true,
  ): TaskRecord {
    const task = this.access.read(taskId, identity);
    if (
      task.current_run_id !== expected.expected_run_id ||
      task.generation !== expected.expected_generation ||
      task.objective_revision !== expected.expected_objective_revision ||
      task.state_revision !== expected.expected_state_revision
    )
      fail(
        'stale_execution',
        'Task/run/objective/state authority has changed.',
      );
    if (deadline && Date.parse(task.limits.deadline) <= Date.now())
      fail('deadline_expired', 'Current task admission has expired.', 422);
    if (expected.expected_assignment_id) {
      const assignment = task.assignments.find(
        (item) =>
          item.id === expected.expected_assignment_id &&
          item.run_id === task.current_run_id,
      );
      if (
        !assignment ||
        assignment.revision !== expected.expected_assignment_revision ||
        assignment.objective_revision !== task.objective_revision ||
        ['cancelled', 'stale', 'failed', 'timed_out'].includes(
          assignment.status,
        )
      )
        fail('stale_execution', 'Assignment authority has changed.');
    } else if (expected.expected_assignment_revision !== undefined)
      fail(
        'invalid_assignment_authority',
        'Assignment revision needs an assignment identity.',
        400,
      );
    return task;
  }
  private requireChainRevision(chain: NightshiftChain, expected: number) {
    if (chain.revision !== expected)
      fail('nightshift_stale_chain', 'Chain revision has changed.');
  }
  private live(chain: NightshiftChain) {
    if (Date.parse(chain.expires_at) <= Date.now())
      fail(
        'nightshift_chain_expired',
        'The absolute chain expiry has passed.',
        422,
      );
    if (chain.status !== 'active')
      fail(
        'nightshift_chain_closed',
        'The chain is not open for new authority.',
        422,
      );
  }
  private refresh(chain: NightshiftChain): NightshiftChain {
    const admitted = this.serverGrant(chain.id);
    chain.grant = clone(admitted.envelope);
    chain.expires_at = admitted.expires_at;
    chain.created_at = admitted.created_at;
    chain.original_run_id = admitted.original_run_id;
    chain.objective_revision = admitted.objective_revision;
    const runs = this.db
      .prepare(
        'SELECT r.body FROM ns_chain_runs c JOIN runs r ON r.id=c.run_id WHERE c.chain_id=?',
      )
      .all(chain.id) as { body: string }[];
    const usage = {
      runs: runs.length,
      model_calls: 0,
      tool_calls: 0,
      assignments: 0,
      artifacts: 0,
      jobs: 0,
      requested_attempts: 0,
      retention_reserved: 0,
    };
    for (const row of runs) {
      const run = JSON.parse(row.body) as RunRecord;
      usage.model_calls += run.usage.model_calls;
      usage.tool_calls += run.usage.tool_calls;
      usage.assignments += run.usage.assignments;
      usage.artifacts += run.usage.artifacts;
    }
    const reservation = this.db
      .prepare(
        'SELECT COALESCE(SUM(charged),0) jobs,COALESCE(SUM(requested_attempts),0) requested_attempts,COALESCE(SUM(retention),0) retention_reserved,COALESCE(SUM(consumed),0) consumed FROM ns_reservations WHERE chain_id=?',
      )
      .get(chain.id) as {
      jobs: number;
      requested_attempts: number;
      retention_reserved: number;
      consumed: number;
    };
    usage.jobs = reservation.jobs;
    usage.requested_attempts = reservation.requested_attempts;
    usage.retention_reserved = reservation.retention_reserved;
    usage.artifacts += reservation.consumed;
    chain.usage = usage;
    chain.remaining = {
      runs: Math.max(0, chain.grant.total_runs - usage.runs),
      model_calls: Math.max(0, chain.grant.max_model_calls - usage.model_calls),
      tool_calls: Math.max(0, chain.grant.max_tool_calls - usage.tool_calls),
      assignments: Math.max(0, chain.grant.max_assignments - usage.assignments),
      artifacts: Math.max(
        0,
        chain.grant.max_artifacts -
          (usage.artifacts +
            reservation.retention_reserved -
            reservation.consumed),
      ),
      jobs: Math.max(0, chain.grant.max_jobs - usage.jobs),
      requested_attempts: Math.max(
        0,
        chain.grant.max_attempts - usage.requested_attempts,
      ),
      retention_reserved: 0,
    };
    if (
      OPEN.includes(chain.status) &&
      Date.parse(chain.expires_at) <= Date.now()
    ) {
      chain.status = 'expired';
      chain.stop_reason =
        'Absolute chain lifetime expired; outstanding reservations and receipts remain retained.';
    }
    return chain;
  }
  chain(id: string, identity: TaskIdentity): NightshiftChain {
    return clone(this.refresh(this.rawChain(id, identity)));
  }
  listChains(identity: TaskIdentity): NightshiftChain[] {
    return (
      this.db
        .prepare(
          "SELECT id FROM ns_chains WHERE principal=? AND workspace=? ORDER BY CASE WHEN json_extract(body,'$.status') IN ('active','paused') AND json_extract(body,'$.expires_at')>? THEN 0 ELSE 1 END,rowid DESC LIMIT 100",
        )
        .all(identity.principal, identity.workspace, at()) as { id: string }[]
    ).map((row) => this.chain(row.id, identity));
  }
  private enrolled(runId: string): NightshiftChain | null {
    const row = this.db
      .prepare('SELECT chain_id FROM ns_chain_runs WHERE run_id=?')
      .get(runId) as { chain_id: string } | undefined;
    return row ? this.refresh(this.rawChain(row.chain_id)) : null;
  }
  admitChain(
    value: unknown,
    key: string,
    identity: TaskIdentity,
    originalRaw: unknown = value,
  ): { chain: NightshiftChain; reused: boolean } {
    const request = chainAdmissionSchema.parse(value);
    const prior = this.admissionForKey(request, key, identity, originalRaw);
    if (prior) return prior;
    return this.access.atomic(() => {
      const result = this.operation(
        identity,
        'nightshift-chain-admission',
        key,
        request,
        () => {
          const task = this.current(request.task_id, identity, request);
          if (!['queued', 'running', 'waiting'].includes(task.status))
            fail(
              'nightshift_task_inactive',
              'A paused or terminal task cannot admit a new Nightshift chain.',
            );
          if (request.schema_version === 'haze.nightshift.chain.admission.v2') {
            this.requireAutomaticRelease();
            this.requireAutomaticScope(request);
            if (request.previous_chain_id) {
              const previous = this.refresh(
                this.rawChain(request.previous_chain_id, identity),
              );
              if (OPEN.includes(previous.status))
                fail(
                  'nightshift_previous_grant_open',
                  'Close the previous grant before separately admitting a larger new grant.',
                );
              if (previous.task_id === task.id)
                fail(
                  'nightshift_new_task_required',
                  'A larger grant requires separate explicit task admission and preserves the predecessor link.',
                );
            }
            if (!task.permissions.tools.includes('nightshift.result'))
              fail(
                'nightshift_result_grant_required',
                'Automatic admission requires an existing explicit task grant for nightshift.result.',
                403,
              );
            if (
              task.status === 'completed' &&
              task.result?.completion === 'full' &&
              ['supported', 'not_required'].includes(task.result.review.status)
            )
              fail(
                'nightshift_deliverables_completed',
                'Haze has already accepted the requested deliverables.',
              );
          }
          const routes = this.access.routes(task.current_run_id);
          if (!routes)
            fail(
              'model_route_upgrade_required',
              'A chain requires an admitted immutable role-route snapshot.',
            );
          const all = (
            this.db.prepare('SELECT id FROM ns_chains').all() as {
              id: string;
            }[]
          ).map((row) => this.refresh(this.rawChain(row.id)));
          if (
            all.some(
              (item) => item.task_id === task.id && OPEN.includes(item.status),
            )
          )
            fail(
              'nightshift_chain_exists',
              'This task already has an open Nightshift chain.',
            );
          if (
            this.db
              .prepare('SELECT run_id FROM ns_chain_runs WHERE run_id=?')
              .get(task.current_run_id)
          )
            fail(
              'nightshift_run_already_enrolled',
              'This run already belongs to an immutable grant. Explicitly admit a new task/run for increased authority.',
            );
          if (
            all.filter((item) => OPEN.includes(item.status)).length >=
            this.maximumChains
          )
            fail(
              'nightshift_chain_capacity',
              'Application-wide open chain capacity exhausted.',
              429,
            );
          const created = at();
          const counts = {
            runs: 1,
            model_calls: 0,
            tool_calls: 0,
            assignments: 0,
            artifacts: 0,
            jobs: 0,
            requested_attempts: 0,
            retention_reserved: 0,
          };
          const chain: NightshiftChain = {
            schema_version:
              request.schema_version === 'haze.nightshift.chain.admission.v2'
                ? 'haze.nightshift.chain.v2'
                : 'haze.nightshift.chain.v1',
            id: randomUUID(),
            task_id: task.id,
            revision: 1,
            status: 'active',
            created_at: created,
            expires_at: new Date(
              Date.now() + request.lifetime_seconds * 1000,
            ).toISOString(),
            original_run_id: task.current_run_id,
            objective_revision: task.objective_revision,
            grant: {
              total_runs: request.total_runs,
              max_jobs: request.max_jobs,
              max_attempts: request.max_attempts,
              automatic_followup_runs: request.automatic_followup_runs,
              privacy: request.privacy,
              max_spend_usd: request.max_spend_usd,
              max_model_calls: task.limits.max_model_calls * request.total_runs,
              max_tool_calls: task.limits.max_tool_calls * request.total_runs,
              max_assignments: task.limits.max_assignments * request.total_runs,
              max_artifacts: task.limits.max_artifacts * request.total_runs,
              route_ids: Object.fromEntries(
                Object.entries(routes.routes).map(([role, route]) => [
                  role,
                  route.route_id,
                ]),
              ) as NightshiftChain['grant']['route_ids'],
            },
            usage: counts,
            remaining: counts,
            stop_reason: null,
          };
          nightshiftChainSchema.parse(chain);
          this.db
            .prepare('INSERT INTO ns_chains VALUES(?,?,?,?,?)')
            .run(
              chain.id,
              task.id,
              identity.principal,
              identity.workspace,
              JSON.stringify(chain),
            );
          this.db.prepare('INSERT INTO ns_grants VALUES(?,?)').run(
            chain.id,
            JSON.stringify({
              identity: clone(identity),
              routes,
              run_limits: task.limits,
              required_tools: task.permissions.tools,
              envelope: chain.grant,
              created_at: chain.created_at,
              expires_at: chain.expires_at,
              original_run_id: chain.original_run_id,
              objective_revision: chain.objective_revision,
              run_duration_ms: Math.max(
                1,
                Date.parse(task.limits.deadline) -
                  Date.parse(
                    task.runs.find((run) => run.id === task.current_run_id)!
                      .created_at,
                  ),
              ),
              admitted_actor: { kind: 'user', id: identity.principal },
              automatic_release_evidence_id:
                request.schema_version === 'haze.nightshift.chain.admission.v2'
                  ? this.automaticPolicy.evidence_id
                  : null,
              ...(request.schema_version ===
                'haze.nightshift.chain.admission.v2' &&
              request.previous_chain_id
                ? { previous_chain_id: request.previous_chain_id }
                : {}),
            } satisfies ServerGrant),
          );
          this.db
            .prepare('INSERT INTO ns_chain_runs VALUES(?,?,1)')
            .run(task.current_run_id, chain.id);
          if (request.schema_version === 'haze.nightshift.chain.admission.v2')
            this.acceptProgress(
              chain,
              task,
              request.initial_progress,
              identity,
              'user',
              true,
            );
          return this.refresh(chain);
        },
      );
      return {
        chain: result.reused
          ? this.chain(result.value.id, identity)
          : result.value,
        reused: result.reused,
      };
    });
  }
  controlChain(
    id: string,
    value: unknown,
    key: string,
    identity: TaskIdentity,
  ): NightshiftChain {
    const request = chainControlSchema.parse(value);
    return this.access.atomic(
      () =>
        this.operation(identity, `nightshift-chain:${id}`, key, request, () => {
          const chain = this.rawChain(id, identity);
          this.current(chain.task_id, identity, request, false);
          this.requireChainRevision(chain, request.expected_chain_revision);
          if (request.action === 'resume') {
            if (chain.status !== 'paused')
              fail(
                'nightshift_chain_closed',
                'Only a paused chain can resume.',
              );
            if (Date.parse(chain.expires_at) <= Date.now())
              fail(
                'nightshift_chain_expired',
                'Resume cannot refresh the chain expiry.',
                422,
              );
            if (this.hasUnknownOutcome(chain))
              fail(
                'nightshift_unknown_outcome',
                'Verified reconciliation is required before resuming automatic chain authority.',
              );
            if (
              chain.schema_version === 'haze.nightshift.chain.v2' &&
              chain.stop_reason?.startsWith('no_progress:')
            )
              fail(
                'nightshift_no_progress',
                'Resume cannot replace a validated refinement proposal. Provide supported changed inputs, an independent review objection or a changed failure cause.',
              );
            chain.status = 'active';
            chain.stop_reason = null;
          } else if (request.action === 'pause') {
            if (!OPEN.includes(chain.status))
              fail('nightshift_chain_closed', 'The chain is already closed.');
            chain.status = 'paused';
            if (!chain.stop_reason?.startsWith('no_progress:'))
              chain.stop_reason = 'Manual submission paused.';
          } else {
            chain.status = 'closed';
            chain.stop_reason =
              request.action === 'cancel'
                ? 'User cancelled the chain; remote termination remains unconfirmed.'
                : 'User closed the chain.';
            this.recordControlStop(
              chain,
              request.action === 'cancel' ? 'chain_cancelled' : 'chain_closed',
              chain.stop_reason,
            );
            if (request.action === 'cancel') this.cancelKnown(chain.id);
          }
          chain.revision++;
          this.putChain(chain);
          return this.refresh(chain);
        }).value,
    );
  }
  reserveJob(
    value: unknown,
    key: string,
    identity: TaskIdentity,
    adapter: NightshiftAdapterIdentity,
    idempotencyRequest?: unknown,
  ): { job: NightshiftJob; reused: boolean } {
    const request = jobSubmitSchema.parse(value);
    const original =
      idempotencyRequest === undefined
        ? request
        : jobSubmitSchema.parse(idempotencyRequest);
    const replay = this.submissionForKey(
      original,
      key,
      identity,
      idempotencyRequest === undefined ? value : idempotencyRequest,
    );
    if (replay) return replay;
    this.assertJobProgress(
      request.chain_id,
      identity,
      request.input_refs,
      request.purpose,
    );
    return this.access.atomic(() => {
      const result = this.operation(
        identity,
        `nightshift-job-submit:${request.chain_id}`,
        key,
        original,
        () => {
          const chain = this.refresh(this.rawChain(request.chain_id, identity));
          this.live(chain);
          this.requireChainRevision(chain, request.expected_chain_revision);
          if (
            request.privacy !== chain.grant.privacy ||
            request.max_spend_usd !== chain.grant.max_spend_usd
          )
            fail(
              'nightshift_job_policy_mismatch',
              'The job privacy and monetary policy must match its immutable chain grant.',
              403,
            );
          const task = this.current(chain.task_id, identity, request);
          if (!['queued', 'running', 'waiting'].includes(task.status))
            fail(
              'nightshift_task_inactive',
              'A paused or terminal task cannot submit a new Nightshift job.',
            );
          if (task.objective_revision !== chain.objective_revision)
            fail(
              'nightshift_objective_changed',
              'The chain was admitted for a different objective.',
            );
          if (
            !this.db
              .prepare(
                'SELECT run_id FROM ns_chain_runs WHERE run_id=? AND chain_id=?',
              )
              .get(task.current_run_id, chain.id)
          )
            fail(
              'nightshift_run_not_enrolled',
              'The submitting run is not enrolled in this grant.',
            );
          if (
            !chain.remaining.jobs ||
            chain.remaining.requested_attempts < request.n
          )
            fail(
              'nightshift_job_grant_exhausted',
              'The job or requested-attempt grant is exhausted.',
              422,
            );
          const capacity = this.db
            .prepare(
              'SELECT COALESCE(SUM(capacity_held),0) count FROM ns_reservations',
            )
            .get() as { count: number };
          if (capacity.count >= this.maximumJobs)
            fail(
              'nightshift_job_capacity',
              'Application-wide nonterminal external-job capacity exhausted.',
              429,
            );
          const scope = this.automaticPolicy.scope;
          if (chain.schema_version === 'haze.nightshift.chain.v2' && scope) {
            if (request.n > scope.max_attempts_per_job)
              fail(
                'nightshift_automatic_scope_exceeded',
                `The released automatic scope allows ${scope.max_attempts_per_job} attempt(s) per job.`,
                422,
              );
            const held = this.db
              .prepare(
                'SELECT COALESCE(SUM(capacity_held),0) count FROM ns_reservations WHERE chain_id=?',
              )
              .get(chain.id) as { count: number };
            if (held.count >= scope.max_concurrent_jobs)
              fail(
                'nightshift_automatic_concurrency',
                `The released automatic scope allows ${scope.max_concurrent_jobs} concurrent native job(s) per chain.`,
                429,
              );
          }
          for (const ref of request.input_refs) {
            this.access.artifact(ref, identity);
            if (!this.access.applicable(task.id, ref, task.objective_revision))
              fail(
                'artifact_not_applicable',
                'Each input requires a current exact applicability check.',
              );
          }
          if (!chain.remaining.artifacts)
            fail(
              'nightshift_retention_exhausted',
              'No original artifact-retention allowance remains.',
              422,
            );
          const reserved = this.retentionForRun(task.current_run_id);
          if (task.usage.artifacts + reserved >= task.limits.max_artifacts)
            fail(
              'nightshift_retention_exhausted',
              'The submitting run has no artifact-retention capacity.',
              422,
            );
          const routes = this.serverGrant(chain.id).routes;
          const route = routes.routes[request.role];
          const created = at();
          const job: NightshiftJob = {
            schema_version: 'haze.nightshift.job.v1',
            id: randomUUID(),
            task_id: task.id,
            chain_id: chain.id,
            revision: 1,
            created_at: created,
            updated_at: created,
            authority: {
              run_id: task.current_run_id,
              generation: task.generation,
              objective_revision: task.objective_revision,
              assignment_id: request.expected_assignment_id ?? null,
              assignment_revision: request.expected_assignment_revision ?? null,
            },
            prompt: request.prompt,
            input_refs: clone(request.input_refs),
            route_id: route.route_id,
            options: {
              n: request.n,
              judge: request.judge,
              budget: request.budget,
              window: request.window,
              fleet: request.fleet ?? null,
              privacy: request.privacy,
              max_spend_usd: request.max_spend_usd,
            },
            request_fingerprint: contractHash({
              request,
              route_id: route.route_id,
              adapter,
            }),
            ...adapter,
            execution_state: 'submitting',
            remote_id: null,
            progress: { generated: null, requested_attempts: request.n },
            judge_outcome: unknownOutcome(),
            receipt: null,
            retrieval_error: null,
            cancellation: {
              requested: false,
              acknowledged: false,
              remote_termination_confirmed: false,
            },
            candidate: true,
            review_status: 'unreviewed',
            selections: [],
            next_poll_at: null,
            read_failures: 0,
          };
          nightshiftJobSchema.parse(job);
          this.db
            .prepare('INSERT INTO ns_jobs VALUES(?,?,?,?,?,?,?)')
            .run(
              job.id,
              chain.id,
              task.id,
              identity.principal,
              identity.workspace,
              null,
              JSON.stringify(job),
            );
          this.db
            .prepare('INSERT INTO ns_submission_attempts VALUES(?,?,?)')
            .run(
              job.id,
              'intent',
              JSON.stringify({
                job_id: job.id,
                fingerprint: job.request_fingerprint,
                authority: job.authority,
                route_id: job.route_id,
                original_job: this.immutableJob(job),
                at: created,
              }),
            );
          this.db
            .prepare('INSERT INTO ns_reservations VALUES(?,?,?,?,?,?,?,0)')
            .run(job.id, chain.id, task.current_run_id, request.n, 1, 1, 1);
          if (chain.schema_version === 'haze.nightshift.chain.v2') {
            const progress = this.progress(chain.id, identity)!;
            this.db.prepare('INSERT INTO ns_job_progress VALUES(?,?,?,?)').run(
              job.id,
              chain.id,
              this.progressFingerprint(progress.progress, identity, false),
              JSON.stringify({
                purpose: progress.progress.purpose,
                progress_revision: progress.revision,
                input_refs: job.input_refs,
              }),
            );
          }
          this.db
            .prepare('INSERT INTO ns_policy_violations VALUES(?,?)')
            .run(job.id, 'policy_not_yet_verified');
          chain.revision++;
          this.putChain(chain);
          this.event(
            job,
            'submission_intent',
            'Submission intent and original retention/attempt/capacity reservations committed.',
          );
          return job;
        },
      );
      return {
        job: result.reused ? this.job(result.value.id, identity) : result.value,
        reused: result.reused,
      };
    });
  }
  job(id: string, identity: TaskIdentity): NightshiftJob {
    return clone(this.rawJob(id, identity));
  }
  jobs(identity: TaskIdentity): NightshiftJob[] {
    return (
      this.db
        .prepare(
          'SELECT id FROM ns_jobs WHERE principal=? AND workspace=? ORDER BY rowid DESC LIMIT 100',
        )
        .all(identity.principal, identity.workspace) as { id: string }[]
    ).map((row) => this.job(row.id, identity));
  }
  jobsForChain(chainId: string, identity: TaskIdentity): NightshiftJob[] {
    this.rawChain(chainId, identity);
    return (
      this.db
        .prepare(
          'SELECT j.id FROM ns_jobs j JOIN ns_reservations r ON r.job_id=j.id WHERE j.chain_id=? AND r.charged=1 ORDER BY j.rowid LIMIT 4',
        )
        .all(chainId) as { id: string }[]
    ).map((row) => this.rawJob(row.id, identity));
  }
  jobSummaries(identity: TaskIdentity) {
    return (
      this.db
        .prepare(
          'SELECT id FROM ns_jobs WHERE principal=? AND workspace=? ORDER BY rowid DESC LIMIT 100',
        )
        .all(identity.principal, identity.workspace) as { id: string }[]
    ).map((row) => summarizeNightshiftJob(this.job(row.id, identity)));
  }
  observableJobs(): NightshiftJob[] {
    return (
      this.db
        .prepare(
          "SELECT id FROM ns_jobs WHERE remote_id IS NOT NULL AND (json_extract(body,'$.execution_state') NOT IN ('completed','failed','cancelled','rejected') OR json_extract(body,'$.receipt') IS NULL OR json_extract(body,'$.judge_outcome.status') IN ('unknown','undecided')) AND (json_extract(body,'$.next_poll_at') IS NULL OR json_extract(body,'$.next_poll_at')<=?) ORDER BY CASE WHEN json_extract(body,'$.cancellation.requested')=1 AND json_extract(body,'$.cancellation.acknowledged')=0 THEN 0 ELSE 1 END, COALESCE(json_extract(body,'$.next_poll_at'),json_extract(body,'$.updated_at')) LIMIT 64",
        )
        .all(at()) as { id: string }[]
    ).map((row) => this.rawJob(row.id));
  }
  schedulePoll(id: string, nextPollAt: string): void {
    this.access.atomic(() => {
      const job = this.rawJob(id);
      job.next_poll_at = nextPollAt;
      this.db
        .prepare('UPDATE ns_jobs SET body=? WHERE id=?')
        .run(JSON.stringify(job), id);
    });
  }
  markDispatched(id: string): void {
    this.access.atomic(() => {
      const job = this.rawJob(id);
      if (job.remote_id || job.execution_state !== 'submitting')
        fail('nightshift_dispatch_fenced', 'Submission cannot be repeated.');
      const dispatch = this.db
        .prepare(
          'UPDATE ns_submission_attempts SET state=? WHERE job_id=? AND state=?',
        )
        .run('dispatched', id, 'intent');
      if (Number(dispatch.changes) !== 1)
        fail('nightshift_dispatch_fenced', 'Submission cannot be repeated.');
      this.event(
        job,
        'submission_dispatched',
        'Dispatch started; a missing acknowledgement must remain unknown.',
      );
    });
  }
  recoverIntents(): void {
    this.access.atomic(() => {
      for (const row of this.db
        .prepare('SELECT id FROM ns_jobs WHERE remote_id IS NULL')
        .all() as { id: string }[]) {
        const job = this.rawJob(row.id);
        if (job.execution_state === 'submitting')
          this.submissionUnknown(job.id);
      }
    });
  }
  submissionUnknown(id: string): NightshiftJob {
    return this.access.atomic(() => {
      const job = this.rawJob(id);
      if (job.remote_id) return job;
      if (job.execution_state === 'rejected') return job;
      job.execution_state = 'submission_unknown';
      job.retrieval_error = {
        code: 'submission_unknown',
        message:
          'Submission outcome is unknown. Reservations remain held; explicit verified reconciliation is required.',
      };
      this.db
        .prepare('UPDATE ns_submission_attempts SET state=? WHERE job_id=?')
        .run('unknown', id);
      this.putJob(job);
      this.event(job, 'submission_unknown', job.retrieval_error.message);
      return job;
    });
  }
  acknowledge(id: string, remoteId: string): NightshiftJob {
    return this.access.atomic(() => {
      const job = this.rawJob(id);
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/u.test(remoteId))
        fail(
          'nightshift_invalid_remote_id',
          'Invalid acknowledgement identity.',
        );
      if (job.remote_id && job.remote_id !== remoteId)
        fail(
          'nightshift_remote_identity_conflict',
          'Remote identity already pinned.',
        );
      const other = this.db
        .prepare('SELECT id FROM ns_jobs WHERE remote_id=? AND id<>?')
        .get(remoteId, id);
      if (other)
        fail(
          'nightshift_remote_identity_conflict',
          'Remote job already belongs to another local handle.',
        );
      if (job.remote_id === remoteId) return job;
      job.remote_id = remoteId;
      job.execution_state = 'queued';
      if (
        !this.db
          .prepare('SELECT job_id FROM ns_policy_violations WHERE job_id=?')
          .get(id)
      )
        job.retrieval_error = null;
      this.db
        .prepare('UPDATE ns_submission_attempts SET state=? WHERE job_id=?')
        .run('acknowledged', id);
      this.putJob(job);
      this.event(
        job,
        'submission_acknowledged',
        'Remote acknowledgement durably pinned.',
      );
      return job;
    });
  }
  rejectBeforeAcceptance(id: string, reason: string): NightshiftJob {
    return this.access.atomic(() => {
      const job = this.rawJob(id);
      if (job.remote_id)
        fail(
          'nightshift_rejection_conflict',
          'An acknowledged remote job cannot release reservations as pre-acceptance rejection.',
        );
      job.execution_state = 'rejected';
      job.retrieval_error = {
        code: 'submission_rejected',
        message: reason.slice(0, 1000),
      };
      this.db
        .prepare(
          'UPDATE ns_reservations SET requested_attempts=0,retention=0,capacity_held=0,charged=0 WHERE job_id=?',
        )
        .run(id);
      this.db
        .prepare('UPDATE ns_submission_attempts SET state=? WHERE job_id=?')
        .run('rejected', id);
      this.putJob(job);
      this.event(
        job,
        'submission_rejected',
        'Verified rejection before remote acceptance released its reservations.',
      );
      return job;
    });
  }
  observation(
    id: string,
    remoteId: string,
    remote: NightshiftRemoteJob,
    outcome?: NightshiftRemoteOutcome,
  ): NightshiftJob {
    return this.access.atomic(() => {
      const job = this.rawJob(id);
      this.remoteMatches(job, remoteId);
      if (remote.remote_id !== remoteId)
        fail(
          'nightshift_remote_identity_conflict',
          'Observation identity differs from the acknowledged job.',
        );
      const fingerprint = contractHash({ remote, outcome: outcome ?? null });
      if (
        this.db
          .prepare(
            'SELECT job_id FROM ns_observations WHERE job_id=? AND fingerprint=?',
          )
          .get(id, fingerprint)
      )
        return job;
      this.db
        .prepare('INSERT INTO ns_observations VALUES(?,?,?)')
        .run(
          id,
          fingerprint,
          JSON.stringify({ remote, outcome: outcome ?? null, at: at() }),
        );
      const native =
        'native_execution_state' in remote
          ? remote.native_execution_state
          : undefined;
      const code = 'failure_code' in remote ? remote.failure_code : undefined;
      const diagnostic = (value: unknown): string | null =>
        typeof value === 'string' && /^[a-z][a-z0-9_-]{0,127}$/u.test(value)
          ? value
          : null;
      if (native !== undefined || code !== undefined)
        job.remote_diagnostic = {
          execution_state:
            diagnostic(native) ??
            job.remote_diagnostic?.execution_state ??
            null,
          failure_code:
            diagnostic(code) ?? job.remote_diagnostic?.failure_code ?? null,
        };
      const originalState = job.execution_state;
      const wasTerminal =
        TERMINAL.includes(originalState) &&
        job.cancellation.remote_termination_confirmed;
      const state = remote.execution_state;
      const allowed = ['queued', 'running', 'completed', 'failed', 'cancelled'];
      job.execution_state = allowed.includes(state)
        ? (state as NightshiftJob['execution_state'])
        : 'unresolved';
      if (!remote.terminal && TERMINAL.includes(job.execution_state)) {
        job.execution_state = 'unresolved';
        job.retrieval_error = {
          code: 'terminal_not_verified',
          message:
            'A terminal label without verified terminal state cannot release capacity.',
        };
      }
      if (wasTerminal && !remote.terminal) job.execution_state = originalState;
      if (
        remote.privacy !== job.options.privacy ||
        (remote.requested_attempts !== null &&
          remote.requested_attempts !== job.options.n)
      ) {
        this.db
          .prepare(
            'INSERT INTO ns_policy_violations VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET reason=excluded.reason WHERE ns_policy_violations.reason<>?',
          )
          .run(
            id,
            remote.privacy === null
              ? 'policy_not_yet_verified'
              : 'policy_mismatch',
            'policy_mismatch',
          );
        job.retrieval_error = {
          code: 'remote_policy_mismatch',
          message:
            'Observed remote policy or requested attempts differs from the admitted job; selection is blocked.',
        };
      } else {
        this.db
          .prepare(
            'DELETE FROM ns_policy_violations WHERE job_id=? AND reason=?',
          )
          .run(id, 'policy_not_yet_verified');
      }
      if (remote.terminal && !TERMINAL.includes(job.execution_state)) {
        job.execution_state = 'unresolved';
        job.retrieval_error = {
          code: 'unsupported_terminal_state',
          message: 'The runtime returned an unsupported terminal state.',
        };
      }
      job.progress = {
        generated: remote.generated,
        requested_attempts: remote.requested_attempts,
      };
      if (outcome) job.judge_outcome = clone(outcome);
      job.read_failures = 0;
      job.next_poll_at = null;
      if (remote.terminal && TERMINAL.includes(job.execution_state)) {
        this.db
          .prepare('UPDATE ns_reservations SET capacity_held=0 WHERE job_id=?')
          .run(id);
        job.cancellation.remote_termination_confirmed = true;
      }
      this.putJob(job);
      this.event(
        job,
        'remote_observed',
        'Persisted remote execution and judging state separately.',
        { execution_state: job.execution_state, terminal: remote.terminal },
      );
      return job;
    });
  }
  private remoteMatches(job: NightshiftJob, remoteId: string) {
    if (!job.remote_id || job.remote_id !== remoteId)
      fail(
        'nightshift_remote_identity_conflict',
        'Receipt is not bound to this acknowledged local job.',
      );
  }
  capture(
    id: string,
    remoteId: string,
    result: NightshiftRemoteResult,
    outcome: NightshiftRemoteOutcome,
  ): NightshiftJob {
    return this.access.atomic(() => {
      const job = this.rawJob(id);
      this.remoteMatches(job, remoteId);
      if (job.receipt) {
        if (result.text !== null && result.text !== job.receipt.output) {
          job.retrieval_error = {
            code: 'receipt_conflict',
            message:
              'A later remote result differed from the immutable retained receipt; the original candidate was preserved.',
          };
          this.putJob(job);
          this.event(job, 'receipt_conflict', job.retrieval_error.message);
        }
        return job;
      }
      if (result.retrieval_error || result.text === null || !result.text.trim())
        return this.captureFailure(
          id,
          result.retrieval_error ?? 'The runtime returned no usable text.',
          null,
        );
      if (
        result.text.length > NIGHTSHIFT_LIMITS.result_characters ||
        Buffer.byteLength(result.text, 'utf8') > 262_144 ||
        Buffer.byteLength(JSON.stringify(result.attempts), 'utf8') >
          NIGHTSHIFT_LIMITS.metadata_bytes ||
        result.attempts.length > NIGHTSHIFT_LIMITS.attempts ||
        Buffer.byteLength(JSON.stringify(outcome), 'utf8') >
          NIGHTSHIFT_LIMITS.metadata_bytes ||
        !result.attempts.every(
          (item) =>
            Number.isSafeInteger(item.seq) &&
            item.seq >= 0 &&
            [item.input_tokens, item.output_tokens, item.total_tokens].every(
              (value) =>
                value === null || (Number.isSafeInteger(value) && value >= 0),
            ) &&
            [
              item.lane,
              item.model,
              item.finish_reason,
              item.receipt_id,
              item.prompt_sha256,
            ].every(
              (value) =>
                value === null ||
                (typeof value === 'string' && value.length <= 512),
            ),
        ) ||
        (result.winner_seq !== null &&
          (!Number.isSafeInteger(result.winner_seq) ||
            result.winner_seq < 0)) ||
        ('truncated' in result && result.truncated !== false)
      )
        return this.captureFailure(
          id,
          'Result or attempt metadata exceeded its admitted bound; no usable candidate was retained.',
          null,
        );
      const grant = this.serverGrant(job.chain_id);
      const reservation = this.db
        .prepare(
          'SELECT retention,consumed FROM ns_reservations WHERE job_id=?',
        )
        .get(id) as { retention: number; consumed: number };
      if (reservation.retention !== 1)
        fail(
          'nightshift_retention_missing',
          'Original receipt-retention reservation is unavailable.',
        );
      const content = {
        schema_version: 'haze.nightshift.candidate.v1',
        job_id: job.id,
        remote_job_id: remoteId,
        authority: job.authority,
        route_id: job.route_id,
        request_fingerprint: job.request_fingerprint,
        input_refs: job.input_refs,
        text: result.text,
        attempts: result.attempts,
        winner_seq: result.winner_seq,
        outcome,
        candidate: true,
        independent_review: 'required',
      };
      const dependencies = job.input_refs.map((ref) => {
        this.access.historicalArtifact(ref, grant.identity);
        return clone(ref);
      });
      const artifact = artifactSchema.parse({
        schema_version: 'haze.artifact.v3',
        id: randomUUID(),
        version: 1,
        identity: grant.identity,
        task_id: job.task_id,
        run_id: job.authority.run_id,
        objective_revision: job.authority.objective_revision,
        generation: job.authority.generation,
        ...(job.authority.assignment_id
          ? {
              assignment_id: job.authority.assignment_id,
              assignment_revision: job.authority.assignment_revision,
            }
          : {}),
        sha256: contractHash(content),
        kind: 'nightshift.candidate',
        producer: { kind: 'service', id: 'Nightshift' },
        created_at: at(),
        dependencies,
        required_tools: [],
        content,
        evidence_origin: 'derived',
      });
      this.access.insertHistoricalArtifact(artifact);
      const captured = at();
      job.receipt = {
        artifact: refOf(artifact),
        output: result.text,
        attempts: JSON.parse(JSON.stringify(result.attempts)) as JsonValue[],
        winner_seq: result.winner_seq,
        captured_at: captured,
      };
      job.judge_outcome = clone(outcome);
      if (
        !this.db
          .prepare('SELECT job_id FROM ns_policy_violations WHERE job_id=?')
          .get(id)
      )
        job.retrieval_error = null;
      job.next_poll_at = null;
      this.db.prepare('INSERT INTO ns_deliveries VALUES(?,?,?,?)').run(
        id,
        artifact.id,
        contractHash(content),
        JSON.stringify({
          artifact: refOf(artifact),
          authority: job.authority,
          captured_at: captured,
        }),
      );
      this.db
        .prepare('UPDATE ns_reservations SET consumed=1 WHERE job_id=?')
        .run(id);
      this.putJob(job);
      this.event(
        job,
        'receipt_captured',
        'Historical derived candidate retained under its original reservation; no applicability, acceptance or wakeup created.',
        { artifact: refOf(artifact) },
      );
      return job;
    });
  }
  pollingFailure(
    id: string,
    reason: string,
    nextPollAt: string | null,
  ): NightshiftJob {
    return this.access.atomic(() => {
      const job = this.rawJob(id);
      job.read_failures++;
      job.next_poll_at = nextPollAt;
      job.retrieval_error = {
        code: 'observation_failed',
        message: reason.slice(0, 1000),
      };
      this.putJob(job);
      this.event(
        job,
        'observation_failed',
        'Remote read failed; acknowledgement and reservations remain pinned.',
      );
      return job;
    });
  }
  captureFailure(
    id: string,
    reason: string,
    nextPollAt: string | null,
  ): NightshiftJob {
    return this.access.atomic(() => {
      const job = this.rawJob(id);
      job.read_failures++;
      job.next_poll_at = nextPollAt;
      job.retrieval_error = {
        code: 'result_retrieval_failed',
        message: reason.slice(0, 1000),
      };
      this.putJob(job);
      this.event(job, 'result_retrieval_failed', job.retrieval_error.message);
      return job;
    });
  }
  cancellationIntent(
    id: string,
    value: unknown,
    key: string,
    identity: TaskIdentity,
  ): { job: NightshiftJob; reused: boolean } {
    const request = jobCancelSchema.parse(value);
    return this.access.atomic(() => {
      const result = this.operation(
        identity,
        `nightshift-job-cancel:${id}`,
        key,
        request,
        () => {
          const job = this.rawJob(id, identity);
          const chain = this.rawChain(job.chain_id, identity);
          this.current(job.task_id, identity, request, false);
          this.requireChainRevision(chain, request.expected_chain_revision);
          if (job.revision !== request.expected_job_revision)
            fail('nightshift_stale_job', 'Job revision has changed.');
          job.cancellation.requested = true;
          job.next_poll_at = null;
          this.putJob(job);
          this.event(
            job,
            'cancellation_requested',
            'Cancellation intent retained. Remote termination is unconfirmed.',
          );
          return job;
        },
      );
      return { job: result.value, reused: result.reused };
    });
  }
  cancellationAcknowledged(id: string): NightshiftJob {
    return this.access.atomic(() => {
      const job = this.rawJob(id);
      job.cancellation.acknowledged = true;
      this.putJob(job);
      this.event(
        job,
        'cancellation_acknowledged',
        'Cancellation acknowledged; capacity remains held until verified terminal observation.',
      );
      return job;
    });
  }
  markCancellationDispatched(id: string): boolean {
    return this.access.atomic(() => {
      const job = this.rawJob(id);
      if (
        !job.remote_id ||
        !job.cancellation.requested ||
        TERMINAL.includes(job.execution_state)
      )
        return false;
      const prior = this.db
        .prepare('SELECT job_id FROM ns_cancel_attempts WHERE job_id=?')
        .get(id);
      if (prior) return false;
      this.db
        .prepare('INSERT INTO ns_cancel_attempts VALUES(?,?)')
        .run(id, at());
      this.event(
        job,
        'cancellation_dispatched',
        'One cancellation request dispatched; unsupported retries remain fenced.',
      );
      return true;
    });
  }
  private cancelKnown(chainId: string) {
    for (const row of this.db
      .prepare('SELECT id FROM ns_jobs WHERE chain_id=?')
      .all(chainId) as { id: string }[]) {
      const job = this.rawJob(row.id);
      if (TERMINAL.includes(job.execution_state)) continue;
      job.cancellation.requested = true;
      job.next_poll_at = null;
      this.putJob(job);
      this.event(
        job,
        'cancellation_requested',
        'Grant was closed or invalidated; known jobs still require verified terminal observation.',
      );
    }
  }
  reconcile(
    id: string,
    value: unknown,
    key: string,
    identity: TaskIdentity,
    proof: { ownership_verified: boolean; request_fingerprint: string },
  ): NightshiftJob {
    const request = jobReconcileSchema.parse(value);
    return this.access.atomic(
      () =>
        this.operation(
          identity,
          `nightshift-job-reconcile:${id}`,
          key,
          request,
          () => {
            const job = this.rawJob(id, identity);
            const chain = this.rawChain(job.chain_id, identity);
            this.current(job.task_id, identity, request, false);
            this.requireChainRevision(chain, request.expected_chain_revision);
            if (job.revision !== request.expected_job_revision)
              fail('nightshift_stale_job', 'Job revision has changed.');
            if (job.execution_state !== 'submission_unknown')
              fail(
                'nightshift_reconcile_state',
                'Only an unknown submission can be reconciled.',
              );
            if (
              !proof.ownership_verified ||
              proof.request_fingerprint !== job.request_fingerprint
            )
              fail(
                'nightshift_reconciliation_unverified',
                'Remote ownership and original request identity were not verified.',
              );
            return this.acknowledge(id, request.remote_id);
          },
        ).value,
    );
  }
  select(
    id: string,
    value: unknown,
    key: string,
    identity: TaskIdentity,
  ): NightshiftSelection {
    const request = jobSelectSchema.parse(value);
    return this.access.atomic(
      () =>
        this.operation(
          identity,
          `nightshift-job-select:${id}`,
          key,
          request,
          () => {
            const job = this.rawJob(id, identity);
            const chain = this.refresh(this.rawChain(job.chain_id, identity));
            this.live(chain);
            this.requireChainRevision(chain, request.expected_chain_revision);
            if (job.revision !== request.expected_job_revision)
              fail('nightshift_stale_job', 'Job revision has changed.');
            const task = this.current(job.task_id, identity, request);
            if (task.objective_revision !== chain.objective_revision)
              fail(
                'nightshift_objective_changed',
                'The original chain objective no longer authorizes consumption.',
              );
            if (
              !this.db
                .prepare(
                  'SELECT run_id FROM ns_chain_runs WHERE run_id=? AND chain_id=?',
                )
                .get(task.current_run_id, chain.id)
            )
              fail(
                'nightshift_run_not_enrolled',
                'Current run is outside this grant.',
              );
            if (
              !job.receipt ||
              canonicalJson(request.candidate) !==
                canonicalJson(job.receipt.artifact) ||
              canonicalJson(request.input_refs) !==
                canonicalJson(job.input_refs)
            )
              fail(
                'nightshift_candidate_mismatch',
                'Candidate and exact original input dependencies must match the retained receipt.',
              );
            this.access.artifact(job.receipt.artifact, identity);
            if (
              this.db
                .prepare(
                  'SELECT job_id FROM ns_policy_violations WHERE job_id=?',
                )
                .get(id)
            )
              fail(
                'nightshift_policy_violation',
                'A remote policy mismatch prevents candidate selection.',
              );
            for (const ref of job.input_refs) {
              this.access.artifact(ref, identity);
              if (
                !this.access.applicable(task.id, ref, task.objective_revision)
              )
                fail(
                  'artifact_not_applicable',
                  'Input dependencies need current applicability before selection.',
                );
            }
            if (!['queued', 'running', 'waiting'].includes(task.status))
              fail(
                'stale_execution',
                'A paused or terminal task cannot consume a historical candidate.',
              );
            if (
              chain.remaining.model_calls < 1 ||
              task.usage.model_calls >= task.limits.max_model_calls
            )
              fail(
                'nightshift_chain_resource_exhausted',
                'Candidate use requires remaining admitted Haze review capacity.',
                422,
              );
            if (request.expected_assignment_id) {
              const assignment = task.assignments.find(
                (item) => item.id === request.expected_assignment_id,
              )!;
              if (assignment.role !== 'EvidenceCritic')
                fail(
                  'nightshift_independent_review_required',
                  'An unreviewed candidate may attach only to a current independent-review assignment.',
                );
              if (assignment.usage.model_calls >= assignment.max_model_calls)
                fail(
                  'nightshift_independent_review_required',
                  'The independent reviewer has no remaining admitted review allowance.',
                  422,
                );
            }
            const citations = [
              ...job.receipt.output.matchAll(/\[S(\d+)\]/gu),
            ].map((match) => Number(match[1]));
            if (
              /\[E\d+\]/u.test(job.receipt.output) ||
              citations.some(
                (number) => number < 1 || number > job.input_refs.length,
              )
            )
              fail(
                'nightshift_citation_mismatch',
                'Generated citations reference sources outside the exact brief inputs.',
              );
            const selection = nightshiftSelectionSchema.parse({
              id: randomUUID(),
              artifact: job.receipt.artifact,
              target_run_id: task.current_run_id,
              target_generation: task.generation,
              target_objective_revision: task.objective_revision,
              assignment_id: request.expected_assignment_id ?? null,
              assignment_revision: request.expected_assignment_revision ?? null,
              created_at: at(),
              requires_independent_review: true,
            });
            const existing = job.selections.find(
              (item) =>
                item.target_run_id === selection.target_run_id &&
                item.target_generation === selection.target_generation &&
                item.target_objective_revision ===
                  selection.target_objective_revision &&
                item.assignment_id === selection.assignment_id &&
                item.assignment_revision === selection.assignment_revision,
            );
            if (existing) return existing;
            this.db
              .prepare('INSERT INTO ns_selections VALUES(?,?,?,?)')
              .run(selection.id, id, task.id, JSON.stringify(selection));
            job.selections.push(selection);
            this.putJob(job);
            this.event(
              job,
              'candidate_selected',
              'Explicit unreviewed dependency selected; independent review remains required and no graph wakeup was issued.',
              { selection_id: selection.id, artifact: selection.artifact },
            );
            return selection;
          },
        ).value,
    );
  }
  isCandidate(ref: ArtifactRef): boolean {
    return !!this.db
      .prepare('SELECT job_id FROM ns_deliveries WHERE artifact_id=?')
      .get(ref.id);
  }
  assertOrdinaryInput(ref: ArtifactRef): void {
    if (this.isCandidate(ref))
      fail(
        'nightshift_explicit_selection_required',
        'Nightshift candidates require explicit selection and independent review; they cannot be ordinary context or applicable evidence.',
      );
  }
  selectedDependencies(
    taskId: string,
    runId: string,
    generation: number,
    objectiveRevision: number,
    assignmentId: string,
    assignmentRevision: number,
    role: Assignment['role'],
  ): NightshiftSelectedDependency[] {
    const chainRow = this.db
      .prepare(
        'SELECT id FROM ns_chains WHERE task_id=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(taskId) as { id: string } | undefined;
    if (!chainRow) return [];
    const grant = this.serverGrant(chainRow.id);
    const task = this.access.read(taskId, grant.identity);
    if (
      task.current_run_id !== runId ||
      task.generation !== generation ||
      task.objective_revision !== objectiveRevision ||
      !['queued', 'running', 'waiting'].includes(task.status) ||
      Date.parse(task.limits.deadline) <= Date.now()
    )
      return [];
    const assignment = task.assignments.find(
      (item) =>
        item.id === assignmentId &&
        item.run_id === runId &&
        item.revision === assignmentRevision &&
        item.role === role,
    );
    if (
      !assignment ||
      ['cancelled', 'failed', 'timed_out', 'stale'].includes(assignment.status)
    )
      return [];
    const rows = this.db
      .prepare(
        'SELECT job_id,body FROM ns_selections WHERE task_id=? ORDER BY rowid LIMIT 256',
      )
      .all(taskId) as { job_id: string; body: string }[];
    const result: NightshiftSelectedDependency[] = [];
    for (const row of rows) {
      const selection = nightshiftSelectionSchema.parse(JSON.parse(row.body));
      if (
        selection.target_run_id !== runId ||
        selection.target_generation !== generation ||
        selection.target_objective_revision !== objectiveRevision ||
        (selection.assignment_id !== null &&
          (selection.assignment_id !== assignmentId ||
            selection.assignment_revision !== assignmentRevision))
      )
        continue;
      const job = this.rawJob(row.job_id, grant.identity);
      const chain = this.refresh(this.rawChain(job.chain_id, grant.identity));
      if (
        !OPEN.includes(chain.status) ||
        Date.parse(chain.expires_at) <= Date.now() ||
        !job.receipt ||
        canonicalJson(selection.artifact) !==
          canonicalJson(job.receipt.artifact) ||
        this.db
          .prepare('SELECT job_id FROM ns_policy_violations WHERE job_id=?')
          .get(job.id)
      )
        continue;
      try {
        this.access.artifact(selection.artifact, grant.identity);
        for (const ref of job.input_refs) {
          this.access.artifact(ref, grant.identity);
          if (!this.access.applicable(taskId, ref, objectiveRevision))
            throw new Error('Input is no longer applicable.');
        }
      } catch {
        continue;
      }
      result.push({
        selection_id: selection.id,
        job_id: job.id,
        artifact: clone(selection.artifact),
        input_refs: clone(job.input_refs),
        original_authority: clone(job.authority),
        requires_independent_review: true,
        candidate: true,
        judge_is_not_review: true,
        ...(role === 'EvidenceCritic' ? { text: job.receipt.output } : {}),
      });
    }
    return result;
  }
  isSelectedReviewDependency(
    taskId: string,
    runId: string,
    generation: number,
    objectiveRevision: number,
    assignment: Assignment | undefined,
    ref: ArtifactRef,
  ): boolean {
    return (
      !!assignment &&
      assignment.role === 'EvidenceCritic' &&
      this.selectedDependencies(
        taskId,
        runId,
        generation,
        objectiveRevision,
        assignment.id,
        assignment.revision,
        assignment.role,
      ).some((item) => canonicalJson(item.artifact) === canonicalJson(ref))
    );
  }
  events(
    id: string,
    after: number,
    identity: TaskIdentity,
  ): NightshiftEventPage {
    this.rawJob(id, identity);
    if (!Number.isSafeInteger(after) || after < 0)
      fail(
        'invalid_cursor',
        'Event cursor must be a nonnegative integer.',
        400,
      );
    const rows = this.db
      .prepare(
        'SELECT cursor,body FROM ns_events WHERE job_id=? AND cursor>? ORDER BY cursor LIMIT 100',
      )
      .all(id, after) as { cursor: number; body: string }[];
    return {
      events: rows.map((row) => ({
        ...(JSON.parse(row.body) as Omit<
          NightshiftEventPage['events'][number],
          'cursor'
        >),
        cursor: row.cursor,
      })),
      next_cursor: rows.at(-1)?.cursor ?? after,
    };
  }
  retentionForRun(runId: string): number {
    return (
      this.db
        .prepare(
          'SELECT COALESCE(SUM(retention),0) count FROM ns_reservations WHERE run_id=?',
        )
        .get(runId) as { count: number }
    ).count;
  }
  chainForRun(runId: string, identity?: TaskIdentity): NightshiftChain | null {
    const chain = this.enrolled(runId);
    if (chain && identity) this.rawChain(chain.id, identity);
    return chain ? clone(chain) : null;
  }
  assertResumeAuthority(runId: string): void {
    const chain = this.enrolled(runId);
    if (!chain) return;
    if (
      !OPEN.includes(chain.status) ||
      Date.parse(chain.expires_at) <= Date.now()
    )
      fail(
        'nightshift_chain_closed',
        'The old grant is closed, expired or invalidated; separate explicit admission is required.',
      );
    const grant = this.serverGrant(chain.id),
      task = this.access.read(chain.task_id, grant.identity);
    if (
      task.current_run_id !== runId ||
      task.objective_revision !== chain.objective_revision ||
      grant.required_tools.some(
        (tool) => !task.permissions.tools.includes(tool),
      )
    )
      fail(
        'nightshift_chain_authority_revoked',
        'The immutable chain objective or permission authority no longer matches.',
      );
    if (this.hasUnknownOutcome(chain))
      fail(
        'nightshift_unknown_outcome',
        'Verified reconciliation is required before resuming unknown operation or submission outcomes.',
      );
    if (
      chain.status === 'paused' &&
      chain.stop_reason !== 'Task pause freezes new submissions.'
    )
      fail(
        'nightshift_chain_paused',
        'Resume the original chain grant before resuming its task.',
      );
  }
  private hasUnknownOutcome(chain: NightshiftChain): boolean {
    const grant = this.serverGrant(chain.id);
    if (
      this.jobsForChain(chain.id, grant.identity).some((job) =>
        ['submitting', 'submission_unknown', 'unresolved'].includes(
          job.execution_state,
        ),
      )
    )
      return true;
    return (
      !!this.db
        .prepare(
          "SELECT 1 FROM ns_chain_runs c JOIN attempts a ON json_extract(a.body,'$.run_id')=c.run_id WHERE c.chain_id=? AND json_extract(a.body,'$.status')='unknown' LIMIT 1",
        )
        .get(chain.id) ||
      !!this.db
        .prepare(
          "SELECT 1 FROM ns_chain_runs c JOIN graph_operations o ON o.run_id=c.run_id WHERE c.chain_id=? AND json_extract(o.body,'$.status')='unknown' LIMIT 1",
        )
        .get(chain.id)
    );
  }
  assertJobProgress(
    chainId: string,
    identity: TaskIdentity,
    inputRefs: ArtifactRef[],
    purpose?: NightshiftProgress['purpose'],
  ): void {
    const chain = this.refresh(this.rawChain(chainId, identity));
    if (chain.schema_version !== 'haze.nightshift.chain.v2') return;
    this.requireAutomaticRelease();
    this.live(chain);
    const task = this.access.read(chain.task_id, identity);
    if (
      task.status === 'completed' &&
      task.result?.completion === 'full' &&
      ['supported', 'not_required'].includes(task.result.review.status)
    ) {
      this.stopAutomatic(chainId, {
        code: 'completed_deliverables',
        message: 'Haze has accepted the requested deliverables.',
        cursor: 0,
        refs: task.result.work_products,
        status: 'closed',
      });
      fail(
        'nightshift_deliverables_completed',
        'Haze has already accepted the requested deliverables.',
      );
    }
    const progress = this.progress(chainId, identity);
    if (!progress)
      fail(
        'nightshift_progress_required',
        'An automatic chain needs an accepted bounded purpose before dispatch.',
      );
    if (purpose !== undefined && purpose !== progress.progress.purpose)
      fail(
        'nightshift_purpose_mismatch',
        'The proposed job purpose differs from the validated outstanding purpose.',
      );
    const expected = semanticSet(
      progress.progress.input_refs.map((ref) =>
        this.normalizedReference(ref, identity),
      ),
    );
    const actual = semanticSet(
      inputRefs.map((ref) => this.normalizedReference(ref, identity)),
    );
    if (canonicalJson(expected) !== canonicalJson(actual))
      fail(
        'nightshift_progress_input_mismatch',
        'New job inputs must match the accepted progress proposal.',
      );
    const jobs = this.jobsForChain(chainId, identity);
    if (!inputRefs.length)
      fail(
        'nightshift_evidence_required',
        'Automatic candidate generation requires at least one exact evidence reference.',
      );
    if (
      this.hasUnknownOutcome(chain) ||
      jobs.some(
        (job) =>
          ['submitting', 'submission_unknown', 'unresolved'].includes(
            job.execution_state,
          ) ||
          (job.cancellation.requested &&
            !job.cancellation.remote_termination_confirmed &&
            !['completed', 'failed', 'rejected'].includes(job.execution_state)),
      )
    ) {
      this.stopAutomatic(chainId, {
        code: 'unknown_outcome',
        message:
          'A dispatched or cancellation-pending outcome remains unresolved.',
        cursor: progress.progress.last_consumed_result_cursor,
        refs: inputRefs,
      });
      fail(
        'nightshift_unknown_outcome',
        'Verified reconciliation is required before further automatic dispatch.',
      );
    }
    const fingerprint = this.progressFingerprint(
      progress.progress,
      identity,
      false,
    );
    if (
      this.db
        .prepare(
          'SELECT job_id FROM ns_job_progress WHERE chain_id=? AND fingerprint=?',
        )
        .get(chainId, fingerprint)
    ) {
      this.stopAutomatic(chainId, {
        code: 'no_progress',
        message:
          'The same purpose, inputs and failure causes were already dispatched. A changed instruction or judge score is insufficient.',
        cursor: progress.progress.last_consumed_result_cursor,
        refs: inputRefs,
      });
      fail(
        'nightshift_no_progress',
        'The same bounded purpose and inputs need a supported changed cause before replacement.',
      );
    }
  }
  progress(
    chainId: string,
    identity: TaskIdentity,
  ): NightshiftProgressRecord | null {
    this.rawChain(chainId, identity);
    const row = this.db
      .prepare(
        'SELECT body FROM ns_progress WHERE chain_id=? ORDER BY revision DESC LIMIT 1',
      )
      .get(chainId) as { body: string } | undefined;
    return row
      ? nightshiftProgressRecordSchema.parse(JSON.parse(row.body))
      : null;
  }
  private normalizedReference(
    ref: ArtifactRef,
    identity: TaskIdentity,
  ): unknown {
    const artifact = this.access.artifact(ref, identity);
    // Candidate IDs, judge scores and request nonces do not prove changed work.
    if (this.isCandidate(ref)) {
      const content = artifact.content as {
        text?: unknown;
        input_refs?: ArtifactRef[];
      };
      return {
        kind: 'candidate',
        text: content.text ?? null,
        inputs: (content.input_refs ?? [])
          .map((input) => this.access.artifact(input, identity).sha256)
          .sort(),
      };
    }
    return { kind: artifact.kind, sha256: artifact.sha256 };
  }
  private progressFingerprint(
    progress: NightshiftProgress,
    identity: TaskIdentity,
    includeCursor = true,
  ): string {
    return contractHash({
      purpose: progress.purpose,
      deliverables: [...new Set(progress.unresolved_deliverables)].sort(),
      inputs: semanticSet(
        progress.input_refs.map((ref) =>
          this.normalizedReference(ref, identity),
        ),
      ),
      objections: semanticSet(
        progress.review_objections.map((ref) => {
          const artifact = this.access.artifact(ref, identity);
          const stable = (value: JsonValue, key = ''): unknown => {
            if (value === null || typeof value === 'boolean') return value;
            if (typeof value === 'number')
              return /score|confidence/iu.test(key) ? undefined : value;
            if (typeof value === 'string')
              return /^(code|status|verdict|type|check_id|method|kind|failure_code)$/u.test(
                key,
              )
                ? value
                : undefined;
            if (Array.isArray(value))
              return value
                .map((item) => stable(item, key))
                .filter((item) => item !== undefined);
            if (typeof value.sha256 === 'string')
              return { sha256: value.sha256 };
            return Object.fromEntries(
              Object.entries(value)
                .map(([field, item]) => [field, stable(item, field)])
                .filter(([, item]) => item !== undefined),
            );
          };
          return { kind: artifact.kind, objection: stable(artifact.content) };
        }),
      ),
      causes: semanticSet(
        progress.failure_causes.map((cause) => {
          const job = this.rawJob(cause.job_id, identity);
          return {
            code: cause.code,
            inputs: semanticSet(
              job.input_refs.map((ref) =>
                this.normalizedReference(ref, identity),
              ),
            ),
          };
        }),
      ),
      ...(includeCursor
        ? { last_consumed_result_cursor: progress.last_consumed_result_cursor }
        : {}),
    });
  }
  private acceptProgress(
    chain: NightshiftChain,
    task: TaskRecord,
    value: unknown,
    identity: TaskIdentity,
    actor: 'user' | 'service' | 'agent',
    initial = false,
  ): NightshiftProgressRecord {
    const progress = nightshiftProgressSchema.parse(value);
    const allowed = new Set([
      'objective',
      ...task.original_request.desired_deliverables,
    ]);
    if (progress.unresolved_deliverables.some((item) => !allowed.has(item)))
      fail(
        'nightshift_deliverable_unknown',
        'Progress must identify admitted outstanding deliverables; changed prose cannot create new authority.',
      );
    for (const ref of [
      ...progress.input_refs,
      ...progress.output_refs,
      ...progress.review_objections,
    ]) {
      const artifact = this.access.artifact(ref, identity);
      if (!this.access.applicable(task.id, ref, task.objective_revision))
        fail(
          'artifact_not_applicable',
          'Progress references need exact current applicability checks.',
        );
      if (
        artifact.required_tools.some(
          (tool) => !task.permissions.tools.includes(tool),
        )
      )
        fail(
          'permission_denied',
          'Progress reference authority was revoked.',
          403,
        );
    }
    for (const ref of progress.output_refs) {
      const artifact = this.access.artifact(ref, identity);
      const producer = task.assignments.find(
        (item) =>
          item.id === artifact.assignment_id &&
          item.revision === artifact.assignment_revision,
      );
      if (
        this.isCandidate(ref) ||
        !producer ||
        producer.status !== 'completed' ||
        producer.usability !== 'usable'
      )
        fail(
          'nightshift_output_not_accepted',
          'A Nightshift judge or unaccepted output cannot establish Haze progress.',
        );
    }
    for (const ref of progress.review_objections) {
      const artifact = this.access.artifact(ref, identity);
      const reviewer = task.assignments.find(
        (item) =>
          item.id === artifact.assignment_id &&
          item.revision === artifact.assignment_revision,
      );
      if (
        !reviewer ||
        reviewer.role !== 'EvidenceCritic' ||
        reviewer.status !== 'completed'
      )
        fail(
          'nightshift_review_not_accepted',
          'Review progress needs an exact completed independent critic artifact.',
        );
      if (
        typeof artifact.content !== 'object' ||
        artifact.content === null ||
        Array.isArray(artifact.content) ||
        typeof (artifact.content.status ?? artifact.content.verdict) !==
          'string' ||
        !['rejected', 'needs_review'].includes(
          (artifact.content.status ?? artifact.content.verdict) as string,
        )
      )
        fail(
          'nightshift_review_objection_missing',
          'A supported review is not an unresolved objection.',
        );
    }
    for (const cause of progress.failure_causes) {
      const job = this.rawJob(cause.job_id, identity);
      const known =
        job.remote_diagnostic?.failure_code ??
        job.retrieval_error?.code ??
        job.execution_state;
      if (
        job.chain_id !== chain.id ||
        !['failed', 'cancelled', 'rejected'].includes(job.execution_state) ||
        cause.code !== known
      )
        fail(
          'nightshift_failure_cause_unknown',
          'Failure progress must identify a recorded terminal failure cause.',
        );
    }
    if (progress.last_consumed_result_cursor > 0) {
      const row = this.db
        .prepare(
          'SELECT cursor FROM ns_result_consumptions WHERE cursor=? AND chain_id=?',
        )
        .get(progress.last_consumed_result_cursor, chain.id);
      if (!row)
        fail(
          'nightshift_result_cursor_unknown',
          'Progress can advance only to a server-recorded controlled result consumption.',
        );
    }
    const prior = this.progress(chain.id, identity);
    const fingerprint = this.progressFingerprint(progress, identity);
    if (!initial && prior) {
      const previousProof = this.progressFingerprint(
        prior.progress,
        identity,
        false,
      );
      const proof = this.progressFingerprint(progress, identity, false);
      if (
        progress.last_consumed_result_cursor <
        prior.progress.last_consumed_result_cursor
      )
        fail(
          'nightshift_progress_cursor_regressed',
          'Consumed result progress cannot move backwards.',
        );
      if (
        proof === previousProof &&
        progress.last_consumed_result_cursor ===
          prior.progress.last_consumed_result_cursor
      )
        fail(
          'nightshift_no_progress',
          'A new instruction, UUID or judge score alone is not useful progress.',
        );
    }
    const record: NightshiftProgressRecord = {
      schema_version: 'haze.nightshift.progress.record.v1',
      chain_id: chain.id,
      run_id: task.current_run_id,
      revision: (prior?.revision ?? 0) + 1,
      actor,
      accepted_at: at(),
      fingerprint,
      progress,
    };
    this.db
      .prepare('INSERT INTO ns_progress VALUES(?,?,?)')
      .run(chain.id, record.revision, JSON.stringify(record));
    return record;
  }
  proposeProgress(
    chainId: string,
    value: unknown,
    key: string,
    identity: TaskIdentity,
    actor: 'user' | 'service' | 'agent' = 'user',
  ): NightshiftProgressRecord {
    const body = chainProgressProposalSchema.parse(value);
    return this.access.atomic(
      () =>
        this.operation(
          identity,
          `nightshift-progress:${chainId}`,
          key,
          body,
          () => {
            const chain = this.refresh(this.rawChain(chainId, identity));
            if (chain.schema_version !== 'haze.nightshift.chain.v2')
              fail(
                'nightshift_manual_chain',
                'Manual-only grants cannot authorize automatic proposals.',
              );
            this.requireAutomaticRelease();
            if (
              Date.parse(chain.expires_at) <= Date.now() ||
              !['active', 'paused'].includes(chain.status)
            )
              fail(
                'nightshift_chain_closed',
                'The original chain grant no longer authorizes progress.',
              );
            this.requireChainRevision(chain, body.expected_chain_revision);
            const task = this.current(chain.task_id, identity, body, false);
            const record = this.acceptProgress(
              chain,
              task,
              body.progress,
              identity,
              actor,
            );
            if (chain.stop_reason?.startsWith('no_progress:')) {
              chain.status = 'active';
              chain.stop_reason = null;
            }
            chain.revision++;
            this.putChain(chain);
            return record;
          },
        ).value,
    );
  }
  successorFor(
    chainId: string,
    predecessorRunId: string,
    objectiveRevision: number,
  ): NightshiftSuccessor | null {
    const row = this.db
      .prepare(
        'SELECT body FROM ns_successors WHERE chain_id=? AND predecessor_run_id=? AND objective_revision=?',
      )
      .get(chainId, predecessorRunId, objectiveRevision) as
      { body: string } | undefined;
    return row ? nightshiftSuccessorSchema.parse(JSON.parse(row.body)) : null;
  }
  recordResultConsumption(
    chainId: string,
    runId: string,
    jobId: string,
    cursor: number,
    decision: string,
    exactRef: ArtifactRef | null,
  ): void {
    this.access.atomic(() => {
      const chain = this.refresh(this.rawChain(chainId)),
        grant = this.serverGrant(chainId),
        task = this.access.read(chain.task_id, grant.identity),
        job = this.rawJob(jobId, grant.identity);
      if (chain.schema_version !== 'haze.nightshift.chain.v2') return;
      this.live(chain);
      if (
        task.current_run_id !== runId ||
        job.chain_id !== chainId ||
        !Number.isSafeInteger(cursor) ||
        cursor < 1 ||
        !this.db
          .prepare(
            'SELECT run_id FROM ns_chain_runs WHERE chain_id=? AND run_id=?',
          )
          .get(chainId, runId)
      )
        fail(
          'nightshift_consumption_authority_invalid',
          'Controlled consumption requires the current enrolled successor and exact result cursor.',
        );
      if (
        exactRef &&
        (!job.receipt ||
          canonicalJson(job.receipt.artifact) !== canonicalJson(exactRef))
      )
        fail(
          'nightshift_consumption_ref_invalid',
          'Consumed candidate must match its immutable receipt.',
        );
      if (exactRef) this.access.artifact(exactRef, grant.identity);
      if (
        ![
          'use_candidate',
          'partial_result',
          'replan',
          'supported_failure',
        ].includes(decision)
      )
        fail(
          'nightshift_consumption_decision_invalid',
          'Controlled result consumption needs a supported decision.',
        );
      const body = { decision, artifact: exactRef, cursor };
      const prior = this.db
        .prepare(
          'SELECT body FROM ns_result_consumptions WHERE chain_id=? AND run_id=? AND job_id=?',
        )
        .get(chainId, runId, jobId) as { body: string } | undefined;
      if (prior) {
        if (canonicalJson(JSON.parse(prior.body)) !== canonicalJson(body))
          fail(
            'nightshift_consumption_conflict',
            'The accepted result consumption cannot change.',
          );
        return;
      }
      this.db
        .prepare('INSERT INTO ns_result_consumptions VALUES(?,?,?,?,?)')
        .run(chainId, runId, jobId, cursor, JSON.stringify(body));
      const progress = this.progress(chainId, grant.identity);
      if (progress && cursor > progress.progress.last_consumed_result_cursor) {
        this.acceptProgress(
          chain,
          task,
          { ...progress.progress, last_consumed_result_cursor: cursor },
          grant.identity,
          'service',
        );
        chain.revision++;
        this.putChain(chain);
      }
    });
  }
  pendingAutomaticChains(): {
    chain: NightshiftChain;
    identity: TaskIdentity;
    progress: NightshiftProgressRecord | null;
  }[] {
    return (
      this.db
        .prepare(
          "SELECT id FROM ns_chains WHERE json_extract(body,'$.schema_version')='haze.nightshift.chain.v2' AND json_extract(body,'$.status')='active' ORDER BY rowid LIMIT 128",
        )
        .all() as { id: string }[]
    )
      .map((row) => {
        const chain = this.refresh(this.rawChain(row.id));
        const grant = this.serverGrant(chain.id);
        if (chain.status === 'expired')
          this.stopAutomatic(chain.id, {
            code: 'absolute_expiry',
            message:
              'The immutable chain expiry has passed; late outputs remain historical.',
            cursor:
              this.progress(chain.id, grant.identity)?.progress
                .last_consumed_result_cursor ?? 0,
            refs: [],
            status: 'expired',
          });
        return {
          chain,
          identity: clone(grant.identity),
          progress: this.progress(chain.id, grant.identity),
        };
      })
      .filter(
        (item) =>
          item.chain.status === 'active' &&
          item.chain.grant.automatic_followup_runs > 0,
      );
  }
  stopAutomatic(
    chainId: string,
    input: {
      code: string;
      message: string;
      cursor: number;
      refs: ArtifactRef[];
      status?: 'active' | 'paused' | 'closed' | 'expired' | 'invalidated';
    },
  ): void {
    this.access.atomic(() => {
      const chain = this.refresh(this.rawChain(chainId));
      const record = nightshiftStopSchema.parse({
        code: input.code,
        message: input.message.slice(0, 2000),
        cursor: input.cursor,
        refs: input.refs,
        remaining: chain.remaining,
        at: at(),
      });
      const fingerprint = contractHash({
        code: record.code,
        cursor: record.cursor,
        refs: record.refs,
      });
      const inserted = this.db
        .prepare(
          'INSERT OR IGNORE INTO ns_chain_stops(chain_id,fingerprint,body) VALUES(?,?,?)',
        )
        .run(chain.id, fingerprint, JSON.stringify(record));
      const status = input.status ?? 'paused';
      let accepted = record;
      if (!inserted.changes) {
        // Redelivery cannot reopen a terminal grant or undo a separate user
        // pause. A repeated fence must still take effect if mutable state no
        // longer reflects the original accepted stop.
        if (!OPEN.includes(chain.status) || status === 'active') return;
        const prior = this.db
          .prepare(
            'SELECT body FROM ns_chain_stops WHERE chain_id=? AND fingerprint=?',
          )
          .get(chain.id, fingerprint) as { body: string };
        accepted = nightshiftStopSchema.parse(JSON.parse(prior.body));
      }
      const reason = `${accepted.code}: ${accepted.message}`;
      if (chain.status === status && chain.stop_reason === reason) return;
      chain.status = status;
      chain.stop_reason = reason;
      chain.revision++;
      this.putChain(chain);
      if (['closed', 'expired', 'invalidated'].includes(chain.status))
        this.cancelKnown(chain.id);
    });
  }
  private recordControlStop(
    chain: NightshiftChain,
    code: string,
    message: string,
  ): void {
    const snapshot = this.refresh(clone(chain));
    const record = nightshiftStopSchema.parse({
      code,
      message,
      cursor: 0,
      refs: [],
      remaining: snapshot.remaining,
      at: at(),
    });
    this.db
      .prepare(
        'INSERT OR IGNORE INTO ns_chain_stops(chain_id,fingerprint,body) VALUES(?,?,?)',
      )
      .run(
        chain.id,
        contractHash({ code, cursor: 0, refs: [] }),
        JSON.stringify(record),
      );
  }
  automationView(
    chainId: string,
    identity: TaskIdentity,
  ): NightshiftChainAutomationView {
    const chain = this.chain(chainId, identity);
    const task = this.access.read(chain.task_id, identity);
    const lineage = (
      this.db
        .prepare(
          'SELECT body FROM ns_successors WHERE chain_id=? ORDER BY rowid',
        )
        .all(chainId) as { body: string }[]
    ).map((row) => nightshiftSuccessorSchema.parse(JSON.parse(row.body)));
    const used = lineage.filter((item) => item.mode === 'automatic').length;
    const progress = this.progress(chainId, identity);
    return chainAutomationViewSchema.parse({
      schema_version: 'haze.nightshift.chain.automation.v1',
      chain_id: chain.id,
      task_id: chain.task_id,
      current_run_id: task.current_run_id,
      ...(this.serverGrant(chain.id).previous_chain_id
        ? {
            previous_chain_id: this.serverGrant(chain.id).previous_chain_id,
            previous_task_id: this.rawChain(
              this.serverGrant(chain.id).previous_chain_id!,
              identity,
            ).task_id,
          }
        : {}),
      automatic_enabled:
        chain.schema_version === 'haze.nightshift.chain.v2' &&
        chain.grant.automatic_followup_runs > 0,
      authorized_followups: chain.grant.automatic_followup_runs,
      used_followups: used,
      remaining_followups: Math.max(
        0,
        chain.grant.automatic_followup_runs - used,
      ),
      admitted_runs: chain.usage.runs,
      maximum_runs: chain.grant.total_runs,
      run_profile: {
        max_model_input_bytes: this.serverGrant(chain.id).run_limits
          .max_model_input_bytes,
        max_model_output_tokens: this.serverGrant(chain.id).run_limits
          .max_model_output_tokens,
        reserved_model_calls: this.serverGrant(chain.id).run_limits
          .reserved_model_calls,
      },
      original_expires_at: chain.expires_at,
      next_purpose:
        chain.status === 'active' && chain.grant.automatic_followup_runs > used
          ? (progress?.progress.purpose ?? null)
          : null,
      progress,
      lineage,
      stops: (
        this.db
          .prepare(
            'SELECT body FROM ns_chain_stops WHERE chain_id=? ORDER BY id DESC LIMIT 100',
          )
          .all(chainId) as { body: string }[]
      )
        .map((row) => nightshiftStopSchema.parse(JSON.parse(row.body)))
        .reverse(),
      inbox: this.jobsForChain(chainId, identity)
        .slice(-100)
        .map((job) => {
          const delegated = this.db
            .prepare(
              'SELECT body FROM ns_run_transfers WHERE task_id=? AND job_id=? ORDER BY rowid DESC LIMIT 1',
            )
            .get(task.id, job.id) as { body: string } | undefined;
          const transfer = delegated
            ? (JSON.parse(delegated.body) as {
                chain_id: string;
                target_run_id: string;
                required: boolean;
              })
            : null;
          const required =
            Boolean(transfer?.chain_id === chain.id && transfer.required) ||
            (
              this.db
                .prepare('SELECT body FROM external_waits WHERE task_id=?')
                .all(task.id) as { body: string }[]
            ).some((row) =>
              (
                JSON.parse(row.body) as {
                  dependencies: { job_id: string; required: boolean }[];
                }
              ).dependencies.some(
                (dep) => dep.job_id === job.id && dep.required,
              ),
            );
          const target = lineage.find((item) =>
            item.delivery_ids.some(
              (id) =>
                !!this.db
                  .prepare(
                    'SELECT id FROM external_result_deliveries WHERE id=? AND job_id=?',
                  )
                  .get(id, job.id),
            ),
          );
          return {
            job_id: job.id,
            remote_id: job.remote_id,
            original_run_id: job.authority.run_id,
            execution_state: job.execution_state,
            candidate: job.receipt?.artifact ?? null,
            required,
            delivered_to_run_id:
              transfer?.chain_id === chain.id
                ? transfer.target_run_id
                : (target?.run_id ?? null),
          };
        }),
    });
  }
  assertResource(
    runId: string,
    kind: 'model_calls' | 'tool_calls' | 'assignments' | 'artifacts',
    amount = 1,
  ): void {
    const chain = this.enrolled(runId);
    if (!chain) return;
    this.live(chain);
    if (
      chain.schema_version === 'haze.nightshift.chain.v2' &&
      this.hasUnknownOutcome(chain)
    )
      fail(
        'nightshift_unknown_outcome',
        'Verified reconciliation is required before further dispatch.',
      );
    const grant = this.serverGrant(chain.id),
      task = this.access.read(chain.task_id, grant.identity);
    if (
      task.objective_revision !== chain.objective_revision ||
      grant.required_tools.some(
        (tool) => !task.permissions.tools.includes(tool),
      )
    )
      fail(
        'nightshift_chain_authority_revoked',
        'The original objective or permission grant no longer authorizes execution.',
      );
    const remaining = chain.remaining[kind];
    if (remaining < amount)
      fail(
        'nightshift_chain_resource_exhausted',
        'The immutable cumulative chain allowance is exhausted.',
        422,
      );
  }
  continuation(
    runId: string,
    mode: 'manual' | 'automatic' = 'manual',
  ): {
    routes: ModelRouteSnapshot;
    limits: ResourceLimits;
    chain_id: string;
  } | null {
    const chain = this.enrolled(runId);
    if (!chain) return null;
    if (mode === 'automatic') {
      this.requireAutomaticRelease();
      if (
        chain.schema_version !== 'haze.nightshift.chain.v2' ||
        chain.grant.automatic_followup_runs <= 0
      )
        fail(
          'nightshift_manual_chain',
          'This immutable grant does not authorize automatic follow-ups.',
        );
      // A narrowed or replaced release cannot be bypassed by an older grant.
      this.requireAutomaticScope({
        ...chain.grant,
        lifetime_seconds: Math.ceil(
          (Date.parse(chain.expires_at) - Date.parse(chain.created_at)) / 1000,
        ),
      });
      const used = (
        this.db
          .prepare(
            "SELECT count(*) n FROM ns_successors WHERE chain_id=? AND json_extract(body,'$.mode')='automatic'",
          )
          .get(chain.id) as { n: number }
      ).n;
      if (used >= chain.grant.automatic_followup_runs)
        fail(
          'nightshift_automatic_grant_exhausted',
          'The separately authorized automatic follow-up allowance is exhausted.',
          422,
        );
      this.live(chain);
    }
    if (chain.status !== 'active' || Date.parse(chain.expires_at) <= Date.now())
      fail(
        'nightshift_chain_closed',
        'The chain cannot authorize another manual run.',
        422,
      );
    if (!chain.remaining.runs)
      fail(
        'nightshift_run_grant_exhausted',
        'The admitted manual run allowance is exhausted; Continue cannot replenish the chain.',
        422,
      );
    const grant = this.serverGrant(chain.id);
    if (
      chain.remaining.model_calls <= grant.run_limits.reserved_model_calls ||
      !chain.remaining.assignments ||
      chain.remaining.artifacts < 2
    )
      fail(
        'nightshift_chain_resource_exhausted',
        'The chain cannot reserve another bounded Haze run.',
        422,
      );
    const task = this.access.read(chain.task_id, grant.identity);
    if (
      task.objective_revision !== chain.objective_revision ||
      grant.required_tools.some(
        (tool) => !task.permissions.tools.includes(tool),
      )
    )
      fail(
        'nightshift_chain_authority_revoked',
        'The original grant no longer matches current permissions or objective.',
      );
    if (this.hasUnknownOutcome(chain))
      fail(
        'nightshift_unknown_outcome',
        'Unknown external outcomes block continuation until verified reconciliation.',
      );
    const limits = {
      ...grant.run_limits,
      deadline: new Date(
        Math.min(
          Date.now() + Math.max(1, grant.run_duration_ms),
          Date.parse(chain.expires_at),
        ),
      ).toISOString(),
      max_model_calls: Math.min(
        grant.run_limits.max_model_calls,
        chain.remaining.model_calls,
      ),
      max_tool_calls: Math.min(
        grant.run_limits.max_tool_calls,
        chain.remaining.tool_calls,
      ),
      max_assignments: Math.min(
        grant.run_limits.max_assignments,
        chain.remaining.assignments,
      ),
      max_artifacts: Math.min(
        grant.run_limits.max_artifacts,
        chain.remaining.artifacts,
      ),
    };
    return { routes: grant.routes, limits, chain_id: chain.id };
  }
  enrollSuccessor(
    chainId: string,
    runId: string,
    details?: Omit<NightshiftSuccessor, 'chain_id' | 'run_id' | 'created_at'>,
  ): void {
    this.access.atomic(() =>
      this.enrollSuccessorEffect(chainId, runId, details),
    );
  }
  private enrollSuccessorEffect(
    chainId: string,
    runId: string,
    details?: Omit<NightshiftSuccessor, 'chain_id' | 'run_id' | 'created_at'>,
  ): void {
    const row = this.db
      .prepare('SELECT body FROM runs WHERE id=?')
      .get(runId) as { body: string } | undefined;
    if (!row)
      fail(
        'run_not_found',
        'Successor run must be created in the same transaction.',
      );
    const run = JSON.parse(row.body) as RunRecord;
    const predecessor = details?.predecessor_run_id ?? run.predecessor_run_id;
    if (!predecessor)
      fail(
        'nightshift_predecessor_required',
        'A linked successor requires its exact predecessor.',
      );
    const objective = details?.objective_revision ?? run.objective_revision;
    const prior = this.successorFor(chainId, predecessor, objective);
    if (prior) {
      if (prior.run_id !== runId)
        fail(
          'nightshift_successor_exists',
          'This predecessor already has a recorded successor.',
        );
      return;
    }
    const chain = this.refresh(this.rawChain(chainId));
    if (
      run.task_id !== chain.task_id ||
      run.objective_revision !== chain.objective_revision ||
      run.predecessor_run_id !== predecessor ||
      !this.db
        .prepare(
          'SELECT run_id FROM ns_chain_runs WHERE chain_id=? AND run_id=?',
        )
        .get(chainId, predecessor)
    )
      fail(
        'nightshift_successor_authority_invalid',
        'Successor identity must match the original enrolled task, predecessor and objective.',
      );
    const mode = details?.mode ?? 'manual';
    this.continuation(predecessor, mode);
    if (
      !OPEN.includes(chain.status) ||
      Date.parse(chain.expires_at) <= Date.now()
    )
      fail(
        'nightshift_chain_closed',
        'The chain cannot authorize a successor.',
        422,
      );
    if (!chain.remaining.runs)
      fail(
        'nightshift_run_grant_exhausted',
        'The manual run grant is exhausted.',
        422,
      );
    this.db
      .prepare('INSERT INTO ns_chain_runs VALUES(?,?,?)')
      .run(runId, chainId, chain.usage.runs + 1);
    const successor = nightshiftSuccessorSchema.parse({
      chain_id: chainId,
      predecessor_run_id: predecessor,
      objective_revision: objective,
      run_id: runId,
      actor: details?.actor ?? 'user',
      mode,
      reason: details?.reason ?? 'Explicit user Continue.',
      cursor: details?.cursor ?? 0,
      delivery_ids: details?.delivery_ids ?? [],
      created_at: at(),
    });
    if ((mode === 'automatic') !== (successor.actor === 'service'))
      fail(
        'nightshift_successor_actor_invalid',
        'Automatic admission must be attributed to the service; manual admission to the user.',
      );
    this.db
      .prepare('INSERT INTO ns_successors VALUES(?,?,?,?,?)')
      .run(chainId, predecessor, objective, runId, JSON.stringify(successor));
    chain.revision++;
    this.putChain(chain);
  }
  onTaskControl(taskId: string, action: string): void {
    for (const row of this.db
      .prepare('SELECT id FROM ns_chains WHERE task_id=?')
      .all(taskId) as { id: string }[]) {
      const chain = this.rawChain(row.id);
      if (!OPEN.includes(chain.status)) continue;
      if (action === 'pause') {
        if (chain.status === 'paused') continue;
        chain.status = 'paused';
        chain.stop_reason = 'Task pause freezes new submissions.';
      } else if (action === 'resume') {
        if (
          chain.status === 'paused' &&
          chain.stop_reason === 'Task pause freezes new submissions.' &&
          Date.parse(chain.expires_at) > Date.now()
        ) {
          chain.status = 'active';
          chain.stop_reason = null;
        }
      } else if (
        action === 'cancel' ||
        action === 'revoke' ||
        action === 'correction'
      ) {
        chain.status = action === 'correction' ? 'invalidated' : 'closed';
        chain.stop_reason =
          action === 'correction'
            ? 'Objective correction invalidated the original chain authority.'
            : `Task ${action} closed the grant; remote work remains monitored.`;
        this.recordControlStop(
          chain,
          action === 'correction'
            ? 'objective_invalidated'
            : action === 'revoke'
              ? 'permission_revoked'
              : 'task_cancelled',
          chain.stop_reason,
        );
        this.cancelKnown(chain.id);
      } else continue;
      chain.revision++;
      this.putChain(chain);
    }
  }
}
