import {
  Annotation,
  Command,
  END,
  interrupt,
  START,
  StateGraph,
} from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { z } from 'zod';
import type { AgentModelCompletion } from '../adapters/agent-model.js';
import { parseContractJson } from '../contracts/json.js';
import { TaskError } from '../contracts/tasks.js';
import { VersionedCheckpointer } from '../graph.js';
import { graphThreadId } from '../tasks/graph-ledger.js';
import {
  agentActionSchema,
  assignmentOutputSchema,
  type AgentAction,
} from './contracts.js';
import type {
  AgentExecutionServices,
  AssignmentOutput,
  ToolContext,
} from './ports.js';
import { boundedExecution } from './ports.js';

export const SPECIALIST_TOPOLOGY_VERSION = 'specialist.v1';

export type SpecialistGraphIdentity = Pick<
  ToolContext,
  | 'taskId'
  | 'runId'
  | 'generation'
  | 'objectiveRevision'
  | 'assignmentId'
  | 'assignmentRevision'
>;

export interface SpecialistGraphHooks {
  /** Rehydrate and authorize before every node. Bind effects to this stable key. */
  services(operationPrefix: string): AgentExecutionServices;
  schema?: z.ZodType<AgentAction>;
  /** Registered deterministic implementations and compatibility extensions only. */
  execute?(
    services: AgentExecutionServices,
  ): AssignmentOutput | Promise<AssignmentOutput>;
  /** Capture the authoritative event cursor before any action can emit events. */
  cursor?(): string;
  /** Commit the waiting status and release capacity before the pure interrupt node. */
  park(output: AssignmentOutput, cursor: string, operationKey: string): void;
  /** Atomically persist the summary, completion and their receipt. */
  complete(output: AssignmentOutput, operationKey: string): void;
  trace?(node: string): void;
}

const specialistState = Annotation.Root({
  topology: Annotation<string>(),
  identity: Annotation<SpecialistGraphIdentity>(),
  turn: Annotation<number>({ default: () => 0, reducer: (_old, next) => next }),
  turnLimit: Annotation<number | null>({
    default: () => null,
    reducer: (_old, next) => next,
  }),
  history: Annotation<unknown[] | null>({
    default: () => null,
    reducer: (_old, next) => next,
  }),
  modelContext: Annotation<unknown>(),
  response: Annotation<AgentModelCompletion>(),
  action: Annotation<AgentAction>(),
  output: Annotation<AssignmentOutput | null>({
    default: () => null,
    reducer: (_old, next) => next,
  }),
  waitCursor: Annotation<string>(),
});

export type SpecialistGraphState = typeof specialistState.State;

export function specialistThreadId(identity: SpecialistGraphIdentity): string {
  return graphThreadId('assignment', {
    task_id: identity.taskId,
    run_id: identity.runId,
    generation: identity.generation,
    objective_revision: identity.objectiveRevision,
    assignment_id: identity.assignmentId,
    assignment_revision: identity.assignmentRevision,
  });
}

/** Each nested deterministic service call has a stable, independently receipted identity. */
function controlledServices(
  hooks: SpecialistGraphHooks,
  prefix: string,
): AgentExecutionServices {
  const counters = new Map<string, number>();
  const next = (method: string) => {
    const index = counters.get(method) ?? 0;
    counters.set(method, index + 1);
    const services = hooks.services(`${prefix}:${method}:${index}`);
    services.context.signal.throwIfAborted();
    return services;
  };
  return {
    get context() {
      return hooks.services(`${prefix}:context`).context;
    },
    get input() {
      return hooks.services(`${prefix}:context`).input;
    },
    get brief() {
      return hooks.services(`${prefix}:context`).brief;
    },
    get instructions() {
      return hooks.services(`${prefix}:context`).instructions;
    },
    get maxTurns() {
      return hooks.services(`${prefix}:context`).maxTurns;
    },
    get history() {
      return hooks.services(`${prefix}:context`).history;
    },
    get toolCards() {
      return hooks.services(`${prefix}:context`).toolCards;
    },
    model: (context) => next('model').model(context),
    accept: (response, action) => next('accept').accept(response, action),
    tool: (id, input) => next('tool').tool(id, input),
    save: (kind, content, metadata) =>
      next('save').save(kind, content, metadata),
    read: (ref) => next('read').read(ref),
    inbox: () => next('inbox').inbox(),
    message: (recipient, purpose, text) =>
      next('message').message(recipient, purpose, text),
    question: (prompt) => next('question').question(prompt),
    escalate: (reason, message) => {
      const services = next('escalate');
      if (!services.escalate)
        throw new TaskError(
          422,
          'escalation_unavailable',
          'The controlled specialist escalation service is unavailable.',
        );
      services.escalate(reason, message);
    },
  };
}

