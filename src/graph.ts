import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import {
  BaseCheckpointSaver,
  type CheckpointTuple,
} from '@langchain/langgraph-checkpoint';
import { z } from 'zod';
import {
  CHECKPOINT_GRAPH_VERSION,
  EXECUTION_SCHEMA_VERSION,
} from './versions.js';

const executionMetadataSchema = z.object({
  runId: z.string().min(1),
  artifactIds: z.array(z.string().min(1)),
  graphVersion: z.literal(CHECKPOINT_GRAPH_VERSION),
  schemaVersion: z.literal(EXECUTION_SCHEMA_VERSION),
});

const workflowVersionSchema = executionMetadataSchema.pick({
  graphVersion: true,
  schemaVersion: true,
});

function validateCheckpointVersions(tuple: CheckpointTuple): void {
  const state = tuple.checkpoint.channel_values;
  // The first input checkpoint can contain only __start__, before state exists.
  if ('runId' in state || 'graphVersion' in state || 'schemaVersion' in state) {
    workflowVersionSchema.parse(state);
  }
}

/** Validate persisted revisions even when a completed checkpoint has no node to run. */
class VersionedCheckpointer extends BaseCheckpointSaver {
  constructor(private readonly delegate: BaseCheckpointSaver) {
    super(delegate.serde);
  }

  async getTuple(...args: Parameters<BaseCheckpointSaver['getTuple']>) {
    const tuple = await this.delegate.getTuple(...args);
    if (tuple) validateCheckpointVersions(tuple);
    return tuple;
  }

  async *list(...args: Parameters<BaseCheckpointSaver['list']>) {
    for await (const tuple of this.delegate.list(...args)) {
      validateCheckpointVersions(tuple);
      yield tuple;
    }
  }

  put(...args: Parameters<BaseCheckpointSaver['put']>) {
    return this.delegate.put(...args);
  }

  putWrites(...args: Parameters<BaseCheckpointSaver['putWrites']>) {
    return this.delegate.putWrites(...args);
  }

  deleteThread(...args: Parameters<BaseCheckpointSaver['deleteThread']>) {
    return this.delegate.deleteThread(...args);
  }

  override getNextVersion(
    ...args: Parameters<BaseCheckpointSaver['getNextVersion']>
  ) {
    return this.delegate.getNextVersion(...args);
  }

  override getDeltaChannelHistory(
    ...args: Parameters<BaseCheckpointSaver['getDeltaChannelHistory']>
  ) {
    return this.delegate.getDeltaChannelHistory(...args);
  }
}

export type ExecutionMetadata = z.infer<typeof executionMetadataSchema>;

const executionState = Annotation.Root({
  runId: Annotation<string>(),
  artifactIds: Annotation<string[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  graphVersion: Annotation<number>({
    reducer: (_previous, next) => next,
    default: () => CHECKPOINT_GRAPH_VERSION,
  }),
  schemaVersion: Annotation<number>({
    reducer: (_previous, next) => next,
    default: () => EXECUTION_SCHEMA_VERSION,
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
    .compile({
      checkpointer: new VersionedCheckpointer(checkpointer),
      ...options,
    });
}
