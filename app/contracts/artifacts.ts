import { z } from 'zod';
import { identifierSchema, timestampSchema } from './common.js';

/** Public JSON validation deliberately has no Node, hashing, or persistence imports. */
export const boundedJsonSchema = z.json().superRefine((value, context) => {
  const visit = (item: unknown, depth: number): boolean =>
    depth <= 32 &&
    (item === null ||
      typeof item !== 'object' ||
      Object.values(item).every((child) => visit(child, depth + 1)));
  if (
    !visit(value, 0) ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > 1_048_576
  )
    context.addIssue({
      code: 'custom',
      message: 'JSON exceeds the 1 MiB or 32-level representation bound.',
    });
});
export type JsonValue = z.infer<typeof boundedJsonSchema>;
export const artifactContentSchema = z.union([
  z
    .string()
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= 1_048_576,
      'Source exceeds 1 MiB decoded UTF-8.',
    ),
  boundedJsonSchema,
]);
export const artifactRefSchema = z.strictObject({
  id: z.uuid(),
  version: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const producerSchema = z.strictObject({
  kind: z.enum(['user', 'service', 'assignment']),
  id: identifierSchema,
});
export const artifactSchema = z.strictObject({
  schema_version: z.literal('haze.artifact.v3'),
  ...artifactRefSchema.shape,
  identity: z.strictObject({
    principal: identifierSchema,
    workspace: identifierSchema,
  }),
  task_id: z.uuid().optional(),
  run_id: z.uuid().optional(),
  assignment_id: z.uuid().optional(),
  assignment_revision: z.number().int().positive().optional(),
  objective_revision: z.number().int().positive().optional(),
  generation: z.number().int().positive().optional(),
  kind: identifierSchema,
  producer: producerSchema,
  created_at: timestampSchema,
  dependencies: z.array(artifactRefSchema).max(256),
  /** Unreviewed generation provenance; these refs never establish applicability. */
  external_candidates: z.array(artifactRefSchema).max(4).optional(),
  required_tools: z.array(identifierSchema).max(128).default([]),
  content: artifactContentSchema,
  original_byte_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  media_type: z
    .enum(['text/plain', 'text/markdown', 'text/csv', 'application/json'])
    .optional(),
  filename: z.string().min(1).max(255).optional(),
  declared_origin: z.string().max(4096).optional(),
  source_location: z.string().max(4096).optional(),
  evidence_origin: z
    .enum(['user_supplied', 'external_source', 'synthetic_fixture', 'derived'])
    .optional(),
});
/** Mutable applicability is stored separately from immutable artifact bytes. */
export const artifactApplicabilitySchema = z.strictObject({
  artifact: artifactRefSchema,
  task_id: z.uuid(),
  objective_revision: z.number().int().positive(),
  current: z.boolean(),
  reason: z.string().min(1).max(4096),
  checked_by: identifierSchema,
  checked_at: timestampSchema,
});
export const artifactImportSchema = z.strictObject({
  schema_version: z.literal('haze.artifact.import.v3'),
  filename: z.string().min(1).max(255),
  media_type: z.enum([
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/json',
  ]),
  content_base64: z.string().max(1_398_104),
  declared_origin: z.string().max(4096).optional(),
  source_location: z.string().max(4096).optional(),
});
export type ArtifactRef = z.infer<typeof artifactRefSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type ArtifactImport = z.infer<typeof artifactImportSchema>;
export type ArtifactApplicability = z.infer<typeof artifactApplicabilitySchema>;
export type ArtifactProducer = z.infer<typeof producerSchema>;
