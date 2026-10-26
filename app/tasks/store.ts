import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  GraphLedger,
  graphThreadId,
  type GraphAuthority,
} from './graph-ledger.js';
import {
  managerDecisionSchema,
  managerStateSchema,
  type ManagerDecision,
  type ManagerState,
} from '../contracts/manager.js';
import {
  canonicalJson,
  contractHash,
  parseContractJson,
} from '../contracts/json.js';
import {
  artifactImportSchema,
  artifactSchema,
  type Artifact,
  type ArtifactApplicability,
  type ArtifactImport,
  type ArtifactProducer,
  type ArtifactRef,
  type JsonValue,
} from '../contracts/artifacts.js';
import {
  type ControlReceipt,
  type TaskControl,
  type TaskUpdate,
} from '../contracts/controls.js';
import {
  assignmentSchema,
  resourceLimitsSchema,
  taskRecordSchema,
  taskRequestSchema,
  taskResultSchema,
  TaskError,
  type Assignment,
  type Question,
  type ResourceLimits,
  type RunRecord,
  type TaskEvent,
  type TaskIdentity,
  type TaskRecord,
  type TaskRequest,
  type TaskResult,
} from '../contracts/tasks.js';

export const GENERAL_STORAGE_FORMAT = 'haze.general.sqlite.v2';
export const STORAGE_MARKER = 'storage-format.json';
export const MIGRATION_PENDING = 'migration-in-progress.json';
const now = () => new Date().toISOString();
const terminal = (status: string) =>
  ['completed', 'failed', 'cancelled', 'timed_out'].includes(status);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const decode = <T>(value: string): T =>
  parseContractJson(value, 8_388_608) as T;
const contentHash = (value: unknown) => contractHash(value, 8_388_608);
const fail = (code: string, message: string, status = 409): never => {
  throw new TaskError(status, code, message);
};
type Row = { body: string };
type TaskCore = Pick<
  TaskRecord,
  | 'schema_version'
  | 'id'
  | 'original_request'
  | 'identity'
  | 'permissions'
  | 'mode'
  | 'created_at'
  | 'updated_at'
> & {
  objective_revision: number;
  current_run_id: string;
  result?: TaskResult;
  error?: TaskRecord['error'];
};
export interface AssignmentDefinition {
  id?: string;
  role: Assignment['role'];
  definition_id: string;
  capability: string;
  definition_version: string;
  brief: string;
  input?: JsonValue;
  dependencies?: string[];
  inputs?: ArtifactRef[];
  tools?: string[];
  max_model_calls?: number;
}
export interface ManagerFence {
  run_id: string;
  objective_revision: number;
  plan_revision: number;
  generation?: number;
}
export interface ManagerInspection extends ManagerFence {
  artifact: ArtifactRef;
  excerpt: string;
  inspected_at: string;
}
export interface ManagerDispatchReceipt {
  decision_id: string;
  run_id: string;
  objective_revision: number;
  plan_revision: number;
  applied_plan_revision: number;
  status: 'applied';
  result: JsonValue;
  created_at: string;
}
export interface ManagerPlanChanges {
  create?: AssignmentDefinition[];
  revise?: ({ id: string; brief: string } & Partial<
    Pick<
      AssignmentDefinition,
      'input' | 'dependencies' | 'inputs' | 'tools' | 'max_model_calls'
    >
  >)[];
  retire?: string[];
  reuse?: { artifact: ArtifactRef; reason: string }[];
}
export interface AttemptRecord {
  id: string;
  task_id: string;
  run_id: string;
  assignment_id: string;
  objective_revision: number;
  assignment_revision: number;
  generation: number;
  lease_token: string;
  kind: 'model' | 'tool';
  status: 'started' | 'completed' | 'failed' | 'unknown';
  charged_at: string;
  details: JsonValue;
  accepted: boolean;
  output?: JsonValue;
  receipt?: JsonValue;
  error?: JsonValue;
}
export interface ActionRecord {
  created_generation: number;
  id: string;
  action_id: string;
  task_id: string;
  run_id: string;
  objective_revision: number;
  assignment_id: string;
  assignment_revision: number;
  generation: number;
  response: JsonValue;
  action: JsonValue;
  dispatched: boolean;
  created_at: string;
}
export interface PeerChannel {
  id: string;
  task_id: string;
  run_id: string;
  revision: number;
  objective_revision: number;
  purpose: string;
  participants: { assignment_id: string; revision: number }[];
  expires_at: string;
  status: 'open' | 'closed';
  messages: number;
  bytes: number;
}
export interface LeaseExpectation {
  generation: number;
  assignment_revision: number;
  lease_token?: string;
}
export interface PeerMessage {
  id: string;
  channel_id: string;
  channel_revision: number;
  sender_revision: number;
  recipient_revision: number;
  sender: string;
  recipient: string;
  text: string;
  created_at: string;
}
export interface SaveArtifactOptions {
  kind: string;
  content: JsonValue;
  producer: ArtifactProducer;
  dependencies?: ArtifactRef[];
  generation?: number;
  assignment_revision?: number;
  evidence_origin?: Artifact['evidence_origin'];
  required_tools?: string[];
}
export interface StoreDefinitions {
  agents: Record<string, string>;
  capabilities: Record<string, string>;
  tools: string[];
  assignments?: Record<
    string,
    { version: string; capability: string; role: string; tools: string[] }
  >;
}

