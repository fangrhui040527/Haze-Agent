import {
  artifactRefSchema,
  boundedJsonSchema,
} from '../contracts/artifacts.js';
import type { z } from 'zod';
import {
  worldContextInputSchema,
  worldContextToolOutputSchema,
  worldLineageInputSchema,
  worldLineageOutputSchema,
  worldLookupInputSchema,
  worldLookupOutputSchema,
} from '../contracts/world-services.js';
import type { ExecutionMode, ToolDefinition } from '../orchestration/ports.js';
import type { TaskStore } from './store.js';

export const WORLD_TOOL_IDS = [
  'world.lookup',
  'world.context',
  'world.lineage',
] as const;

export function createWorldModelTools(store: TaskStore, mode: ExecutionMode) {
  const lookup: ToolDefinition<
    z.infer<typeof worldLookupInputSchema>,
    z.infer<typeof worldLookupOutputSchema>
  > = {
    id: 'world.lookup',
    version: 'world-lookup.v1',
    description:
      'Find a bounded list of World Model records in the current workspace and execution mode.',
    mode,
    inputSchema: worldLookupInputSchema,
    outputSchema: worldLookupOutputSchema,
    execute: (input, context) =>
      Promise.resolve(
        store.worldLookup(context.taskId, context.identity, mode, input),
      ),
  };
  const contextTool: ToolDefinition<
    z.infer<typeof worldContextInputSchema>,
    z.infer<typeof worldContextToolOutputSchema>
  > = {
    id: 'world.context',
    version: 'world-context.v1',
    description:
      'Read one record with current acceptance, source-access checks, and exact support references.',
    mode,
    inputSchema: worldContextInputSchema,
    outputSchema: worldContextToolOutputSchema,
    execute: (input, context) => {
      const value = store.worldContext(
        context.taskId,
        context.identity,
        mode,
        input.record_id,
      );
      store.pinWorldContext(
        context.taskId,
        context.identity,
        context.assignmentId,
        context.generation,
        value.support_artifacts,
        input.stated_use,
      );
      const snapshot = store.saveArtifact(context.taskId, context.identity, {
        kind: 'world.context.snapshot',
        content: boundedJsonSchema.parse({
          schema_version: 'haze.world.context-snapshot.v1',
          stated_use: input.stated_use,
          record: {
            id: value.record.ref.id,
            revision: value.record.ref.revision,
            sha256: value.record.ref.sha256,
          },
          acceptances: value.acceptances,
          support_artifacts: value.support_artifacts,
          relationships: value.relationships.map((relationship) => ({
            id: relationship.id,
            kind: relationship.kind,
            from: relationship.from,
            to: relationship.to,
          })),
        }),
        producer: { kind: 'assignment', id: context.assignmentId },
        dependencies: value.support_artifacts,
        generation: context.generation,
      });
      return Promise.resolve(
        worldContextToolOutputSchema.parse({
          ...value,
          snapshot: artifactRefSchema.parse({
            id: snapshot.id,
            version: snapshot.version,
            sha256: snapshot.sha256,
          }),
        }),
      );
    },
  };
  const lineage: ToolDefinition<
    z.infer<typeof worldLineageInputSchema>,
    z.infer<typeof worldLineageOutputSchema>
  > = {
    id: 'world.lineage',
    version: 'world-lineage.v1',
    description:
      'Read a bounded, paginated event lineage for one authorized World Model record.',
    mode,
    inputSchema: worldLineageInputSchema,
    outputSchema: worldLineageOutputSchema,
    execute: (input, context) =>
      Promise.resolve(
        store.worldLineage(context.taskId, context.identity, mode, input),
      ),
  };
  return [lookup, contextTool, lineage] as const;
}
