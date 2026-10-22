import { randomUUID } from 'node:crypto';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { describe, expect, it } from 'vitest';
import {
  createCheckpointGraph,
  type ExecutionMetadata,
} from '../../app/graph.js';
import {
  CHECKPOINT_GRAPH_VERSION,
  EXECUTION_SCHEMA_VERSION,
} from '../../app/versions.js';

const connectionString = process.env['HAZE_TEST_POSTGRES_URL'];
if (!connectionString) {
  throw new Error(
    'HAZE_TEST_POSTGRES_URL is required for the PostgreSQL test project.',
  );
}

describe('PostgreSQL checkpoints', () => {
  it('persists and resumes work after reconnecting, with isolated threads', async () => {
    const threadId = `haze-test-${randomUUID()}`;
    const otherThreadId = `haze-test-${randomUUID()}`;
    const config = { configurable: { thread_id: threadId } };
    const otherConfig = { configurable: { thread_id: otherThreadId } };
    const metadata = {
      runId: 'run-a',
      artifactIds: ['artifact-a'],
      graphVersion: CHECKPOINT_GRAPH_VERSION,
      schemaVersion: EXECUTION_SCHEMA_VERSION,
    } satisfies ExecutionMetadata;
    let saver = PostgresSaver.fromConnString(connectionString);
    let initialized = false;

    try {
      await saver.setup();
      initialized = true;
      const graph = createCheckpointGraph(saver, {
        interruptBefore: ['checkpoint'],
      });
      await graph.invoke(metadata, config);
      expect((await graph.getState(config)).next).toEqual(['checkpoint']);
      await saver.end();

      saver = PostgresSaver.fromConnString(connectionString);
      const restartedGraph = createCheckpointGraph(saver, {
        interruptBefore: ['checkpoint'],
      });
      expect((await restartedGraph.getState(config)).values).toEqual(metadata);
      expect(await restartedGraph.invoke(null, config)).toEqual(metadata);
      expect((await restartedGraph.getState(config)).next).toEqual([]);

      const otherGraph = createCheckpointGraph(saver);
      await otherGraph.invoke({ runId: 'run-b' }, otherConfig);
      expect((await otherGraph.getState(otherConfig)).values).toEqual({
        runId: 'run-b',
        artifactIds: [],
        graphVersion: CHECKPOINT_GRAPH_VERSION,
        schemaVersion: EXECUTION_SCHEMA_VERSION,
      });
      expect((await restartedGraph.getState(config)).values).toEqual(metadata);
    } finally {
      try {
        if (initialized) {
          await saver.deleteThread(threadId);
          await saver.deleteThread(otherThreadId);
        }
      } finally {
        await saver.end();
      }
    }
  });
});
