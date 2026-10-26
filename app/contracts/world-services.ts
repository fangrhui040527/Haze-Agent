import { z } from 'zod';
import { artifactRefSchema, boundedJsonSchema } from './artifacts.js';
import {
  worldAcceptanceOutcomeSchema,
  worldLineagePageSchema,
  worldRecordSchema,
  worldRelationshipSchema,
} from './world.js';

const worldRecordRef = z.strictObject({
  id: z.string().min(1).max(256),
  revision: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const worldLookupInputSchema = z.strictObject({
  kind: z.string().min(1).max(128).optional(),
  artifact_kind: z.string().min(1).max(128).optional(),
  external_id: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export const worldLookupOutputSchema = z.strictObject({
  schema_version: z.literal('haze.world.lookup.v1'),
  records: z.array(worldRecordSchema).max(50),
  current_acceptances: z
    .array(
      z.strictObject({
        subject: z.string().min(1).max(256),
        acceptance: worldAcceptanceOutcomeSchema,
      }),
    )
    .max(250),
});

export const worldContextInputSchema = z.strictObject({
  record_id: z.string().min(1).max(256),
  stated_use: z.string().min(1).max(512),
});
export const worldContextOutputSchema = z
  .strictObject({
    schema_version: z.literal('haze.world.context.v1'),
    record: worldRecordSchema,
    relationships: z.array(worldRelationshipSchema).max(100),
    acceptances: z.array(worldAcceptanceOutcomeSchema).max(50),
    support_artifacts: z.array(artifactRefSchema).max(64),
    payload: boundedJsonSchema,
  })
  .superRefine((value, context) => {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1_048_576)
      context.addIssue({
        code: 'custom',
        message: 'World Model context exceeds the 1 MiB response bound.',
      });
  });
export const worldContextToolOutputSchema = worldContextOutputSchema.extend({
  snapshot: artifactRefSchema,
});
export const worldContextSnapshotSchema = z.strictObject({
  schema_version: z.literal('haze.world.context-snapshot.v1'),
  stated_use: z.string().min(1).max(512),
  record: worldRecordRef,
  acceptances: z.array(worldAcceptanceOutcomeSchema).max(50),
  support_artifacts: z.array(artifactRefSchema).max(64),
  relationships: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(256),
        kind: z.string().min(1).max(128),
        from: worldRecordRef,
        to: worldRecordRef,
      }),
    )
    .max(100),
});

export const worldLineageInputSchema = z.strictObject({
  record_id: z.string().min(1).max(256),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z
    .string()
    .regex(/^\d+$/u)
    .max(16)
    .refine((value) => Number.isSafeInteger(Number(value)), {
      message: 'Cursor must be a safe sequence number.',
    })
    .optional(),
});
export const worldLineageOutputSchema = worldLineagePageSchema;

export type WorldLookupInput = z.infer<typeof worldLookupInputSchema>;
export type WorldContextInput = z.infer<typeof worldContextInputSchema>;
export type WorldLineageInput = z.infer<typeof worldLineageInputSchema>;
export type WorldContextOutput = z.infer<typeof worldContextOutputSchema>;
