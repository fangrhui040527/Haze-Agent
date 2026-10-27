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
import { ModelRouteStore } from './model-route-store.js';
import { NightshiftStore } from './nightshift-store.js';
import { ExternalWaitStore } from './external-wait-store.js';
import { LinkedRunService } from './linked-run-service.js';
import { NightshiftTransferStore } from './nightshift-transfer-store.js';
import {
  createOfflineRouteSnapshot,
  type ModelRouteSnapshot,
} from '../contracts/model-routes.js';
import {
  GraphLedger,
  graphThreadId,
  MANAGER_TOPOLOGY,
  SPECIALIST_TOPOLOGY,
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
import { CONTRACT_LIMITS } from '../contracts/common.js';
import {
  artifactRefSchema,
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
import {
  worldAcceptanceOutcomeSchema,
  type WorldEvent,
  type WorldAcceptanceOutcome,
  type WorldRecord,
} from '../contracts/world.js';
import {
  worldContextOutputSchema,
  worldContextSnapshotSchema,
  worldLookupOutputSchema,
  type WorldContextOutput,
  type WorldLineageInput,
  type WorldLookupInput,
} from '../contracts/world-services.js';
import {
  worldRecordDetailResponseSchema,
  worldProjectionRebuildRequestSchema,
  worldProjectionRebuildResponseSchema,
  worldTaskResponseSchema,
} from '../contracts/world-api.js';
import { migrateWorldSchema } from './world-schema.js';
import { WorldModelStore } from './world-store.js';
import {
  acceptanceExpiry,
  isWorldAcceptanceEnabled,
  policyAllows,
  resolveWorldAcceptancePolicy,
  type WorldAcceptancePolicy,
} from './world-policy.js';
import type { CapabilityWorldModelAdapter } from '../orchestration/ports.js';
import type { AdapterResult, WriteSummary } from '../world/types.js';
import {
  entityId,
  findHazeRecord,
  ingestAdapterResult,
  ingestCollectionCapture,
  validateAdapterResult,
} from '../world/ingest.js';

export const GENERAL_STORAGE_FORMAT = 'haze.general.sqlite.v2';
export const STORAGE_MARKER = 'storage-format.json';
export const MIGRATION_PENDING = 'migration-in-progress.json';
/** Purpose-bound peer channel budget. One run may never exceed these. */
const PEER_MAX_MESSAGES = 6;
const PEER_MAX_BYTES = 12_288;
const PEER_CHANNEL_TTL_MS = 600_000;
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
  /** Set when the response failed validation and no action was dispatched. */
  rejected?: string;
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
export interface WorldProjectionRecordInput {
  capability_id: string;
  kind: string;
  external_id: string;
  payload: JsonValue;
  evidence: ArtifactRef[];
  relationships?: {
    kind: string;
    external_id: string;
    relationship: string;
  }[];
}
export interface WorldCapabilityAdapterInput {
  capability_id: string;
  adapter: CapabilityWorldModelAdapter;
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
  readonly modelRoutes: ModelRouteStore;
  readonly nightshift: NightshiftStore;
  readonly externalWaits: ExternalWaitStore;
  readonly linkedRuns: LinkedRunService;
  readonly nightshiftTransfers: NightshiftTransferStore;
  readonly directory: string;
  readonly world: WorldModelStore;
  readonly worldAcceptancePolicy: WorldAcceptancePolicy;
  private definitions: StoreDefinitions | undefined;
  private transactionDepth = 0;
  private readonly worldListeners = new Set<(event: WorldEvent) => void>();
  private readonly pendingWorldEvents: WorldEvent[] = [];
  private readonly commitCallbacks: (() => void)[] = [];
  private savepointSequence = 0;
  private commitCallbackFailures = 0;
  constructor(
    directory = '.state/general-v2',
    options: {
      recover?: boolean;
      migration?: boolean;
      acceptancePolicy?: unknown;
    } = {},
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
    this.worldAcceptancePolicy = resolveWorldAcceptancePolicy(
      options.acceptancePolicy,
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
      CREATE TABLE IF NOT EXISTS task_run_results(run_id TEXT NOT NULL,objective_revision INTEGER NOT NULL,task_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_id,objective_revision));
      CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id);
      CREATE TABLE IF NOT EXISTS assignments(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,run_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS assignments_run ON assignments(run_id);
      CREATE TABLE IF NOT EXISTS operations(scope TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(scope,key));
      CREATE TABLE IF NOT EXISTS events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_events ON events(task_id,cursor);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,principal TEXT NOT NULL,workspace TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS applicability(task_id TEXT NOT NULL,artifact_id TEXT NOT NULL,objective_revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(task_id,artifact_id,objective_revision));
      CREATE TABLE IF NOT EXISTS world_task_pins(task_id TEXT NOT NULL,principal TEXT NOT NULL,workspace TEXT NOT NULL,mode TEXT NOT NULL,record_id TEXT NOT NULL,support_artifacts TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(task_id,record_id,generation));
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
      CREATE TABLE IF NOT EXISTS assignment_history(assignment_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(assignment_id,revision));
      INSERT OR IGNORE INTO task_run_results(run_id,objective_revision,task_id,body)
        SELECT json_extract(body,'$.current_run_id'),json_extract(body,'$.objective_revision'),id,json_extract(body,'$.result') FROM tasks
        WHERE json_type(body,'$.result')='object' AND json_extract(body,'$.result.currency')='current';`);
    try {
      migrateWorldSchema(this.db);
      this.modelRoutes = new ModelRouteStore(this.db);
      this.nightshift = new NightshiftStore(this.db, {
        atomic: (operation) => this.atomic(operation),
        read: (id, identity) => this.read(id, identity),
        artifact: (ref, identity) => this.artifact(ref.id, identity, ref),
        historicalArtifact: (ref, identity) =>
          this.artifactMetadata(ref.id, identity, ref),
        insertHistoricalArtifact: (artifact) => this.insertArtifact(artifact),
        routes: (runId) => this.modelRoutes.snapshot(runId),
        applicable: (taskId, ref, objective) =>
          this.applicability(taskId, ref.id, objective)?.current === true,
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.graph = new GraphLedger(
      this.db,
      (operation) => this.atomic(operation),
      (authority) => this.assertGraphAuthority(authority),
    );
    this.nightshiftTransfers = new NightshiftTransferStore(this.db, {
      atomic: (operation) => this.atomic(operation),
      read: (id, identity) => this.read(id, identity),
      nightshift: this.nightshift,
    });
    this.externalWaits = new ExternalWaitStore(this.db, {
      atomic: (operation) => this.atomic(operation),
      read: (id, identity) => this.read(id, identity),
      graph: this.graph,
      job: (id, identity) => this.nightshift.job(id, identity),
      chain: (id, identity) => this.nightshift.chain(id, identity),
      artifact: (ref, identity) => this.artifact(ref.id, identity, ref),
      delegated: (authority, job, identity) =>
        this.nightshiftTransfers.authorized(authority, job, identity),
      applicable: (id, ref, objective) =>
        this.applicability(id, ref.id, objective)?.current === true,
      emit: (authority, type, message, data) => {
        const event = {
          schema_version: 'haze.task.event.v3',
          task_id: authority.task_id,
          run_id: authority.run_id,
          generation: authority.generation,
          objective_revision: authority.objective_revision,
          ...(authority.assignment_id
            ? { assignment_id: authority.assignment_id }
            : {}),
          at: now(),
          type,
          actor: 'Runtime',
          message,
          data,
        };
        const inserted = this.db
          .prepare('INSERT INTO events(task_id,body) VALUES(?,?)')
          .run(authority.task_id, JSON.stringify(event));
        const cursor = Number(inserted.lastInsertRowid);
        this.graph.wake(authority.task_id, cursor, type);
        return cursor;
      },
    });
    this.linkedRuns = new LinkedRunService(this.db, {
      atomic: (operation) => this.atomic(operation),
      read: (id, identity) => this.read(id, identity),
      graph: this.graph,
      capacity: this.externalWaits,
      routes: this.modelRoutes,
      nightshift: this.nightshift,
      preparePredecessor: (task, automatic) => {
        const run = this.run(task.current_run_id);
        run.generation++;
        if (!terminal(run.status))
          run.status = automatic ? 'timed_out' : 'cancelled';
        this.putRun(run);
        this.closeChannels(run.id);
        this.markUnknown(run.id);
        for (const assignment of this.allAssignments(run.id))
          if (!terminal(assignment.status)) {
            assignment.status = automatic ? 'timed_out' : 'cancelled';
            delete assignment.lease_token;
            this.putAssignment(assignment);
          }
      },
      initialize: (id, runId) => {
        this.initializeManager(id, runId);
      },
      staleSources: (id, identity) => this.staleLinkedSources(id, identity),
      emit: (id, type, actor, message, data) =>
        this.appendEvent(id, type, actor, message, data).cursor,
      attach: (request, runId) =>
        this.nightshiftTransfers.attach(request, runId),
    });
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
    this.world = new WorldModelStore(
      this.db,
      (operation) => this.atomic(operation),
      undefined,
      (event) => {
        this.publishWorldLifecycle(event);
        this.pendingWorldEvents.push(event);
      },
    );
    // A format-only migration preserves acceptance history; normal runtime opens
    // evaluate it against the configured server policy.
    if (!options.migration)
      this.world.holdPolicyChanges(this.worldAcceptancePolicy.sha256);
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
      this.holdChangedWorldMethods(definitions);
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
      this.externalWaits.replanAssignments(
        taskId,
        [...changed],
        decision.explanation,
      );
      this.nightshiftTransfers.replanAssignments(
        taskId,
        [...changed],
        decision.explanation,
      );
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
            this.artifactMetadata(ref.id, task.identity, ref);
            return ![...this.artifactAssignments([ref])].some((id) =>
              changed.has(id),
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
          // Retained outputs from this assignment already exist. They do not
          // require the assignment to schedule itself; explicit self-edges do.
          ...[...this.artifactAssignments(item!.inputs)].filter(
            (producer) => producer !== id && graph.has(producer),
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
  private publishWorldLifecycle(event: WorldEvent): void {
    const recordIds = new Set<string>();
    const artifactIds = new Set<string>();
    if (
      event.event_kind === 'record_created' ||
      event.event_kind === 'record_revised'
    ) {
      recordIds.add(event.value.ref.id);
      if (
        event.value.kind === 'artifact_reference' &&
        typeof event.value.payload === 'object' &&
        event.value.payload !== null &&
        !Array.isArray(event.value.payload)
      ) {
        const ref = artifactRefSchema.safeParse(event.value.payload.artifact);
        if (ref.success) artifactIds.add(ref.data.id);
      }
    } else if (event.event_kind === 'relationship_created') {
      recordIds.add(event.value.from.id);
      recordIds.add(event.value.to.id);
    } else if (event.event_kind === 'acceptance_evaluated') {
      recordIds.add(event.value.subject.id);
      for (const support of event.value.support_revisions)
        if (support.artifact) artifactIds.add(support.artifact.id);
    } else if (
      event.event_kind === 'hold_created' ||
      event.event_kind === 'hold_cleared'
    ) {
      recordIds.add(event.value.subject.id);
    }
    const conditions: string[] = [];
    const values: (string | number)[] = [
      event.scope.principal,
      event.scope.workspace,
      event.scope.mode,
    ];
    if (recordIds.size) {
      conditions.push(
        `record_id IN (${[...recordIds].map(() => '?').join(',')})`,
      );
      values.push(...recordIds);
    }
    if (artifactIds.size) {
      conditions.push(
        `EXISTS (
          SELECT 1 FROM json_each(world_task_pins.support_artifacts) pinned
          WHERE json_extract(pinned.value,'$.id') IN (${[...artifactIds]
            .map(() => '?')
            .join(',')})
        )`,
      );
      values.push(...artifactIds);
    }
    if (conditions.length === 0) return;
    const pins = this.db
      .prepare(
        `SELECT DISTINCT task_id FROM world_task_pins
         WHERE principal=? AND workspace=? AND mode=?
         AND (${conditions.join(' OR ')})`,
      )
      .all(...values) as { task_id: string }[];
    for (const { task_id } of pins)
      this.appendEvent(
        task_id,
        'world_lifecycle_changed',
        'Runtime',
        'World Model state changed for context pinned by this task. Refresh status before reuse.',
        {
          world_event_id: event.event_id,
          world_sequence: event.sequence,
          event_kind: event.event_kind,
          record_ids: [...recordIds],
        },
      );
  }
  private holdChangedWorldMethods(definitions: StoreDefinitions) {
    const rows = this.db
      .prepare(
        `SELECT principal,workspace,mode,body FROM world_acceptances
         WHERE status='accepted'
         AND revision=(SELECT MAX(current.revision) FROM world_acceptances current
           WHERE current.principal=world_acceptances.principal
           AND current.workspace=world_acceptances.workspace
           AND current.mode=world_acceptances.mode
           AND current.acceptance_id=world_acceptances.acceptance_id)`,
      )
      .all() as (Row & {
      principal: string;
      workspace: string;
      mode: TaskRecord['mode'];
    })[];
    for (const row of rows) {
      const acceptance = worldAcceptanceOutcomeSchema.parse(
        JSON.parse(row.body),
      );
      const changed = acceptance.support_revisions.some((support) => {
        const admitted = support.assignment;
        if (!admitted) return false;
        const current = definitions.assignments?.[admitted.definition_id];
        return (
          current === undefined ||
          current.version !== admitted.version ||
          current.role !== admitted.role
        );
      });
      if (changed)
        this.world.hold(
          {
            principal: row.principal,
            workspace: row.workspace,
            mode: row.mode,
          },
          acceptance.subject,
          'A supporting assignment or method version changed.',
          'method_change',
        );
    }
  }
  worldRebuildProjections(
    identity: TaskIdentity,
    mode: TaskRecord['mode'],
    key: string,
    request: unknown,
  ) {
    const parsed = worldProjectionRebuildRequestSchema.parse(request);
    return this.atomic(() => {
      const result = this.operation(
        identity,
        'POST /api/world/projections/rebuild',
        key,
        { mode, request: parsed },
        () => ({
          schema_version: 'haze.world.projection-rebuild.v1' as const,
          mode,
          projection_cursor: this.world.rebuildProjections({
            ...identity,
            mode,
          }),
        }),
      );
      return worldProjectionRebuildResponseSchema.parse({
        ...result.value,
        reused: result.reused,
      });
    });
  }
  /** Read governed evidence for chat without admitting a task or acquiring grants. */
  conversationWorldLookup(
    identity: TaskIdentity,
    mode: TaskRecord['mode'],
    input: WorldLookupInput,
  ) {
    const scope = { ...identity, mode };
    const records: WorldRecord[] = [];
    const current_acceptances: {
      subject: string;
      acceptance: WorldAcceptanceOutcome;
    }[] = [];
    for (const record of this.world.lookup(scope, input)) {
      try {
        const context = this.conversationWorldContext(
          identity,
          mode,
          record.ref.id,
        );
        records.push(context.record);
        current_acceptances.push(
          ...context.acceptances.map((acceptance) => ({
            subject: record.ref.id,
            acceptance,
          })),
        );
      } catch (error) {
        if (
          error instanceof TaskError &&
          ['world_support_unavailable', 'world_record_not_found'].includes(
            error.code,
          )
        )
          continue;
        throw error;
      }
    }
    return worldLookupOutputSchema.parse({
      schema_version: 'haze.world.lookup.v1',
      records,
      current_acceptances: current_acceptances.slice(0, 250),
    });
  }

  /** Acceptance is always re-evaluated against current policy and source access. */
  conversationWorldContext(
    identity: TaskIdentity,
    mode: TaskRecord['mode'],
    recordId: string,
  ): WorldContextOutput {
    const scope = { ...identity, mode };
    const context = this.world.context(scope, recordId);
    if (!context)
      return fail(
        'world_record_not_found',
        'World Model record not found.',
        404,
      );
    this.requireConversationWorldSupportAccess(
      identity,
      mode,
      this.world.supportArtifacts(scope, recordId),
    );
    const acceptances = context.acceptances.flatMap((acceptance) => {
      const current = this.world.currentAcceptance(scope, acceptance.id, {
        policyHash: this.worldAcceptancePolicy.sha256,
        supportIsCurrent: (outcome) =>
          this.worldSupportIsCurrent(identity, mode, outcome),
      });
      return current ? [current] : [];
    });
    return worldContextOutputSchema.parse({ ...context, acceptances });
  }

  private requireConversationWorldSupportAccess(
    identity: TaskIdentity,
    mode: TaskRecord['mode'],
    refs: ArtifactRef[],
  ): void {
    const visited = new Set<string>();
    const pending = [...refs];
    while (pending.length) {
      const ref = pending.pop()!;
      const key = `${ref.id}:${ref.version}:${ref.sha256}`;
      if (visited.has(key)) continue;
      visited.add(key);
      if (visited.size > 1024)
        fail(
          'world_support_unavailable',
          'World Model support exceeds the bounded conversation access check.',
          403,
        );
      let artifact: Artifact;
      try {
        artifact = this.artifactMetadata(ref.id, identity, ref);
        const source = artifact.task_id
          ? this.core(artifact.task_id, identity)
          : undefined;
        if (
          (source && source.mode !== mode) ||
          artifact.required_tools.some(
            (tool) => !source?.permissions.tools.includes(tool),
          ) ||
          (source &&
            this.applicability(
              source.id,
              artifact.id,
              source.objective_revision,
            )?.current === false)
        )
          throw new Error('Source support is no longer available.');
      } catch {
        return fail(
          'world_support_unavailable',
          'Current source access prevents World Model context disclosure.',
          403,
        );
      }
      pending.push(...artifact.dependencies);
    }
  }

  worldLookup(
    taskId: string,
    identity: TaskIdentity,
    mode: TaskRecord['mode'],
    input: WorldLookupInput,
  ) {
    const task = this.core(taskId, identity);
    if (task.mode !== mode)
      fail('world_mode_mismatch', 'World Model execution mode mismatch.', 403);
    const scope = { ...identity, mode };
    const records = this.world.lookup(scope, input);
    const current_acceptances = records.flatMap((record) => {
      const context = this.world.context(scope, record.ref.id);
      if (!context) return [];
      this.requireWorldSupportAccess(
        task,
        this.world.supportArtifacts(scope, record.ref.id),
      );
      return context.acceptances.flatMap((acceptance) => {
        const current = this.world.currentAcceptance(scope, acceptance.id, {
          policyHash: this.worldAcceptancePolicy.sha256,
          supportIsCurrent: (outcome) =>
            this.worldSupportIsCurrent(identity, mode, outcome),
        });
        return current ? [{ subject: record.ref.id, acceptance: current }] : [];
      });
    });
    return worldLookupOutputSchema.parse({
      schema_version: 'haze.world.lookup.v1',
      records,
      current_acceptances,
    });
  }
  /** Recheck lifecycle state for every pinned dependency at publication time. */
  revalidateWorldEvidence(
    taskId: string,
    identity: TaskIdentity,
    ref: ArtifactRef,
  ): void {
    const requester = this.core(taskId, identity);
    const pins = this.db
      .prepare(
        `SELECT record_id FROM world_task_pins
         WHERE task_id=? AND principal=? AND workspace=? AND mode=? AND generation=?
         AND EXISTS (SELECT 1 FROM json_each(support_artifacts) support
           WHERE json_extract(support.value,'$.id')=?
           AND json_extract(support.value,'$.version')=?
           AND json_extract(support.value,'$.sha256')=?)`,
      )
      .all(
        taskId,
        identity.principal,
        identity.workspace,
        requester.mode,
        this.run(requester.current_run_id).generation,
        ref.id,
        ref.version,
        ref.sha256,
      ) as { record_id: string }[];
    if (!pins.length) return;
    this.requireWorldSupportAccess(requester, [ref]);
    const scope = { ...identity, mode: requester.mode };
    const records = this.db
      .prepare(
        `SELECT record_id FROM world_entities
         WHERE principal=? AND workspace=? AND mode=? AND kind='artifact_reference'
         AND revision=(SELECT MAX(current.revision) FROM world_entities current
           WHERE current.principal=world_entities.principal
           AND current.workspace=world_entities.workspace
           AND current.mode=world_entities.mode
           AND current.record_id=world_entities.record_id)
         AND json_extract(body,'$.payload.artifact.id')=?
         AND json_extract(body,'$.payload.artifact.version')=?
         AND json_extract(body,'$.payload.artifact.sha256')=?`,
      )
      .all(
        identity.principal,
        identity.workspace,
        requester.mode,
        ref.id,
        ref.version,
        ref.sha256,
      ) as { record_id: string }[];
    if (
      !records.length ||
      [...records, ...pins].some(
        ({ record_id }) => this.world.activeHolds(scope, record_id).length > 0,
      )
    )
      fail(
        'world_support_unavailable',
        'Pinned World Model evidence is revised or held; collect and review fresh evidence before publication.',
        422,
      );
  }
  /** Foreign assignment provenance is reusable only through an exact governed pin. */
  worldEvidenceOwner(
    taskId: string,
    identity: TaskIdentity,
    ref: ArtifactRef,
  ): TaskRecord | undefined {
    const requester = this.core(taskId, identity);
    const artifact = this.artifact(ref.id, identity, ref);
    if (!artifact.task_id || artifact.task_id === taskId) return undefined;
    const pins = this.db
      .prepare(
        'SELECT support_artifacts FROM world_task_pins WHERE task_id=? AND principal=? AND workspace=? AND mode=? AND generation=?',
      )
      .all(
        taskId,
        identity.principal,
        identity.workspace,
        requester.mode,
        this.run(requester.current_run_id).generation,
      ) as { support_artifacts: string }[];
    if (
      !pins.some((pin) =>
        (JSON.parse(pin.support_artifacts) as ArtifactRef[]).some(
          (support) =>
            support.id === ref.id &&
            support.version === ref.version &&
            support.sha256 === ref.sha256,
        ),
      )
    )
      return undefined;
    this.requireWorldSupportAccess(requester, [ref]);
    const owner = this.read(artifact.task_id, identity);
    if (
      !owner.artifacts.some(
        (entry) =>
          entry.objective_revision === owner.objective_revision &&
          entry.current &&
          entry.artifact.id === ref.id &&
          entry.artifact.version === ref.version &&
          entry.artifact.sha256 === ref.sha256,
      )
    )
      fail(
        'world_support_unavailable',
        'World Model producer evidence is no longer applicable.',
        422,
      );
    return owner;
  }
  /** Exact operator-admitted context can retain producer lineage without granting World Model acceptance. */
  admittedEvidenceOwner(
    taskId: string,
    identity: TaskIdentity,
    ref: ArtifactRef,
  ): TaskRecord | undefined {
    const requester = this.read(taskId, identity);
    const matches = (value: ArtifactRef) =>
      value.id === ref.id &&
      value.version === ref.version &&
      value.sha256 === ref.sha256;
    const explicit = [
      ...requester.original_request.context_refs,
      ...requester.corrections.flatMap(
        (correction) => correction.context_refs ?? [],
      ),
    ];
    if (
      !explicit.some(matches) ||
      !requester.artifacts.some(
        (entry) =>
          entry.current &&
          entry.objective_revision === requester.objective_revision &&
          matches(entry.artifact),
      )
    )
      return undefined;
    const artifact = this.artifact(ref.id, identity, ref);
    if (!artifact.task_id || artifact.task_id === taskId) return undefined;
    this.requireWorldSupportAccess(this.core(taskId, identity), [ref]);
    const scope = { ...identity, mode: requester.mode };
    const records = this.world.lookup(scope, {
      kind: 'artifact_reference',
      external_id: `artifact:${ref.id}:${ref.version}`,
      limit: 2,
    });
    if (
      records.length > 1 ||
      records.some(
        (record) => this.world.activeHolds(scope, record.ref.id).length,
      )
    )
      fail(
        'artifact_not_applicable',
        'Admitted source evidence is held or withdrawn.',
        422,
      );
    const owner = this.read(artifact.task_id, identity);
    if (
      owner.mode !== requester.mode ||
      artifact.run_id !== owner.current_run_id ||
      artifact.objective_revision !== owner.objective_revision ||
      !owner.artifacts.some(
        (entry) =>
          entry.current &&
          entry.objective_revision === owner.objective_revision &&
          matches(entry.artifact),
      )
    )
      fail(
        'artifact_not_applicable',
        'Admitted producer evidence is no longer current in this mode.',
        422,
      );
    return owner;
  }
  worldTaskView(taskId: string, identity: TaskIdentity) {
    const task = this.core(taskId, identity);
    const refs = new Map<string, ArtifactRef>();
    const add = (ref: ArtifactRef) =>
      refs.set(`${ref.id}:${ref.version}:${ref.sha256}`, ref);
    for (const ref of task.original_request.context_refs) add(ref);
    for (const assignment of this.allAssignments(task.current_run_id))
      for (const ref of [...assignment.inputs, ...assignment.outputs]) add(ref);
    if (task.result) {
      for (const ref of task.result.work_products) add(ref);
      for (const source of task.result.sources) add(source.artifact);
      if (task.result.review.artifact) add(task.result.review.artifact);
    }
    const scope = { ...identity, mode: task.mode };
    const related = this.world.recordsForArtifacts(scope, [...refs.values()]);
    const current_acceptances = related.records.flatMap((record) => {
      const context = this.worldContext(
        taskId,
        identity,
        task.mode,
        record.ref.id,
      );
      return context.acceptances.map((acceptance) => ({
        subject: record.ref.id,
        acceptance,
      }));
    });
    return worldTaskResponseSchema.parse({
      schema_version: 'haze.world.task-view.v1',
      task_id: task.id,
      mode: task.mode,
      records: related.records,
      current_acceptances: current_acceptances.slice(0, 250),
      truncated: related.truncated || current_acceptances.length > 250,
    });
  }
  worldContext(
    taskId: string,
    identity: TaskIdentity,
    mode: TaskRecord['mode'],
    recordId: string,
  ): WorldContextOutput {
    const requester = this.core(taskId, identity);
    if (requester.mode !== mode)
      fail('world_mode_mismatch', 'World Model execution mode mismatch.', 403);
    const scope = { ...identity, mode };
    const context = this.world.context(scope, recordId);
    if (!context)
      return fail(
        'world_record_not_found',
        'World Model record not found.',
        404,
      );
    const current = context.acceptances.map((acceptance) =>
      this.world.currentAcceptance(scope, acceptance.id, {
        policyHash: this.worldAcceptancePolicy.sha256,
        supportIsCurrent: (outcome) =>
          this.worldSupportIsCurrent(identity, mode, outcome),
      }),
    );
    this.requireWorldSupportAccess(
      requester,
      this.world.supportArtifacts(scope, recordId),
    );
    return worldContextOutputSchema.parse({
      ...context,
      acceptances: current.filter(
        (value): value is WorldAcceptanceOutcome => value !== undefined,
      ),
    });
  }
  worldRecordDetail(taskId: string, identity: TaskIdentity, recordId: string) {
    const task = this.core(taskId, identity);
    const context = this.worldContext(taskId, identity, task.mode, recordId);
    return worldRecordDetailResponseSchema.parse({
      schema_version: 'haze.world.record-detail.v1',
      record: context.record,
      relationships: context.relationships,
      support_artifacts: context.support_artifacts,
      payload: context.payload,
      status: {
        schema_version: 'haze.world.current-status.v1',
        record_id: recordId,
        acceptances: context.acceptances,
      },
    });
  }
  worldRecordDetailForIdentity(
    identity: TaskIdentity,
    mode: TaskRecord['mode'],
    recordId: string,
  ) {
    const scope = { ...identity, mode };
    const context = this.world.context(scope, recordId);
    if (!context)
      return fail(
        'world_record_not_found',
        'World Model record not found.',
        404,
      );
    const acceptances = context.acceptances.flatMap((acceptance) => {
      const current = this.world.currentAcceptance(scope, acceptance.id, {
        policyHash: this.worldAcceptancePolicy.sha256,
        supportIsCurrent: (outcome) =>
          this.worldSupportIsCurrent(identity, mode, outcome),
      });
      return current ? [current] : [];
    });
    return worldRecordDetailResponseSchema.parse({
      schema_version: 'haze.world.record-detail.v1',
      record: context.record,
      relationships: context.relationships,
      support_artifacts: context.support_artifacts,
      payload: context.payload,
      status: {
        schema_version: 'haze.world.current-status.v1',
        record_id: recordId,
        acceptances,
      },
    });
  }
  worldLineageForIdentity(
    identity: TaskIdentity,
    mode: TaskRecord['mode'],
    input: WorldLineageInput,
  ) {
    const scope = { ...identity, mode };
    if (!this.world.record(scope, input.record_id))
      return fail(
        'world_record_not_found',
        'World Model record not found.',
        404,
      );
    const page = this.world.lineage(scope, input);
    if (!page)
      return fail(
        'world_record_not_found',
        'World Model record not found.',
        404,
      );
    return page;
  }
  worldLineage(
    taskId: string,
    identity: TaskIdentity,
    mode: TaskRecord['mode'],
    input: WorldLineageInput,
  ) {
    this.worldContext(taskId, identity, mode, input.record_id);
    const page = this.world.lineage({ ...identity, mode }, input);
    if (!page)
      return fail(
        'world_record_not_found',
        'World Model record not found.',
        404,
      );
    return page;
  }
  pinWorldContext(
    taskId: string,
    identity: TaskIdentity,
    assignmentId: string,
    generation: number,
    refs: ArtifactRef[],
    statedUse: string,
    recordId: string,
  ): void {
    if (!statedUse.trim())
      fail(
        'world_use_required',
        'An explicit intended use is required before reusing context.',
        422,
      );
    this.atomic(() => {
      const task = this.core(taskId, identity);
      const run = this.run(task.current_run_id);
      const assignment = this.assignment(assignmentId, taskId);
      this.assertCurrent(task, run, assignment, generation);
      for (const ref of refs) {
        const artifact = this.artifact(ref.id, identity, ref);
        const sourceTask = artifact.task_id
          ? this.core(artifact.task_id, identity)
          : undefined;
        this.requireWorldSupportAccess(task, [ref]);
        if (
          (sourceTask && sourceTask.mode !== task.mode) ||
          artifact.required_tools.some(
            (tool) =>
              (sourceTask && !sourceTask.permissions.tools.includes(tool)) ||
              !task.permissions.tools.includes(tool),
          )
        )
          fail(
            'world_support_unavailable',
            'World Model context is outside current source or task grants.',
            403,
          );
        if (
          !assignment.inputs.some(
            (item) =>
              item.id === ref.id &&
              item.version === ref.version &&
              item.sha256 === ref.sha256,
          )
        )
          assignment.inputs.push(ref);
        this.recordApplicability(
          taskId,
          identity,
          artifact,
          true,
          'World Model context was pinned with exact source access checks.',
          'Runtime',
        );
      }
      this.putAssignment(assignment);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO world_task_pins
           (task_id,principal,workspace,mode,record_id,support_artifacts,generation)
           VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          taskId,
          identity.principal,
          identity.workspace,
          task.mode,
          recordId,
          JSON.stringify(refs),
          generation,
        );
      this.appendEvent(
        taskId,
        'world_context_retrieved',
        assignment.role,
        `Retrieved World Model context for the stated use: ${statedUse}`,
        { record_refs: refs },
        assignment.id,
      );
    });
  }
  /** Replace retrieved inputs before a fresh collection, retaining explicit user context. */
  clearWorldContextPins(
    taskId: string,
    identity: TaskIdentity,
    assignmentId: string,
    generation: number,
  ): void {
    this.atomic(() => {
      const task = this.core(taskId, identity),
        run = this.run(task.current_run_id),
        assignment = this.assignment(assignmentId, taskId);
      this.assertCurrent(task, run, assignment, generation);
      // Historical pins identify inputs retained across an objective correction.
      const pins = this.db
        .prepare(
          `SELECT record_id,support_artifacts,generation FROM world_task_pins
           WHERE task_id=? AND principal=? AND workspace=? AND mode=?`,
        )
        .all(taskId, identity.principal, identity.workspace, task.mode) as {
        record_id: string;
        support_artifacts: string;
        generation: number;
      }[];
      if (!pins.length) return;
      const key = (ref: ArtifactRef) =>
        `${ref.id}:${ref.version}:${ref.sha256}`;
      const retrieved = new Set(
        pins.flatMap((pin) =>
          (JSON.parse(pin.support_artifacts) as ArtifactRef[]).map(key),
        ),
      );
      const explicit = new Set(task.original_request.context_refs.map(key));
      for (const row of this.db
        .prepare('SELECT body FROM corrections WHERE task_id=?')
        .all(taskId) as Row[]) {
        const correction = decode<{ context_refs?: ArtifactRef[] }>(row.body);
        for (const ref of correction.context_refs ?? []) explicit.add(key(ref));
      }
      const dependsOnRetrieved = new Map<string, boolean>();
      const visiting = new Set<string>();
      const retrievedInput = (ref: ArtifactRef): boolean => {
        const identityKey = key(ref);
        if (explicit.has(identityKey)) return false;
        if (retrieved.has(identityKey)) return true;
        const known = dependsOnRetrieved.get(identityKey);
        if (known !== undefined) return known;
        if (visiting.has(identityKey))
          fail(
            'artifact_dependency_cycle',
            'Artifact dependency cycle detected.',
          );
        visiting.add(identityKey);
        const artifact = this.artifactMetadata(ref.id, identity, ref);
        const depends = artifact.dependencies.some(retrievedInput);
        visiting.delete(identityKey);
        dependsOnRetrieved.set(identityKey, depends);
        return depends;
      };
      const assignments = this.allAssignments(run.id);
      const branch = new Set([assignmentId]);
      for (let changed = true; changed;) {
        changed = false;
        for (const current of assignments)
          if (
            !branch.has(current.id) &&
            current.dependencies.some((id) => branch.has(id))
          ) {
            branch.add(current.id);
            changed = true;
          }
      }
      const removed = new Map<string, ArtifactRef>();
      for (const current of assignments) {
        if (!branch.has(current.id)) continue;
        current.inputs = current.inputs.filter((ref) => {
          if (!retrievedInput(ref)) return true;
          removed.set(key(ref), ref);
          return false;
        });
        this.putAssignment(current);
      }
      const remaining = new Set(
        assignments.flatMap((current) => current.inputs.map(key)),
      );
      for (const pin of pins)
        if (
          pin.generation === generation &&
          !(JSON.parse(pin.support_artifacts) as ArtifactRef[]).some(
            (ref) => remaining.has(key(ref)) && !explicit.has(key(ref)),
          )
        )
          this.db
            .prepare(
              'DELETE FROM world_task_pins WHERE task_id=? AND record_id=? AND generation=?',
            )
            .run(taskId, pin.record_id, generation);
      for (const [identityKey, ref] of removed)
        if (!remaining.has(identityKey))
          this.recordApplicability(
            taskId,
            identity,
            ref,
            false,
            'Prior retrieved context was replaced by fresh collection.',
            'Runtime',
          );
    });
  }
  private requireWorldSupportAccess(
    requester: TaskCore,
    refs: ArtifactRef[],
  ): void {
    for (const ref of refs) {
      const row = this.db
        .prepare(
          `SELECT body FROM artifacts
           WHERE id=? AND principal=? AND workspace=?`,
        )
        .get(
          ref.id,
          requester.identity.principal,
          requester.identity.workspace,
        ) as Row | undefined;
      if (!row)
        return fail(
          'world_support_unavailable',
          'Current source access prevents World Model context disclosure.',
          403,
        );
      const artifact = artifactSchema.parse(decode(row.body));
      if (artifact.version !== ref.version || artifact.sha256 !== ref.sha256)
        fail(
          'world_support_unavailable',
          'Current source access prevents World Model context disclosure.',
          403,
        );
      const source = artifact.task_id
        ? this.core(artifact.task_id, requester.identity)
        : undefined;
      if (
        (source && source.mode !== requester.mode) ||
        artifact.required_tools.some(
          (tool) =>
            (source && !source.permissions.tools.includes(tool)) ||
            !requester.permissions.tools.includes(tool),
        )
      )
        fail(
          'world_support_unavailable',
          'Current source access prevents World Model context disclosure.',
          403,
        );
    }
  }
  private worldSupportIsCurrent(
    identity: TaskIdentity,
    mode: TaskRecord['mode'],
    outcome: WorldAcceptanceOutcome,
  ): boolean {
    for (const support of outcome.support_revisions) {
      if (support.grant) {
        const taskRow = this.db
          .prepare(
            'SELECT body FROM tasks WHERE id=? AND principal=? AND workspace=?',
          )
          .get(
            support.grant.task_id,
            identity.principal,
            identity.workspace,
          ) as Row | undefined;
        if (!taskRow) return false;
        const task = decode<TaskCore>(taskRow.body);
        if (
          task.mode !== mode ||
          support.grant.tools.some(
            (tool) => !task.permissions.tools.includes(tool),
          )
        )
          return false;
      }
      if (support.assignment) {
        const registeredMethod =
          this.definitions?.assignments?.[support.assignment.definition_id];
        if (
          !registeredMethod ||
          registeredMethod.version !== support.assignment.version ||
          registeredMethod.role !== support.assignment.role
        )
          return false;
        const assignmentRow = this.db
          .prepare('SELECT body FROM assignments WHERE id=?')
          .get(support.assignment.id) as Row | undefined;
        if (!assignmentRow) return false;
        const assignment = assignmentSchema.parse(decode(assignmentRow.body));
        const taskRow = this.db
          .prepare(
            'SELECT body FROM tasks WHERE id=? AND principal=? AND workspace=?',
          )
          .get(assignment.task_id, identity.principal, identity.workspace) as
          Row | undefined;
        if (!taskRow) return false;
        const task = decode<TaskCore>(taskRow.body);
        if (
          task.mode !== mode ||
          assignment.revision !== support.assignment.revision ||
          assignment.definition_version !== support.assignment.version ||
          assignment.role !== support.assignment.role ||
          assignment.support !== support.assignment.support ||
          assignment.status !== 'completed' ||
          ['rejected', 'stale'].includes(assignment.usability)
        )
          return false;
      }
      if (support.artifact) {
        const row = this.db
          .prepare(
            `SELECT body FROM artifacts
             WHERE id=? AND principal=? AND workspace=?`,
          )
          .get(support.artifact.id, identity.principal, identity.workspace) as
          Row | undefined;
        if (!row) return false;
        const artifact = artifactSchema.parse(decode(row.body));
        if (
          artifact.version !== support.artifact.version ||
          artifact.sha256 !== support.artifact.sha256
        )
          return false;
        if (artifact.task_id) {
          const taskRow = this.db
            .prepare(
              'SELECT body FROM tasks WHERE id=? AND principal=? AND workspace=?',
            )
            .get(artifact.task_id, identity.principal, identity.workspace) as
            Row | undefined;
          if (!taskRow) return false;
          const task = decode<TaskCore>(taskRow.body);
          if (
            task.mode !== mode ||
            artifact.required_tools.some(
              (tool) => !task.permissions.tools.includes(tool),
            )
          )
            return false;
          const applicability = this.applicability(
            task.id,
            artifact.id,
            task.objective_revision,
          );
          if (applicability && !applicability.current) return false;
        } else if (artifact.required_tools.length) return false;
      }
    }
    return true;
  }
  private atomic<T>(operation: () => T): T {
    if (this.transactionDepth) return operation();
    const eventOffset = this.pendingWorldEvents.length;
    const callbackOffset = this.commitCallbacks.length;
    let committed = false;
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try {
      const result = operation();
      this.db.exec('COMMIT');
      committed = true;
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.pendingWorldEvents.splice(eventOffset);
      this.commitCallbacks.splice(callbackOffset);
      throw error;
    } finally {
      this.transactionDepth--;
      if (committed) {
        const events = this.pendingWorldEvents.splice(eventOffset);
        for (const event of events)
          for (const listener of this.worldListeners) {
            // Observer failure must never change an already committed write.
            try {
              listener(event);
            } catch {
              /* Reconnect reads authoritative state. */
            }
          }
        for (const callback of this.commitCallbacks.splice(callbackOffset))
          this.invokeCommitted(callback);
      }
    }
  }

  /** Domain transactions share this connection and nest with rollback savepoints. */
  transaction<T>(operation: () => T): T {
    const invoke = () => {
      const result = operation();
      if (result && typeof result === 'object' && 'then' in result)
        throw new Error('Task-store transactions must be synchronous.');
      return result;
    };
    if (!this.transactionDepth) return this.atomic(invoke);
    const savepoint = `haze_extension_${++this.savepointSequence}`;
    const eventOffset = this.pendingWorldEvents.length;
    const callbackOffset = this.commitCallbacks.length;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = invoke();
      this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      this.pendingWorldEvents.splice(eventOffset);
      this.commitCallbacks.splice(callbackOffset);
      throw error;
    }
  }
  afterCommit(callback: () => void): void {
    if (this.transactionDepth) this.commitCallbacks.push(callback);
    else this.invokeCommitted(callback);
  }
  private invokeCommitted(callback: () => void): void {
    try {
      callback();
    } catch {
      this
        .commitCallbackFailures++; /* Durable queued work remains recoverable. */
    }
  }
  get failedAfterCommitCallbacks() {
    return this.commitCallbackFailures;
  }

  /** Read a committed result for an exact run, without following the current pointer. */
  runResult(
    taskId: string,
    runId: string,
    identity: TaskIdentity,
    objectiveRevision?: number,
  ): TaskResult | undefined {
    const task = this.read(taskId, identity);
    const run = task.runs.find((run) => run.id === runId);
    if (!run) fail('run_not_found', 'Run is not part of this task.', 404);
    const objective = objectiveRevision ?? run!.objective_revision;
    const row = this.db
      .prepare(
        'SELECT body FROM task_run_results WHERE task_id=? AND run_id=? AND objective_revision=?',
      )
      .get(taskId, runId, objective) as Row | undefined;
    if (row) return taskResultSchema.parse(decode(row.body));
    return task.current_run_id === runId &&
      task.objective_revision === objective &&
      task.result?.currency === 'current'
      ? copy(task.result)
      : undefined;
  }

  subscribeWorld(listener: (event: WorldEvent) => void): () => void {
    this.worldListeners.add(listener);
    return () => this.worldListeners.delete(listener);
  }

  /** Internal service/migration boundary; never exposed as arbitrary HTTP writes. */
  withWorldTransaction<T>(operation: () => T): T {
    return this.atomic(operation);
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
    if (this.externalWaits) {
      const task = this.core(run.task_id);
      if (terminal(run.status) || run.status === 'paused')
        this.externalWaits.onAuthorityChange(run.task_id, run.status);
      else
        this.externalWaits.retainPermit({
          task_id: run.task_id,
          run_id: run.id,
          generation: run.generation,
          objective_revision: task.objective_revision,
        });
    }
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
  /** Bounded local inbox; never returns another principal's task content. */
  listTaskSummaries(
    identity: TaskIdentity,
    options: { limit?: number; cursor?: string; status?: string } = {},
  ) {
    const limit = options.limit ?? 50;
    const cursor = options.cursor ?? String(Number.MAX_SAFE_INTEGER);
    const status = options.status ?? 'all';
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !/^\d{1,16}$/u.test(cursor) ||
      !Number.isSafeInteger(Number(cursor)) ||
      !['all', 'active', 'failed'].includes(status)
    )
      throw new TaskError(400, 'invalid_query', 'Invalid task inbox query.');
    const rows = this.db
      .prepare(
        `SELECT t.rowid AS cursor, t.body AS task, r.body AS run
         FROM tasks t JOIN runs r ON r.id=json_extract(t.body,'$.current_run_id')
         WHERE t.principal=? AND t.workspace=? AND t.rowid<?
         AND (?='all' OR (?='active' AND json_extract(r.body,'$.status') IN ('queued','running','waiting','paused'))
           OR (?='failed' AND json_extract(r.body,'$.status') IN ('failed','timed_out')))
         ORDER BY t.rowid DESC LIMIT ?`,
      )
      .all(
        identity.principal,
        identity.workspace,
        Number(cursor),
        status,
        status,
        status,
        limit + 1,
      ) as {
      cursor: number;
      task: string;
      run: string;
    }[];
    const page = rows.slice(0, limit);
    return {
      tasks: page.map((row) => {
        const task = decode<TaskCore>(row.task);
        const run = decode<RunRecord>(row.run);
        return {
          id: task.id,
          objective: task.original_request.objective.slice(0, 1600),
          status: run.status,
          current_run_id: run.id,
          updated_at: run.updated_at,
          usage: run.usage,
        };
      }),
      has_more: rows.length > limit,
      ...(rows.length > limit
        ? { next_cursor: String(page.at(-1)!.cursor) }
        : {}),
    };
  }
  activeAssignmentSummaries(identity: TaskIdentity) {
    const rows = this.db
      .prepare(
        `SELECT a.body FROM assignments a JOIN tasks t ON t.id=a.task_id
         WHERE t.principal=? AND t.workspace=?
         AND a.run_id=json_extract(t.body,'$.current_run_id')
         AND json_extract(a.body,'$.status') IN ('queued','running','waiting','paused')
         ORDER BY a.rowid DESC LIMIT 257`,
      )
      .all(identity.principal, identity.workspace) as Row[];
    const assignments = rows.slice(0, 256).map((row) => {
      const assignment = assignmentSchema.parse(decode(row.body));
      return {
        id: assignment.id,
        task_id: assignment.task_id,
        role: assignment.role,
        definition_id: assignment.definition_id,
        status: assignment.status,
      };
    });
    return { assignments, has_more: rows.length > 256 };
  }
  /** Active execution authority includes external waits with a released permit. */
  listCapacityTasks(): TaskRecord[] {
    return (this.db.prepare('SELECT body FROM tasks').all() as Row[])
      .map((row) => decode<TaskCore>(row.body))
      .map((task) => this.read(task.id, task.identity))
      .filter((task) => ['queued', 'running', 'waiting'].includes(task.status));
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
      routeSnapshot?: ModelRouteSnapshot;
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
          this.externalWaits.assertCanAdmit();
          for (const ref of parsed.context_refs) {
            this.artifact(ref.id, identity, ref);
            this.nightshift.assertOrdinaryInput(ref);
          }
          const limits = resourceLimitsSchema.parse({
            // Investigation profile (docs/plans/orchestration/general-agent-refactor-plan.md).
            // Model-driven specialists each spend turns, so the short-lookup
            // ceiling of six cannot seat Manager planning, three specialists
            // and synthesis in one run.
            deadline: new Date(Date.now() + 300_000).toISOString(),
            max_model_calls: 40,
            max_tool_calls: 40,
            max_assignments: 16,
            max_artifacts: 64,
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
          for (const ref of parsed.context_refs) {
            const artifact = this.artifact(ref.id, identity, ref);
            this.projectArtifact(artifact, task.mode);
          }
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
          this.modelRoutes.admit(
            id,
            runId,
            options.routeSnapshot ?? createOfflineRouteSnapshot(),
          );
          this.externalWaits.acquire(
            {
              task_id: id,
              run_id: runId,
              generation: run.generation,
              objective_revision: task.objective_revision,
            },
            'new admission',
          );
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
      this.nightshift.assertResource(run.id, 'assignments', definitions.length);
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
          // An exact retained artifact can contain this assignment's own
          // output without introducing a new scheduling prerequisite.
          ...[...this.artifactAssignments(item!.inputs)].filter(
            (producer) => producer !== id && graph.has(producer),
          ),
        ]))
          visit(dep);
        visiting.delete(id);
        visited.add(id);
      };
      for (const item of [...prior, ...created]) visit(item.id);
      for (const item of created) {
        this.db
          .prepare('INSERT INTO assignments VALUES(?,?,?,?)')
          .run(item.id, taskId, runId, JSON.stringify(item));
        this.modelRoutes.bindAssignment(item);
        this.nightshiftTransfers.bindAssignment(item);
      }
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
      this.externalWaits.assertPermit({
        task_id: taskId,
        run_id: run.id,
        generation: run.generation,
        objective_revision: task.objective_revision,
      });
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
          !this.applicability(taskId, ref.id, task.objective_revision)
            ?.current &&
          !this.nightshift.isSelectedReviewDependency(
            taskId,
            run.id,
            run.generation,
            task.objective_revision,
            assignment,
            ref,
          )
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
      this.nightshiftTransfers.bindAssignment(assignment);
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
      this.nightshift.assertResource(
        run.id,
        kind === 'model' ? 'model_calls' : 'tool_calls',
      );
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
        const critics = this.allAssignments(run.id).filter(
          (item) =>
            item.role === 'EvidenceCritic' &&
            item.objective_revision === task.objective_revision,
        );
        const completedReview = critics.some(
          (item) => item.status === 'completed' && item.usability !== 'stale',
        );
        // Once every registered critic for this revision has terminated without
        // a usable result, the independent review can no longer run. Holding its
        // reserve would strand floor(reserved_model_calls / 2) calls for the rest
        // of the run: nobody can claim them and synthesis is denied them. Release
        // them to the final synthesis only — specialist work still may not take
        // them, which preserves the documented guarantee that review and
        // synthesis retain capacity before specialists consume the budget.
        const reviewUnavailable =
          critics.length > 0 &&
          critics.every(
            (item) => terminal(item.status) || item.usability === 'stale',
          );
        const reviewRemaining = completedReview
          ? 0
          : Math.max(
              0,
              Math.floor(run.limits.reserved_model_calls / 2) - reviewUsed,
            );
        const finalising = [
          'core.manager.synthesis',
          'core.manager.coordinator',
        ].includes(assignment.definition_id);
        const reserve =
          (finalising ? 0 : synthesisRemaining) +
          (assignment.role === 'EvidenceCritic' ||
          (finalising && reviewUnavailable)
            ? 0
            : reviewRemaining);
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
  /**
   * Record a model response that failed validation. No action is dispatched,
   * but the response is marked consumed: an unconsumed response is replayed on
   * the next turn, which would hand a specialist the same malformed text it
   * was asked to correct.
   */
  rejectResponse(
    taskId: string,
    assignmentId: string,
    actionId: string,
    response: JsonValue,
    reason: string,
    expected?: LeaseExpectation,
  ): ActionRecord {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(task.current_run_id),
        assignment = this.assignment(assignmentId, taskId);
      this.assertCurrent(task, run, assignment);
      this.expectLease(assignment, expected);
      const id = `${assignmentId}:${assignment.revision}:${actionId}`,
        fingerprint = contractHash({ response, rejected: reason });
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
        action: null,
        dispatched: true,
        rejected: reason,
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
  /** Trusted configured watcher input; shares task storage, scope and provenance. */
  ingestHazeAdapterResult(
    result: AdapterResult,
    identity: TaskIdentity,
    mode: TaskRecord['mode'],
    runId: string,
  ): WriteSummary {
    validateAdapterResult(result);
    return this.atomic(() => {
      const artifacts = new Map<string, Artifact>();
      const scope = { ...identity, mode };
      for (const { record, raw } of result.evidence) {
        const retained = findHazeRecord(
          this.world,
          scope,
          'evidence',
          entityId('evidence', record.evidenceId),
        );
        const original = retained?.payload as unknown as
          { attrs: Record<string, unknown> } | undefined;
        if (original && original.attrs.rawSha256 !== record.rawSha256)
          fail(
            'evidence_identity_conflict',
            'Pinned haze evidence identity was reused with different raw bytes.',
          );
        const evidence = original?.attrs ?? record;
        const dependencies: ArtifactRef[] = [];
        const chunkBytes = 262_144;
        if (raw.length > chunkBytes * CONTRACT_LIMITS.references)
          fail(
            'evidence_too_large',
            'A raw response exceeds the 64 MiB retained evidence bound.',
            413,
          );
        for (
          let offset = 0;
          offset < raw.length || offset === 0;
          offset += chunkBytes
        ) {
          const content = {
            schema_version: 'haze.evidence.raw-chunk.v1',
            mode,
            raw_sha256: record.rawSha256,
            index: offset / chunkBytes,
            raw_base64: raw
              .subarray(offset, offset + chunkBytes)
              .toString('base64'),
          };
          const artifact = this.retainHazeServiceArtifact(
            identity,
            mode,
            `raw:${record.rawSha256}:${offset}`,
            'haze.evidence.raw.chunk',
            content,
            [],
            record.retrievedAt,
          );
          dependencies.push({
            id: artifact.id,
            version: artifact.version,
            sha256: artifact.sha256,
          });
        }
        const content = {
          schema_version: 'haze.evidence.retained.v1',
          mode,
          record: evidence,
          raw_sha256: record.rawSha256,
          raw_bytes: raw.length,
          chunks: dependencies,
        } as JsonValue;
        const capture = this.retainHazeServiceArtifact(
          identity,
          mode,
          `evidence:${contentHash(evidence)}`,
          'haze.evidence.capture',
          content,
          dependencies,
          record.retrievedAt,
        );
        artifacts.set(record.evidenceId, capture);
      }
      return ingestAdapterResult(this.world, scope, result, runId, artifacts);
    });
  }

  private retainHazeServiceArtifact(
    identity: TaskIdentity,
    mode: TaskRecord['mode'],
    key: string,
    kind: string,
    content: JsonValue,
    dependencies: ArtifactRef[],
    createdAt: string,
  ): Artifact {
    return this.operation(
      identity,
      `haze-service-artifact:${mode}`,
      key,
      { kind, content, dependencies },
      () => {
        const artifact: Artifact = {
          schema_version: 'haze.artifact.v3',
          id: randomUUID(),
          version: 1,
          identity: copy(identity),
          sha256: contentHash(content),
          kind,
          producer: { kind: 'service', id: 'HazeOps' },
          created_at: createdAt,
          dependencies,
          required_tools: [],
          content,
          evidence_origin:
            mode === 'fixture' ? 'synthetic_fixture' : 'external_source',
        };
        this.insertArtifact(artifact);
        this.projectArtifact(artifact, mode);
        return artifact;
      },
    ).value;
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
      if (
        run.usage.artifacts + this.nightshift.retentionForRun(run.id) >=
        run.limits.max_artifacts
      )
        fail(
          'artifact_limit',
          'Artifact capacity is reserved for original Nightshift receipts.',
          422,
        );
      this.nightshift.assertResource(run.id, 'artifacts');
      for (const ref of options.dependencies ?? []) {
        this.artifact(ref.id, identity, ref);
        if (
          !this.applicability(taskId, ref.id, task.objective_revision)
            ?.current &&
          !this.nightshift.isSelectedReviewDependency(
            taskId,
            run.id,
            run.generation,
            task.objective_revision,
            assignment,
            ref,
          )
        )
          fail(
            'artifact_not_applicable',
            'Dependency has no current applicability check.',
          );
      }
      const externalCandidates = [
        ...new Map(
          [
            ...(assignment
              ? this.externalWaits
                  .candidateContext(
                    {
                      task_id: taskId,
                      run_id: run.id,
                      generation: run.generation,
                      objective_revision: task.objective_revision,
                      assignment_id: assignment.id,
                      assignment_revision: assignment.revision,
                    },
                    identity,
                  )
                  .map((item) => item.artifact)
              : []),
            ...(options.dependencies ?? []).flatMap(
              (ref) =>
                this.artifact(ref.id, identity, ref).external_candidates ?? [],
            ),
          ].map((ref) => [`${ref.id}:${ref.version}:${ref.sha256}`, ref]),
        ).values(),
      ];
      if (externalCandidates.length > 4)
        fail(
          'external_candidate_limit',
          'Candidate provenance exceeds the bounded exact-reference limit.',
          422,
        );
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
        ...(externalCandidates.length
          ? { external_candidates: externalCandidates }
          : {}),
        required_tools: [
          ...new Set([
            ...(assignment?.tools ?? []),
            ...(externalCandidates.length ? ['nightshift.result'] : []),
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
      this.projectArtifact(artifact, task.mode);
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
  private projectArtifact(
    artifact: Artifact,
    mode: TaskRecord['mode'],
    ancestors = new Set<string>(),
    // Shared dependencies are projected once; without this, layered
    // dependency graphs are re-walked once per path (exponential).
    projectedKeys = new Set<string>(),
  ): void {
    if (this.nightshift.isCandidate(artifact)) return;
    if (
      artifact.task_id &&
      this.core(artifact.task_id, artifact.identity).mode !== mode
    )
      fail('world_mode_mismatch', 'World Model execution mode mismatch.', 403);
    if (
      artifact.producer.kind === 'service' &&
      artifact.producer.id === 'HazeOps' &&
      (artifact.kind === 'haze.evidence.capture' ||
        artifact.kind === 'haze.evidence.raw.chunk') &&
      (typeof artifact.content !== 'object' ||
        artifact.content === null ||
        Array.isArray(artifact.content) ||
        artifact.content.mode !== mode)
    )
      fail('world_mode_mismatch', 'World Model execution mode mismatch.', 403);
    const key = `${artifact.id}/${artifact.version}`;
    if (ancestors.has(key))
      fail('artifact_dependency_cycle', 'Artifact dependency cycle detected.');
    if (projectedKeys.has(key)) return;
    const nextAncestors = new Set(ancestors).add(key);
    const dependencies = artifact.dependencies.map((ref) =>
      this.artifact(ref.id, artifact.identity, ref),
    );
    for (const dependency of dependencies)
      this.projectArtifact(dependency, mode, nextAncestors, projectedKeys);

    const projected = this.world.projectArtifact(artifact, mode).value;
    if (artifact.kind === 'evidence.collection.capture')
      ingestCollectionCapture(this.world, artifact, mode);
    for (const dependency of dependencies) {
      // A selected review dependency is still an unreviewed service candidate.
      if (this.nightshift.isCandidate(dependency)) continue;
      const projectedDependency = this.world.projectArtifact(
        dependency,
        mode,
      ).value;
      this.world.relate({
        scope: projected.scope,
        operation_key: `artifact-dependency:${artifact.id}:${artifact.version}:${dependency.id}:${dependency.version}`,
        kind: 'depends_on',
        from: projected.ref,
        to: projectedDependency.ref,
        recorded_at: artifact.created_at,
      });
    }
    projectedKeys.add(key);
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
      if (current) this.nightshift.assertOrdinaryInput(ref);
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
    worldProjections: WorldProjectionRecordInput[] = [],
    worldAdapters: WorldCapabilityAdapterInput[] = [],
  ): TaskRecord {
    return this.atomic(() => {
      const task = this.core(taskId),
        run = this.run(runId);
      this.assertCurrent(task, run, undefined, generation);
      const result = taskResultSchema.parse(input);
      this.nightshiftTransfers.assertFinalizable({
        task_id: taskId,
        run_id: run.id,
        generation: run.generation,
        objective_revision: task.objective_revision,
      });
      this.externalWaits.assertFinalizable({
        task_id: taskId,
        run_id: run.id,
        generation: run.generation,
        objective_revision: task.objective_revision,
      });
      if (
        result.review.status !== 'supported' &&
        [
          ...result.work_products,
          ...result.sources.map((source) => source.artifact),
        ].some(
          (ref) =>
            this.artifact(ref.id, task.identity, ref).external_candidates
              ?.length,
        )
      )
        fail(
          'external_candidate_review_required',
          'Candidate-derived products require independent review before final selection.',
        );
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
      const worldScope = {
        ...task.identity,
        mode: task.mode,
      };
      const projectedRecords = new Map<
        string,
        ReturnType<WorldModelStore['putRecord']>['value']
      >();
      const projectedByCapability = new Map<
        string,
        ReturnType<WorldModelStore['putRecord']>['value'][]
      >();
      for (const projection of worldProjections) {
        const record = this.world.putRecord({
          scope: worldScope,
          operation_key: `capability-projection:${contractHash({
            capability: projection.capability_id,
            kind: projection.kind,
            external_id: projection.external_id,
            payload: projection.payload,
          })}`,
          kind: projection.kind,
          external_id: projection.external_id,
          payload: projection.payload,
          producer: { kind: 'service', id: projection.capability_id },
        }).value;
        projectedRecords.set(
          `${projection.kind}:${projection.external_id}`,
          record,
        );
        const capabilityRecords =
          projectedByCapability.get(projection.capability_id) ?? [];
        capabilityRecords.push(record);
        projectedByCapability.set(projection.capability_id, capabilityRecords);
        for (const evidenceRef of projection.evidence) {
          const evidenceArtifact = this.artifact(
            evidenceRef.id,
            task.identity,
            evidenceRef,
          );
          const evidenceRecord = this.world.projectArtifact(
            evidenceArtifact,
            task.mode,
          ).value;
          this.world.relate({
            scope: worldScope,
            operation_key: `capability-evidence:${contractHash({
              capability: projection.capability_id,
              record: record.ref,
              evidence: evidenceRecord.ref,
            })}`,
            kind: 'supported_by',
            from: record.ref,
            to: evidenceRecord.ref,
          });
        }
      }
      for (const projection of worldProjections) {
        const record = projectedRecords.get(
          `${projection.kind}:${projection.external_id}`,
        )!;
        for (const relationship of projection.relationships ?? []) {
          const target = projectedRecords.get(
            `${relationship.kind}:${relationship.external_id}`,
          );
          if (!target)
            return fail(
              'invalid_world_projection',
              'Capability projection references a record it did not produce.',
              422,
            );
          this.world.relate({
            scope: worldScope,
            operation_key: `capability-relationship:${contractHash({
              capability: projection.capability_id,
              from: record.ref,
              relationship: relationship.relationship,
              to: target.ref,
            })}`,
            kind: relationship.relationship,
            from: record.ref,
            to: target.ref,
          });
        }
      }
      this.evaluateWorldCandidates({
        task,
        run,
        result,
        adapters: worldAdapters,
        records: projectedByCapability,
      });
      task.result = result;
      this.db
        .prepare(
          'INSERT INTO task_run_results(run_id,objective_revision,task_id,body) VALUES(?,?,?,?) ON CONFLICT(run_id,objective_revision) DO NOTHING',
        )
        .run(run.id, task.objective_revision, taskId, JSON.stringify(result));
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
  private evaluateWorldCandidates(input: {
    task: TaskCore;
    run: RunRecord;
    result: TaskResult;
    adapters: WorldCapabilityAdapterInput[];
    records: Map<string, WorldRecord[]>;
  }): void {
    const { task, run } = input;
    const assignments = this.allAssignments(run.id).filter(
      (assignment) => assignment.objective_revision === task.objective_revision,
    );
    const capabilities = new Set(
      assignments
        .filter((assignment) => assignment.capability !== 'core.manager')
        .map((assignment) => assignment.capability),
    );
    const artifactsByRef = new Map<string, Artifact>();
    const refKey = (ref: ArtifactRef) =>
      `${ref.id}:${ref.version}:${ref.sha256}`;
    const add = (ref: ArtifactRef): void => {
      const key = refKey(ref);
      if (artifactsByRef.has(key)) return;
      const artifact = this.artifact(ref.id, task.identity, ref);
      artifactsByRef.set(key, artifact);
      for (const dependency of artifact.dependencies) add(dependency);
    };
    for (const ref of [
      ...input.result.work_products,
      ...input.result.sources.map((source) => source.artifact),
      ...(input.result.review.artifact ? [input.result.review.artifact] : []),
    ])
      add(ref);
    const selected = new Set(artifactsByRef.keys());
    for (const check of input.result.review.checks ?? []) {
      if (
        check.verdict !== 'supported' ||
        !check.review_artifact ||
        !selected.has(refKey(check.artifact))
      )
        continue;
      const reviewer = assignments.find(
        (assignment) =>
          assignment.id === check.reviewer_assignment_id &&
          assignment.revision === check.reviewer_revision &&
          assignment.role === 'EvidenceCritic' &&
          assignment.id !== check.producer_assignment_id &&
          assignment.status === 'completed' &&
          assignment.support === 'supported' &&
          !['rejected', 'stale'].includes(assignment.usability),
      );
      if (!reviewer) continue;
      const review = this.artifact(
        check.review_artifact.id,
        task.identity,
        check.review_artifact,
      );
      if (
        review.assignment_id === reviewer.id &&
        review.assignment_revision === reviewer.revision
      )
        add(check.review_artifact);
    }
    const artifacts = [...artifactsByRef.values()];
    const scope = { ...task.identity, mode: task.mode };
    const evaluatedAt = now();

    for (const { capability_id: capability, adapter } of input.adapters) {
      if (!capabilities.has(capability)) continue;
      const records = input.records.get(capability) ?? [];
      if (!records.length) continue;
      const recordsForCapability = records;
      const reviewRequirements = adapter.requiredReviewCoverage({
        request: task.original_request,
        assignments: assignments.map((assignment) => ({
          key: assignment.id,
          definition_id: assignment.definition_id,
          brief: assignment.brief,
          depends_on: assignment.dependencies,
        })),
        artifacts,
      });
      const assessments = [] as const;
      const candidate = adapter.buildAcceptanceCandidate({
        request: task.original_request,
        records: recordsForCapability,
        assessments,
        artifacts,
        assignments: assignments.map((assignment) => ({
          id: assignment.id,
          revision: assignment.revision,
          definition_id: assignment.definition_id,
          role: assignment.role,
          status: assignment.status,
          support: assignment.support,
        })),
      });
      const subject = candidate
        ? recordsForCapability.find(
            (record) =>
              record.ref.id === candidate.subject.id &&
              record.ref.revision === candidate.subject.revision &&
              record.ref.sha256 === candidate.subject.sha256,
          )
        : recordsForCapability.at(-1);
      if (!subject) continue;
      const statedUse =
        candidate?.stated_use ??
        (capability === 'damage-account-intake'
          ? 'damage-account:partial'
          : capability);
      const reasons: string[] = [];
      let pendingReview = false;
      if (!isWorldAcceptanceEnabled(this.worldAcceptancePolicy))
        reasons.push('Server acceptance policy is disabled.');
      else if (!policyAllows(this.worldAcceptancePolicy, capability, statedUse))
        reasons.push('Capability or stated use is not authorized by policy.');

      const candidateEvidence = candidate?.evidence ?? [];
      const evidenceById = new Map<string, Artifact>();
      for (const ref of candidateEvidence) {
        if (
          !artifacts.some(
            (item) =>
              item.id === ref.id &&
              item.version === ref.version &&
              item.sha256 === ref.sha256,
          )
        ) {
          reasons.push(`Evidence ${ref.id} is outside the current task scope.`);
          continue;
        }
        this.collectWorldEvidenceClosure(
          ref,
          task,
          evidenceById,
          reasons,
          new Set(),
        );
      }
      for (const requirement of reviewRequirements) {
        let supportingReview: Artifact | undefined;
        const covered = assignments.some((reviewer) => {
          if (
            !requirement.reviewer_roles.includes(reviewer.role) ||
            reviewer.status !== 'completed' ||
            reviewer.support !== 'supported' ||
            ['rejected', 'stale'].includes(reviewer.usability)
          )
            return false;
          supportingReview = reviewer.outputs
            .map((output) => {
              const reviewArtifact = artifacts.find(
                (artifact) =>
                  artifact.id === output.id &&
                  artifact.version === output.version &&
                  artifact.sha256 === output.sha256,
              );
              return reviewArtifact?.dependencies &&
                requirement.evidence.every((required) =>
                  reviewArtifact.dependencies.some(
                    (dependency) =>
                      dependency.id === required.id &&
                      dependency.version === required.version &&
                      dependency.sha256 === required.sha256,
                  ),
                )
                ? reviewArtifact
                : undefined;
            })
            .find((reviewArtifact) => reviewArtifact !== undefined);
          return supportingReview !== undefined;
        });
        if (!covered) {
          pendingReview = true;
          reasons.push(
            `Required review coverage is incomplete: ${requirement.id}.`,
          );
        } else if (supportingReview) {
          this.collectWorldEvidenceClosure(
            supportingReview,
            task,
            evidenceById,
            reasons,
            new Set(),
          );
        }
      }
      for (const check of input.result.review.checks ?? [])
        if (
          check.verdict === 'rejected' &&
          evidenceById.has(refKey(check.artifact))
        )
          reasons.push(
            `Evidence ${check.artifact.id} failed independent review.`,
          );
      if (!candidate && !pendingReview)
        reasons.push(
          'Capability adapter did not produce an eligible candidate.',
        );
      const support_revisions: WorldAcceptanceOutcome['support_revisions'] = [
        {
          schema_version: 'haze.world.support-revision.v1',
          id: `policy:${this.worldAcceptancePolicy.id}`,
          scope,
          revision: 1,
          kind: 'policy',
          sha256: this.worldAcceptancePolicy.sha256,
          recorded_at: evaluatedAt,
        },
        ...[...evidenceById.values()].map((artifact) => ({
          schema_version: 'haze.world.support-revision.v1' as const,
          id: `artifact:${artifact.id}:${artifact.version}`,
          scope,
          revision: artifact.version,
          kind: 'artifact' as const,
          sha256: artifact.sha256,
          artifact: {
            id: artifact.id,
            version: artifact.version,
            sha256: artifact.sha256,
          },
          recorded_at: evaluatedAt,
        })),
        ...new Map(
          [...evidenceById.values()].flatMap((artifact) => {
            if (
              artifact.producer.kind !== 'assignment' ||
              !artifact.assignment_id ||
              !artifact.task_id
            )
              return [];
            const ownerTaskId = artifact.task_id;
            const producer = this.assignment(
              artifact.assignment_id,
              ownerTaskId,
            );
            const assignment = {
              id: producer.id,
              definition_id: producer.definition_id,
              revision: producer.revision,
              version: producer.definition_version,
              role: producer.role,
              support: producer.support,
            };
            return [
              [
                producer.id,
                {
                  schema_version: 'haze.world.support-revision.v1' as const,
                  id: `assignment:${producer.id}:${producer.revision}`,
                  scope,
                  revision: producer.revision,
                  kind: 'method' as const,
                  sha256: contractHash(assignment),
                  assignment,
                  recorded_at: evaluatedAt,
                },
              ] as const,
            ];
          }),
        ).values(),
        ...new Map(
          [...evidenceById.values()].flatMap((artifact) => {
            if (!artifact.task_id || !artifact.required_tools.length) return [];
            const owner = this.core(artifact.task_id, task.identity);
            const tools = [...new Set(artifact.required_tools)].sort();
            const grant = { task_id: owner.id, tools };
            return [
              [
                owner.id,
                {
                  schema_version: 'haze.world.support-revision.v1' as const,
                  id: `grant:${owner.id}:${contractHash(grant)}`,
                  scope,
                  revision: Math.max(1, owner.objective_revision),
                  kind: 'grant' as const,
                  sha256: contractHash(grant),
                  grant,
                  recorded_at: evaluatedAt,
                },
              ] as const,
            ];
          }),
        ).values(),
      ];
      if (support_revisions.length > CONTRACT_LIMITS.references)
        reasons.push(
          'Exact support closure exceeds the policy evidence bound.',
        );
      const boundedSupportRevisions = support_revisions.slice(
        0,
        CONTRACT_LIMITS.references,
      );
      const status = reasons.length
        ? pendingReview &&
          reasons.every((reason) =>
            reason.startsWith('Required review coverage'),
          )
          ? 'pending_review'
          : 'not_eligible'
        : 'accepted';
      const expiresAt =
        status === 'accepted'
          ? acceptanceExpiry(this.worldAcceptancePolicy, evaluatedAt)
          : undefined;
      this.world.evaluateAcceptance({
        scope,
        subject: subject.ref,
        stated_use: statedUse,
        status,
        policy: {
          id: this.worldAcceptancePolicy.id,
          version: this.worldAcceptancePolicy.version,
          sha256: this.worldAcceptancePolicy.sha256,
        },
        support_revisions: boundedSupportRevisions,
        ...(status === 'accepted' ? {} : { reasons }),
        actor: { kind: 'service', id: capability },
        evaluated_at: evaluatedAt,
        ...(expiresAt ? { expires_at: expiresAt } : {}),
      });
    }
  }
  private collectWorldEvidenceClosure(
    ref: ArtifactRef,
    requester: TaskCore,
    collected: Map<string, Artifact>,
    reasons: string[],
    visiting: Set<string>,
  ): void {
    const key = `${ref.id}:${ref.version}:${ref.sha256}`;
    if (collected.has(key)) return;
    if (visiting.has(key)) {
      reasons.push(`Evidence dependency cycle includes ${ref.id}.`);
      return;
    }
    const artifactRow = this.db
      .prepare(
        `SELECT body FROM artifacts
         WHERE id=? AND principal=? AND workspace=?`,
      )
      .get(
        ref.id,
        requester.identity.principal,
        requester.identity.workspace,
      ) as Row | undefined;
    if (!artifactRow) {
      reasons.push(`Evidence dependency ${ref.id} is unavailable.`);
      return;
    }
    const artifact = artifactSchema.parse(decode(artifactRow.body));
    if (artifact.version !== ref.version || artifact.sha256 !== ref.sha256) {
      reasons.push(`Evidence dependency ${ref.id} has a changed hash.`);
      return;
    }
    let owner: TaskCore | undefined;
    if (artifact.task_id) {
      const taskRow = this.db
        .prepare(
          'SELECT body FROM tasks WHERE id=? AND principal=? AND workspace=?',
        )
        .get(
          artifact.task_id,
          requester.identity.principal,
          requester.identity.workspace,
        ) as Row | undefined;
      if (!taskRow) {
        reasons.push(`Evidence ${ref.id} belongs to an unavailable task.`);
        return;
      }
      owner = decode<TaskCore>(taskRow.body);
      const sourcePermissions = owner.permissions.tools;
      if (
        owner.mode !== requester.mode ||
        artifact.required_tools.some(
          (tool) =>
            !sourcePermissions.includes(tool) ||
            !requester.permissions.tools.includes(tool),
        )
      ) {
        reasons.push(
          `Evidence ${ref.id} is outside current tool grants or mode.`,
        );
        return;
      }
      const applicability = this.applicability(
        owner.id,
        artifact.id,
        owner.objective_revision,
      );
      if (applicability && !applicability.current) {
        reasons.push(`Evidence ${ref.id} is no longer applicable.`);
        return;
      }
    } else if (
      artifact.required_tools.some(
        (tool) => !requester.permissions.tools.includes(tool),
      )
    ) {
      reasons.push(`Evidence ${ref.id} is outside current task grants.`);
      return;
    }
    if (artifact.producer.kind === 'assignment') {
      if (!artifact.assignment_id || !owner) {
        reasons.push(`Evidence ${ref.id} has no verifiable producer revision.`);
        return;
      }
      const producerRow = this.db
        .prepare('SELECT body FROM assignments WHERE id=? AND task_id=?')
        .get(artifact.assignment_id, owner.id) as Row | undefined;
      if (!producerRow) {
        reasons.push(`Evidence ${ref.id} has no verifiable producer revision.`);
        return;
      }
      const producer = assignmentSchema.parse(decode(producerRow.body));
      if (
        producer.revision !== artifact.assignment_revision ||
        producer.status !== 'completed' ||
        producer.support === 'gap' ||
        producer.support === 'unknown' ||
        ['rejected', 'stale'].includes(producer.usability)
      ) {
        reasons.push(
          `Evidence ${ref.id} has a stale or unsupported producer revision.`,
        );
        return;
      }
    }
    if (artifact.kind === 'world.context.snapshot') {
      const snapshot = worldContextSnapshotSchema.safeParse(artifact.content);
      if (!snapshot.success) {
        reasons.push(
          `Retrieved context ${ref.id} has an invalid snapshot schema.`,
        );
        return;
      }
      const snapshotScope = { ...requester.identity, mode: requester.mode };
      const currentRecord = this.world.record(
        snapshotScope,
        snapshot.data.record.id,
      );
      if (
        !currentRecord ||
        currentRecord.ref.revision !== snapshot.data.record.revision ||
        currentRecord.ref.sha256 !== snapshot.data.record.sha256 ||
        this.world.activeHolds(snapshotScope, snapshot.data.record.id).length >
          0
      ) {
        reasons.push(
          `Retrieved context ${ref.id} has a revised or held World Model record.`,
        );
        return;
      }
      const directDependencies = new Set(
        artifact.dependencies.map(
          (dependency) =>
            `${dependency.id}:${dependency.version}:${dependency.sha256}`,
        ),
      );
      if (
        snapshot.data.support_artifacts.some(
          (support) =>
            !directDependencies.has(
              `${support.id}:${support.version}:${support.sha256}`,
            ),
        )
      ) {
        reasons.push(
          `Retrieved context ${ref.id} has an incomplete support closure.`,
        );
        return;
      }
      for (const prior of snapshot.data.acceptances.filter(
        (acceptance) => acceptance.status === 'accepted',
      )) {
        const current = this.world.currentAcceptance(
          { ...requester.identity, mode: requester.mode },
          prior.id,
          {
            policyHash: this.worldAcceptancePolicy.sha256,
            supportIsCurrent: (acceptance) =>
              this.worldSupportIsCurrent(
                requester.identity,
                requester.mode,
                acceptance,
              ),
          },
        );
        if (current?.status !== 'accepted')
          reasons.push(
            `Retrieved acceptance ${prior.id} is no longer current.`,
          );
      }
    }
    visiting.add(key);
    collected.set(key, artifact);
    for (const dependency of artifact.dependencies)
      this.collectWorldEvidenceClosure(
        dependency,
        requester,
        collected,
        reasons,
        visiting,
      );
    visiting.delete(key);
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
            this.nightshift.onTaskControl(taskId, 'correction');
            for (const ref of update.context_refs ?? []) {
              this.artifact(ref.id, identity, ref);
              this.nightshift.assertOrdinaryInput(ref);
            }
            const assignments = this.allAssignments(run.id),
              affected = new Set(
                (update.affected_assignment_ids?.length
                  ? update.affected_assignment_ids
                  : undefined) ??
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
            const worldScope = { ...task.identity, mode: task.mode };
            const changedSupport = assignments
              .filter((assignment) => affected.has(assignment.id))
              .flatMap((assignment) => assignment.outputs);
            if (!update.affected_assignment_ids?.length && task.result)
              changedSupport.push(
                ...task.result.work_products,
                ...task.result.sources.map((source) => source.artifact),
                ...(task.result.review.artifact
                  ? [task.result.review.artifact]
                  : []),
              );
            for (const ref of new Map(
              changedSupport.map((ref) => [
                `${ref.id}:${ref.version}:${ref.sha256}`,
                ref,
              ]),
            ).values())
              this.world.holdForSupportArtifact(
                worldScope,
                ref.id,
                'A correction changed the supporting assignment branch.',
                'correction',
                { kind: 'user', id: identity.principal },
              );
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
                  this.artifactMetadata(ref.id, identity, ref);
                  return ![...this.artifactAssignments([ref])].some((id) =>
                    affected.has(id),
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
            if (
              this.nightshift.chainForRun(run.id, identity)?.status ===
              'invalidated'
            ) {
              run.status = 'paused';
              for (const assignment of this.allAssignments(run.id))
                if (!terminal(assignment.status)) {
                  assignment.status = 'paused';
                  delete assignment.lease_token;
                  this.putAssignment(assignment);
                }
            }
            this.putCore(task);
            this.putRun(run);
            this.externalWaits.onAuthorityChange(taskId, 'correction', false);
            if (['queued', 'running'].includes(run.status))
              this.externalWaits.acquire(
                {
                  task_id: taskId,
                  run_id: run.id,
                  generation: run.generation,
                  objective_revision: task.objective_revision,
                },
                'objective correction',
              );
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
  private staleLinkedSources(taskId: string, identity: TaskIdentity) {
    for (const row of this.db
      .prepare(
        'SELECT artifact_id,objective_revision,body FROM applicability WHERE task_id=?',
      )
      .all(taskId) as (Row & {
      artifact_id: string;
      objective_revision: number;
    })[]) {
      const value = decode<ArtifactApplicability>(row.body);
      value.current = false;
      value.reason =
        'Historical artifact requires fresh applicability and support checks in the linked successor.';
      this.db
        .prepare(
          'UPDATE applicability SET body=? WHERE task_id=? AND artifact_id=? AND objective_revision=?',
        )
        .run(
          JSON.stringify(value),
          taskId,
          row.artifact_id,
          row.objective_revision,
        );
    }
    for (const ref of this.core(taskId, identity).original_request.context_refs)
      this.recordApplicability(
        taskId,
        identity,
        ref,
        false,
        'Source permission and hash revalidated; the new Manager must inspect applicability for this continuation.',
        'Runtime',
      );
  }
  control(
    taskId: string,
    identity: TaskIdentity,
    key: string,
    control: TaskControl,
    routeSnapshot?: ModelRouteSnapshot,
    serviceActor?: { kind: 'service'; id: string },
  ): ControlReceipt {
    return this.atomic(
      () =>
        this.operation(
          identity,
          serviceActor
            ? `SERVICE ${serviceActor.id} /api/tasks/${taskId}/control`
            : `POST /api/tasks/${taskId}/control`,
          key,
          control,
          () => {
            const task = this.core(taskId, identity);
            let run = this.run(task.current_run_id);
            this.expect(task, run, control);
            if (control.action === 'continue') {
              const result = this.linkedRuns.admit({
                task_id: taskId,
                identity,
                predecessor_run_id: run.id,
                objective_revision: task.objective_revision,
                actor: { kind: 'user', id: identity.principal },
                mode: 'manual',
                trigger_cursor: this.events(taskId, identity, 0).next_cursor,
                delivery_ids: [],
                reason: control.reason ?? 'Explicit user Continue.',
                ...(routeSnapshot ? { routeSnapshot } : {}),
              });
              if ('waiting' in result)
                return fail('active_task_limit', result.reason, 429);
              Object.assign(task, this.core(taskId, identity));
              run = this.run(result.run_id);
            } else if (control.action === 'resume') {
              this.nightshift.assertResumeAuthority(run.id);
              this.assertGraphExecution(run.id);
              if (!this.modelRoutes.snapshot(run.id))
                fail(
                  'model_route_upgrade_required',
                  'This run predates immutable model routes. Explicitly Continue to admit a linked run with a new route snapshot.',
                );
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
              if (control.action === 'revoke') {
                this.world.holdForTaskGrant(
                  { ...task.identity, mode: task.mode },
                  task.id,
                  control.revoked_tools ?? task.permissions.tools,
                  'A required tool grant was revoked.',
                  { kind: 'user', id: task.identity.principal },
                );
                task.permissions.tools = task.permissions.tools.filter(
                  (tool) =>
                    !(control.revoked_tools ?? task.permissions.tools).includes(
                      tool,
                    ),
                );
              }
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
            this.nightshift.onTaskControl(taskId, control.action);
            this.putCore(task);
            this.putRun(run);
            const authority = {
              task_id: taskId,
              run_id: run.id,
              generation: run.generation,
              objective_revision: task.objective_revision,
            };
            if (control.action === 'resume' || control.action === 'continue') {
              this.externalWaits.acquire(authority, control.action);
              if (control.action === 'resume')
                this.externalWaits.rebind(authority, 'resume');
            } else this.externalWaits.onAuthorityChange(taskId, control.action);
            if (control.action !== 'continue')
              this.appendEvent(
                taskId,
                `control_${control.action}`,
                serviceActor ? 'Runtime' : 'User',
                control.reason ??
                  `Requested ${control.action}; local work fenced. Remote termination unconfirmed.`,
                serviceActor
                  ? { actor_kind: 'service', actor_id: serviceActor.id }
                  : undefined,
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
        const topology = this.executionVersion(run.id);
        if (
          topology?.engine === 'langgraph' &&
          (topology.manager_topology !== MANAGER_TOPOLOGY ||
            topology.specialist_topology !== SPECIALIST_TOPOLOGY)
        ) {
          const state = this.managerState(task.id, task.identity);
          if (state) {
            state.upgrade_required =
              'This run uses an earlier graph topology. Explicit Continue creates a linked run; historical checkpoints, charges and unknown operations remain retained.';
            this.putManager(state);
          }
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
        const requiresRouteUpgrade = !this.modelRoutes.snapshot(run.id);
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
        if (requiresRouteUpgrade && manager) {
          manager.upgrade_required =
            'This unfinished run predates immutable model routes. Explicitly Continue to admit a linked run with a new route snapshot; historical operations retain unknown requested routes.';
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
        if (
          started ||
          requiresUpgrade ||
          requiresRouteUpgrade ||
          manager?.upgrade_required
        )
          run.status = 'paused';
        else if (run.status === 'running') run.status = 'queued';
        for (const assignment of this.allAssignments(run.id)) {
          assignment.generation = run.generation;
          if (assignment.status === 'running') {
            assignment.status =
              started || requiresUpgrade || requiresRouteUpgrade
                ? 'paused'
                : 'queued';
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
        if (run.status !== 'paused')
          this.externalWaits.rebind(
            {
              task_id: task.id,
              run_id: run.id,
              generation: run.generation,
              objective_revision: task.objective_revision,
            },
            'recovery',
            true,
          );
        this.appendEvent(
          task.id,
          requiresRouteUpgrade
            ? 'model_route_upgrade_required'
            : requiresUpgrade
              ? 'manager_upgrade_required'
              : 'restart_recovered',
          'Runtime',
          requiresUpgrade || requiresRouteUpgrade
            ? manager!.upgrade_required!
            : started
              ? 'Interrupted outcome unknown and charged; explicit resume admits replacement.'
              : 'New lease generation acquired; accepted output and remaining budget preserved.',
        );
      }
      this.graph.recover();
      this.externalWaits.recover();
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
        (previous.messages >= PEER_MAX_MESSAGES ||
          previous.bytes >= PEER_MAX_BYTES ||
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
            Date.now() + PEER_CHANNEL_TTL_MS,
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
        channel.messages >= PEER_MAX_MESSAGES ||
        channel.bytes + bytes > PEER_MAX_BYTES
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
      if (
        channel.messages >= PEER_MAX_MESSAGES ||
        channel.bytes >= PEER_MAX_BYTES
      )
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
  /** A targeted inbox delivery may reactivate its own run only after admission. */
  wakeExternalTask(authority: GraphAuthority): TaskRecord {
    return this.atomic(() => {
      const task = this.core(authority.task_id),
        run = this.run(task.current_run_id);
      this.externalWaits.assertPermit(authority);
      if (
        run.id !== authority.run_id ||
        run.generation !== authority.generation ||
        task.objective_revision !== authority.objective_revision
      )
        fail('stale_execution', 'External delivery target has been fenced.');
      const wait = this.graph.wait(graphThreadId('assignment', authority));
      if (
        !wait ||
        wait.status !== 'ready' ||
        !wait.event_types?.includes('external_result_ready')
      )
        fail(
          'external_delivery_not_ready',
          'External delivery requires an exact ready assignment wait.',
        );
      if (Date.parse(run.limits.deadline) <= Date.now())
        fail(
          'deadline_expired',
          'Original run deadline expired; explicitly Continue.',
          422,
        );
      if (
        this.read(task.id, task.identity).questions.some(
          (q) => q.run_id === run.id && q.status === 'open',
        )
      )
        fail(
          'question_unanswered',
          'An external delivery cannot bypass a human wait.',
        );
      if (run.status === 'waiting') {
        run.status = 'queued';
        this.putRun(run);
      } else if (!['queued', 'running'].includes(run.status))
        fail('execution_fenced', 'The target run is stopped.');
      return this.read(task.id, task.identity);
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
