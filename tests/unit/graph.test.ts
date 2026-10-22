import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { createCheckpointGraph } from '../../app/graph.js';
import {
  CHECKPOINT_GRAPH_VERSION,
  EXECUTION_SCHEMA_VERSION,
} from '../../app/versions.js';

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
      graphVersion: CHECKPOINT_GRAPH_VERSION,
      schemaVersion: EXECUTION_SCHEMA_VERSION,
    });
    await graph.invoke({ runId: 'run-b' }, second);
    await graph.invoke({ artifactIds: ['artifact-a2'] }, first);

    expect((await graph.getState(first)).values).toEqual({
      runId: 'run-a',
      artifactIds: ['artifact-a2'],
      graphVersion: CHECKPOINT_GRAPH_VERSION,
      schemaVersion: EXECUTION_SCHEMA_VERSION,
    });
    expect((await graph.getState(second)).values).toEqual({
      runId: 'run-b',
      artifactIds: [],
      graphVersion: CHECKPOINT_GRAPH_VERSION,
      schemaVersion: EXECUTION_SCHEMA_VERSION,
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

  it.each([
    { graphVersion: CHECKPOINT_GRAPH_VERSION + 1 },
    { schemaVersion: EXECUTION_SCHEMA_VERSION + 1 },
    { schemaVersion: 1 },
  ])('rejects incompatible workflow metadata %j', async (version) => {
    const graph = createCheckpointGraph(new MemorySaver());

    await expect(
      graph.invoke(
        { runId: 'incompatible-run', ...version },
        { configurable: { thread_id: 'incompatible-run' } },
      ),
    ).rejects.toThrow();
  });

  it('rejects completed legacy checkpoints before returning state or resuming', async () => {
    const checkpointer = new MemorySaver();
    const config = { configurable: { thread_id: 'completed-legacy-run' } };
    const legacyState = Annotation.Root({
      runId: Annotation<string>(),
      artifactIds: Annotation<string[]>({
        reducer: (_previous, next) => next,
        default: () => [],
      }),
      schemaVersion: Annotation<number>({
        reducer: (_previous, next) => next,
        default: () => 1,
      }),
    });
    const legacyGraph = new StateGraph(legacyState)
      .addNode('checkpoint', (state) => state)
      .addEdge(START, 'checkpoint')
      .addEdge('checkpoint', END)
      .compile({ checkpointer });
    await legacyGraph.invoke({ runId: 'legacy-run' }, config);
    expect((await legacyGraph.getState(config)).next).toEqual([]);

    const graph = createCheckpointGraph(checkpointer);
    await expect(graph.getState(config)).rejects.toThrow();
    await expect(graph.invoke(null, config)).rejects.toThrow();
    await expect(
      graph.invoke({ runId: 'new-input' }, config),
    ).rejects.toThrow();
  });
});
