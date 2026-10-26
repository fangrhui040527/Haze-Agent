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
export type WorldRecordDetailResponse = z.infer<
  typeof worldRecordDetailResponseSchema
>;
export type WorldTaskResponse = z.infer<typeof worldTaskResponseSchema>;
export type WorldRecordReadResponse = z.infer<
  typeof worldRecordReadResponseSchema
>;
