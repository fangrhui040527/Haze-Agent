import type { z } from 'zod';
import type {
  AgentModel,
  AgentModelCompletion,
  AgentModelInput,
} from '../adapters/agent-model.js';
import type { Artifact, ArtifactRef } from '../contracts/artifacts.js';
import type { AgentRole, CapabilityCard } from '../contracts/capabilities.js';
import type { TaskRequest, TaskRecord, TaskEvent } from '../contracts/tasks.js';
import type {
  ManagerDecision,
  ManagerState,
  ArtifactReviewCheck,
} from '../contracts/manager.js';
import type { ManagerContext } from '../contracts/manager.js';
import type { AgentAction } from './contracts.js';

export type ExecutionMode = 'live' | 'fixture' | 'replay';
export interface AssignmentPlan {
  key: string;
  definition_id: string;
  brief: string;
  depends_on: string[];
  input?: unknown;
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
  execute(input: I, context: ToolContext): Promise<O>;
}
export interface AssignmentServices {
  readonly context: ToolContext;
  readonly input: unknown;
  tool(id: string, input: unknown): Promise<unknown>;
  save(
    kind: string,
    content: unknown,
    metadata?: { evidence_origin?: Artifact['evidence_origin'] },
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
  model(context: unknown): Promise<AgentModelCompletion>;
  accept(response: AgentModelCompletion, action: AgentAction): boolean;
}

/** Registration describes implementations. Task grants are checked separately at every boundary. */
export class ExecutionRegistry {
  readonly capabilities = new Map<string, CapabilityDefinition>();
  readonly definitions = new Map<string, AssignmentDefinition>();
  readonly tools = new Map<string, ToolDefinition>();
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
