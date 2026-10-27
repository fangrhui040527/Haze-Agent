import type { z } from 'zod';
import type {
  AgentModel,
  AgentModelCompletion,
  AgentModelInput,
} from '../adapters/agent-model.js';
import type { Artifact, ArtifactRef } from '../contracts/artifacts.js';
import type { AgentRole, CapabilityCard } from '../contracts/capabilities.js';
import type {
  Assignment,
  TaskRequest,
  TaskRecord,
  TaskEvent,
  TaskIdentity,
  TaskResult,
} from '../contracts/tasks.js';
import type {
  ManagerDecision,
  ManagerState,
  ArtifactReviewCheck,
} from '../contracts/manager.js';
import type { ManagerContext } from '../contracts/manager.js';
import type {
  WorldAssessment,
  WorldRecord,
  WorldHold,
  WorldAcceptanceOutcome,
} from '../contracts/world.js';
import type {
  WorldLookupInput,
  WorldContextOutput,
} from '../contracts/world-services.js';
import type { AgentAction } from './contracts.js';
import type { ManagerGraphFactory } from './manager-workflow.js';
import type { TaskStore } from '../tasks/store.js';
import type {
  TaskControl,
  TaskUpdate,
  ControlReceipt,
} from '../contracts/controls.js';
import type {
  NightshiftJobReadiness,
  NightshiftSubmitRequest,
  NightshiftRemoteJob,
  NightshiftRemoteOutcome,
  NightshiftRemoteResult,
} from '../contracts/nightshift.js';

/** External inference only: this port grants no task, effect or evidence authority. */
export interface NightshiftJobPort {
  readiness(signal?: AbortSignal): Promise<NightshiftJobReadiness>;
  submit(
    request: NightshiftSubmitRequest,
    signal?: AbortSignal,
  ): Promise<{ remote_id: string }>;
  inspect(remoteId: string, signal?: AbortSignal): Promise<NightshiftRemoteJob>;
  outcome(
    remoteId: string,
    signal?: AbortSignal,
  ): Promise<NightshiftRemoteOutcome>;
  result(
    remoteId: string,
    signal?: AbortSignal,
  ): Promise<NightshiftRemoteResult>;
  cancel(
    remoteId: string,
    signal?: AbortSignal,
  ): Promise<{ acknowledged: boolean }>;
  verifyReconciliation(
    remoteId: string,
    request: NightshiftSubmitRequest,
    signal?: AbortSignal,
  ): Promise<{ verified: boolean; reason: string | null }>;
}

