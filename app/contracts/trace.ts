import { z } from 'zod';
import { artifactRefSchema, boundedJsonSchema } from './artifacts.js';
import { artifactReviewCheckSchema } from './manager.js';
import { timestampSchema } from './common.js';

/** Independent from TaskEvent v3: immutable facts captured at the event boundary. */
export const traceRecordSchema = z.strictObject({
  schema_version: z.literal('haze.trace.record.v1'),
  event_id: z.string(),
  cursor: z.number().int().positive(),
  task_id: z.uuid(),
  run_id: z.uuid(),
  at: timestampSchema,
  action: z.string(),
  actor: z.string(),
  status: z.string(),
  summary: z.string(),
  input_summary: z.string().optional(),
  output_summary: z.string().optional(),
  assignment_id: z.uuid().optional(),
  assignment_revision: z.number().int().positive().optional(),
  objective_revision: z.number().int().positive(),
  generation: z.number().int().positive(),
  plan_revision: z.number().int().nonnegative().optional(),
  attempt_number: z.number().int().positive().optional(),
  execution_status: z.string().optional(),
  execution_accepted: z.boolean().optional(),
  evidence_verdict: z.string().optional(),
  task_status: z.string().optional(),
  manager_consumed_event_cursor: z.number().int().nonnegative().optional(),
  artifacts: z.array(artifactRefSchema),
  reviews: z.array(artifactReviewCheckSchema).optional(),
  causes: z.strictObject({
    decision_id: z.string().optional(),
    attempt_id: z.string().optional(),
    message_id: z.string().optional(),
    event_ids: z.array(z.string()),
  }),
  /** Revision/replacement links are distinct from direct triggering causes. */
  supersedes: z
    .strictObject({
      event_ids: z.array(z.string()),
      artifacts: z.array(artifactRefSchema),
    })
    .optional(),
  peer: z
    .strictObject({
      sender_id: z.string(),
      sender_role: z.string(),
      recipient_id: z.string(),
      recipient_role: z.string(),
    })
    .optional(),
  provenance: z.strictObject({
    capture: z.enum(['native', 'reconstructed']),
    mode: z.enum(['live', 'fixture', 'replay']),
    omissions: z.array(z.string()),
  }),
  details: boundedJsonSchema.optional(),
});
export type TraceRecord = z.infer<typeof traceRecordSchema>;
