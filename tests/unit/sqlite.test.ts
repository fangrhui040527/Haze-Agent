import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openSqliteCheckpointer } from '../../src/checkpoints/sqlite.js';
import {
  createCheckpointGraph,
  type ExecutionMetadata,
} from '../../src/graph.js';
import {
  CHECKPOINT_GRAPH_VERSION,
  EXECUTION_SCHEMA_VERSION,
} from '../../src/versions.js';

describe('SQLite checkpoints', () => {
  it('reopens persisted state and resumes interrupted work', async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'haze-checkpoints-'),
    );
    const stateDirectory = join(temporaryDirectory, 'state');
    const config = { configurable: { thread_id: 'restarted-run' } };
    const metadata = {
      runId: 'run-a',
      artifactIds: ['artifact-a'],
      graphVersion: CHECKPOINT_GRAPH_VERSION,
      schemaVersion: EXECUTION_SCHEMA_VERSION,
    } satisfies ExecutionMetadata;
    let handle: Awaited<ReturnType<typeof openSqliteCheckpointer>> | undefined;

    try {
      handle = await openSqliteCheckpointer(stateDirectory);
      const graph = createCheckpointGraph(handle.checkpointer, {
        interruptBefore: ['checkpoint'],
      });
      await graph.invoke(metadata, config);
      expect((await graph.getState(config)).next).toEqual(['checkpoint']);
      handle.close();

      handle = await openSqliteCheckpointer(stateDirectory);
      const restartedGraph = createCheckpointGraph(handle.checkpointer, {
        interruptBefore: ['checkpoint'],
      });
      const interruptedState = await restartedGraph.getState(config);
      expect(interruptedState.values).toEqual(metadata);
      expect(interruptedState.next).toEqual(['checkpoint']);

      expect(await restartedGraph.invoke(null, config)).toEqual(metadata);
      expect((await restartedGraph.getState(config)).next).toEqual([]);
      expect(
        (
          await restartedGraph.getState({
            configurable: { thread_id: 'other-run' },
          })
        ).values,
      ).toEqual({});
    } finally {
      handle?.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('requires an explicit state directory', async () => {
    await expect(openSqliteCheckpointer('   ')).rejects.toThrow('STATE_DIR');
  });

  it.each([
    { graphVersion: CHECKPOINT_GRAPH_VERSION + 1 },
    { schemaVersion: 1 },
  ])(
    'rejects incompatible persisted workflow metadata %j after reopening',
    async (version) => {
      const temporaryDirectory = await mkdtemp(
        join(tmpdir(), 'haze-incompatible-checkpoints-'),
      );
      const config = { configurable: { thread_id: 'incompatible-run' } };
      let handle:
        Awaited<ReturnType<typeof openSqliteCheckpointer>> | undefined;

      try {
        handle = await openSqliteCheckpointer(temporaryDirectory);
        const graph = createCheckpointGraph(handle.checkpointer, {
          interruptBefore: ['checkpoint'],
        });
        await graph.invoke({ runId: 'incompatible-run', ...version }, config);
        handle.close();

        handle = await openSqliteCheckpointer(temporaryDirectory);
        const restartedGraph = createCheckpointGraph(handle.checkpointer);
        await expect(restartedGraph.invoke(null, config)).rejects.toThrow();
      } finally {
        handle?.close();
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    },
  );
});
