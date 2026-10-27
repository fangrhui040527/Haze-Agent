import { z } from 'zod';
import { artifactRefSchema } from './artifacts.js';
import { traceRecordSchema } from './trace.js';

export const traceCompletenessSchema = z.strictObject({
  native: z.number().int().nonnegative(),
  reconstructed: z.number().int().nonnegative(),
  omissions: z.array(z.string()),
});
export const tracePageSchema = z.strictObject({
  schema_version: z.literal('haze.trace.page.v1'),
  task_id: z.uuid(),
  run_id: z.uuid(),
  records: z.array(traceRecordSchema),
  next_cursor: z.number().int().nonnegative(),
  has_more: z.boolean(),
  snapshot_cursor: z.number().int().nonnegative(),
  active_snapshot: z.boolean(),
  completeness: traceCompletenessSchema,
  sink_health: z.json().optional(),
});
export const traceManifestSchema = z.strictObject({
  schema_version: z.literal('haze.trace.manifest.v1'),
  task_id: z.uuid(),
  run_id: z.uuid(),
  snapshot_cursor: z.number().int().nonnegative(),
  active_snapshot: z.boolean(),
  status: z.string(),
  mode: z.enum(['live', 'fixture', 'replay']),
  capture: traceCompletenessSchema,
  omissions: z.array(
    z.strictObject({ subject: z.string(), reason: z.string() }),
  ),
  sanitization: z.string(),
  created_at: z.string(),
  sink_health: z.json().optional(),
});
export const exportedTraceArtifactSchema = z.strictObject({
  original_ref: artifactRefSchema,
  filename: z.string().regex(/^artifact-\d{4,}\.json$/),
  exported_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.json(),
  provenance: z.json(),
});
export const evidenceBundleSchema = z.strictObject({
  schema_version: z.literal('haze.evidence-bundle.v1'),
  manifest: traceManifestSchema,
  records: z.array(traceRecordSchema),
  summary: z.string(),
  input: z.json(),
  output: z.json(),
  artifacts: z.array(exportedTraceArtifactSchema),
  context: z.json(),
});
export type TracePage = z.infer<typeof tracePageSchema>;
export type TraceManifest = z.infer<typeof traceManifestSchema>;
export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;