function waiting(
  status: 'waiting_human' | 'waiting_peer',
  summary: string,
  outputs: AssignmentOutput['outputs'] = [],
  uncertainty: string[] = [],
): AssignmentOutput {
  return { status, summary, support: 'gap', uncertainty, outputs };
}

/**
 * An independently checkpointed assignment workflow. The application ledger owns
 * effects and budgets; checkpoints own routing, model context and logical steps.
 * No node retries a spending operation, even if an adapter ignores cancellation.
 */
export function createSpecialistGraph(
  checkpointer: BaseCheckpointSaver,
  hooks: SpecialistGraphHooks,
) {
  const enter = (node: string, state: SpecialistGraphState) => {
    const services = hooks.services(`turn:${state.turn}:${node}`);
    services.context.signal.throwIfAborted();
    for (const [key, value] of Object.entries(state.identity))
      if (services.context[key as keyof SpecialistGraphIdentity] !== value)
        throw new TaskError(
          409,
          'stale_graph_authority',
          'The specialist checkpoint no longer has current execution authority.',
        );
    hooks.trace?.(node);
    return services;
  };
  const next = (state: SpecialistGraphState, history: unknown) => ({
    history: [...(state.history ?? []), history],
    turn: state.turn + 1,
  });
  return new StateGraph(specialistState)
    .setNodeDefaults({ retryPolicy: { maxAttempts: 1 } })
    .addNode('hydrate', (state) => {
      if (state.topology !== SPECIALIST_TOPOLOGY_VERSION)
        throw new TaskError(
          409,
          'graph_topology_mismatch',
          'The specialist topology requires explicit linked continuation.',
        );
      const services = enter('hydrate', state);
      return {
        history: state.history ?? [...services.history],
        turnLimit: state.turnLimit ?? services.maxTurns,
        output: null,
      };
    })
    .addNode('context', (state) => {
      const services = enter('context', state);
      return {
        waitCursor: hooks.cursor?.() ?? String(state.turn),
        modelContext: {
          purpose: 'specialist',
          brief: services.brief,
          definition: services.instructions,
          inputs: services.context.inputs,
          inbox: services.inbox(),
          outputs: services.context.outputs,
          history: state.history,
          tools: services.toolCards,
        },
      };
    })
    .addNode('model', async (state) => {
      const services = enter('model', state);
      if (state.turn >= (state.turnLimit ?? services.maxTurns))
        throw new TaskError(
          422,
          'local_turn_limit',
          'The specialist exhausted its bounded local turns.',
        );
      return { response: await services.model(state.modelContext) };
    })
    .addNode('validate', (state) => {
      const services = enter('validate', state);
      const action = (hooks.schema ?? agentActionSchema).parse(
        parseContractJson(state.response.text),
      );
      if (!services.accept(state.response, action))
        throw new TaskError(
          409,
          'duplicate_action',
          'This validated action was already dispatched.',
        );
      return { action };
    })
    .addNode('tool', async (state) => {
      const services = enter('tool', state);
      const action = state.action;
      if (action.type !== 'tool') throw new Error('Invalid tool graph route.');
      return next(state, {
        action,
        output: await services.tool(action.tool, action.input),
      });
    })
    .addNode('save', (state) => {
      const services = enter('save', state);
      const action = state.action;
      if (action.type !== 'save') throw new Error('Invalid save graph route.');
      const { id, version, sha256 } = services.save(
        action.kind,
        action.content,
      );
      return next(state, { action, artifact: { id, version, sha256 } });
    })
    .addNode('message', (state) => {
      const services = enter('message', state);
      const action = state.action;
      if (action.type !== 'message')
        throw new Error('Invalid message graph route.');
      services.message(action.recipient, action.purpose, action.text);
      return next(state, action);
    })
    .addNode('escalate', (state) => {
      const services = enter('escalate', state);
      const action = state.action;
      if (action.type !== 'escalate')
        throw new Error('Invalid escalation graph route.');
      if (!services.escalate)
        throw new TaskError(
          422,
          'escalation_unavailable',
          'The controlled specialist escalation service is unavailable.',
        );
      services.escalate(action.reason, action.message);
      return {
        output: waiting(
          'waiting_peer',
          action.message,
          services.context.outputs,
          [action.message],
        ),
      };
    })
    .addNode('question', (state) => {
      const services = enter('question', state);
      const action = state.action;
      if (action.type !== 'question')
        throw new Error('Invalid question graph route.');
      services.question(action.prompt);
      return {
        output: waiting('waiting_human', action.prompt, [], [action.prompt]),
      };
    })
    .addNode('peer_wait', (state) => {
      enter('peer_wait', state);
      return {
        output: waiting(
          'waiting_peer',
          'Waiting for an authorized peer message.',
        ),
      };
    })
    .addNode('finish', (state) => {
      enter('finish', state);
      const action = state.action;
      if (action.type !== 'finish')
        throw new Error('Invalid finish graph route.');
      return {
        output: assignmentOutputSchema.parse({
          status: 'completed',
          summary: action.summary,
          support: action.support,
          uncertainty: action.uncertainty,
          outputs: action.outputs,
        }),
      };
    })
    .addNode('deterministic', async (state) => {
      const services = enter('deterministic', state);
      const output = await boundedExecution(services.context, () =>
        Promise.resolve(
          hooks.execute!(
            controlledServices(hooks, `deterministic:${state.turn}`),
          ),
        ),
      );
      return {
        output: assignmentOutputSchema.parse({
          ...output,
          outputs: output.outputs.map(({ id, version, sha256 }) => ({
            id,
            version,
            sha256,
          })),
        }),
      };
    })
    .addNode('prepare_wait', (state) => {
      enter('prepare_wait', state);
      hooks.park(state.output!, state.waitCursor, `turn:${state.turn}:park`);
      return {};
    })
    .addNode('wait', (state) => {
      // LangGraph replays this node from the beginning on Command({ resume }).
      // Keep it entirely free of application writes, reads and trace callbacks.
      const resumed = interrupt<{ cursor: string }, { cursor: string }>({
        cursor: state.waitCursor,
      });
      if (resumed?.cursor !== state.waitCursor)
        throw new TaskError(
          409,
          'wait_cursor_mismatch',
          'The wakeup does not match the persisted specialist wait cursor.',
        );
      return { turn: state.turn + 1 };
    })
    .addNode('completion', (state) => {
      enter('completion', state);
      hooks.complete(state.output!, `turn:${state.turn}:complete`);
      return {};
    })
    .addEdge(START, 'hydrate')
    .addEdge('hydrate', 'context')
    .addConditionalEdges('context', () =>
      hooks.execute ? 'deterministic' : 'model',
    )
    .addEdge('model', 'validate')
    .addConditionalEdges('validate', (state) => {
      const type = state.action.type;
      return type === 'wait' ? 'peer_wait' : type;
    })
    .addEdge('tool', 'context')
    .addEdge('save', 'context')
    .addEdge('message', 'context')
    .addEdge('escalate', 'prepare_wait')
    .addEdge('question', 'prepare_wait')
    .addEdge('peer_wait', 'prepare_wait')
    .addEdge('finish', 'completion')
    .addConditionalEdges('deterministic', (state) =>
      state.output?.status === 'completed' ? 'completion' : 'prepare_wait',
    )
    .addEdge('prepare_wait', 'wait')
    .addEdge('wait', 'hydrate')
    .addEdge('completion', END)
    .compile({
      checkpointer: new VersionedCheckpointer(checkpointer, (tuple) => {
        const values = tuple.checkpoint.channel_values;
        if (
          'identity' in values &&
          values.topology !== SPECIALIST_TOPOLOGY_VERSION
        )
          throw new TaskError(
            409,
            'graph_topology_mismatch',
            'The specialist checkpoint topology requires explicit linked continuation.',
          );
      }),
    });
}

