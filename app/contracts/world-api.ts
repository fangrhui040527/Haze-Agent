import { z } from 'zod';
import {
  worldAcceptanceOutcomeSchema,
  worldHistoryPageSchema,
  worldLineagePageSchema,
  worldRecordSchema,
} from './world.js';
import { executionModeSchema } from './tasks.js';
import { worldContextOutputSchema } from './world-services.js';

const recordIdSchema = z.string().min(1).max(256);
const cursorSchema = z
  .string()
  .regex(/^\d+$/u)
  .max(16)
  .refine((value) => Number.isSafeInteger(Number(value)), {
    message: 'Cursor must be a safe sequence number.',
  });

export const worldApiPageQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: cursorSchema.optional(),
});

export const worldApiBrowseQuerySchema = worldApiPageQuerySchema.extend({
  kind: z.string().min(1).max(128).optional(),
  query: z.string().min(1).max(256).optional(),
});

export const WORLD_BROWSE_RESPONSE_BYTES = 2 * 1024 * 1024;

export const worldBrowseResponseSchema = z
  .strictObject({
    schema_version: z.literal('haze.world.browse.v1'),
    scope: worldRecordSchema.shape.scope,
    records: z.array(worldRecordSchema).max(100),
    kinds: z
      .array(
        z.strictObject({
          kind: z.string().min(1).max(128),
          count: z.number().int().nonnegative(),
        }),
      )
      .max(1000),
    kinds_truncated: z.boolean(),
    counts: z.strictObject({
      records: z.number().int().nonnegative(),
      relationships: z.number().int().nonnegative(),
      events: z.number().int().nonnegative(),
    }),
    projection_cursor: z.number().int().nonnegative(),
    has_more: z.boolean(),
    next_cursor: cursorSchema.optional(),
  })
  .superRefine((value, context) => {
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      WORLD_BROWSE_RESPONSE_BYTES
    )
      context.addIssue({
        code: 'custom',
        message: 'World Model browse response exceeds its 2 MiB bound.',
      });
    if (value.has_more !== (value.next_cursor !== undefined))
      context.addIssue({
        code: 'custom',
        message: 'World Model browse cursor must match page availability.',
      });
  });

export const worldProjectionRebuildRequestSchema = z.strictObject({});
export const worldProjectionRebuildResponseSchema = z.strictObject({
  schema_version: z.literal('haze.world.projection-rebuild.v1'),
  mode: executionModeSchema,
  projection_cursor: z.number().int().nonnegative(),
  reused: z.boolean(),
});

export const worldApiRecordParamsSchema = z.strictObject({
  record_id: recordIdSchema,
});

export const worldCurrentStatusSchema = z.strictObject({
  schema_version: z.literal('haze.world.current-status.v1'),
  record_id: recordIdSchema,
  acceptances: z.array(worldAcceptanceOutcomeSchema).max(50),
});

export const worldRecordDetailResponseSchema = z.strictObject({
  schema_version: z.literal('haze.world.record-detail.v1'),
  record: worldRecordSchema,
  relationships: worldContextOutputSchema.shape.relationships,
  support_artifacts: worldContextOutputSchema.shape.support_artifacts,
  payload: worldContextOutputSchema.shape.payload,
  status: worldCurrentStatusSchema,
});

export const worldTaskResponseSchema = z.strictObject({
  schema_version: z.literal('haze.world.task-view.v1'),
  task_id: z.uuid(),
  mode: executionModeSchema,
  records: z.array(worldRecordSchema).max(50),
  current_acceptances: z
    .array(
      z.strictObject({
        subject: recordIdSchema,
        acceptance: worldAcceptanceOutcomeSchema,
      }),
    )
    .max(250),
  truncated: z.boolean(),
});

export const worldRecordHistoryResponseSchema = worldHistoryPageSchema;
export const worldRecordLineageResponseSchema = worldLineagePageSchema;

export const worldApiRecordReadQuerySchema = worldApiPageQuerySchema.extend({
  view: z.enum(['detail', 'history', 'lineage']).default('detail'),
});

export const worldRecordReadResponseSchema = z.discriminatedUnion('view', [
  z.strictObject({
    view: z.literal('detail'),
    detail: worldRecordDetailResponseSchema,
  }),
  z.strictObject({
    view: z.literal('history'),
    history: worldRecordHistoryResponseSchema,
  }),
  z.strictObject({
    view: z.literal('lineage'),
    lineage: worldRecordLineageResponseSchema,
  }),
]);

export const worldApiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(1024),
  }),
});

export const worldRecordNotFoundSchema = z.strictObject({
  error: z.strictObject({
    code: z.literal('world_record_not_found'),
    message: z.literal('World Model record not found.'),
  }),
});

export type WorldApiPageQuery = z.infer<typeof worldApiPageQuerySchema>;
export type WorldApiBrowseQuery = z.infer<typeof worldApiBrowseQuerySchema>;
export type WorldBrowseResponse = z.infer<typeof worldBrowseResponseSchema>;
export type WorldProjectionRebuildResponse = z.infer<
  typeof worldProjectionRebuildResponseSchema
>;
export type WorldRecordDetailResponse = z.infer<
  typeof worldRecordDetailResponseSchema
>;
export type WorldTaskResponse = z.infer<typeof worldTaskResponseSchema>;
export type WorldRecordReadResponse = z.infer<
  typeof worldRecordReadResponseSchema
>;
