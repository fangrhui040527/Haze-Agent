import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { z } from 'zod';
import type {
  openHazeEngines,
  MemoryRecord,
  Observation,
} from './meterless/index.js';
import { VersionedCheckpointer } from '../graph.js';
import versions from '../workflow_versions.json' with { type: 'json' };
import type {
  ProbeProvider,
  ProviderProbeResult,
} from '../adapters/provider.js';

export const MEMORY_TEXT =
  'Always use scoped engine records as evidence and SQLite only for execution checkpoints.';

export const compatibilityVersions = versions.compatibilityProbe;
const metadataSchema = z.object({
  runId: z.string().regex(/^compat-[a-f0-9-]{36}$/),
  graphId: z.literal(compatibilityVersions.id),
  graphVersion: z.literal(compatibilityVersions.graphVersion),
  schemaVersion: z.literal(compatibilityVersions.schemaVersion),
});

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// Recall updates upstream access metadata; compare the stable record fields only.
function memoryDigest(memory: MemoryRecord): string {
  return digest({
    id: memory.id,
    content: memory.content,
    source: memory.source,
    provenance: memory.provenance,
    tags: memory.tags,
    confidence: memory.confidence,
  });
}

const state = Annotation.Root({
  runId: Annotation<string>(),
  graphId: Annotation<string>(),
  graphVersion: Annotation<number>(),
  schemaVersion: Annotation<number>(),
  memoryId: Annotation<string>(),
  memoryDigest: Annotation<string>(),
  worldEntityId: Annotation<string>(),
  worldObservationId: Annotation<string>(),
  worldProjectionDigest: Annotation<string>(),
  worldEventIds: Annotation<string[]>(),
  providerResult: Annotation<ProviderProbeResult>(),
  completedNodes: Annotation<string[]>({
    reducer: (previous, next) => [...previous, ...next],
    default: () => [],
  }),
  recordsVerified: Annotation<boolean>(),
});

export type CompatibilityState = typeof state.State;
export type ProbeEngines = Awaited<ReturnType<typeof openHazeEngines>>;

export function initialCompatibilityState(runId: string) {
  return metadataSchema.parse({
    runId,
    graphId: compatibilityVersions.id,
    graphVersion: compatibilityVersions.graphVersion,
    schemaVersion: compatibilityVersions.schemaVersion,
  });
}

/** A bounded infrastructure spike, not the four-role Haze domain workflow. */
export function createCompatibilityGraph(
  checkpointer: BaseCheckpointSaver,
  engines: ProbeEngines,
  provider: ProbeProvider,
) {
  return new StateGraph(state)
    .addNode('capture_memory', async (input) => {
      metadataSchema.parse(input);
      const [memory] = await engines.memory.mine(
        'user_correction',
        MEMORY_TEXT,
        {
          chatId: input.runId,
        },
      );
      assert(memory, 'H-MEM must capture the synthetic correction');
      return {
        memoryId: memory.id,
        memoryDigest: memoryDigest(memory),
        completedNodes: ['capture_memory'],
      };
    })
    .addNode('append_observation', async (input) => {
      const observation: Observation = {
        externalId: `observation-${input.runId}`,
        title: 'Synthetic compatibility observation',
        text: 'Infrastructure fixture; not scientific haze evidence.',
        at: '2026-10-22T00:00:00.000Z',
        source: {
          kind: 'synthetic-compatibility-fixture',
          at: '2026-10-22T00:00:00.000Z',
          runId: input.runId,
        },
        entities: [{ type: 'compatibility_probe', name: input.runId }],
      };
      const first = await engines.world.ingest([observation]);
      assert.equal(first.processed, 1);
      const repeated = await engines.world.ingest([observation]);
      assert.equal(repeated.skippedUnchanged, 1);
      assert.equal(repeated.eventsAppended, 0);
      const entityId = engines.world.entityId(
        'compatibility_probe',
        input.runId,
      );
      assert(
        engines.world.entity(entityId),
        'World Model must project the entity',
      );
      return {
        worldEntityId: entityId,
        worldObservationId: observation.externalId,
        worldProjectionDigest: digest(engines.world.projectionCanonical()),
        worldEventIds: engines.world.events().map((event) => event.id),
        completedNodes: ['append_observation'],
      };
    })
    .addNode('probe_provider', async () => {
      let providerResult: ProviderProbeResult;
      try {
        providerResult = await provider.probe();
      } catch {
        providerResult = {
          ...provider.selection,
          status: 'failed',
          kind: 'chat-completion',
          reason:
            'Selected-provider generation failed; no offline fallback was used.',
        };
      }
      return { providerResult, completedNodes: ['probe_provider'] };
    })
    .addNode('recall_after_restart', async (input) => {
      metadataSchema.parse(input);
      const memory = engines.memory
        .query(MEMORY_TEXT, { chatId: input.runId, threshold: 0 })
        .memories.find((hit) => hit.memory.id === input.memoryId)?.memory;
      assert(memory, 'Saved H-MEM ID must be readable from its engine store');
      assert.equal(memoryDigest(memory), input.memoryDigest);
      assert.equal(
        engines.memory
          .history(input.memoryId)
          .filter((entry) => entry.action === 'create').length,
        1,
        'Resume must not repeat memory capture',
      );
      const entity = engines.world.entity(input.worldEntityId);
      assert.equal(entity?.name, input.runId);
      assert.deepEqual(
        engines.world.events().map((event) => event.id),
        input.worldEventIds,
      );
      // Upstream replays canonical events on load; derived mention aggregates
      // are rebuilt by ingest from its persisted observations, with no new input.
      const rebuilt = await engines.world.ingest([]);
      assert.equal(rebuilt.processed, 0);
      assert.equal(rebuilt.eventsAppended, 0);
      assert.equal(
        digest(engines.world.projectionCanonical()),
        input.worldProjectionDigest,
      );
      return {
        recordsVerified: true,
        completedNodes: ['recall_after_restart'],
      };
    })
    .addEdge(START, 'capture_memory')
    .addEdge('capture_memory', 'append_observation')
    .addEdge('append_observation', 'recall_after_restart')
    .addEdge('recall_after_restart', 'probe_provider')
    .addEdge('probe_provider', END)
    .compile({
      checkpointer: new VersionedCheckpointer(checkpointer, (tuple) => {
        const values = tuple.checkpoint.channel_values;
        if ('runId' in values) metadataSchema.parse(values);
        else if (values['__start__']) metadataSchema.parse(values['__start__']);
      }),
      interruptBefore: ['recall_after_restart'],
    });
}