/** Derive isolation from authoritative identity; never accept a checkpoint namespace. */
export async function invokeSpecialistGraph(
  graph: ReturnType<typeof createSpecialistGraph>,
  identity: SpecialistGraphIdentity,
  options: {
    signal: AbortSignal;
    resumeCursor?: string;
    /** Accepted progress from a fenced generation; never execution authority. */
    initialState?: Partial<
      Pick<SpecialistGraphState, 'turn' | 'history' | 'turnLimit'>
    >;
  },
) {
  // Callers may pass their broader ToolContext. Persist identity fields only;
  // AbortSignals, authority objects and live service inputs are never state.
  const {
    taskId,
    runId,
    generation,
    objectiveRevision,
    assignmentId,
    assignmentRevision,
  } = identity;
  const executionIdentity: SpecialistGraphIdentity = {
    taskId,
    runId,
    generation,
    objectiveRevision,
    assignmentId,
    assignmentRevision,
  };
  const config = {
    configurable: { thread_id: specialistThreadId(executionIdentity) },
    durability: 'sync' as const,
    signal: options.signal,
    recursionLimit: 1000,
  };
  const existing = await graph.getState(config);
  if (
    options.resumeCursor !== undefined &&
    options.resumeCursor !==
      (existing.values as Partial<SpecialistGraphState>).waitCursor
  )
    throw new TaskError(
      409,
      'wait_cursor_mismatch',
      'The wakeup does not match the persisted specialist wait cursor.',
    );
  const input =
    options.resumeCursor !== undefined
      ? new Command<{ cursor: string }, typeof specialistState.Update, never>({
          resume: { cursor: options.resumeCursor },
        })
      : existing.createdAt
        ? null
        : {
            ...options.initialState,
            topology: SPECIALIST_TOPOLOGY_VERSION,
            identity: executionIdentity,
          };
  await graph.invoke(input, config);
  return (await graph.getState(config)).values as SpecialistGraphState;
}
