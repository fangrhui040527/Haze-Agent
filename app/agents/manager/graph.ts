import {
  Annotation,
  END,
  START,
  StateGraph,
  interrupt,
} from '@langchain/langgraph';
import type {
  ManagerGraphFactory,
  ManagerGraphState,
} from '../../orchestration/manager-workflow.js';
import type { AgentModelCompletion } from '../../adapters/agent-model.js';
import type {
  ManagerContext,
  ManagerDecision,
} from '../../contracts/manager.js';

const state = Annotation.Root({
  cycle: Annotation<number>({
    reducer: (_old, value) => value,
    default: () => 0,
  }),
  cursor: Annotation<number>(),
  context: Annotation<ManagerContext>(),
  response: Annotation<AgentModelCompletion | null>(),
  decision: Annotation<ManagerDecision>(),
  original: Annotation<ManagerDecision | null>(),
  lookup: Annotation<unknown>(),
  forceDecision: Annotation<boolean>({
    default: () => false,
    reducer: (_old, value) => value,
  }),
  route: Annotation<'decide' | 'wait' | 'done'>(),
});
type Update = Partial<ManagerGraphState> | void;

/** Scheduling is explicit graph control flow; assignments run on independent threads. */
export const createManagerGraph: ManagerGraphFactory = (
  checkpointer,
  hooks,
) => {
  const node =
    (name: string, fn: (s: ManagerGraphState) => Update | Promise<Update>) =>
    async (s: ManagerGraphState) => {
      hooks.trace?.(name);
      return (await fn(s)) ?? {};
    };
  return (
    new StateGraph(state)
      .setNodeDefaults({ retryPolicy: { maxAttempts: 1 } })
      .addNode('hydrate_authority', node('hydrate_authority', hooks.hydrate))
      .addNode('assemble_context', node('assemble_context', hooks.context))
      .addNode('model_decision', node('model_decision', hooks.decide))
      .addNode('validate_decision', node('validate_decision', hooks.validate))
      .addNode('lookup_action', node('lookup_action', hooks.lookup))
      .addNode('execute_action', node('execute_action', hooks.execute))
      .addNode(
        'dispatch_assignments',
        node('dispatch_assignments', hooks.dispatch),
      )
      .addNode('persist_wait', node('persist_wait', hooks.park))
      // No database writes, network calls, or traces before interrupt: this node replays.
      .addNode('wait', (s) => {
        interrupt({ cursor: s.cursor, kind: 'manager' });
        return {};
      })
      .addNode(
        'finalize',
        node('finalize', (s) => (s.route === 'done' ? {} : hooks.execute(s))),
      )
      .addEdge(START, 'hydrate_authority')
      .addConditionalEdges('hydrate_authority', (s) =>
        s.route === 'done' ? 'finalize' : 'dispatch_assignments',
      )
      .addConditionalEdges('dispatch_assignments', (s) =>
        s.route === 'decide'
          ? 'assemble_context'
          : s.route === 'wait'
            ? 'persist_wait'
            : 'finalize',
      )
      .addEdge('assemble_context', 'model_decision')
      .addEdge('model_decision', 'validate_decision')
      .addEdge('validate_decision', 'lookup_action')
      .addConditionalEdges('lookup_action', (s) =>
        s.decision.action.type === 'finalize' ? 'finalize' : 'execute_action',
      )
      .addEdge('execute_action', 'dispatch_assignments')
      .addEdge('persist_wait', 'wait')
      .addEdge('wait', 'hydrate_authority')
      .addEdge('finalize', END)
      .compile({ checkpointer })
  );
};