/** The outcome classification is safe policy input; arbitrary upstream text is not. */
export class NightshiftJobTransportError extends Error {
  constructor(
    readonly outcome: 'rejected-before-acceptance' | 'unknown' | 'read-failed',
    readonly diagnostic_code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Narrow host port for governed, store-backed tools; domain factories stay in composition. */
export interface StatefulToolStore {
  world: {
    lookup(scope: WorldRecord['scope'], input: WorldLookupInput): WorldRecord[];
    activeHolds(scope: WorldRecord['scope'], subjectId: string): WorldHold[];
  };
  read(id: string, identity: TaskIdentity): TaskRecord;
  artifact(id: string, identity: TaskIdentity, ref?: ArtifactRef): Artifact;
  worldLookup(
    taskId: string,
    identity: TaskIdentity,
    mode: ExecutionMode,
    input: WorldLookupInput,
  ): {
    schema_version: 'haze.world.lookup.v1';
    records: WorldRecord[];
    current_acceptances: {
      subject: string;
      acceptance: WorldAcceptanceOutcome;
    }[];
  };
  worldContext(
    taskId: string,
    identity: TaskIdentity,
    mode: ExecutionMode,
    recordId: string,
  ): WorldContextOutput;
  pinWorldContext(
    taskId: string,
    identity: TaskIdentity,
    assignmentId: string,
    generation: number,
    refs: ArtifactRef[],
    statedUse: string,
    recordId: string,
  ): void;
  pinAssignmentInput(
    taskId: string,
    assignmentId: string,
    generation: number,
    ref: ArtifactRef,
  ): void;
  clearWorldContextPins(
    taskId: string,
    identity: TaskIdentity,
    assignmentId: string,
    generation: number,
  ): void;
  saveArtifact(
    taskId: string,
    identity: TaskIdentity,
    options: {
      kind: string;
      content: Artifact['content'];
      producer: Artifact['producer'];
      dependencies?: ArtifactRef[];
      required_tools?: string[];
      generation?: number;
      assignment_revision?: number;
      evidence_origin?: Artifact['evidence_origin'];
    },
  ): Artifact;
}

export type ExecutionMode = 'live' | 'fixture' | 'replay';
export interface TaskMutationContext {
  kind: 'update' | 'control';
  before: TaskRecord;
  input: TaskUpdate | TaskControl;
  key: string;
  identity: TaskIdentity;
}
export interface TaskExtensionHttpRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  body: unknown;
  key?: string;
  identity: TaskIdentity;
}
export interface TaskRuntimeExtensionHost {
  store: TaskStore;
  mode: ExecutionMode;
  atomic<T>(operation: () => T): T;
  afterCommit(callback: () => void): void;
  readTask(id: string, identity: TaskIdentity): TaskRecord;
  readArtifact(ref: ArtifactRef, identity: TaskIdentity): Artifact;
  artifactReviews(
    taskId: string,
    identity: TaskIdentity,
  ): ArtifactReviewCheck[];
  readView(taskId: string, viewId: string, identity: TaskIdentity): unknown;
  runResult(
    taskId: string,
    runId: string,
    identity: TaskIdentity,
    objectiveRevision?: number,
  ): TaskResult | undefined;
  admitTask(
    request: TaskRequest,
    key: string,
    identity: TaskIdentity,
  ): {
    task_id: string;
    status_url: string;
    events_url: string;
    reused: boolean;
  };
  updateTask(
    id: string,
    update: TaskUpdate,
    key: string,
    identity: TaskIdentity,
  ): ControlReceipt;
  controlTask(
    id: string,
    control: TaskControl,
    key: string,
    identity: TaskIdentity,
  ): ControlReceipt;
}
export interface TaskRuntimeExtension {
  id: string;
  service?: unknown;
  tools?: ToolDefinition[];
  taskViews?: Record<
    string,
    (taskId: string, identity: TaskIdentity) => unknown
  >;
  handlesHttp?(pathname: string): boolean;
  handleHttp?(request: TaskExtensionHttpRequest): {
    status: number;
    body: unknown;
  };
  mutateTask?(
    context: TaskMutationContext,
    perform: () => ControlReceipt,
  ): ControlReceipt;
}
export interface AssignmentPlan {
  key: string;
  definition_id: string;
  brief: string;
  depends_on: string[];
  input?: unknown;
}
export interface WorldModelRecordDraft {
  kind: string;
  external_id: string;
  payload: WorldRecord['payload'];
  evidence: ArtifactRef[];
  relationships?: {
    kind: string;
    external_id: string;
    relationship: string;
  }[];
}
export interface WorldModelAcceptanceCandidate {
  subject: WorldRecord['ref'];
  stated_use: string;
  evidence: ArtifactRef[];
}
export interface WorldModelReviewRequirement {
  id: string;
  evidence: ArtifactRef[];
  reviewer_roles: AgentRole[];
}
export interface CapabilityWorldModelAdapter {
  extract(input: {
    request: TaskRequest;
    artifacts: readonly Artifact[];
  }): WorldModelRecordDraft[];
  buildAcceptanceCandidate(input: {
    request: TaskRequest;
    records: readonly WorldRecord[];
    assessments: readonly WorldAssessment[];
    artifacts: readonly Artifact[];
    assignments: readonly Pick<
      Assignment,
      'id' | 'revision' | 'definition_id' | 'role' | 'status' | 'support'
    >[];
  }): WorldModelAcceptanceCandidate | undefined;
  requiredReviewCoverage(input: {
    request: TaskRequest;
    assignments: readonly AssignmentPlan[];
    artifacts: readonly Artifact[];
  }): WorldModelReviewRequirement[];
}
export interface CapabilityDefinition {
  card: CapabilityCard;
  matches(request: TaskRequest): boolean;
  assignments(request: TaskRequest): AssignmentPlan[];
  prerequisites?: { definition_id: string; depends_on_definitions: string[] }[];
  availability?(request: TaskRequest): {
    available: boolean;
    reasons: string[];
  };
  review_requirements?: {
    artifact_kind: string;
    review_definition_id: string;
    producer_definition_ids?: string[];
  }[];
  peer_requirements?: { definitions: [string, string]; purpose: string }[];
  normalizeReview?(artifact: Artifact):
    | {
        verdict: 'supported' | 'rejected' | 'needs_review';
        artifacts: ArtifactRef[];
        limitations: string[];
      }
    | undefined;
  worldModel?: CapabilityWorldModelAdapter;
}
export interface ToolContext {
  taskId: string;
  runId: string;
  assignmentId: string;
  assignmentRevision: number;
  objectiveRevision: number;
  generation: number;
  identity: { principal: string; workspace: string };
  deadline: string;
  signal: AbortSignal;
  inputs: Artifact[];
  peers: { id: string; definition_id: string; revision: number }[];
  outputs: ArtifactRef[];
}
export interface ToolDefinition<I = unknown, O = unknown> {
  id: string;
  version: string;
  description: string;
  mode: ExecutionMode;
  /** Explicit Manager grant; omitted tools are specialist-only. */
  manager_read_only?: boolean;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  /** When declared, a retained result may only be saved as this artifact kind. */
  output_artifact_kind?: string;
  execute(input: I, context: ToolContext): Promise<O>;
}
export interface AssignmentServices {
  readonly context: ToolContext;
  readonly input: unknown;
  tool(id: string, input: unknown): Promise<unknown>;
  save(
    kind: string,
    content: unknown,
    metadata?: {
      evidence_origin?: Artifact['evidence_origin'];
      /** Exact material support; defaults to all pinned inputs. */
      dependencies?: ArtifactRef[];
    },
  ): Artifact;
  question(prompt: string): void;
  message(recipient: string, purpose: string, text: string): void;
  inbox(): { id: string; sender: string; recipient: string; text: string }[];
  read(ref: ArtifactRef): Artifact;
  escalate?(
    reason:
      | 'missing_dependency'
      | 'scope_conflict'
      | 'unavailable_resource'
      | 'peer_request',
    message: string,
  ): void;
}
export interface AssignmentOutput {
  status: 'completed' | 'waiting_human' | 'waiting_peer';
  summary: string;
  support: 'supported' | 'partial' | 'gap';
  uncertainty: string[];
  outputs: ArtifactRef[];
}
export interface AssignmentDefinition {
  id: string;
  version: string;
  capability: string;
  agent: AgentRole;
  tools: string[];
  /** Available only when explicitly granted by the admitted task. */
  optional_tools?: string[];
  instructions: string;
  /** Registered deterministic implementation; never model-supplied executable code. */
  execute?(
    services: AssignmentServices,
  ): AssignmentOutput | Promise<AssignmentOutput>;
}
export interface AgentDefinition {
  id: AgentRole;
  version: string;
  instructions: string;
  schemas?: Partial<
    Record<'plan' | 'synthesis' | 'specialist' | 'decision', z.ZodType>
  >;
  execute?(services: AgentExecutionServices): Promise<AssignmentOutput>;
  /** The registered Manager provides its executable workflow topology. */
  createManagerGraph?: ManagerGraphFactory;
  decide?(services: ManagerServices): Promise<ManagerDecision>;
  assembleContext?(
    task: TaskRecord,
    registry: ExecutionRegistry,
    state: ManagerState,
    options: {
      events: TaskEvent[];
      artifacts: Artifact[];
      maxBytes?: number;
      reviews?: ArtifactReviewCheck[];
    },
  ): ManagerContext;
  fixtureDecision?(context: ManagerContext): ManagerDecision;
}
export interface ManagerServices {
  readonly context: ManagerContext;
  model(context: unknown): Promise<AgentModelCompletion>;
}
export type { ManagerContext } from '../contracts/manager.js';
export type { ManagerDecision, ManagerState } from '../contracts/manager.js';
export interface AgentExecutionServices extends AssignmentServices {
  brief: string;
  instructions: string;
  maxTurns: number;
  history: unknown[];
  toolCards: unknown[];
  /** Only current, owned or explicitly delegated acknowledged local jobs. */
  acknowledgedJobs?(): { job_id: string; remote_acknowledged: true }[];
  artifactKinds?: string[];
  /** Active parallel work may need Manager coordination before a peer grant exists. */
  peerWaitAvailable?: boolean;
  /** Live recipients, separate from descriptive identities used to read prior messages. */
  messagePeers?: ToolContext['peers'];
  model(context: unknown): Promise<AgentModelCompletion>;
  accept(response: AgentModelCompletion, action: AgentAction): boolean;
  /**
   * Record a response that failed validation. Nothing is dispatched, but the
   * response is consumed so the next turn is a fresh completion rather than a
   * replay of the same malformed text.
   */
  reject(response: AgentModelCompletion, reason: string): void;
}

/** One deterministic section of a saved quantitative answer. */
export interface FinalAnswerSection {
  heading: string;
  lines: string[];
}
export interface FinalRendererInput {
  task: TaskRecord;
  /** Selected artifacts of this renderer's registered kinds, in selection order. */
  artifacts: readonly Artifact[];
  /** The validated exact dependency closure of the whole final selection. */
  closure: readonly Artifact[];
  reviews: readonly ArtifactReviewCheck[];
  /** Read-only services. Renderers never call models or mutate state. */
  services: {
    store: StatefulToolStore;
    mode: ExecutionMode;
    read(ref: ArtifactRef): Artifact;
  };
}
export interface FinalRenderer {
  /** Selection is by registered kind and producing capability, never by model prose. */
  artifact_kinds: string[];
  render(input: FinalRendererInput): {
    sections: FinalAnswerSection[];
    limitations: string[];
    /** Explicit outstanding items; they also become result next requirements. */
    gaps: string[];
  };
}

/** Registration describes implementations. Task grants are checked separately at every boundary. */
export class ExecutionRegistry {
  readonly finalRenderers = new Map<string, FinalRenderer>();
  /** Quantitative capabilities own the factual text of their saved answers. */
  registerFinalRenderer(capabilityId: string, renderer: FinalRenderer): this {
    this.unique(this.finalRenderers, capabilityId, renderer);
    return this;
  }
  readonly extensionFactories: ((
    host: TaskRuntimeExtensionHost,
  ) => TaskRuntimeExtension)[] = [];
  registerExtension(
    factory: (host: TaskRuntimeExtensionHost) => TaskRuntimeExtension,
  ): this {
    this.extensionFactories.push(factory);
    return this;
  }
  readonly taskViews = new Map<
    string,
    (
      store: StatefulToolStore,
      mode: ExecutionMode,
      taskId: string,
      identity: TaskIdentity,
    ) => unknown
  >();
  registerTaskView(
    id: string,
    reader: (
      store: StatefulToolStore,
      mode: ExecutionMode,
      taskId: string,
      identity: TaskIdentity,
    ) => unknown,
  ): this {
    this.unique(this.taskViews, id, reader);
    return this;
  }
  readonly storeToolFactories: ((
    store: StatefulToolStore,
    mode: ExecutionMode,
  ) => ToolDefinition[])[] = [];
  registerStoreTools(
    factory: (
      store: StatefulToolStore,
      mode: ExecutionMode,
    ) => ToolDefinition[],
  ): this {
    this.storeToolFactories.push(factory);
    return this;
  }
  readonly capabilities = new Map<string, CapabilityDefinition>();
  readonly definitions = new Map<string, AssignmentDefinition>();
  readonly tools = new Map<string, ToolDefinition>();
  private readonly extensionToolOwners = new Map<string, string>();
  readonly agents = new Map<AgentRole, AgentDefinition>();
  registerCapability(value: CapabilityDefinition): this {
    this.unique(this.capabilities, value.card.id, value);
    return this;
  }
  registerAssignment(value: AssignmentDefinition): this {
    this.unique(this.definitions, value.id, value);
    return this;
  }
  registerTool<I, O>(value: ToolDefinition<I, O>): this {
    this.unique(this.tools, value.id, value);
    return this;
  }
  /** Rebind store-backed tools when the same registry is reused by its owner. */
  registerExtensionTools(
    owner: string,
    tools: readonly ToolDefinition[],
  ): this {
    const selected = new Set<string>();
    for (const tool of tools) {
      if (
        selected.has(tool.id) ||
        (this.tools.has(tool.id) &&
          this.extensionToolOwners.get(tool.id) !== owner)
      )
        throw new Error(`Duplicate registration: ${tool.id}`);
      selected.add(tool.id);
    }
    // Validate the complete replacement before removing or overwriting any
    // existing registrations, so a collision cannot leave a partial tool set.
    for (const [id, registeredOwner] of this.extensionToolOwners)
      if (registeredOwner === owner && !selected.has(id)) {
        this.tools.delete(id);
        this.extensionToolOwners.delete(id);
      }
    for (const tool of tools) {
      this.tools.set(tool.id, tool);
      this.extensionToolOwners.set(tool.id, owner);
    }
    return this;
  }
  registerAgent(value: AgentDefinition): this {
    this.unique(this.agents, value.id, value);
    return this;
  }
  private unique<T>(map: Map<string, T>, id: string, value: T) {
    if (map.has(id)) throw new Error(`Duplicate registration: ${id}`);
    map.set(id, value);
  }
}

/** Deadline and cancellation apply even when an adapter ignores AbortSignal. */
export async function boundedExecution<T>(
  context: Pick<ToolContext, 'deadline' | 'signal'>,
  operation: () => Promise<T>,
): Promise<T> {
  context.signal.throwIfAborted();
  const remaining = Date.parse(context.deadline) - Date.now();
  if (remaining <= 0) throw new Error('deadline_exceeded');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const stop = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('deadline_exceeded')), remaining);
    abort = () => reject(new Error('execution_aborted'));
    context.signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await Promise.race([operation(), stop]);
    context.signal.throwIfAborted();
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) context.signal.removeEventListener('abort', abort);
  }
}
export async function completeModel(
  model: AgentModel,
  input: AgentModelInput,
  context: Pick<ToolContext, 'deadline' | 'signal'>,
): Promise<AgentModelCompletion> {
  return boundedExecution(context, async () =>
    model.completeWithReceipt
      ? model.completeWithReceipt(input, context.signal)
      : {
          text: await model.complete(input, context.signal),
          receipt: {
            response_model: null,
            response_id: null,
            input_tokens: null,
            output_tokens: null,
          },
        },
  );
}
