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
import { artifactRefSchema } from '../contracts/artifacts.js';
import { toolPreviewSchema } from '../contracts/tool-preview.js';
import { TaskError } from '../contracts/tasks.js';
import { VersionedCheckpointer } from '../graph.js';
import { graphThreadId, SPECIALIST_TOPOLOGY } from '../tasks/graph-ledger.js';
import type { ExternalWaitAction } from '../contracts/external-waits.js';
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
import { createSpecialistActionContract } from './action-contract.js';

export const SPECIALIST_TOPOLOGY_VERSION = SPECIALIST_TOPOLOGY;

/**
 * How many malformed responses a specialist may correct before the assignment
 * fails. This is self-correction against a strict schema, not a provider retry:
 * the rejected action is never dispatched and its charged attempt is retained.
 */
const MAX_CORRECTIONS = 2;

/**
 * Retained evidence stays out of the model context. A specialist needs to
 * know that a method returned and what it concluded, not the rows it
 * returned: tools read pinned artifacts server-side, and evidence is
 * persisted by reference. Short scalar and string fields survive so a
 * reviewer can still read a verdict and its stated limitations.
 */
export function digest(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return { items: value.length };
  const summary: Record<string, unknown> = {};
  for (const [field, item] of Object.entries(value)) {
    if (field === 'model_preview') {
      const preview = toolPreviewSchema.safeParse(item);
      if (preview.success) summary[field] = preview.data;
      continue;
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'number')
      summary[field] = item;
    else if (typeof item === 'string')
      summary[field] = item.length <= 200 ? item : { characters: item.length };
    else if (Array.isArray(item)) {
      const text = item.filter((entry) => typeof entry === 'string');
      summary[field] =
        text.length === item.length &&
        text.reduce((total, entry) => total + entry.length, 0) <= 1_200
          ? item
          : { items: item.length };
    } else summary[field] = { fields: Object.keys(item as object).length };
  }
  return summary;
}

/**
 * A retrieval method states where its bytes came from. Fixture output stays
 * labelled as a fixture; anything else a method retrieved is external. Absent
 * provenance is left absent rather than guessed, and it is never read from the
 * model: a live external selection must not be filed as derived work simply
 * because an agent chose to persist it.
 */
function originOf(
  result: unknown,
): 'external_source' | 'synthetic_fixture' | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const declared = (result as { evidence_origin?: unknown }).evidence_origin;
  if (declared === 'synthetic_fixture') return 'synthetic_fixture';
  return typeof declared === 'string' ? 'external_source' : undefined;
}

/**
 * Validator codes are precise but not actionable. A specialist corrects a
 * malformed action far more reliably when told what to do differently than
 * when handed the parser's own vocabulary.
 */
