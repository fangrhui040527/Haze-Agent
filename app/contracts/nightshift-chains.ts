import { z } from 'zod';
import { artifactRefSchema } from './artifacts.js';

export const nightshiftPurposeSchema = z.enum([
  'evidence_linked_draft',
  'alternative_explanation',
  'critique_candidate',
]);
export const nightshiftProgressSchema = z.strictObject({
  schema_version: z.literal('haze.nightshift.progress.v1'),
  purpose: nightshiftPurposeSchema,
  instruction: z.string().trim().min(1).max(2000),
  unresolved_deliverables: z
    .array(z.string().trim().min(1).max(4096))
    .min(1)
    .max(32)
    .default(['objective']),
  input_refs: z.array(artifactRefSchema).max(32).default([]),
  output_refs: z.array(artifactRefSchema).max(32).default([]),
  review_objections: z.array(artifactRefSchema).max(16).default([]),
  failure_causes: z
    .array(
      z.strictObject({ job_id: z.uuid(), code: z.string().min(1).max(128) }),
    )
    .max(16)
    .default([]),
  last_consumed_result_cursor: z.number().int().nonnegative().default(0),
});
export const nightshiftProgressRecordSchema = z.strictObject({
  schema_version: z.literal('haze.nightshift.progress.record.v1'),
  chain_id: z.uuid(),
  run_id: z.uuid(),
  revision: z.number().int().positive(),
  actor: z.enum(['user', 'service', 'agent']),
  accepted_at: z.string(),
  fingerprint: z.string(),
  progress: nightshiftProgressSchema,
});
export const nightshiftSuccessorSchema = z.strictObject({
  chain_id: z.uuid(),
  predecessor_run_id: z.uuid(),
  objective_revision: z.number().int().positive(),
  run_id: z.uuid(),
  actor: z.enum(['user', 'service']),
  mode: z.enum(['manual', 'automatic']),
  reason: z.string().max(2000),
  cursor: z.number().int().nonnegative(),
  delivery_ids: z.array(z.uuid()).max(64),
  created_at: z.string(),
});
export const nightshiftStopSchema = z.strictObject({
  code: z.string().min(1).max(128),
  message: z.string().max(2000),
  cursor: z.number().int().nonnegative(),
  refs: z.array(artifactRefSchema).max(64),
  remaining: z.record(z.string(), z.number().nonnegative()),
  at: z.string(),
});
export const chainAutomationViewSchema = z.strictObject({
  schema_version: z.literal('haze.nightshift.chain.automation.v1'),
  chain_id: z.uuid(),
  task_id: z.uuid(),
  current_run_id: z.uuid(),
  previous_chain_id: z.uuid().optional(),
  previous_task_id: z.uuid().optional(),
  automatic_enabled: z.boolean(),
  authorized_followups: z.number().int().nonnegative(),
  used_followups: z.number().int().nonnegative(),
  remaining_followups: z.number().int().nonnegative(),
  admitted_runs: z.number().int().positive(),
  maximum_runs: z.number().int().positive(),
  run_profile: z.strictObject({
    max_model_input_bytes: z.number().int().positive(),
    max_model_output_tokens: z.number().int().positive(),
    reserved_model_calls: z.number().int().nonnegative(),
  }),
  original_expires_at: z.string(),
  next_purpose: nightshiftPurposeSchema.nullable(),
  progress: nightshiftProgressRecordSchema.nullable(),
  lineage: z.array(nightshiftSuccessorSchema).max(3),
  stops: z.array(nightshiftStopSchema).max(100),
  inbox: z
    .array(
      z.strictObject({
        job_id: z.uuid(),
        remote_id: z.string().nullable(),
        original_run_id: z.uuid(),
        execution_state: z.string(),
        candidate: artifactRefSchema.nullable(),
        required: z.boolean(),
        delivered_to_run_id: z.uuid().nullable(),
      }),
    )
    .max(100),
});
export type NightshiftProgress = z.infer<typeof nightshiftProgressSchema>;
export type NightshiftProgressRecord = z.infer<
  typeof nightshiftProgressRecordSchema
>;
export type NightshiftSuccessor = z.infer<typeof nightshiftSuccessorSchema>;
export type NightshiftChainAutomationView = z.infer<
  typeof chainAutomationViewSchema
>;
