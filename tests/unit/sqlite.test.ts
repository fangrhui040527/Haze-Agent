import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openSqliteCheckpointer } from '../../src/checkpoints/sqlite.js';
import {
  createCheckpointGraph,
  type ExecutionMetadata,
} from '../../src/graph.js';

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
      schemaVersion: 1,
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
});
