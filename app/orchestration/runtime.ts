import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { TaskError } from '../contracts/tasks.js';
import type { AssignmentPlan, ExecutionRegistry } from './ports.js';

/** Checkpoints contain references only. The authoritative records are reloaded after every boundary. */
const references = Annotation.Root({
  taskId: Annotation<string>(),
  runId: Annotation<string>(),
  generation: Annotation<number>(),
  objectiveRevision: Annotation<number>(),
  assignmentIds: Annotation<string[]>(),
  actionIds: Annotation<string[]>(),
  artifactIds: Annotation<string[]>(),
});
export function createTaskBoundaryGraph(checkpointer: BaseCheckpointSaver) {
  return new StateGraph(references)
    .addNode('persisted_boundary', (state) => state)
    .addEdge(START, 'persisted_boundary')
    .addEdge('persisted_boundary', END)
    .compile({ checkpointer });
}

export function validateAssignmentPlan(
  plan: AssignmentPlan[],
  registry: ExecutionRegistry,
  authorizedCapabilities: Set<string>,
  authorizedTools: Set<string>,
): void {
  const keys = new Set<string>();
  for (const item of plan) {
    if (keys.has(item.key))
      throw new TaskError(
        422,
        'duplicate_assignment_key',
        'Assignment keys must be unique.',
      );
    keys.add(item.key);
    const definition = registry.definitions.get(item.definition_id);
    if (
      !definition ||
      !authorizedCapabilities.has(definition.capability) ||
      !registry.agents.has(definition.agent)
    )
      throw new TaskError(
        403,
        'definition_denied',
        'Assignment definition or capability is not registered and authorized.',
      );
    for (const tool of definition.tools)
      if (!registry.tools.has(tool) || !authorizedTools.has(tool))
        throw new TaskError(
          403,
          'tool_denied',
          'Assignment requests an unregistered or revoked tool.',
        );
  }
  const visiting = new Set<string>(),
    visited = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key))
      throw new TaskError(
        422,
        'dependency_cycle',
        'Assignment dependencies must form a DAG.',
      );
    if (visited.has(key)) return;
    const assignment = plan.find((item) => item.key === key);
    if (!assignment)
      throw new TaskError(
        422,
        'missing_prerequisite',
        'An assignment dependency does not exist.',
      );
    visiting.add(key);
    for (const dependency of assignment.depends_on) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  }
  for (const key of keys) visit(key);
}
