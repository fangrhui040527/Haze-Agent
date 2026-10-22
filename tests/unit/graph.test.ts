import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { describe, expect, it } from 'vitest';
import { createCheckpointGraph } from '../../src/graph.js';

describe('local StateGraph foundation', () => {
  it('retains execution metadata within its own thread', async () => {
    const graph = createCheckpointGraph(new MemorySaver());
    const first = { configurable: { thread_id: 'first-run' } };
    const second = { configurable: { thread_id: 'second-run' } };

    expect(
      await graph.invoke(
        { runId: 'run-a', artifactIds: ['artifact-a'] },
        first,
      ),
    ).toEqual({
      runId: 'run-a',
      artifactIds: ['artifact-a'],
      schemaVersion: 1,
    });
    await graph.invoke({ runId: 'run-b' }, second);
    await graph.invoke({ artifactIds: ['artifact-a2'] }, first);

    expect((await graph.getState(first)).values).toEqual({
      runId: 'run-a',
      artifactIds: ['artifact-a2'],
      schemaVersion: 1,
    });
    expect((await graph.getState(second)).values).toEqual({
      runId: 'run-b',
      artifactIds: [],
      schemaVersion: 1,
    });
  });

  it('rejects execution metadata without a run identifier', async () => {
    const graph = createCheckpointGraph(new MemorySaver());

    await expect(
      graph.invoke(
        { runId: '' },
        { configurable: { thread_id: 'invalid-run' } },
      ),
    ).rejects.toThrow();
  });
});
