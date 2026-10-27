import { randomUUID } from 'node:crypto';
import { MemorySaver } from '@langchain/langgraph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagerGraph } from '../../app/agents/manager/graph.js';
import type { ManagerGraphHooks } from '../../app/orchestration/manager-workflow.js';

afterEach(() => vi.restoreAllMocks());

function hooks(hydrate: ManagerGraphHooks['hydrate']): ManagerGraphHooks {
  return {
    hydrate,
    context: () => ({}),
    decide: () => Promise.resolve({}),
    validate: () => ({}),
    lookup: () => Promise.resolve({}),
    execute: () => ({}),
    dispatch: () => ({}),
    park: () => ({}),
  };
}

describe('Manager graph execution timing', () => {
  it('records elapsed node execution after async work with the original start trace', async () => {
    let time = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    const trace = vi.fn();
    const traceCompleted = vi.fn();
    const graph = createManagerGraph(new MemorySaver(), {
      ...hooks(async () => {
        expect(trace).toHaveBeenCalledWith('hydrate_authority');
        expect(traceCompleted).not.toHaveBeenCalled();
        await Promise.resolve();
        time += 42.5;
        return { route: 'done' };
      }),
      trace,
      traceCompleted,
    });

    await graph.invoke(
      { cycle: 0 },
      { configurable: { thread_id: randomUUID() }, durability: 'sync' },
    );

    expect(traceCompleted).toHaveBeenCalledWith('hydrate_authority', {
      duration_ms: 42.5,
      outcome: 'ok',
    });
    expect(traceCompleted).toHaveBeenCalledWith('finalize', {
      duration_ms: 0,
      outcome: 'ok',
    });
  });

  it.each([false, true])(
    'preserves execution errors when completion tracing fails: %s',
    async (traceFails) => {
      let time = 100;
      vi.spyOn(performance, 'now').mockImplementation(() => time);
      const traceCompleted = vi.fn(() => {
        if (traceFails) throw new Error('Receipt persistence failed.');
      });
      const failure = new Error('Authority could not be hydrated.');
      const graph = createManagerGraph(new MemorySaver(), {
        ...hooks(async () => {
          await Promise.resolve();
          time += 18;
          throw failure;
        }),
        traceCompleted,
      });

      await expect(
        graph.invoke(
          { cycle: 0 },
          { configurable: { thread_id: randomUUID() }, durability: 'sync' },
        ),
      ).rejects.toThrow(failure);
      expect(traceCompleted).toHaveBeenCalledExactlyOnceWith(
        'hydrate_authority',
        { duration_ms: 18, outcome: 'error' },
      );
    },
  );
});
