import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { z } from 'zod';

const executionMetadataSchema = z.object({
  runId: z.string().min(1),
  artifactIds: z.array(z.string().min(1)),
  schemaVersion: z.literal(1),
});

export type ExecutionMetadata = z.infer<typeof executionMetadataSchema>;

const executionState = Annotation.Root({
  runId: Annotation<string>(),
  artifactIds: Annotation<string[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  schemaVersion: Annotation<1>({
    reducer: (_previous, next) => next,
    default: () => 1,
  }),
});

export interface CheckpointGraphOptions {
  interruptBefore?: 'checkpoint'[];
}

/** Infrastructure probe for local checkpointing; domain roles are implemented separately. */
export function createCheckpointGraph(
  checkpointer: BaseCheckpointSaver,
  options: CheckpointGraphOptions = {},
) {
  return new StateGraph(executionState)
    .addNode('checkpoint', (state) => executionMetadataSchema.parse(state))
    .addEdge(START, 'checkpoint')
    .addEdge('checkpoint', END)
    .compile({ checkpointer, ...options });
}