/** Authoritative row transitions. Checkpoints reference rows; they never replace task snapshots. */
export class TaskStore {
  readonly db: DatabaseSync;
  readonly graph: GraphLedger;
  readonly directory: string;
  private definitions: StoreDefinitions | undefined;
  private transactionDepth = 0;
  constructor(
    directory = '.state/general-v2',
    options: { recover?: boolean; migration?: boolean } = {},
  ) {
    this.directory = resolve(directory);
    if (
      !options.migration &&
      existsSync(join(this.directory, MIGRATION_PENDING))
    )
      fail(
        'migration_incomplete',
        'This target migration is incomplete; preserve it for inspection and migrate again into a separate target.',
      );
    const marker = join(this.directory, STORAGE_MARKER);
    if (existsSync(this.directory)) {
      if (!existsSync(marker) && readdirSync(this.directory).length)
        fail(
          'incompatible_state_directory',
          'State has no general storage marker; historical directory was left untouched.',
        );
      if (existsSync(marker)) {
        let value: unknown;
        try {
          value = JSON.parse(readFileSync(marker, 'utf8'));
        } catch {
          fail(
            'incompatible_state_directory',
            'Invalid marker; state was left untouched.',
          );
        }
        if (
          canonicalJson(value) !==
          canonicalJson({ format: GENERAL_STORAGE_FORMAT, schema_version: 2 })
        )
          fail(
            'incompatible_state_directory',
            'Incompatible storage format; directory was left untouched.',
          );
      }
    }
    // SQLite and its WAL sidecars must never be opened before marker validation.
    mkdirSync(this.directory, { recursive: true });
    if (!existsSync(marker))
      writeFileSync(
        marker,
        JSON.stringify({ format: GENERAL_STORAGE_FORMAT, schema_version: 2 }),
        { flag: 'wx' },
      );
    this.db = new DatabaseSync(join(this.directory, 'tasks.sqlite'));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,principal TEXT NOT NULL,workspace TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id);
      CREATE TABLE IF NOT EXISTS assignments(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,run_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS assignments_run ON assignments(run_id);
      CREATE TABLE IF NOT EXISTS operations(scope TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(scope,key));
      CREATE TABLE IF NOT EXISTS events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_events ON events(task_id,cursor);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,principal TEXT NOT NULL,workspace TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS applicability(task_id TEXT NOT NULL,artifact_id TEXT NOT NULL,objective_revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(task_id,artifact_id,objective_revision));
      CREATE TABLE IF NOT EXISTS corrections(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,assignment_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,assignment_id TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,run_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_history(run_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_id,revision));
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(channel_id,key));
      CREATE TABLE IF NOT EXISTS checkpoints(run_id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_state(run_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_state_history(run_id TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_id,fingerprint));
      CREATE TABLE IF NOT EXISTS manager_decisions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,run_id TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,receipt TEXT);
      CREATE TABLE IF NOT EXISTS assignment_history(assignment_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(assignment_id,revision));`);
    this.graph = new GraphLedger(
      this.db,
      (operation) => this.atomic(operation),
      (authority) => this.assertGraphAuthority(authority),
    );
    for (const row of this.db.prepare('SELECT id FROM runs').all() as {
      id: string;
    }[])
      if (!this.graph.version(row.id)) this.graph.register(row.id, 'legacy');
    for (const row of this.db
      .prepare('SELECT run_id,body FROM manager_state')
      .all() as (Row & { run_id: string })[]) {
      if (!this.compatibleManagerState(row.body))
        this.archiveManagerState(row.run_id, row.body);
    }
    if (options.recover !== false) this.recover();
  }
  executionVersion(runId: string) {
    return this.graph.version(runId);
  }
  assertGraphExecution(runId: string) {
    return this.graph.assertVersion(runId);
  }
  private assertGraphAuthority(authority: GraphAuthority) {
    const task = this.core(authority.task_id),
      run = this.run(authority.run_id);
    this.assertGraphExecution(run.id);
    const assignment = authority.assignment_id
      ? this.assignment(authority.assignment_id, task.id)
      : undefined;
    this.assertCurrent(task, run, assignment, authority.generation);
    if (
      task.objective_revision !== authority.objective_revision ||
      (assignment && assignment.revision !== authority.assignment_revision)
    )
      fail('stale_execution', 'Graph operation authority has been fenced.');
  }
  configureDefinitions(definitions: StoreDefinitions) {
    this.definitions = copy(definitions);
    this.atomic(() => {
      for (const row of this.db
        .prepare('SELECT body FROM tasks')
        .all() as Row[]) {
        const task = decode<TaskCore>(row.body),
          run = this.run(task.current_run_id);
        if (terminal(run.status)) continue;
        const coordinator = this.allAssignments(run.id).find(
          (item) => item.definition_id === 'core.manager.coordinator',
        );
        if (!coordinator) continue;
        const registered = definitions.assignments?.[coordinator.definition_id];
        if (
          definitions.agents['Manager'] !== coordinator.agent_version ||
          definitions.capabilities[coordinator.capability] !==
            coordinator.capability_version ||
          (definitions.assignments &&
            (!registered ||
              registered.version !== coordinator.definition_version ||
              registered.role !== 'Manager' ||
              registered.capability !== coordinator.capability))
        ) {
          const state = this.managerState(task.id, task.identity);
          if (state?.upgrade_required) continue;
          const raw = this.db
            .prepare('SELECT body FROM manager_state WHERE run_id=?')
            .get(run.id) as Row | undefined;
          if (raw) this.archiveManagerState(run.id, raw.body);
          this.db
            .prepare('DELETE FROM manager_state WHERE run_id=?')
            .run(run.id);
          const replacement = this.initializeManager(task.id, run.id);
          replacement.upgrade_required =
            'The pinned Manager version is unavailable. Explicit continuation starts a linked run under the current Manager; previous coordination state is preserved without reinterpretation.';
          this.putManager(replacement);
          run.generation++;
          run.status = 'paused';
          for (const assignment of this.allAssignments(run.id))
            if (!terminal(assignment.status)) {
              assignment.status = 'paused';
              delete assignment.lease_token;
              this.putAssignment(assignment);
            }
          this.markUnknown(run.id);
          this.closeChannels(run.id);
          this.putRun(run);
          this.appendEvent(
            task.id,
            'manager_upgrade_required',
            'Runtime',
            replacement.upgrade_required,
          );
        }
      }
    });
  }
  private archiveManagerState(runId: string, body: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO manager_state_history VALUES(?,?,?)')
      .run(runId, contentHash(body), body);
  }
  private compatibleManagerState(body: string): ManagerState | undefined {
    try {
      const parsed = managerStateSchema.safeParse(decode(body));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
  private initializeManager(taskId: string, runId: string): ManagerState {
    const state: ManagerState = {
      version: 'manager.v4',
      run_id: runId,
      plan_revision: 0,
      last_handled_event_cursor: 0,
      plans: [],
      decisions: [],
      inspections: [],
      pending_events: [],
      dispatch_receipts: [],
    };
    this.db
      .prepare('INSERT INTO manager_state VALUES(?,?,?)')
      .run(runId, taskId, JSON.stringify(state));
    return state;
  }
  private putManager(state: ManagerState) {
    this.db
      .prepare('UPDATE manager_state SET body=? WHERE run_id=?')
      .run(JSON.stringify(managerStateSchema.parse(state)), state.run_id);
  }
  managerState(
    taskId: string,
    identity: TaskIdentity,
  ): ManagerState | undefined {
    const task = this.core(taskId, identity);
    const row = this.db
      .prepare('SELECT body FROM manager_state WHERE run_id=? AND task_id=?')
      .get(task.current_run_id, taskId) as Row | undefined;
    if (!row) return undefined;
    const state = this.compatibleManagerState(row.body);
    if (!state) return undefined;
    state.pending_events = decode<JsonValue[]>(
      JSON.stringify(
        this.materialManagerEvents(
          taskId,
          state.run_id,
          state.last_handled_event_cursor,
        ),
      ),
    );
    return state;
  }
  private materialManagerEvents(
    taskId: string,
    runId: string,
    after: number,
  ): TaskEvent[] {
    const material = new Set([
      'task_admitted',
      'objective_revised',
      'assignment_completed',
      'assignment_failed',
      'assignment_timed_out',
      'assignment_waiting',
      'artifact_saved',
      'specialist_escalated',
      'review_objection',
      'control_resume',
      'control_continue',
      'restart_recovered',
    ]);
    return (
      this.db
        .prepare(
          'SELECT cursor,body FROM events WHERE task_id=? AND cursor>? ORDER BY cursor',
        )
        .all(taskId, after) as (Row & { cursor: number })[]
    )
      .map((row) => ({
        ...decode<Omit<TaskEvent, 'cursor'>>(row.body),
        cursor: row.cursor,
      }))
      .filter(
        (event) =>
          event.run_id === runId &&
          material.has(event.type) &&
          !(
            event.type === 'artifact_saved' &&
            event.data &&
            typeof event.data === 'object' &&
            !Array.isArray(event.data) &&
            event.data['kind'] === 'assignment.summary'
          ),
      );
  }
  pendingManagerEvents(taskId: string, identity: TaskIdentity): TaskEvent[] {
    const task = this.core(taskId, identity),
      state = this.managerState(taskId, identity);
    return this.materialManagerEvents(
      taskId,
      task.current_run_id,
      state?.last_handled_event_cursor ?? 0,
    );
  }
  ensureManager(
    taskId: string,
    runId: string,
    definition: AssignmentDefinition,
  ): Assignment {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(runId);
      this.assertCurrent(task, run);
      if (
        definition.role !== 'Manager' ||
        definition.definition_id !== 'core.manager.coordinator'
      )
        fail(
          'invalid_manager_coordinator',
          'The persistent Manager requires its registered coordinator definition.',
          422,
        );
      const state = this.managerState(taskId, task.identity);
      if (!state || state.upgrade_required)
        fail(
          'manager_upgrade_required',
          'Explicit continuation is required before using the new Manager.',
        );
      const previous = this.allAssignments(runId).find(
        (assignment) => assignment.definition_id === 'core.manager.coordinator',
      );
      if (previous) {
        state!.coordinator_assignment_id = previous.id;
        this.putManager(state!);
        if (terminal(previous.status)) {
          this.preserveAssignment(previous);
          previous.revision++;
          previous.objective_revision = task.objective_revision;
          previous.generation = run.generation;
          previous.status = 'queued';
          previous.acknowledged_revision = 0;
          previous.usability = 'needs_review';
          previous.outputs = [];
          delete previous.lease_token;
          delete previous.error;
          this.putAssignment(previous);
        }
        return previous;
      }
      const coordinator = this.createAssignments(
        taskId,
        runId,
        task.objective_revision,
        [definition],
      )[0]!;
      state!.coordinator_assignment_id = coordinator.id;
      this.putManager(state!);
      return coordinator;
    });
  }
  private assertManagerFence(taskId: string, fence: ManagerFence) {
    const task = this.core(taskId),
      run = this.run(fence.run_id);
    this.assertCurrent(task, run, undefined, fence.generation);
    const state = this.managerState(taskId, task.identity);
    if (
      !state ||
      state.upgrade_required ||
      fence.objective_revision !== task.objective_revision ||
      fence.plan_revision !== state.plan_revision
    )
      fail(
        'stale_manager_decision',
        'Manager decision belongs to a corrected or superseded plan.',
      );
    return { task, run, state: state! };
  }
  recordManagerInspection(
    taskId: string,
    fence: ManagerFence,
    ref: ArtifactRef,
    excerpt: string,
  ): ManagerInspection {
    return this.atomic(() => {
      const { task, state } = this.assertManagerFence(taskId, fence);
      this.artifact(ref.id, task.identity, ref);
      if (Buffer.byteLength(excerpt, 'utf8') > 12_000)
        fail(
          'manager_inspection_limit',
          'Inspection excerpts must fit the bounded Manager context.',
          422,
        );
      const inspection: ManagerInspection = {
        artifact: { id: ref.id, version: ref.version, sha256: ref.sha256 },
        run_id: fence.run_id,
        objective_revision: fence.objective_revision,
        plan_revision: fence.plan_revision,
        excerpt,
        inspected_at: now(),
      };
      state.inspections.push(inspection);
      this.putManager(state);
      return inspection;
    });
  }
  applyManagerDecision(
    taskId: string,
    input: ManagerDecision,
    execute: () => JsonValue = () => ({}),
  ): ManagerDispatchReceipt {
    return this.atomic(() => {
      const decision = managerDecisionSchema.parse(input),
        fingerprint = contentHash(decision);
      const prior = this.db
        .prepare(
          'SELECT task_id,fingerprint,receipt FROM manager_decisions WHERE id=?',
        )
        .get(decision.id) as
        | { task_id: string; fingerprint: string; receipt: string | null }
        | undefined;
      if (prior) {
        if (prior.task_id !== taskId || prior.fingerprint !== fingerprint)
          fail(
            'idempotency_conflict',
            'Manager decision ID reused with different content.',
          );
        if (!prior.receipt)
          fail(
            'manager_dispatch_incomplete',
            'Manager decision has no committed dispatch receipt.',
          );
        return decode<ManagerDispatchReceipt>(prior.receipt!);
      }
      const { task, state } = this.assertManagerFence(taskId, decision);
      const latest = this.db
        .prepare('SELECT MAX(cursor) AS cursor FROM events WHERE task_id=?')
        .get(taskId) as { cursor: number | null };
      if (
        decision.event_cursor < state.last_handled_event_cursor ||
        decision.event_cursor > (latest.cursor ?? 0)
      )
        fail(
          'invalid_manager_cursor',
          'Manager event cursor is outside the admitted event range.',
        );
      for (const ref of decision.references)
        this.artifact(ref.id, task.identity, ref);
      this.db
        .prepare('INSERT INTO manager_decisions VALUES(?,?,?,?,?,NULL)')
        .run(
          decision.id,
          taskId,
          decision.run_id,
          fingerprint,
          JSON.stringify(decision),
        );
      state.decisions.push({ decision, created_at: now() });
      if (decision.interpretation)
        state.interpretation = copy(decision.interpretation);
      this.putManager(state);
      const result = execute();
      const committed = this.managerState(taskId, task.identity)!;
      committed.last_handled_event_cursor = decision.event_cursor;
      const receipt: ManagerDispatchReceipt = {
        decision_id: decision.id,
        run_id: decision.run_id,
        objective_revision: decision.objective_revision,
        plan_revision: decision.plan_revision,
        applied_plan_revision: committed.plan_revision,
        status: 'applied',
        result,
        created_at: now(),
      };
      committed.dispatch_receipts.push(receipt);
      this.putManager(committed);
      this.db
        .prepare('UPDATE manager_decisions SET receipt=? WHERE id=?')
        .run(JSON.stringify(receipt), decision.id);
      this.appendEvent(
        taskId,
        'manager_decision_applied',
        'Manager',
        decision.explanation,
        {
          decision_id: decision.id,
          action: decision.action.type,
          plan_revision: committed.plan_revision,
        },
      );
      return receipt;
    });
  }
  private preserveAssignment(assignment: Assignment) {
    this.db
      .prepare('INSERT OR IGNORE INTO assignment_history VALUES(?,?,?)')
      .run(assignment.id, assignment.revision, JSON.stringify(assignment));
  }
  /** Read dependency metadata for fencing, without disclosing revoked artifact content. */
  private artifactAssignments(
    refs: ArtifactRef[],
    visited = new Set<string>(),
  ): Set<string> {
    const producers = new Set<string>();
    for (const ref of refs) {
      if (visited.has(ref.id)) continue;
      visited.add(ref.id);
      const row = this.db
        .prepare('SELECT body FROM artifacts WHERE id=?')
        .get(ref.id) as Row | undefined;
      if (!row) continue;
      const artifact = artifactSchema.parse(decode(row.body));
      if (artifact.assignment_id) producers.add(artifact.assignment_id);
      for (const producer of this.artifactAssignments(
        artifact.dependencies,
        visited,
      ))
        producers.add(producer);
    }
    return producers;
  }
  assignmentHistory(
    taskId: string,
    identity: TaskIdentity,
    assignmentId: string,
  ): Assignment[] {
    this.core(taskId, identity);
    this.assignment(assignmentId, taskId);
    return (
      this.db
        .prepare(
          'SELECT body FROM assignment_history WHERE assignment_id=? ORDER BY revision',
        )
        .all(assignmentId) as Row[]
    ).map((row) => assignmentSchema.parse(decode(row.body)));
  }
  applyManagerPlan(
    taskId: string,
    decision: ManagerDecision,
    changes: ManagerPlanChanges,
  ): { revision: number; assignments: Assignment[] } {
    return this.atomic(() => {
      const { task, run, state } = this.assertManagerFence(taskId, decision);
      const previous = this.allAssignments(run.id),
        retire = new Set(changes.retire ?? []),
        changed = new Set<string>([
          ...retire,
          ...(changes.revise ?? []).map((revision) => revision.id),
        ]);
      const failedWork = previous.filter((item) =>
        ['failed', 'timed_out'].includes(item.status),
      );
      for (const replacement of changes.create ?? [])
        if (
          failedWork.some(
            (item) =>
              item.definition_id === replacement.definition_id &&
              contentHash({
                brief: item.brief,
                input: item.input ?? null,
                dependencies: item.dependencies,
                inputs: item.inputs,
                tools: item.tools,
              }) ===
                contentHash({
                  brief: replacement.brief,
                  input: replacement.input ?? null,
                  dependencies: replacement.dependencies ?? [],
                  inputs: replacement.inputs ?? [],
                  tools: replacement.tools ?? [],
                }),
          )
        )
          fail(
            'manager_no_progress',
            'Repeating failed work requires a changed brief, evidence, dependency, or authorized alternative.',
            422,
          );
      if (
        [
          ...(changes.retire ?? []),
          ...(changes.revise ?? []).map((revision) => revision.id),
        ].some((id, index, ids) => ids.indexOf(id) !== index)
      )
        fail(
          'duplicate_assignment',
          'Plan changes must name each assignment once.',
          422,
        );
      for (const id of changed) {
        const item = previous.find((assignment) => assignment.id === id);
        if (!item || item.definition_id === 'core.manager.coordinator')
          fail(
            'invalid_manager_plan',
            'Plan changes must name a current specialist assignment.',
            422,
          );
      }
      for (let expanded = true; expanded;) {
        expanded = false;
        for (const item of previous)
          if (
            !changed.has(item.id) &&
            (item.dependencies.some((id) => changed.has(id)) ||
              [...this.artifactAssignments(item.inputs)].some((id) =>
                changed.has(id),
              ))
          ) {
            changed.add(item.id);
            expanded = true;
          }
      }
      for (const item of previous) {
        const revision = changes.revise?.find((entry) => entry.id === item.id);
        if (!changed.has(item.id)) continue;
        this.preserveAssignment(item);
        if (retire.has(item.id)) {
          item.status = 'cancelled';
          item.usability = 'stale';
        } else {
          if (
            revision &&
            ['failed', 'timed_out'].includes(item.status) &&
            contentHash({
              brief: item.brief,
              input: item.input ?? null,
              dependencies: item.dependencies,
              inputs: item.inputs,
              tools: item.tools,
            }) ===
              contentHash({
                brief: revision.brief,
                input: revision.input ?? item.input ?? null,
                dependencies: revision.dependencies ?? item.dependencies,
                inputs: revision.inputs ?? item.inputs,
                tools: revision.tools ?? item.tools,
              })
          )
            fail(
              'manager_no_progress',
              'Repeating failed work requires a changed brief, evidence, dependency, or authorized alternative.',
              422,
            );
          item.revision++;
          if (revision) Object.assign(item, revision);
          const registered =
            this.definitions?.assignments?.[item.definition_id];
          if (
            item.tools.some(
              (tool) =>
                !task.permissions.tools.includes(tool) ||
                (this.definitions && !this.definitions.tools.includes(tool)) ||
                (registered && !registered.tools.includes(tool)),
            )
          )
            fail(
              'permission_denied',
              'Rebrief tools exceed current grants.',
              403,
            );
          if (
            item.max_model_calls < item.usage.model_calls ||
            item.max_model_calls > run.limits.max_model_calls
          )
            fail(
              'assignment_model_limit',
              'Rebrief allocation must cover charged calls within the original run budget.',
              422,
            );
          item.status = revision ? 'queued' : 'paused';
          item.usability = revision ? 'needs_review' : 'stale';
          item.support = 'unknown';
          item.outputs = [];
          item.acknowledged_revision = 0;
          item.inputs = item.inputs.filter((ref) => {
            const artifact = this.artifactMetadata(ref.id, task.identity, ref);
            return (
              !artifact.assignment_id || !changed.has(artifact.assignment_id)
            );
          });
          delete item.error;
        }
        delete item.lease_token;
        item.objective_revision = task.objective_revision;
        item.generation = run.generation;
        this.putAssignment(item);
        this.closeChannels(run.id, item.id);
      }
      for (const prior of (
        this.db
          .prepare(
            'SELECT body FROM applicability WHERE task_id=? AND objective_revision=?',
          )
          .all(taskId, task.objective_revision) as Row[]
      ).map((row) => decode<ArtifactApplicability>(row.body))) {
        const artifact = this.artifactMetadata(
          prior.artifact.id,
          task.identity,
          prior.artifact,
        );
        if (
          (artifact.assignment_id && changed.has(artifact.assignment_id)) ||
          [...this.artifactAssignments(artifact.dependencies)].some((id) =>
            changed.has(id),
          )
        )
          this.recordApplicability(
            taskId,
            task.identity,
            prior.artifact,
            false,
            'Producer or dependency superseded by an explicit Manager plan.',
            'Runtime',
          );
      }
      const created = this.createAssignments(
        taskId,
        run.id,
        task.objective_revision,
        changes.create ?? [],
      );
      const all = this.allAssignments(run.id),
        active = all.filter((item) => item.status !== 'cancelled');
      const graph = new Map(active.map((item) => [item.id, item])),
        visiting = new Set<string>(),
        visited = new Set<string>();
      const visit = (id: string) => {
        if (visiting.has(id))
          fail('dependency_cycle', 'Assignment graph must be acyclic.', 422);
        if (visited.has(id)) return;
        const item = graph.get(id);
        if (!item)
          fail(
            'missing_prerequisite',
            'Plan retains a dependency on retired or missing work.',
            422,
          );
        visiting.add(id);
        for (const dependency of new Set([
          ...item!.dependencies,
          ...[...this.artifactAssignments(item!.inputs)].filter((id) =>
            graph.has(id),
          ),
        ]))
          visit(dependency);
        visiting.delete(id);
        visited.add(id);
      };
      for (const item of active) visit(item.id);
      for (const reuse of changes.reuse ?? [])
        this.applyManagerApplicability(
          taskId,
          decision,
          reuse.artifact,
          true,
          reuse.reason,
        );
      state.plan_revision++;
      state.plans.push({
        revision: state.plan_revision,
        objective_revision: task.objective_revision,
        decision_id: decision.id,
        reason: decision.explanation,
        assignment_revisions: all
          .filter((item) => item.status !== 'cancelled')
          .map((item) => ({ id: item.id, revision: item.revision })),
        created_at: now(),
      });
      this.putManager(state);
      const interrupted = (
        this.db
          .prepare('SELECT body FROM attempts WHERE task_id=?')
          .all(taskId) as Row[]
      )
        .map((row) => decode<AttemptRecord>(row.body))
        .some(
          (attempt) =>
            attempt.run_id === run.id &&
            changed.has(attempt.assignment_id) &&
            attempt.status === 'started',
        );
      if (interrupted) {
        const fenced = this.run(run.id);
        fenced.generation++;
        fenced.status = 'paused';
        this.markUnknown(run.id);
        for (const assignment of this.allAssignments(run.id))
          if (!terminal(assignment.status)) {
            assignment.generation = fenced.generation;
            assignment.status = 'paused';
            delete assignment.lease_token;
            this.putAssignment(assignment);
          }
        this.putRun(fenced);
        this.appendEvent(
          taskId,
          'manager_replan_outcome_unknown',
          'Runtime',
          'Plan changes fenced an in-flight remote attempt. The charged unknown outcome requires explicit resume.',
        );
      }
      this.appendEvent(
        taskId,
        'manager_plan_revised',
        'Manager',
        decision.explanation,
        {
          plan_revision: state.plan_revision,
          created: created.map((item) => item.id),
          revised: [...changed],
        },
      );
      return {
        revision: state.plan_revision,
        assignments: this.allAssignments(run.id),
      };
    });
  }
  applyManagerApplicability(
    taskId: string,
    decision: ManagerDecision,
    ref: ArtifactRef,
    current: boolean,
    reason: string,
  ): ArtifactApplicability {
    const { task, state } = this.assertManagerFence(taskId, decision);
    if (
      current &&
      !state.inspections.some(
        (inspection) =>
          inspection.objective_revision === task.objective_revision &&
          inspection.artifact.id === ref.id &&
          inspection.artifact.version === ref.version &&
          inspection.artifact.sha256 === ref.sha256,
      )
    )
      fail(
        'manager_inspection_required',
        'Applicability requires actual inspection against the corrected objective.',
        422,
      );
    const artifact = this.artifact(ref.id, task.identity, ref);
    if (current && artifact.assignment_id) {
      const producer = this.assignment(artifact.assignment_id, taskId);
      if (
        producer.revision !== artifact.assignment_revision ||
        ['stale', 'cancelled'].includes(producer.status) ||
        producer.usability === 'stale'
      )
        fail(
          'artifact_not_applicable',
          'Producer revision or dependency was superseded.',
        );
    }
    if (current)
      for (const dependency of artifact.dependencies) {
        this.artifact(dependency.id, task.identity, dependency);
        if (
          !this.applicability(taskId, dependency.id, task.objective_revision)
            ?.current
        )
          fail(
            'artifact_not_applicable',
            'Dependency applicability remains uncertain.',
          );
      }
    return this.recordApplicability(
      taskId,
      task.identity,
      ref,
      current,
      reason,
      `Manager:${decision.id}`,
    );
  }
  grantManagerPeerChannel(
    taskId: string,
    decision: ManagerDecision,
    purpose: string,
    participants: { assignment_id: string; revision: number }[],
  ): PeerChannel {
    this.assertManagerFence(taskId, decision);
    for (const participant of participants) {
      const assignment = this.assignment(participant.assignment_id, taskId);
      if (assignment.revision !== participant.revision)
        fail(
          'stale_manager_decision',
          'Peer grant names a superseded assignment revision.',
        );
      if (
        assignment.role === 'Manager' ||
        terminal(assignment.status) ||
        assignment.usability === 'stale'
      )
        fail(
          'invalid_peer_participant',
          'Peer grants require current active specialist revisions.',
          422,
        );
    }
    return this.openPeerChannel(
      taskId,
      decision.run_id,
      purpose,
      participants.map((participant) => participant.assignment_id),
    );
  }
  closeManagerAssignments(
    taskId: string,
    decision: ManagerDecision,
    assignmentIds?: string[],
  ) {
    return this.atomic(() => {
      const { run } = this.assertManagerFence(taskId, decision);
      const interrupted = (
        this.db
          .prepare('SELECT body FROM attempts WHERE task_id=?')
          .all(taskId) as Row[]
      )
        .map((row) => decode<AttemptRecord>(row.body))
        .some(
          (attempt) =>
            attempt.run_id === run.id &&
            attempt.status === 'started' &&
            (!assignmentIds || assignmentIds.includes(attempt.assignment_id)),
        );
      if (interrupted) {
        run.generation++;
        run.status = 'paused';
        this.markUnknown(run.id);
      }
      for (const assignment of this.allAssignments(run.id)) {
        if (
          assignmentIds &&
          !assignmentIds.includes(assignment.id) &&
          !interrupted
        )
          continue;
        if (!terminal(assignment.status)) {
          assignment.status =
            assignment.definition_id === 'core.manager.coordinator'
              ? interrupted
                ? 'paused'
                : 'completed'
              : !assignmentIds || assignmentIds.includes(assignment.id)
                ? 'cancelled'
                : 'paused';
          assignment.generation = run.generation;
          delete assignment.lease_token;
          this.putAssignment(assignment);
        }
      }
      this.putRun(run);
      this.closeChannels(run.id);
      if (interrupted)
        this.appendEvent(
          taskId,
          'manager_finalization_outcome_unknown',
          'Runtime',
          'Finalization fenced an in-flight remote attempt. Its outcome remains charged and unknown; explicit resume is required before committing a result.',
        );
      return { paused: interrupted };
    });
  }
  recordManagerEscalation(
    taskId: string,
    assignmentId: string,
    kind: string,
    detail: string,
  ) {
    const task = this.core(taskId),
      run = this.run(task.current_run_id),
      assignment = this.assignment(assignmentId, taskId);
    this.assertCurrent(task, run, assignment);
    return this.appendEvent(
      taskId,
      'specialist_escalated',
      assignment.role,
      detail,
      { kind },
      assignmentId,
    );
  }
  pauseManagerRecovery(
    taskId: string,
    fence: ManagerFence,
    reason: string,
  ): TaskRecord {
    return this.atomic(() => {
      const { task, run } = this.assertManagerFence(taskId, fence);
      run.generation++;
      run.status = 'paused';
      for (const assignment of this.allAssignments(run.id))
        if (!terminal(assignment.status)) {
          assignment.status = 'paused';
          assignment.generation = run.generation;
          delete assignment.lease_token;
          this.putAssignment(assignment);
        }
      this.markUnknown(run.id);
      this.closeChannels(run.id);
      this.putRun(run);
      this.appendEvent(taskId, 'manager_recovery_paused', 'Runtime', reason);
      return this.read(taskId, task.identity);
    });
  }
  waitForManagerEvent(
    taskId: string,
    fence: ManagerFence,
    reason: string,
  ): TaskRecord {
    return this.atomic(() => {
      const { task, run } = this.assertManagerFence(taskId, fence);
      const assignments = this.allAssignments(run.id);
      const started = (
        this.db
          .prepare('SELECT body FROM attempts WHERE task_id=?')
          .all(taskId) as Row[]
      )
        .map((row) => decode<AttemptRecord>(row.body))
        .some(
          (attempt) =>
            attempt.run_id === run.id && attempt.status === 'started',
        );
      if (
        started ||
        assignments.some(
          (assignment) =>
            assignment.role !== 'Manager' && assignment.status === 'running',
        )
      )
        fail(
          'manager_wait_work_active',
          'A durable Manager wait requires no active execution.',
        );
      run.status = 'waiting';
      for (const assignment of assignments)
        if (
          assignment.definition_id === 'core.manager.coordinator' &&
          !terminal(assignment.status)
        ) {
          assignment.status = 'waiting';
          delete assignment.lease_token;
          this.putAssignment(assignment);
        }
      this.putRun(run);
      this.appendEvent(taskId, 'manager_waiting', 'Manager', reason);
      return this.read(taskId, task.identity);
    });
  }
  private atomic<T>(operation: () => T): T {
    if (this.transactionDepth) return operation();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }
  private core(id: string, identity?: TaskIdentity): TaskCore {
    const row = this.db.prepare('SELECT body FROM tasks WHERE id=?').get(id) as
      Row | undefined;
    if (!row) return fail('task_not_found', 'Task not found.', 404);
    const task = decode<TaskCore>(row.body);
    if (
      identity &&
      (task.identity.principal !== identity.principal ||
        task.identity.workspace !== identity.workspace)
    )
      return fail(
        'task_not_found',
        'Task not found in this principal/workspace.',
        404,
      );
    return task;
  }
  private putCore(task: TaskCore) {
    task.updated_at = now();
    this.db
      .prepare('UPDATE tasks SET body=? WHERE id=?')
      .run(JSON.stringify(task), task.id);
  }
  private run(id: string): RunRecord {
    const row = this.db.prepare('SELECT body FROM runs WHERE id=?').get(id) as
      Row | undefined;
    if (!row) return fail('run_not_found', 'Run not found.', 404);
    return decode<RunRecord>(row.body);
  }
  private putRun(run: RunRecord, bump = true) {
    run.updated_at = now();
    if (bump) run.state_revision++;
    this.db
      .prepare('UPDATE runs SET body=? WHERE id=?')
      .run(JSON.stringify(run), run.id);
  }
  private assignment(id: string, taskId?: string): Assignment {
    const row = this.db
      .prepare('SELECT body FROM assignments WHERE id=?')
      .get(id) as Row | undefined;
    if (!row) return fail('assignment_not_found', 'Assignment not found.', 404);
    const assignment = assignmentSchema.parse(decode(row.body));
    if (taskId && assignment.task_id !== taskId)
      return fail('assignment_not_found', 'Assignment not found.', 404);
    return assignment;
  }
  private putAssignment(assignment: Assignment) {
    const parsed = assignmentSchema.parse(assignment);
    this.db
      .prepare('UPDATE assignments SET body=? WHERE id=?')
      .run(JSON.stringify(parsed), parsed.id);
  }
  private allAssignments(runId: string): Assignment[] {
    return (
      this.db
        .prepare('SELECT body FROM assignments WHERE run_id=? ORDER BY rowid')
        .all(runId) as Row[]
    ).map((row) => assignmentSchema.parse(decode(row.body)));
  }
  exists(id: string) {
    return !!this.db.prepare('SELECT id FROM tasks WHERE id=?').get(id);
  }
  read(id: string, identity: TaskIdentity): TaskRecord {
    const task = this.core(id, identity),
      run = this.run(task.current_run_id);
    const list = (table: string) =>
      (
        this.db
          .prepare(`SELECT body FROM ${table} WHERE task_id=? ORDER BY rowid`)
          .all(id) as Row[]
      ).map((row) => decode(row.body));
    return taskRecordSchema.parse({
      ...task,
      generation: run.generation,
      state_revision: run.state_revision,
      status: run.status,
      limits: run.limits,
      usage: run.usage,
      runs: list('runs'),
      assignments: list('assignments'),
      corrections: list('corrections'),
      questions: list('questions'),
      artifacts: list('applicability'),
      ...(this.managerState(id, identity)
        ? { manager: this.managerState(id, identity) }
        : {}),
    });
  }
  listRecoverableTasks(): TaskRecord[] {
    return (this.db.prepare('SELECT body FROM tasks').all() as Row[])
      .map((row) => decode<TaskCore>(row.body))
      .filter(
        (task) =>
          this.executionVersion(task.current_run_id)?.engine === 'langgraph' &&
          ['queued', 'running'].includes(this.run(task.current_run_id).status),
      )
      .map((task) => this.read(task.id, task.identity));
  }
  private operation<T>(
    identity: TaskIdentity,
    scope: string,
    key: string,
    original: unknown,
    execute: () => T,
  ): { value: T; reused: boolean } {
    if (!key || key.length > 256)
      fail(
        'idempotency_key_required',
        'Provide an idempotency key of at most 256 characters.',
        400,
      );
    const ownerScope = JSON.stringify([
        identity.principal,
        identity.workspace,
        scope,
      ]),
      fingerprint = contentHash(original);
    const prior = this.db
      .prepare(
        'SELECT fingerprint,receipt FROM operations WHERE scope=? AND key=?',
      )
      .get(ownerScope, key) as
      { fingerprint: string; receipt: string } | undefined;
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        fail(
          'idempotency_conflict',
          'This key was used with different content.',
        );
      return { value: decode<T>(prior.receipt), reused: true };
    }
    const value = execute();
    this.db
      .prepare('INSERT INTO operations VALUES(?,?,?,?)')
      .run(ownerScope, key, fingerprint, JSON.stringify(value));
    return { value, reused: false };
  }
  admit(
    request: TaskRequest,
    identity: TaskIdentity,
    key: string,
    options: {
      mode?: TaskRecord['mode'];
      limits?: Partial<ResourceLimits>;
      tools?: string[];
    } = {},
  ): { task: TaskRecord; reused: boolean } {
    const parsed = taskRequestSchema.parse(request);
    return this.atomic(() => {
      const result = this.operation(
        identity,
        'POST /api/tasks',
        key,
        parsed,
        () => {
          const active = (
            this.db.prepare('SELECT body FROM runs').all() as Row[]
          )
            .map((row) => decode<RunRecord>(row.body))
            .filter((run) =>
              ['queued', 'running', 'waiting'].includes(run.status),
            );
          if (active.length >= 2)
            fail(
              'active_task_limit',
              'Two active tasks are already admitted.',
              429,
            );
          for (const ref of parsed.context_refs)
            this.artifact(ref.id, identity, ref);
          const limits = resourceLimitsSchema.parse({
            deadline: new Date(Date.now() + 90_000).toISOString(),
            max_model_calls: 6,
            max_tool_calls: 6,
            max_assignments: 6,
            max_artifacts: 16,
            max_model_input_bytes: 16_384,
            max_model_output_tokens: 1200,
            reserved_model_calls: 2,
            ...options.limits,
          });
          if (Date.parse(limits.deadline) <= Date.now())
            fail('deadline_expired', 'Admission deadline has passed.', 422);
          const id = randomUUID(),
            runId = randomUUID(),
            at = now();
          const task: TaskCore = {
            schema_version: 'haze.task.v3',
            id,
            original_request: parsed,
            identity: copy(identity),
            permissions: {
              tools: [...new Set(options.tools ?? [])],
              effects: [],
            },
            mode: options.mode ?? 'live',
            objective_revision: 1,
            current_run_id: runId,
            created_at: at,
            updated_at: at,
          };
          const run: RunRecord = {
            id: runId,
            task_id: id,
            objective_revision: 1,
            generation: 1,
            state_revision: 1,
            status: 'queued',
            limits,
            usage: {
              model_calls: 0,
              tool_calls: 0,
              artifacts: 0,
              assignments: 0,
            },
            created_at: at,
            updated_at: at,
          };
          this.db
            .prepare('INSERT INTO tasks VALUES(?,?,?,?)')
            .run(
              id,
              identity.principal,
              identity.workspace,
              JSON.stringify(task),
            );
          this.db
            .prepare('INSERT INTO runs VALUES(?,?,?)')
            .run(runId, id, JSON.stringify(run));
          this.graph.register(runId);
          this.initializeManager(task.id, runId);
          for (const ref of parsed.context_refs)
            this.recordApplicability(
              id,
              identity,
              ref,
              true,
              'Source explicitly included at admission.',
              'Runtime',
            );
          this.appendEvent(
            id,
            'task_admitted',
            'Manager',
            'General objective admitted with bounded resources.',
          );
          return this.read(id, identity);
        },
      );
      return { task: result.value, reused: result.reused };
    });
  }
  appendEvent(
    taskId: string,
    type: string,
    actor: TaskEvent['actor'],
    message: string,
    data?: JsonValue,
    assignmentId?: string,
  ): TaskEvent {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(task.current_run_id);
      const event = {
        schema_version: 'haze.task.event.v3' as const,
        task_id: taskId,
        run_id: run.id,
        objective_revision: task.objective_revision,
        generation: run.generation,
        at: now(),
        type,
        actor,
        message,
        ...(data === undefined ? {} : { data }),
        ...(assignmentId ? { assignment_id: assignmentId } : {}),
      };
      const receipt = this.db
        .prepare('INSERT INTO events(task_id,body) VALUES(?,?)')
        .run(taskId, JSON.stringify(event));
      const cursor = Number(receipt.lastInsertRowid);
      if (!(type === 'restart_recovered' && run.status === 'waiting'))
        this.graph.wake(taskId, cursor, type);
      if (
        this.executionVersion(run.id)?.engine === 'langgraph' &&
        ['queued', 'running', 'waiting'].includes(run.status) &&
        !(type === 'restart_recovered' && run.status === 'waiting') &&
        this.materialManagerEvents(taskId, run.id, cursor - 1).some(
          (item) => item.cursor === cursor,
        )
      ) {
        const authority = {
          task_id: taskId,
          run_id: run.id,
          generation: run.generation,
          objective_revision: task.objective_revision,
        };
        this.graph.enqueue({
          ...authority,
          thread_id: graphThreadId('manager', authority),
          kind: 'manager',
          cursor,
        });
      }
      return { ...event, cursor: Number(receipt.lastInsertRowid) };
    });
  }
  events(id: string, identity: TaskIdentity, after = 0) {
    const task = this.read(id, identity);
    const events = (
      this.db
        .prepare(
          'SELECT cursor,body FROM events WHERE task_id=? AND cursor>? ORDER BY cursor LIMIT 100',
        )
        .all(id, after) as (Row & { cursor: number })[]
    ).map((row) => ({
      ...decode<Omit<TaskEvent, 'cursor'>>(row.body),
      cursor: row.cursor,
    }));
    return {
      events,
      next_cursor: events.at(-1)?.cursor ?? after,
      status: task.status,
    };
  }
  private assertCurrent(
    task: TaskCore,
    run: RunRecord,
    assignment?: Assignment,
    generation?: number,
  ) {
    this.assertGraphExecution(run.id);
    if (
      task.current_run_id !== run.id ||
      task.objective_revision !== run.objective_revision ||
      (generation !== undefined && run.generation !== generation)
    )
      fail('stale_execution', 'Run or generation has been fenced.');
    if (!['queued', 'running'].includes(run.status))
      fail(
        'execution_not_running',
        'Execution is paused, waiting, or terminal.',
      );
    if (Date.parse(run.limits.deadline) <= Date.now())
      fail(
        'deadline_expired',
        'Original deadline passed; explicitly continue to admit a new run.',
        422,
      );
    if (
      assignment &&
      (assignment.run_id !== run.id ||
        assignment.objective_revision !== task.objective_revision ||
        assignment.generation !== run.generation ||
        assignment.acknowledged_revision !== assignment.revision ||
        assignment.status !== 'running')
    )
      fail(
        'stale_execution',
        'Assignment lease or revised brief is not current.',
      );
    if (assignment) this.checkDefinitions(assignment);
  }
  private checkDefinitions(assignment: Assignment) {
    if (!this.definitions) return;
    const definition = this.definitions.assignments?.[assignment.definition_id];
    if (
      this.definitions.agents[assignment.role] !== assignment.agent_version ||
      this.definitions.capabilities[assignment.capability] !==
        assignment.capability_version ||
      (this.definitions.assignments &&
        (!definition ||
          definition.version !== assignment.definition_version ||
          definition.role !== assignment.role ||
          definition.capability !== assignment.capability))
    )
      fail(
        'definition_changed',
        'Pinned agent, capability, or executable definition version is unavailable.',
      );
  }
  private expectLease(assignment: Assignment, expected?: LeaseExpectation) {
    if (
      expected &&
      (assignment.generation !== expected.generation ||
        assignment.revision !== expected.assignment_revision ||
        assignment.lease_token !== expected.lease_token)
    )
      fail(
        'stale_execution',
        'Caller does not own the current assignment lease.',
      );
  }
  createAssignments(
    taskId: string,
    runId: string,
    objectiveRevision: number,
    definitions: AssignmentDefinition[],
  ): Assignment[] {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(runId);
      this.assertCurrent(task, run);
      if (task.objective_revision !== objectiveRevision)
        fail('stale_objective', 'Objective revision changed.');
      if (
        run.usage.assignments + definitions.length >
        run.limits.max_assignments
      )
        fail('assignment_limit', 'Assignment reservation exhausted.', 422);
      const prior = this.allAssignments(runId),
        ids = new Set(prior.map((item) => item.id));
      if (
        prior.filter(
          (item) => item.definition_id === 'core.manager.coordinator',
        ).length +
          definitions.filter(
            (item) => item.definition_id === 'core.manager.coordinator',
          ).length >
        1
      )
        fail(
          'manager_coordinator_limit',
          'Each run retains exactly one persistent Manager coordinator.',
          422,
        );
      const created = definitions.map((definition) => {
        const id = definition.id ?? randomUUID();
        if (ids.has(id))
          fail('duplicate_assignment', 'Assignment ID already exists.');
        ids.add(id);
        const registered =
          this.definitions?.assignments?.[definition.definition_id];
        if (
          this.definitions &&
          (!this.definitions.agents[definition.role] ||
            !this.definitions.capabilities[definition.capability] ||
            (this.definitions.assignments &&
              (!registered ||
                registered.version !== definition.definition_version ||
                registered.role !== definition.role ||
                registered.capability !== definition.capability)))
        )
          fail(
            'unregistered_definition',
            'Assignment definition is unregistered.',
            422,
          );
        const tools = definition.tools ?? [];
        if (
          tools.some(
            (tool) =>
              !task.permissions.tools.includes(tool) ||
              (this.definitions && !this.definitions.tools.includes(tool)) ||
              (registered && !registered.tools.includes(tool)),
          )
        )
          fail(
            'permission_denied',
            'Assignment tools exceed current grants.',
            403,
          );
        for (const ref of definition.inputs ?? [])
          this.artifact(ref.id, task.identity, ref);
        return assignmentSchema.parse({
          ...definition,
          agent_version:
            this.definitions?.agents[definition.role] ?? 'unversioned',
          capability_version:
            this.definitions?.capabilities[definition.capability] ??
            'unversioned',
          id,
          task_id: taskId,
          run_id: runId,
          revision: 1,
          objective_revision: objectiveRevision,
          generation: run.generation,
          acknowledged_revision: 0,
          inputs: definition.inputs ?? [],
          dependencies: definition.dependencies ?? [],
          tools,
          deadline: run.limits.deadline,
          max_model_calls:
            definition.max_model_calls ?? run.limits.max_model_calls,
          status: 'queued',
          usage: { model_calls: 0, tool_calls: 0 },
          outputs: [],
          assumptions: [],
          gaps: [],
        });
      });
      const graph = new Map(
          [...prior, ...created].map((item) => [item.id, item]),
        ),
        visiting = new Set<string>(),
        visited = new Set<string>();
      const visit = (id: string) => {
        if (visiting.has(id))
          fail('dependency_cycle', 'Assignment graph must be acyclic.', 422);
        if (visited.has(id)) return;
        const item = graph.get(id);
        if (!item) fail('missing_prerequisite', 'Unknown prerequisite.', 422);
        visiting.add(id);
        for (const dep of new Set([
          ...item!.dependencies,
          ...[...this.artifactAssignments(item!.inputs)].filter((producer) =>
            graph.has(producer),
          ),
        ]))
          visit(dep);
        visiting.delete(id);
        visited.add(id);
      };
      for (const item of [...prior, ...created]) visit(item.id);
      for (const item of created)
        this.db
          .prepare('INSERT INTO assignments VALUES(?,?,?,?)')
          .run(item.id, taskId, runId, JSON.stringify(item));
      run.usage.assignments += created.length;
      this.putRun(run);
      this.appendEvent(
        taskId,
        'assignments_created',
        'Manager',
        `Admitted ${created.length} assignments.`,
        { assignment_ids: created.map((item) => item.id) },
      );
      return created;
    });
  }
  acquireAssignment(taskId: string, assignmentId: string): Assignment | null {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(task.current_run_id),
        assignment = this.assignment(assignmentId, taskId);
      this.assertCurrent(task, run);
      this.checkDefinitions(assignment);
      if (
        assignment.run_id !== run.id ||
        !['queued', 'paused'].includes(assignment.status)
      )
        return null;
      const peers = this.allAssignments(run.id);
      if (
        assignment.usability === 'stale' &&
        assignment.definition_id !== 'core.manager.coordinator' &&
        peers.some((item) => item.definition_id === 'core.manager.coordinator')
      )
        return null;
      if (
        assignment.dependencies.some(
          (id) =>
            !peers.some(
              (item) =>
                item.id === id &&
                item.status === 'completed' &&
                !['rejected', 'stale'].includes(item.usability),
            ),
        )
      )
        return null;
      const active = (
        this.db.prepare('SELECT body FROM assignments').all() as Row[]
      )
        .map((row) => decode<Assignment>(row.body))
        .filter((item) => item.role !== 'Manager' && item.status === 'running');
      if (assignment.role !== 'Manager' && active.length >= 2) return null;
      assignment.inputs = [
        ...new Map(
          [
            ...assignment.inputs,
            ...peers
              .filter((item) => assignment.dependencies.includes(item.id))
              .flatMap((item) => item.outputs),
          ].map((ref) => [ref.id, ref]),
        ).values(),
      ];
      for (const ref of assignment.inputs) {
        this.artifact(ref.id, task.identity, ref);
        if (
          assignment.definition_id !== 'core.manager.coordinator' &&
          !this.applicability(taskId, ref.id, task.objective_revision)?.current
        )
          fail(
            'artifact_not_applicable',
            'Input has no current applicability check.',
          );
      }
      assignment.generation = run.generation;
      assignment.objective_revision = task.objective_revision;
      assignment.acknowledged_revision = assignment.revision;
      assignment.status = 'running';
      assignment.lease_token = randomUUID();
      this.putAssignment(assignment);
      run.status = 'running';
      this.putRun(run);
      this.appendEvent(
        taskId,
        'assignment_started',
        assignment.role,
        'Exact inputs pinned and revised brief acknowledged.',
        undefined,
        assignment.id,
      );
      return assignment;
    });
  }
  patchAssignment(
    taskId: string,
    assignmentId: string,
    generation: number,
    patch: Partial<
      Pick<
        Assignment,
        'status' | 'assumptions' | 'gaps' | 'support' | 'usability' | 'error'
      >
    >,
  ): Assignment {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(task.current_run_id),
        assignment = this.assignment(assignmentId, taskId);
      this.assertCurrent(task, run, assignment, generation);
      Object.assign(assignment, patch);
      if (assignment.status !== 'running') delete assignment.lease_token;
      this.putAssignment(assignment);
      this.putRun(run);
      return assignment;
    });
  }
  chargeAttempt(
    taskId: string,
    assignmentId: string,
    kind: 'model' | 'tool',
    details: JsonValue = {},
    expected?: LeaseExpectation,
  ): AttemptRecord {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(task.current_run_id),
        assignment = this.assignment(assignmentId, taskId);
      this.assertCurrent(task, run, assignment);
      this.expectLease(assignment, expected);
      if (kind === 'model') {
        if (assignment.usage.model_calls >= assignment.max_model_calls)
          fail(
            'assignment_model_limit',
            'Assignment model budget exhausted.',
            422,
          );
        // Reserve synthesis and independent-review turns before any specialist allocation.
        const modelAttempts = (
          this.db
            .prepare('SELECT body FROM attempts WHERE task_id=?')
            .all(taskId) as Row[]
        )
          .map((row) => decode<AttemptRecord>(row.body))
          .filter(
            (attempt) => attempt.run_id === run.id && attempt.kind === 'model',
          );
        const synthesisUsed = modelAttempts.filter(
          (attempt) =>
            this.assignment(attempt.assignment_id).definition_id ===
            'core.manager.synthesis',
        ).length;
        const reviewUsed = modelAttempts.filter(
          (attempt) =>
            this.assignment(attempt.assignment_id).role === 'EvidenceCritic',
        ).length;
        const synthesisRemaining = Math.max(
          0,
          Math.ceil(run.limits.reserved_model_calls / 2) - synthesisUsed,
        );
        const completedReview = this.allAssignments(run.id).some(
          (item) =>
            item.role === 'EvidenceCritic' &&
            item.objective_revision === task.objective_revision &&
            item.status === 'completed' &&
            item.usability !== 'stale',
        );
        const reviewRemaining = completedReview
          ? 0
          : Math.max(
              0,
              Math.floor(run.limits.reserved_model_calls / 2) - reviewUsed,
            );
        const reserve =
          (['core.manager.synthesis', 'core.manager.coordinator'].includes(
            assignment.definition_id,
          )
            ? 0
            : synthesisRemaining) +
          (assignment.role === 'EvidenceCritic' ? 0 : reviewRemaining);
        if (run.usage.model_calls >= run.limits.max_model_calls - reserve)
          fail(
            'model_limit',
            'Model capacity exhausted or reserved for synthesis/review.',
            422,
          );
        run.usage.model_calls++;
        assignment.usage.model_calls++;
      } else {
        const tool =
          typeof details === 'object' &&
          details !== null &&
          !Array.isArray(details)
            ? details['tool']
            : undefined;
        if (
          typeof tool !== 'string' ||
          !task.permissions.tools.includes(tool) ||
          !assignment.tools.includes(tool)
        )
          fail(
            'permission_denied',
            'Tool was not granted or was revoked.',
            403,
          );
        if (run.usage.tool_calls >= run.limits.max_tool_calls)
          fail('tool_limit', 'Tool attempts exhausted.', 422);
        run.usage.tool_calls++;
        assignment.usage.tool_calls++;
      }
      const attempt: AttemptRecord = {
        id: randomUUID(),
        task_id: taskId,
        run_id: run.id,
        assignment_id: assignmentId,
        objective_revision: task.objective_revision,
        assignment_revision: assignment.revision,
        generation: run.generation,
        lease_token: assignment.lease_token!,
        kind,
        status: 'started',
        charged_at: now(),
        details: copy(details),
        accepted: false,
      };
      this.db
        .prepare('INSERT INTO attempts VALUES(?,?,?,?)')
        .run(attempt.id, taskId, assignmentId, JSON.stringify(attempt));
      this.putRun(run);
      this.putAssignment(assignment);
      this.appendEvent(
        taskId,
        'attempt_charged',
        assignment.role,
        `${kind} attempt charged before dispatch.`,
        { attempt_id: attempt.id },
        assignmentId,
      );
      return attempt;
    });
  }
  completeAttempt(
    taskId: string,
    attemptId: string,
    result: { output?: JsonValue; receipt?: JsonValue; error?: JsonValue },
  ): AttemptRecord {
    return this.atomic(() => {
      const row = this.db
        .prepare('SELECT body FROM attempts WHERE id=? AND task_id=?')
        .get(attemptId, taskId) as Row | undefined;
      if (!row) return fail('attempt_not_found', 'Attempt not found.', 404);
      const attempt = decode<AttemptRecord>(row.body);
      if (['completed', 'failed'].includes(attempt.status)) return attempt;
      const task = this.core(taskId),
        run = this.run(task.current_run_id),
        assignment = this.assignment(attempt.assignment_id, taskId);
      const tool =
        typeof attempt.details === 'object' &&
        attempt.details !== null &&
        !Array.isArray(attempt.details)
          ? attempt.details['tool']
          : undefined;
      attempt.accepted =
        result.error === undefined &&
        attempt.status !== 'unknown' &&
        run.id === attempt.run_id &&
        run.generation === attempt.generation &&
        task.objective_revision === attempt.objective_revision &&
        assignment.revision === attempt.assignment_revision &&
        assignment.status === 'running' &&
        assignment.lease_token === attempt.lease_token &&
        ['queued', 'running'].includes(run.status) &&
        Date.parse(run.limits.deadline) > Date.now() &&
        (attempt.kind !== 'tool' ||
          (typeof tool === 'string' &&
            task.permissions.tools.includes(tool) &&
            assignment.tools.includes(tool)));
      attempt.status = result.error === undefined ? 'completed' : 'failed';
      Object.assign(attempt, copy(result));
      this.db
        .prepare('UPDATE attempts SET body=? WHERE id=?')
        .run(JSON.stringify(attempt), attemptId);
      this.appendEvent(
        taskId,
        attempt.accepted ? 'attempt_completed' : 'late_receipt_recorded',
        assignment.role,
        attempt.accepted
          ? 'Current attempt receipt persisted.'
          : 'Historical receipt retained; output excluded by execution fence.',
        { attempt_id: attempt.id, accepted: attempt.accepted },
        assignment.id,
      );
      return attempt;
    });
  }
  interruptUnknown(
    taskId: string,
    attemptId: string,
    error: JsonValue,
    expected?: LeaseExpectation,
  ): AttemptRecord {
    return this.atomic(() => {
      const row = this.db
        .prepare('SELECT body FROM attempts WHERE id=? AND task_id=?')
        .get(attemptId, taskId) as Row | undefined;
      if (!row) return fail('attempt_not_found', 'Attempt not found.', 404);
      const attempt = decode<AttemptRecord>(row.body);
      if (
        expected &&
        (attempt.generation !== expected.generation ||
          attempt.assignment_revision !== expected.assignment_revision ||
          attempt.lease_token !== expected.lease_token)
      )
        fail(
          'stale_execution',
          'Caller lease does not identify this interrupted attempt.',
        );
      // A committed receipt wins a simultaneous local timeout. Never replace known history.
      if (attempt.status === 'completed' || attempt.status === 'failed')
        return attempt;
      const wasStarted = attempt.status === 'started';
      attempt.status = 'unknown';
      attempt.accepted = false;
      attempt.error = copy(error);
      this.db
        .prepare('UPDATE attempts SET body=? WHERE id=?')
        .run(JSON.stringify(attempt), attempt.id);
      const task = this.core(taskId),
        run = this.run(task.current_run_id),
        assignment = this.assignment(attempt.assignment_id, taskId);
      const ownsCurrentLease =
        wasStarted &&
        task.current_run_id === attempt.run_id &&
        run.generation === attempt.generation &&
        task.objective_revision === attempt.objective_revision &&
        assignment.revision === attempt.assignment_revision &&
        assignment.status === 'running' &&
        assignment.lease_token === attempt.lease_token &&
        ['queued', 'running'].includes(run.status);
      if (ownsCurrentLease) {
        run.generation++;
        run.status = 'paused';
        for (const item of this.allAssignments(run.id))
          if (item.status === 'running') {
            item.status = 'paused';
            item.acknowledged_revision = 0;
            delete item.lease_token;
            this.putAssignment(item);
          }
        this.markUnknown(run.id);
        this.putRun(run);
        // Pause preserves revision-bound peer history and its original expiry/budget.
        this.appendEvent(
          taskId,
          'remote_outcome_unknown',
          'Runtime',
          'Remote outcome is unknown and remains charged. Execution is fenced; explicitly resume to admit a replacement attempt.',
          { attempt_id: attempt.id, generation: attempt.generation },
        );
      }
      return attempt;
    });
  }
  attempts(taskId: string, identity: TaskIdentity): AttemptRecord[] {
    this.core(taskId, identity);
    return (
      this.db
        .prepare('SELECT body FROM attempts WHERE task_id=? ORDER BY rowid')
        .all(taskId) as Row[]
    ).map((row) => decode<AttemptRecord>(row.body));
  }
  recordAction(
    taskId: string,
    assignmentId: string,
    actionId: string,
    response: JsonValue,
    validatedAction: JsonValue,
    expected?: LeaseExpectation,
  ) {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(task.current_run_id),
        assignment = this.assignment(assignmentId, taskId);
      this.assertCurrent(task, run, assignment);
      this.expectLease(assignment, expected);
      const id = `${assignmentId}:${assignment.revision}:${actionId}`,
        fingerprint = contractHash({ response, validatedAction });
      const prior = this.db
        .prepare('SELECT fingerprint,body FROM actions WHERE id=?')
        .get(id) as { fingerprint: string; body: string } | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          fail('action_conflict', 'Action ID reused with different content.');
        return decode<ActionRecord>(prior.body);
      }
      const action: ActionRecord = {
        created_generation: run.generation,
        id,
        action_id: actionId,
        task_id: taskId,
        run_id: run.id,
        objective_revision: task.objective_revision,
        assignment_id: assignmentId,
        assignment_revision: assignment.revision,
        generation: run.generation,
        response,
        action: validatedAction,
        dispatched: false,
        created_at: now(),
      };
      this.db
        .prepare('INSERT INTO actions VALUES(?,?,?,?,?)')
        .run(id, taskId, assignmentId, fingerprint, JSON.stringify(action));
      return action;
    });
  }
  actions(taskId: string, identity: TaskIdentity): ActionRecord[] {
    this.core(taskId, identity);
    return (
      this.db
        .prepare('SELECT body FROM actions WHERE task_id=? ORDER BY rowid')
        .all(taskId) as Row[]
    ).map((row) => decode<ActionRecord>(row.body));
  }
  adoptAction(
    taskId: string,
    assignmentId: string,
    actionId: string,
    expected?: LeaseExpectation,
  ): ActionRecord {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(task.current_run_id),
        assignment = this.assignment(assignmentId, taskId);
      this.assertCurrent(task, run, assignment);
      this.expectLease(assignment, expected);
      const id = `${assignmentId}:${assignment.revision}:${actionId}`,
        row = this.db
          .prepare(
            'SELECT body FROM actions WHERE id=? AND task_id=? AND assignment_id=?',
          )
          .get(id, taskId, assignmentId) as Row | undefined;
      if (!row)
        return fail('unpersisted_action', 'Validated action not found.');
      const action = decode<ActionRecord>(row.body);
      if (
        action.dispatched ||
        action.run_id !== run.id ||
        action.objective_revision !== task.objective_revision ||
        action.assignment_revision !== assignment.revision
      )
        fail(
          'action_not_replayable',
          'Only an undispatched validated action from this exact assignment revision can be adopted.',
        );
      action.generation = run.generation;
      this.db
        .prepare('UPDATE actions SET body=? WHERE id=?')
        .run(JSON.stringify(action), id);
      return action;
    });
  }
  dispatchAction(
    taskId: string,
    assignmentId: string,
    actionId: string,
    expected?: LeaseExpectation,
  ): boolean {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(task.current_run_id),
        assignment = this.assignment(assignmentId, taskId);
      this.assertCurrent(task, run, assignment);
      this.expectLease(assignment, expected);
      const id = `${assignmentId}:${assignment.revision}:${actionId}`,
        row = this.db.prepare('SELECT body FROM actions WHERE id=?').get(id) as
          Row | undefined;
      if (!row)
        return fail(
          'unpersisted_action',
          'Persist validated response/action before dispatch.',
        );
      const action = decode<{ dispatched: boolean; generation: number }>(
        row.body,
      );
      if (action.generation !== run.generation)
        fail('stale_execution', 'Action belongs to an old generation.');
      if (action.dispatched) return false;
      action.dispatched = true;
      this.db
        .prepare('UPDATE actions SET body=? WHERE id=?')
        .run(JSON.stringify(action), id);
      return true;
    });
  }
  artifact(id: string, identity: TaskIdentity, ref?: ArtifactRef): Artifact {
    const artifact = this.artifactMetadata(id, identity, ref);
    if (artifact.task_id) {
      const task = this.core(artifact.task_id, identity);
      if (
        artifact.required_tools.some(
          (tool) => !task.permissions.tools.includes(tool),
        )
      )
        fail(
          'permission_denied',
          'Artifact disclosure depends on a revoked tool grant.',
          403,
        );
    }
    return artifact;
  }
  private artifactMetadata(
    id: string,
    identity: TaskIdentity,
    ref?: ArtifactRef,
  ): Artifact {
    const row = this.db
      .prepare(
        'SELECT body FROM artifacts WHERE id=? AND principal=? AND workspace=?',
      )
      .get(id, identity.principal, identity.workspace) as Row | undefined;
    if (!row)
      return fail(
        'artifact_not_found',
        'Artifact not found in this principal/workspace.',
        404,
      );
    const artifact = artifactSchema.parse(decode(row.body));
    if (
      contentHash(artifact.content) !== artifact.sha256 ||
      (ref &&
        (ref.version !== artifact.version || ref.sha256 !== artifact.sha256))
    )
      fail('artifact_integrity', 'Exact artifact version/hash does not match.');
    return artifact;
  }
  private insertArtifact(artifact: Artifact) {
    const parsed = artifactSchema.parse(artifact);
    this.db
      .prepare('INSERT INTO artifacts VALUES(?,?,?,?)')
      .run(
        parsed.id,
        parsed.identity.principal,
        parsed.identity.workspace,
        JSON.stringify(parsed),
      );
  }
  importArtifact(
    input: ArtifactImport,
    identity: TaskIdentity,
    key: string,
  ): { artifact: Artifact; reused: boolean } {
    const parsed = artifactImportSchema.parse(input);
    return this.atomic(() => {
      const result = this.operation(
        identity,
        'POST /api/artifacts',
        key,
        parsed,
        () => {
          if (
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
              parsed.content_base64,
            )
          )
            fail('invalid_base64', 'Source must use canonical base64.', 400);
          const bytes = Buffer.from(parsed.content_base64, 'base64');
          if (bytes.toString('base64') !== parsed.content_base64)
            fail('invalid_base64', 'Source must use canonical base64.', 400);
          if (bytes.length > 1_048_576)
            fail('artifact_too_large', 'Decoded source exceeds 1 MiB.', 413);
          let text: string;
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch {
            return fail('invalid_utf8', 'Source must be valid UTF-8.', 400);
          }
          const content =
            parsed.media_type === 'application/json'
              ? parseContractJson(text)
              : text;
          const artifact: Artifact = {
            schema_version: 'haze.artifact.v3',
            id: randomUUID(),
            version: 1,
            identity: copy(identity),
            sha256: contentHash(content),
            kind: 'source.import',
            producer: { kind: 'user', id: identity.principal },
            created_at: now(),
            dependencies: [],
            required_tools: [],
            content,
            original_byte_sha256: createHash('sha256')
              .update(bytes)
              .digest('hex'),
            media_type: parsed.media_type,
            filename: parsed.filename,
            evidence_origin: 'user_supplied',
            ...(parsed.declared_origin === undefined
              ? {}
              : { declared_origin: parsed.declared_origin }),
            ...(parsed.source_location === undefined
              ? {}
              : { source_location: parsed.source_location }),
          };
          this.insertArtifact(artifact);
          return artifact;
        },
      );
      return { artifact: result.value, reused: result.reused };
    });
  }
  saveArtifact(
    taskId: string,
    identity: TaskIdentity,
    options: SaveArtifactOptions,
  ): Artifact {
    return this.atomic(() => {
      const task = this.core(taskId, identity),
        run = this.run(task.current_run_id),
        assignment =
          options.producer.kind === 'assignment'
            ? this.assignment(options.producer.id, taskId)
            : undefined;
      this.assertCurrent(task, run, assignment, options.generation);
      if (
        options.required_tools?.some(
          (tool) => !task.permissions.tools.includes(tool),
        )
      )
        fail(
          'permission_denied',
          'Artifact provenance cannot use an ungranted tool.',
          403,
        );
      if (
        assignment &&
        options.assignment_revision !== undefined &&
        assignment.revision !== options.assignment_revision
      )
        fail('stale_execution', 'Assignment revision fenced.');
      if (run.usage.artifacts >= run.limits.max_artifacts)
        fail('artifact_limit', 'Artifact reservation exhausted.', 422);
      for (const ref of options.dependencies ?? []) {
        this.artifact(ref.id, identity, ref);
        if (
          !this.applicability(taskId, ref.id, task.objective_revision)?.current
        )
          fail(
            'artifact_not_applicable',
            'Dependency has no current applicability check.',
          );
      }
      const artifact: Artifact = {
        schema_version: 'haze.artifact.v3',
        id: randomUUID(),
        version: 1,
        identity: copy(identity),
        task_id: taskId,
        run_id: run.id,
        objective_revision: task.objective_revision,
        generation: run.generation,
        ...(assignment
          ? {
              assignment_id: assignment.id,
              assignment_revision: assignment.revision,
            }
          : {}),
        sha256: contentHash(options.content),
        kind: options.kind,
        producer: options.producer,
        created_at: now(),
        dependencies: options.dependencies ?? [],
        required_tools: [
          ...new Set([
            ...(assignment?.tools ?? []),
            ...(options.required_tools ?? []),
            ...(options.dependencies ?? []).flatMap(
              (ref) => this.artifact(ref.id, identity, ref).required_tools,
            ),
          ]),
        ],
        content: options.content,
        ...(options.evidence_origin === undefined
          ? {}
          : { evidence_origin: options.evidence_origin }),
      };
      this.insertArtifact(artifact);
      run.usage.artifacts++;
      this.putRun(run);
      if (assignment) {
        assignment.outputs.push({
          id: artifact.id,
          version: artifact.version,
          sha256: artifact.sha256,
        });
        this.putAssignment(assignment);
      }
      this.recordApplicability(
        taskId,
        identity,
        artifact,
        true,
        'Produced under current objective and acknowledged lease.',
        assignment?.role ?? 'Runtime',
      );
      this.appendEvent(
        taskId,
        'artifact_saved',
        assignment?.role ?? 'Runtime',
        `Saved immutable ${artifact.kind}.`,
        {
          id: artifact.id,
          version: artifact.version,
          sha256: artifact.sha256,
          kind: artifact.kind,
        },
        assignment?.id,
      );
      return artifact;
    });
  }
  private applicability(
    taskId: string,
    artifactId: string,
    revision: number,
  ): ArtifactApplicability | undefined {
    const row = this.db
      .prepare(
        'SELECT body FROM applicability WHERE task_id=? AND artifact_id=? AND objective_revision=?',
      )
      .get(taskId, artifactId, revision) as Row | undefined;
    return row ? decode<ArtifactApplicability>(row.body) : undefined;
  }
  recordApplicability(
    taskId: string,
    identity: TaskIdentity,
    ref: ArtifactRef,
    current: boolean,
    reason: string,
    checkedBy: string,
  ): ArtifactApplicability {
    return this.atomic(() => {
      const task = this.core(taskId, identity);
      if (current) this.artifact(ref.id, identity, ref);
      else this.artifactMetadata(ref.id, identity, ref);
      const body: ArtifactApplicability = {
        artifact: { id: ref.id, version: ref.version, sha256: ref.sha256 },
        task_id: taskId,
        objective_revision: task.objective_revision,
        current,
        reason,
        checked_by: checkedBy,
        checked_at: now(),
      };
      this.db
        .prepare(
          'INSERT INTO applicability VALUES(?,?,?,?) ON CONFLICT(task_id,artifact_id,objective_revision) DO UPDATE SET body=excluded.body',
        )
        .run(taskId, ref.id, task.objective_revision, JSON.stringify(body));
      this.appendEvent(
        taskId,
        'artifact_applicability_checked',
        'Runtime',
        reason,
        { artifact_id: ref.id, current },
      );
      return body;
    });
  }
  completeAssignment(
    taskId: string,
    assignmentId: string,
    generation: number,
    result: {
      status: 'completed' | 'failed' | 'waiting';
      outputs?: ArtifactRef[];
      assumptions?: string[];
      gaps?: string[];
      support?: Assignment['support'];
      usability?: Assignment['usability'];
      error?: Assignment['error'];
    },
  ): Assignment {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(task.current_run_id),
        assignment = this.assignment(assignmentId, taskId);
      this.assertCurrent(task, run, assignment, generation);
      for (const ref of result.outputs ?? []) {
        const artifact = this.artifact(ref.id, task.identity, ref);
        if (
          artifact.assignment_id !== assignmentId ||
          artifact.assignment_revision !== assignment.revision ||
          !this.applicability(taskId, ref.id, task.objective_revision)?.current
        )
          fail(
            'invalid_assignment_output',
            'Output was not produced by current assignment revision.',
          );
      }
      Object.assign(assignment, result);
      delete assignment.lease_token;
      this.putAssignment(assignment);
      this.putRun(run);
      if (terminal(assignment.status))
        this.closeChannels(run.id, assignment.id);
      this.appendEvent(
        taskId,
        `assignment_${result.status}`,
        assignment.role,
        'Execution state persisted independently of evidence support.',
        undefined,
        assignment.id,
      );
      return assignment;
    });
  }
  saveResult(
    taskId: string,
    runId: string,
    generation: number,
    input: TaskResult,
  ): TaskRecord {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(runId);
      this.assertCurrent(task, run, undefined, generation);
      const result = taskResultSchema.parse(input);
      if (
        result.review.status === 'supported' &&
        !result.review.reviewer_assignment_id
      )
        fail(
          'independent_review_required',
          'A supported review requires its independent reviewer assignment.',
        );
      for (const ref of [
        ...result.work_products,
        ...result.sources.map((source) => source.artifact),
        ...(result.review.artifact ? [result.review.artifact] : []),
      ]) {
        this.artifact(ref.id, task.identity, ref);
        if (
          !this.applicability(taskId, ref.id, task.objective_revision)?.current
        )
          fail(
            'artifact_not_applicable',
            'Result references inapplicable material.',
          );
      }
      if (result.review.reviewer_assignment_id) {
        const reviewer = this.assignment(
          result.review.reviewer_assignment_id,
          taskId,
        );
        if (
          reviewer.role !== 'EvidenceCritic' ||
          reviewer.status !== 'completed'
        )
          fail(
            'independent_review_required',
            'Review requires a completed independent critic assignment.',
          );
        if (
          result.review.status === 'supported' &&
          reviewer.support !== 'supported'
        )
          fail(
            'independent_review_required',
            'A critic evidence gap cannot be represented as a supported review.',
          );
        if (result.review.artifact) {
          const reviewArtifact = this.artifact(
            result.review.artifact.id,
            task.identity,
            result.review.artifact,
          );
          if (
            reviewArtifact.assignment_id !== reviewer.id ||
            reviewArtifact.assignment_revision !== reviewer.revision
          )
            fail(
              'invalid_review_artifact',
              'Review artifact must be produced by the independent reviewer revision.',
            );
        }
        for (const ref of [
          ...result.work_products,
          ...result.sources.map((source) => source.artifact),
        ])
          if (
            this.artifact(ref.id, task.identity, ref).assignment_id ===
            reviewer.id
          )
            fail('self_review', 'A producer cannot approve its own output.');
      }
      if (result.currency !== 'current' || result.provenance.mode !== task.mode)
        fail(
          'invalid_result_provenance',
          'Result mode/currency must match admitted execution.',
        );
      if (
        this.allAssignments(run.id).some(
          (assignment) => !terminal(assignment.status),
        )
      )
        fail(
          'unfinished_assignments',
          'Complete, fail, or cancel every assignment before committing the run result.',
        );
      task.result = result;
      delete task.error;
      this.putCore(task);
      run.status = 'completed';
      this.putRun(run);
      this.closeChannels(run.id);
      this.appendEvent(
        taskId,
        'task_completed',
        'Manager',
        'General result committed with exact sources/work products.',
      );
      return this.read(taskId, task.identity);
    });
  }
  askQuestion(
    taskId: string,
    assignmentId: string | undefined,
    question: string,
    kind: 'human' | 'data' = 'human',
  ): Question {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(task.current_run_id);
      this.assertCurrent(task, run);
      const item: Question = {
        id: randomUUID(),
        task_id: taskId,
        run_id: run.id,
        objective_revision: task.objective_revision,
        ...(assignmentId ? { assignment_id: assignmentId } : {}),
        question,
        kind,
        status: 'open',
        created_at: now(),
      };
      this.db
        .prepare('INSERT INTO questions VALUES(?,?,?)')
        .run(item.id, taskId, JSON.stringify(item));
      if (assignmentId) {
        const assignment = this.assignment(assignmentId, taskId);
        assignment.status = 'waiting';
        delete assignment.lease_token;
        this.putAssignment(assignment);
      }
      // A task-level human wait fences other in-flight branches and releases shared slots.
      for (const assignment of this.allAssignments(run.id))
        if (assignment.status === 'running') {
          assignment.status = 'paused';
          delete assignment.lease_token;
          this.putAssignment(assignment);
        }
      this.markUnknown(run.id);
      run.status = 'waiting';
      this.putRun(run);
      this.appendEvent(taskId, 'question_opened', 'Manager', question, {
        question_id: item.id,
        kind,
      });
      return item;
    });
  }
  update(
    taskId: string,
    identity: TaskIdentity,
    key: string,
    update: TaskUpdate,
  ): ControlReceipt {
    return this.atomic(
      () =>
        this.operation(
          identity,
          `POST /api/tasks/${taskId}/updates`,
          key,
          update,
          () => {
            const task = this.core(taskId, identity),
              run = this.run(task.current_run_id);
            this.assertGraphExecution(run.id);
            this.expect(task, run, update);
            for (const ref of update.context_refs ?? [])
              this.artifact(ref.id, identity, ref);
            const assignments = this.allAssignments(run.id),
              affected = new Set(
                update.affected_assignment_ids ??
                  assignments.map((assignment) => assignment.id),
              );
            for (const id of affected)
              if (!assignments.some((assignment) => assignment.id === id))
                fail(
                  'assignment_not_found',
                  'Affected assignment is not in current run.',
                  422,
                );
            for (let changed = true; changed;) {
              changed = false;
              for (const assignment of assignments)
                if (
                  !affected.has(assignment.id) &&
                  (assignment.dependencies.some((id) => affected.has(id)) ||
                    [...this.artifactAssignments(assignment.inputs)].some(
                      (id) => affected.has(id),
                    ))
                ) {
                  affected.add(assignment.id);
                  changed = true;
                }
            }
            if (update.question_id) {
              const row = this.db
                .prepare('SELECT body FROM questions WHERE id=? AND task_id=?')
                .get(update.question_id, taskId) as Row | undefined;
              if (!row) fail('question_not_found', 'Question not found.', 404);
              const question = decode<Question>(row!.body);
              if (question.status !== 'open')
                fail('question_closed', 'Question is no longer open.');
              question.status = 'answered';
              question.answer = update.passage;
              this.db
                .prepare('UPDATE questions SET body=? WHERE id=?')
                .run(JSON.stringify(question), question.id);
            }
            task.objective_revision++;
            run.objective_revision = task.objective_revision;
            run.generation++;
            run.status = terminal(run.status)
              ? 'paused'
              : run.status === 'waiting'
                ? 'queued'
                : run.status;
            if (task.result) task.result.currency = 'stale';
            const correction = {
              id: randomUUID(),
              objective_revision: task.objective_revision,
              kind: update.kind,
              passage: update.passage,
              ...(update.scope === undefined ? {} : { scope: update.scope }),
              ...(update.question_id
                ? { question_id: update.question_id }
                : {}),
              ...(update.context_refs
                ? { context_refs: update.context_refs }
                : {}),
              affected_assignment_ids: [...affected],
              created_at: now(),
            };
            this.db
              .prepare('INSERT INTO corrections VALUES(?,?,?)')
              .run(correction.id, taskId, JSON.stringify(correction));
            for (const assignment of assignments) {
              this.preserveAssignment(assignment);
              delete assignment.lease_token;
              assignment.objective_revision = task.objective_revision;
              assignment.generation = run.generation;
              if (affected.has(assignment.id)) {
                assignment.revision++;
                assignment.objective_revision = task.objective_revision;
                assignment.generation = run.generation;
                assignment.acknowledged_revision = 0;
                assignment.status = 'queued';
                assignment.usability = 'stale';
                if (assignment.definition_id === 'core.manager.coordinator')
                  assignment.usability = 'needs_review';
                assignment.brief += `\n\nExact ${update.kind} at objective revision ${task.objective_revision}:\n${update.passage}`;
                assignment.outputs = [];
                assignment.inputs = assignment.inputs.filter((ref) => {
                  const artifact = this.artifactMetadata(ref.id, identity, ref);
                  return (
                    !artifact.assignment_id ||
                    !affected.has(artifact.assignment_id)
                  );
                });
                assignment.inputs = [
                  ...new Map(
                    [...assignment.inputs, ...(update.context_refs ?? [])].map(
                      (ref) => [ref.id, ref],
                    ),
                  ).values(),
                ];
              } else if (assignment.status === 'running') {
                assignment.status = 'queued';
                assignment.acknowledged_revision = 0;
              }
              this.putAssignment(assignment);
            }
            const previous = (
              this.db
                .prepare(
                  'SELECT body FROM applicability WHERE task_id=? AND objective_revision=?',
                )
                .all(taskId, task.objective_revision - 1) as Row[]
            ).map((row) => decode<ArtifactApplicability>(row.body));
            for (const prior of previous) {
              const artifact = this.artifactMetadata(
                  prior.artifact.id,
                  identity,
                  prior.artifact,
                ),
                isAffected =
                  artifact.assignment_id &&
                  affected.has(artifact.assignment_id);
              const body: ArtifactApplicability = {
                ...prior,
                objective_revision: task.objective_revision,
                current: false,
                reason: isAffected
                  ? 'Producer branch affected by correction.'
                  : 'Requires explicit applicability check against revised objective.',
                checked_by: 'Runtime',
                checked_at: now(),
              };
              this.db
                .prepare('INSERT INTO applicability VALUES(?,?,?,?)')
                .run(
                  taskId,
                  prior.artifact.id,
                  task.objective_revision,
                  JSON.stringify(body),
                );
            }
            this.markUnknown(run.id);
            if (
              (
                this.db
                  .prepare('SELECT body FROM attempts WHERE task_id=?')
                  .all(taskId) as Row[]
              )
                .map((row) => decode<AttemptRecord>(row.body))
                .some(
                  (attempt) =>
                    attempt.run_id === run.id && attempt.status === 'unknown',
                )
            )
              run.status = 'paused';
            this.closeChannels(run.id);
            this.putCore(task);
            this.putRun(run);
            for (const ref of update.context_refs ?? [])
              this.recordApplicability(
                taskId,
                identity,
                ref,
                false,
                'New correction evidence requires an inspected Manager applicability decision.',
                'Runtime',
              );
            this.appendEvent(
              taskId,
              'objective_revised',
              'User',
              update.passage,
              { affected_assignment_ids: [...affected] },
            );
            return this.receipt(task, run, update.kind);
          },
        ).value,
    );
  }
  private expect(
    task: TaskCore,
    run: RunRecord,
    expected: TaskControl | TaskUpdate,
  ) {
    if (
      expected.expected_objective_revision !== task.objective_revision ||
      expected.expected_run_id !== run.id ||
      expected.expected_generation !== run.generation ||
      expected.expected_state_revision !== run.state_revision
    )
      fail(
        'stale_mutation',
        'Objective, run, generation, or state revision changed. Refresh before retrying.',
      );
  }
  private receipt(
    task: TaskCore,
    run: RunRecord,
    requested: string,
  ): ControlReceipt {
    return {
      schema_version: 'haze.task.control.receipt.v3',
      operation_id: randomUUID(),
      task_id: task.id,
      run_id: run.id,
      requested,
      confirmed: run.status,
      objective_revision: task.objective_revision,
      generation: run.generation,
      state_revision: run.state_revision,
      at: now(),
      remote_termination_confirmed: false,
    };
  }
  control(
    taskId: string,
    identity: TaskIdentity,
    key: string,
    control: TaskControl,
  ): ControlReceipt {
    return this.atomic(
      () =>
        this.operation(
          identity,
          `POST /api/tasks/${taskId}/control`,
          key,
          control,
          () => {
            const task = this.core(taskId, identity);
            let run = this.run(task.current_run_id);
            this.expect(task, run, control);
            if (control.action === 'continue') {
              if (!terminal(run.status) && run.status !== 'paused')
                fail(
                  'run_still_active',
                  'Pause or finish predecessor before continuation.',
                );
              const active = (
                this.db.prepare('SELECT body FROM runs').all() as Row[]
              )
                .map((row) => decode<RunRecord>(row.body))
                .filter((item) =>
                  ['queued', 'running', 'waiting'].includes(item.status),
                );
              if (active.length >= 2)
                fail(
                  'active_task_limit',
                  'Two active tasks are admitted.',
                  429,
                );
              const previous = run,
                duration =
                  Date.parse(previous.limits.deadline) -
                  Date.parse(previous.created_at),
                at = now();
              previous.generation++;
              if (!terminal(previous.status)) previous.status = 'cancelled';
              this.putRun(previous);
              this.closeChannels(previous.id);
              this.markUnknown(previous.id);
              for (const assignment of this.allAssignments(previous.id))
                if (!terminal(assignment.status)) {
                  assignment.status = 'cancelled';
                  delete assignment.lease_token;
                  this.putAssignment(assignment);
                }
              run = {
                id: randomUUID(),
                task_id: taskId,
                predecessor_run_id: previous.id,
                objective_revision: task.objective_revision,
                generation: previous.generation,
                state_revision: 1,
                status: 'queued',
                limits: {
                  ...previous.limits,
                  deadline: new Date(
                    Date.now() + Math.max(1, duration),
                  ).toISOString(),
                },
                usage: {
                  model_calls: 0,
                  tool_calls: 0,
                  artifacts: 0,
                  assignments: 0,
                },
                created_at: at,
                updated_at: at,
              };
              this.db
                .prepare('INSERT INTO runs VALUES(?,?,?)')
                .run(run.id, taskId, JSON.stringify(run));
              this.graph.register(run.id);
              task.current_run_id = run.id;
              this.initializeManager(taskId, run.id);
              if (task.result) task.result.currency = 'stale';
              for (const row of this.db
                .prepare(
                  'SELECT artifact_id,objective_revision,body FROM applicability WHERE task_id=?',
                )
                .all(taskId) as (Row & {
                artifact_id: string;
                objective_revision: number;
              })[]) {
                const applicability = decode<ArtifactApplicability>(row.body);
                applicability.current = false;
                applicability.reason =
                  'Historical artifact requires fresh applicability and support checks in the linked successor.';
                this.db
                  .prepare(
                    'UPDATE applicability SET body=? WHERE task_id=? AND artifact_id=? AND objective_revision=?',
                  )
                  .run(
                    JSON.stringify(applicability),
                    taskId,
                    row.artifact_id,
                    row.objective_revision,
                  );
              }
              for (const ref of task.original_request.context_refs)
                this.recordApplicability(
                  taskId,
                  identity,
                  ref,
                  false,
                  'Source permission and hash revalidated; the new Manager must inspect applicability for this continuation.',
                  'Runtime',
                );
            } else if (control.action === 'resume') {
              this.assertGraphExecution(run.id);
              if (this.managerState(taskId, identity)?.upgrade_required)
                fail(
                  'manager_upgrade_required',
                  'This unfinished run uses the previous Manager. Explicitly continue to start a linked run under manager.v4.',
                );
              if (!['paused', 'waiting'].includes(run.status))
                fail(
                  'invalid_control_state',
                  'Resume requires paused/waiting run.',
                );
              if (Date.parse(run.limits.deadline) <= Date.now())
                fail(
                  'deadline_expired',
                  'Resume preserves expired deadline; explicitly continue for a new run.',
                  422,
                );
              const active = (
                this.db.prepare('SELECT body FROM runs').all() as Row[]
              )
                .map((row) => decode<RunRecord>(row.body))
                .filter(
                  (item) =>
                    item.id !== run.id &&
                    ['queued', 'running', 'waiting'].includes(item.status),
                );
              if (active.length >= 2)
                fail(
                  'active_task_limit',
                  'Two active tasks are admitted.',
                  429,
                );
              const open = (
                this.db
                  .prepare('SELECT body FROM questions WHERE task_id=?')
                  .all(taskId) as Row[]
              )
                .map((row) => decode<Question>(row.body))
                .some((q) => q.run_id === run.id && q.status === 'open');
              if (open)
                fail(
                  'question_unanswered',
                  'Answer persisted questions before resuming.',
                );
              run.generation++;
              this.graph.replaceUnknown(run.id, run.generation);
              run.status = 'queued';
              this.graph.rebindWaits({
                task_id: taskId,
                run_id: run.id,
                generation: run.generation,
                objective_revision: task.objective_revision,
              });
              for (const assignment of this.allAssignments(run.id))
                if (
                  ['paused', 'waiting', 'running'].includes(assignment.status)
                ) {
                  assignment.status = 'queued';
                  assignment.generation = run.generation;
                  assignment.acknowledged_revision = 0;
                  delete assignment.lease_token;
                  this.putAssignment(assignment);
                }
            } else {
              if (terminal(run.status) && control.action !== 'revoke')
                fail(
                  'invalid_control_state',
                  'Run is terminal; explicitly continue for another run.',
                );
              const previousStatus = run.status;
              run.generation++;
              run.status =
                control.action === 'cancel'
                  ? 'cancelled'
                  : terminal(previousStatus)
                    ? previousStatus
                    : 'paused';
              if (control.action === 'revoke')
                task.permissions.tools = task.permissions.tools.filter(
                  (tool) =>
                    !(control.revoked_tools ?? task.permissions.tools).includes(
                      tool,
                    ),
                );
              if (task.result && control.action === 'revoke')
                task.result.currency = 'stale';
              for (const assignment of this.allAssignments(run.id))
                if (!terminal(assignment.status)) {
                  assignment.status =
                    control.action === 'cancel' ? 'cancelled' : 'paused';
                  delete assignment.lease_token;
                  this.putAssignment(assignment);
                }
              this.markUnknown(run.id);
              if (control.action === 'cancel' || control.action === 'revoke')
                this.closeChannels(run.id);
            }
            this.putCore(task);
            this.putRun(run);
            this.appendEvent(
              taskId,
              `control_${control.action}`,
              'User',
              control.reason ??
                `Requested ${control.action}; local work fenced. Remote termination unconfirmed.`,
            );
            return this.receipt(task, run, control.action);
          },
        ).value,
    );
  }
  stop(
    taskId: string,
    status: 'failed' | 'timed_out',
    code: string,
    message: string,
    expected?: {
      run_id: string;
      generation: number;
      objective_revision: number;
    },
  ): TaskRecord {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(task.current_run_id);
      if (
        expected &&
        (expected.run_id !== run.id ||
          expected.generation !== run.generation ||
          expected.objective_revision !== task.objective_revision)
      )
        return this.read(taskId, task.identity);
      if (!terminal(run.status)) {
        run.generation++;
        run.status = status;
        task.error = { code, message };
        this.putRun(run);
        this.putCore(task);
        for (const assignment of this.allAssignments(run.id))
          if (!terminal(assignment.status)) {
            assignment.status = status;
            delete assignment.lease_token;
            this.putAssignment(assignment);
          }
        this.markUnknown(run.id);
        this.closeChannels(run.id);
        this.appendEvent(taskId, `task_${status}`, 'Runtime', message);
      }
      return this.read(taskId, task.identity);
    });
  }
  private markUnknown(runId: string) {
    this.graph.fence(runId);
    for (const row of this.db
      .prepare('SELECT id,body FROM attempts')
      .all() as (Row & { id: string })[]) {
      const attempt = decode<AttemptRecord>(row.body);
      if (attempt.run_id === runId && attempt.status === 'started') {
        attempt.status = 'unknown';
        attempt.accepted = false;
        this.db
          .prepare('UPDATE attempts SET body=? WHERE id=?')
          .run(JSON.stringify(attempt), row.id);
      }
    }
  }
  recover() {
    return this.atomic(() => {
      for (const row of this.db
        .prepare('SELECT body FROM tasks')
        .all() as Row[]) {
        const task = decode<TaskCore>(row.body),
          run = this.run(task.current_run_id);
        if (terminal(run.status)) continue;
        if (this.executionVersion(run.id)?.engine === 'legacy') {
          let manager = this.managerState(task.id, task.identity);
          if (!manager) {
            const raw = this.db
              .prepare('SELECT body FROM manager_state WHERE run_id=?')
              .get(run.id) as Row | undefined;
            if (raw) this.archiveManagerState(run.id, raw.body);
            this.db
              .prepare('DELETE FROM manager_state WHERE run_id=?')
              .run(run.id);
            manager = this.initializeManager(task.id, run.id);
          }
          manager.upgrade_required =
            'This unfinished run uses retired legacy orchestration. Explicitly Continue to start a linked LangGraph run; saved history and artifacts remain inspectable.';
          this.putManager(manager);
          run.generation++;
          run.status = 'paused';
          for (const assignment of this.allAssignments(run.id))
            if (!terminal(assignment.status)) {
              assignment.status = 'paused';
              delete assignment.lease_token;
              this.putAssignment(assignment);
            }
          this.markUnknown(run.id);
          this.closeChannels(run.id);
          this.putRun(run);
          continue;
        }
        let manager = this.managerState(task.id, task.identity);
        const requiresUpgrade = !manager;
        if (requiresUpgrade) {
          const raw = this.db
            .prepare('SELECT body FROM manager_state WHERE run_id=?')
            .get(run.id) as Row | undefined;
          if (raw) {
            this.archiveManagerState(run.id, raw.body);
            this.db
              .prepare('DELETE FROM manager_state WHERE run_id=?')
              .run(run.id);
          }
          manager = this.initializeManager(task.id, run.id);
          manager.upgrade_required =
            'This unfinished run was created by the previous Manager. Explicit continuation starts a linked run under manager.v4; historical decisions remain unchanged.';
          this.putManager(manager);
        }
        const started = (
          this.db
            .prepare('SELECT body FROM attempts WHERE task_id=?')
            .all(task.id) as Row[]
        )
          .map((item) => decode<AttemptRecord>(item.body))
          .some((item) => item.run_id === run.id && item.status === 'started');
        run.generation++;
        if (started || requiresUpgrade || manager?.upgrade_required)
          run.status = 'paused';
        else if (run.status === 'running') run.status = 'queued';
        for (const assignment of this.allAssignments(run.id)) {
          assignment.generation = run.generation;
          if (assignment.status === 'running') {
            assignment.status =
              started || requiresUpgrade ? 'paused' : 'queued';
            assignment.acknowledged_revision = 0;
          }
          delete assignment.lease_token;
          this.putAssignment(assignment);
        }
        this.markUnknown(run.id);
        this.putRun(run);
        this.graph.rebindWaits(
          {
            task_id: task.id,
            run_id: run.id,
            generation: run.generation,
            objective_revision: task.objective_revision,
          },
          run.status !== 'paused',
        );
        this.appendEvent(
          task.id,
          requiresUpgrade ? 'manager_upgrade_required' : 'restart_recovered',
          'Runtime',
          requiresUpgrade
            ? manager!.upgrade_required!
            : started
              ? 'Interrupted outcome unknown and charged; explicit resume admits replacement.'
              : 'New lease generation acquired; accepted output and remaining budget preserved.',
        );
      }
      this.graph.recover();
    });
  }
  saveCheckpoint(
    taskId: string,
    runId: string,
    generation: number,
    references: JsonValue,
  ) {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(runId);
      if (
        task.current_run_id !== runId ||
        run.generation !== generation ||
        task.objective_revision !== run.objective_revision
      )
        fail('stale_execution', 'Checkpoint boundary belongs to a fenced run.');
      const checkpoint = {
        task_id: taskId,
        run_id: runId,
        objective_revision: task.objective_revision,
        generation,
        references,
        at: now(),
      };
      this.db
        .prepare(
          'INSERT INTO checkpoints VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET body=excluded.body',
        )
        .run(runId, JSON.stringify(checkpoint));
      return checkpoint;
    });
  }
  checkpoint(runId: string) {
    const row = this.db
      .prepare('SELECT body FROM checkpoints WHERE run_id=?')
      .get(runId) as Row | undefined;
    return row ? decode<JsonValue>(row.body) : undefined;
  }
  openPeerChannel(
    taskId: string,
    runId: string,
    purpose: string,
    assignmentIds: string[],
  ): PeerChannel {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(runId);
      this.assertCurrent(task, run);
      if (
        assignmentIds.length !== 2 ||
        new Set(assignmentIds).size !== 2 ||
        !purpose ||
        purpose.length > 4096
      )
        fail(
          'invalid_peer_channel',
          'A purpose-bound channel needs two assignment instances.',
          422,
        );
      const participants = assignmentIds.map((id) => {
        const assignment = this.assignment(id, taskId);
        if (assignment.run_id !== runId)
          fail('invalid_peer_recipient', 'Peer belongs to another run.');
        return { assignment_id: id, revision: assignment.revision };
      });
      const previous = this.peerChannelForRun(runId, true);
      if (
        previous &&
        previous.objective_revision === task.objective_revision &&
        (previous.status === 'open' ||
          participants.every((participant) =>
            previous.participants.some(
              (prior) =>
                prior.assignment_id === participant.assignment_id &&
                prior.revision === participant.revision,
            ),
          ))
      )
        fail(
          'peer_channel_limit',
          'Only one peer channel per run/objective revision.',
          422,
        );
      if (
        previous &&
        (previous.messages >= 6 ||
          previous.bytes >= 12_288 ||
          Date.parse(previous.expires_at) <= Date.now())
      )
        fail(
          'peer_message_limit',
          'Run peer budget or expiry is exhausted; revisions cannot replenish it.',
          422,
        );
      if (previous)
        this.db
          .prepare('INSERT INTO channel_history VALUES(?,?,?)')
          .run(runId, previous.revision, JSON.stringify(previous));
      const channel: PeerChannel = {
        id: previous?.id ?? randomUUID(),
        task_id: taskId,
        run_id: runId,
        revision: (previous?.revision ?? 0) + 1,
        objective_revision: task.objective_revision,
        purpose,
        participants,
        expires_at: new Date(
          Math.min(
            Date.now() + 600_000,
            Date.parse(run.limits.deadline),
            previous ? Date.parse(previous.expires_at) : Infinity,
          ),
        ).toISOString(),
        status: 'open',
        messages: previous?.messages ?? 0,
        bytes: previous?.bytes ?? 0,
      };
      this.db
        .prepare(
          'INSERT INTO channels VALUES(?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET body=excluded.body',
        )
        .run(channel.id, taskId, runId, JSON.stringify(channel));
      return channel;
    });
  }
  sendPeerMessage(
    taskId: string,
    channelId: string,
    sender: string,
    recipient: string,
    text: string,
    key: string,
  ): PeerMessage {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(task.current_run_id),
        row = this.db
          .prepare('SELECT body FROM channels WHERE id=? AND task_id=?')
          .get(channelId, taskId) as Row | undefined;
      if (!row)
        return fail('peer_channel_not_found', 'Peer channel not found.', 404);
      const channel = decode<PeerChannel>(row.body),
        fingerprint = contractHash({ sender, recipient, text });
      const prior = this.db
        .prepare(
          'SELECT fingerprint,body FROM messages WHERE channel_id=? AND key=?',
        )
        .get(channelId, key) as
        { fingerprint: string; body: string } | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          fail(
            'idempotency_conflict',
            'Peer key reused with different content.',
          );
        return decode<PeerMessage>(prior.body);
      }
      this.assertCurrent(task, run);
      if (
        channel.run_id !== run.id ||
        channel.objective_revision !== task.objective_revision ||
        channel.status !== 'open' ||
        Date.parse(channel.expires_at) <= Date.now()
      )
        fail('peer_channel_closed', 'Peer channel closed or expired.');
      if (
        sender === recipient ||
        !channel.participants.some((p) => p.assignment_id === sender) ||
        !channel.participants.some((p) => p.assignment_id === recipient)
      )
        fail(
          'peer_access_denied',
          'Sender/recipient is not a channel participant.',
          403,
        );
      for (const participant of channel.participants) {
        const assignment = this.assignment(participant.assignment_id, taskId);
        if (
          assignment.revision !== participant.revision ||
          terminal(assignment.status) ||
          assignment.status === 'stale'
        )
          fail(
            'peer_channel_closed',
            'Participant completed or changed revision.',
          );
      }
      this.assertCurrent(task, run, this.assignment(sender, taskId));
      const bytes = Buffer.byteLength(text, 'utf8');
      if (
        !key ||
        !text ||
        channel.messages >= 6 ||
        channel.bytes + bytes > 12_288
      )
        fail('peer_message_limit', 'Peer message/byte budget exhausted.', 422);
      const message: PeerMessage = {
        id: randomUUID(),
        channel_id: channelId,
        channel_revision: channel.revision,
        sender_revision: this.assignment(sender, taskId).revision,
        recipient_revision: this.assignment(recipient, taskId).revision,
        sender,
        recipient,
        text,
        created_at: now(),
      };
      this.db
        .prepare('INSERT INTO messages VALUES(?,?,?,?,?)')
        .run(message.id, channelId, key, fingerprint, JSON.stringify(message));
      channel.messages++;
      channel.bytes += bytes;
      if (channel.messages === 6 || channel.bytes === 12_288)
        channel.status = 'closed';
      this.db
        .prepare('UPDATE channels SET body=? WHERE id=?')
        .run(JSON.stringify(channel), channelId);
      this.appendEvent(
        taskId,
        'peer_message_sent',
        'Runtime',
        'Purpose-bound peer message persisted.',
        {
          channel_id: channelId,
          channel_revision: channel.revision,
          sender,
          recipient,
          recipient_revision: message.recipient_revision,
        },
      );
      return message;
    });
  }
  peerMessages(
    taskId: string,
    identity: TaskIdentity,
    channelId: string,
    recipient: string,
  ): PeerMessage[] {
    this.core(taskId, identity);
    const row = this.db
      .prepare('SELECT body FROM channels WHERE id=? AND task_id=?')
      .get(channelId, taskId) as Row | undefined;
    if (!row)
      return fail('peer_channel_not_found', 'Peer channel not found.', 404);
    const channel = decode<PeerChannel>(row.body);
    if (
      !channel.participants.some(
        (participant) => participant.assignment_id === recipient,
      )
    )
      fail('peer_access_denied', 'Recipient is not a participant.', 403);
    const participant = channel.participants.find(
      (item) => item.assignment_id === recipient,
    )!;
    if (this.assignment(recipient, taskId).revision !== participant.revision)
      fail('peer_access_denied', 'Recipient revision changed.', 403);
    return (
      this.db
        .prepare('SELECT body FROM messages WHERE channel_id=? ORDER BY rowid')
        .all(channelId) as Row[]
    )
      .map((item) => decode<PeerMessage>(item.body))
      .filter(
        (message) =>
          message.recipient === recipient &&
          message.channel_revision === channel.revision &&
          message.recipient_revision === participant.revision,
      );
  }
  peerChannelForRun(
    runId: string,
    includeHistorical = false,
  ): PeerChannel | undefined {
    const row = this.db
      .prepare('SELECT body FROM channels WHERE run_id=?')
      .get(runId) as Row | undefined;
    if (!row) return undefined;
    const channel = decode<PeerChannel>(row.body);
    return includeHistorical ||
      channel.objective_revision === this.run(runId).objective_revision
      ? channel
      : undefined;
  }
  wakeManager(taskId: string, cursor?: number): TaskRecord {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(task.current_run_id);
      this.assertGraphExecution(run.id);
      if (run.status !== 'waiting') return this.read(taskId, task.identity);
      const wait = this.graph.wait(
        graphThreadId('manager', {
          task_id: taskId,
          run_id: run.id,
          generation: run.generation,
          objective_revision: task.objective_revision,
        }),
      );
      if (
        wait?.status !== 'ready' ||
        wait.wake_cursor === undefined ||
        wait.wake_cursor <= wait.after_cursor ||
        (cursor !== undefined &&
          (cursor <= wait.after_cursor || cursor > wait.wake_cursor))
      )
        return this.read(taskId, task.identity);
      const openQuestions = (
        this.db
          .prepare('SELECT body FROM questions WHERE task_id=?')
          .all(taskId) as Row[]
      )
        .map((row) => decode<Question>(row.body))
        .some(
          (question) =>
            question.run_id === run.id && question.status === 'open',
        );
      if (
        openQuestions ||
        this.managerState(taskId, task.identity)?.upgrade_required
      )
        return this.read(taskId, task.identity);
      if (Date.parse(run.limits.deadline) <= Date.now())
        fail(
          'deadline_expired',
          'Resume preserves expired deadline; explicitly continue for a new run.',
          422,
        );
      run.status = 'queued';
      for (const assignment of this.allAssignments(run.id))
        if (
          assignment.definition_id === 'core.manager.coordinator' &&
          assignment.status === 'waiting'
        ) {
          assignment.status = 'queued';
          assignment.generation = run.generation;
          assignment.acknowledged_revision = 0;
          delete assignment.lease_token;
          this.putAssignment(assignment);
        }
      this.putRun(run);
      return this.read(taskId, task.identity);
    });
  }
  wakeAssignment(taskId: string, assignmentId: string): Assignment {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(task.current_run_id),
        assignment = this.assignment(assignmentId, taskId);
      this.assertCurrent(task, run);
      if (
        assignment.run_id !== run.id ||
        assignment.objective_revision !== task.objective_revision ||
        assignment.generation !== run.generation
      )
        fail(
          'stale_execution',
          'Waiting assignment belongs to a fenced revision.',
        );
      if (assignment.status === 'waiting') {
        assignment.status = 'queued';
        delete assignment.lease_token;
        this.putAssignment(assignment);
        this.putRun(run);
      }
      return assignment;
    });
  }
  reviseAssignmentInput(
    taskId: string,
    assignmentId: string,
    generation: number,
    input: JsonValue,
  ): Assignment {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(task.current_run_id),
        assignment = this.assignment(assignmentId, taskId);
      this.assertCurrent(task, run, undefined, generation);
      if (
        assignment.run_id !== run.id ||
        assignment.objective_revision !== task.objective_revision ||
        assignment.status !== 'queued' ||
        assignment.acknowledged_revision !== 0
      )
        fail(
          'stale_execution',
          'Only an unacknowledged queued brief can receive revised capability inputs.',
        );
      assignment.input = copy(input);
      this.putAssignment(assignment);
      this.putRun(run);
      return assignment;
    });
  }
  pinAssignmentInput(
    taskId: string,
    assignmentId: string,
    generation: number,
    ref: ArtifactRef,
  ): Assignment {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(task.current_run_id),
        assignment = this.assignment(assignmentId, taskId);
      this.assertCurrent(task, run, assignment, generation);
      const artifact = this.artifact(ref.id, task.identity, ref);
      if (artifact.task_id && artifact.task_id !== taskId)
        fail('artifact_not_applicable', 'Peer input belongs to another task.');
      if (!this.applicability(taskId, ref.id, task.objective_revision)?.current)
        fail(
          'artifact_not_applicable',
          'Peer input has no current applicability check.',
        );
      if (
        !assignment.inputs.some(
          (input) =>
            input.id === ref.id &&
            input.version === ref.version &&
            input.sha256 === ref.sha256,
        )
      )
        assignment.inputs.push({
          id: ref.id,
          version: ref.version,
          sha256: ref.sha256,
        });
      this.putAssignment(assignment);
      this.putRun(run);
      return assignment;
    });
  }
  private closeChannels(runId: string, participantId?: string) {
    const row = this.db
      .prepare('SELECT body FROM channels WHERE run_id=?')
      .get(runId) as Row | undefined;
    if (!row) return;
    const channel = decode<PeerChannel>(row.body);
    if (
      participantId &&
      !channel.participants.some(
        (participant) => participant.assignment_id === participantId,
      )
    )
      return;
    channel.status = 'closed';
    this.db
      .prepare('UPDATE channels SET body=? WHERE id=?')
      .run(JSON.stringify(channel), channel.id);
  }
  close() {
    this.db.close();
  }
}
export type TaskArtifact = Artifact;