function remedyFor(reason: string): string {
  if (reason.includes('duplicate_json_key'))
    return 'The response repeated an object key. Write every key exactly once, and send only one action.';
  if (reason.includes('unexpected_json_suffix'))
    return 'The response carried text after the JSON object. Send the object alone, with no prose and no code fences.';
  if (reason.includes('No matching discriminator') || reason.includes('type'))
    return 'Choose a type listed in context.action_contract.allowed_actions and return exactly the keys in its supplied schema. Use no ungranted action or finish-only keys in another variant.';
  if (reason.includes('unrecognized_keys') || reason.includes('Unrecognized'))
    return 'The response carried keys the chosen variant does not define. Include only that variant’s keys.';
  if (reason.includes('Invalid option') || reason.includes('invalid_value'))
    return 'A field used a value outside its allowed set. Re-read the allowed values and choose one of them.';
  return 'Re-read the action variants and return exactly one well-formed action.';
}

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
  /** Persist exact external dependencies and release the lease before interrupt. */
  parkExternal?(
    action: ExternalWaitAction,
    cursor: string,
    operationKey: string,
  ): void;
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
  corrections: Annotation<number>({
    default: () => 0,
    reducer: (_old, next) => next,
  }),
  /** Set when the last response was refused, routing one more model turn. */
  correction: Annotation<{ reason: string; remedy: string } | null>({
    default: () => null,
    reducer: (_old, next) => next,
  }),
  /**
   * Exact tool output by dispatched tool-action id. Kept out of the model
   * context and out of history, so save_tool_result can persist the bytes a
   * method actually returned rather than anything the model retyped.
   */
  retained: Annotation<Record<string, unknown>>({
    default: () => ({}),
    reducer: (old, next) => ({ ...old, ...next }),
  }),
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
    reject: (response, reason) => next('reject').reject(response, reason),
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
      const inbox = services.inbox();
      return {
        waitCursor: hooks.cursor?.() ?? String(state.turn),
        modelContext: {
          purpose: 'specialist',
          brief: services.brief,
          definition: services.instructions,
          // The pinned assignment input carries the admitted scope. A
          // deterministic executor reads it directly; a model-driven
          // specialist is blind to its own place and period without it.
          input: services.input,
          // References only. A tool reads the pinned content server-side, so
          // whole captures never enter the prompt: that is both the point of
          // save_tool_result and what keeps the input inside its byte budget.
          inputs: services.context.inputs.map((artifact) => ({
            id: artifact.id,
            version: artifact.version,
            sha256: artifact.sha256,
            kind: artifact.kind,
          })),
          // Named peer instances: a message recipient is an assignment id,
          // never an agent role, so the context must disclose them.
          peers: services.context.peers,
          message_peers: services.messagePeers ?? services.context.peers,
          inbox,
          shared_refs: inbox.flatMap((message) => {
            try {
              const content = parseContractJson(message.text) as {
                artifact?: unknown;
              };
              const ref = artifactRefSchema.safeParse(content?.artifact);
              return ref.success ? [ref.data] : [];
            } catch {
              return [];
            }
          }),
          outputs: services.context.outputs,
          owned_outputs: services.context.outputs,
          history: state.history,
          tools: services.toolCards,
          artifact_kinds: services.artifactKinds ?? [],
          acknowledged_jobs: services.acknowledgedJobs?.() ?? [],
          escalation_available: typeof services.escalate === 'function',
          peer_wait_available: services.peerWaitAvailable ?? false,
          tool_results: (state.history ?? []).flatMap((entry) => {
            if (
              typeof entry !== 'object' ||
              entry === null ||
              !('action' in entry)
            )
              return [];
            const action = entry.action as AgentAction;
            if (action?.type !== 'tool' || !(action.id in state.retained))
              return [];
            const card = services.toolCards.find(
              (card) =>
                typeof card === 'object' &&
                card !== null &&
                'id' in card &&
                card.id === action.tool,
            );
            const kind =
              typeof card === 'object' &&
              card !== null &&
              'output_artifact_kind' in card
                ? card.output_artifact_kind
                : undefined;
            return [
              {
                action_id: action.id,
                tool: action.tool,
                status: 'completed',
                saved: (state.history ?? []).some((entry) => {
                  if (
                    typeof entry !== 'object' ||
                    entry === null ||
                    !('action' in entry)
                  )
                    return false;
                  const savedAction = entry.action as AgentAction;
                  return (
                    savedAction.type === 'save_tool_result' &&
                    savedAction.tool_action_id === action.id
                  );
                }),
                ...(typeof kind === 'string' ? { artifact_kind: kind } : {}),
              },
            ];
          }),
          external_wait_contract: {
            schema_version: 'haze.external.wait.action.v1',
            action: 'external_wait',
            dependencies:
              'One to four unique acknowledged local job handles with explicit required flags, owned by this assignment revision.',
            resolution:
              'Read nightshift.result after delivery. Resolve required jobs explicitly with use_candidate, partial_result, replan or supported_failure. A Nightshift judge never establishes evidence acceptance.',
          },
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
      let action: AgentAction;
      try {
        action = createSpecialistActionContract(
          state.modelContext,
          hooks.schema ?? agentActionSchema,
        ).schema.parse(parseContractJson(state.response.text));
      } catch (error) {
        // A rejected response is never accepted and never dispatched, and its
        // attempt stays charged and recorded. The specialist is told exactly
        // what failed and may correct it within the turns it already holds; a
        // persistently malformed one still fails fast.
        const reason = (error instanceof Error ? error.message : String(error))
          .replaceAll(/\s+/gu, ' ')
          .slice(0, 400);
        // Consume the response either way: an unconsumed one is replayed, so
        // without this the next turn re-parses the same malformed text and
        // every correction is spent on a single model call.
        services.reject(state.response, reason);
        if (state.corrections >= MAX_CORRECTIONS) throw error;
        const correction = { reason, remedy: remedyFor(reason) };
        return {
          correction,
          corrections: state.corrections + 1,
          history: [...(state.history ?? []), { rejected_action: correction }],
          turn: state.turn + 1,
        };
      }
      if (!services.accept(state.response, action))
        throw new TaskError(
          409,
          'duplicate_action',
          'This validated action was already dispatched.',
        );
      return { action, correction: null };
    })
    .addNode('tool', async (state) => {
      const services = enter('tool', state);
      const action = state.action;
      if (action.type !== 'tool') throw new Error('Invalid tool graph route.');
      const output = await services.tool(action.tool, action.input);
      return {
        // The model is told what the method concluded, never handed its rows.
        ...next(state, { action, output: digest(output) }),
        retained: { [action.id]: output },
      };
    })
    .addNode('save_tool_result', (state) => {
      const services = enter('save_tool_result', state);
      const action = state.action;
      if (action.type !== 'save_tool_result')
        throw new Error('Invalid save_tool_result graph route.');
      if (!(action.tool_action_id in state.retained))
        throw new TaskError(
          422,
          'unknown_tool_action',
          'No dispatched tool action produced that result.',
        );
      const result = state.retained[action.tool_action_id];
      // Provenance comes from the method that produced the bytes.
      const origin = originOf(result);
      const { id, version, sha256 } = services.save(
        action.kind,
        result,
        origin ? { evidence_origin: origin } : undefined,
      );
      return next(state, { action, artifact: { id, version, sha256 } });
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
    .addNode('prepare_external_wait', (state) => {
      enter('prepare_external_wait', state);
      const action = state.action;
      if (action.type !== 'external_wait')
        throw new Error('Invalid external wait graph route.');
      if (!hooks.parkExternal)
        throw new TaskError(
          422,
          'external_wait_unavailable',
          'This assignment has no controlled external-wait service.',
        );
      hooks.parkExternal(
        action,
        state.waitCursor,
        `turn:${state.turn}:external-park`,
      );
      return {
        output: waiting(
          'waiting_peer',
          'Waiting for acknowledged external jobs.',
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
      // A refused response routes one more model turn carrying its remedy,
      // rather than failing the assignment on the first malformed action.
      if (state.correction) return 'context';
      const type = state.action.type;
      return type === 'wait'
        ? 'peer_wait'
        : type === 'external_wait'
          ? 'prepare_external_wait'
          : type;
    })
    .addEdge('tool', 'context')
    .addEdge('save', 'context')
    .addEdge('save_tool_result', 'context')
    .addEdge('message', 'context')
    .addEdge('escalate', 'prepare_wait')
    .addEdge('question', 'prepare_wait')
    .addEdge('peer_wait', 'prepare_wait')
    .addEdge('prepare_external_wait', 'wait')
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
