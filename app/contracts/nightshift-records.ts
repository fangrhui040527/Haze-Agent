import { z } from 'zod';
import { artifactRefSchema, boundedJsonSchema } from './artifacts.js';
import { agentRoleSchema } from './capabilities.js';

const count = z.number().int().nonnegative();
const nullableText = z.string().nullable();
const usageSchema = z.strictObject({
  runs: count,
  model_calls: count,
  tool_calls: count,
  assignments: count,
  artifacts: count,
  jobs: count,
  requested_attempts: count,
  retention_reserved: count,
});
export const nightshiftChainSchema = z
  .strictObject({
    schema_version: z.enum([
      'haze.nightshift.chain.v1',
      'haze.nightshift.chain.v2',
    ]),
    id: z.uuid(),
    task_id: z.uuid(),
    revision: z.number().int().positive(),
    status: z.enum(['active', 'paused', 'closed', 'expired', 'invalidated']),
    created_at: z.string(),
    expires_at: z.string(),
    original_run_id: z.uuid(),
    objective_revision: z.number().int().positive(),
    grant: z.strictObject({
      total_runs: z.number().int().min(1).max(4),
      max_jobs: z.number().int().min(1).max(4),
      max_attempts: z.number().int().min(1).max(16),
      automatic_followup_runs: z.number().int().min(0).max(3),
      privacy: z.literal('local-only'),
      max_spend_usd: z.literal(0),
      max_model_calls: count,
      max_tool_calls: count,
      max_assignments: count,
      max_artifacts: count,
      route_ids: z.record(agentRoleSchema, z.string()),
    }),
    usage: usageSchema,
    remaining: usageSchema,
    stop_reason: nullableText,
  })
  .refine(
    (chain) =>
      chain.schema_version !== 'haze.nightshift.chain.v1' ||
      chain.grant.automatic_followup_runs === 0,
    { message: 'Manual v1 grants cannot acquire automatic authority.' },
  );
export const nightshiftSelectionSchema = z.strictObject({
  id: z.uuid(),
  artifact: artifactRefSchema,
  target_run_id: z.uuid(),
  target_generation: z.number().int().positive(),
  target_objective_revision: z.number().int().positive(),
  assignment_id: z.uuid().nullable(),
  assignment_revision: z.number().int().positive().nullable(),
  created_at: z.string(),
  requires_independent_review: z.literal(true),
});
export const nightshiftJobSchema = z.strictObject({
  schema_version: z.literal('haze.nightshift.job.v1'),
  id: z.uuid(),
  task_id: z.uuid(),
  chain_id: z.uuid(),
  revision: z.number().int().positive(),
  created_at: z.string(),
  updated_at: z.string(),
  authority: z.strictObject({
    run_id: z.uuid(),
    generation: z.number().int().positive(),
    objective_revision: z.number().int().positive(),
    assignment_id: z.uuid().nullable(),
    assignment_revision: z.number().int().positive().nullable(),
  }),
  prompt: z.string(),
  input_refs: z.array(artifactRefSchema).max(32),
  route_id: z.string(),
  options: z.strictObject({
    n: z.number().int().positive(),
    judge: z.string(),
    budget: z.string(),
    window: z.string(),
    fleet: nullableText,
    privacy: z.literal('local-only'),
    max_spend_usd: z.literal(0),
  }),
  request_fingerprint: z.string(),
  adapter_version: z.string(),
  runtime_version: nullableText,
  schema_hash: z.string(),
  execution_state: z.enum([
    'submitting',
    'submission_unknown',
    'queued',
    'running',
    'completed',
    'failed',
    'cancelled',
    'unresolved',
    'rejected',
  ]),
  remote_id: nullableText,
  progress: z.strictObject({
    generated: count.nullable(),
    requested_attempts: count.nullable(),
  }),
  judge_outcome: z.strictObject({
    status: z.enum(['accepted', 'rejected', 'undecided', 'unknown']),
    basis: nullableText,
    explanation: nullableText,
  }),
  receipt: z
    .strictObject({
      artifact: artifactRefSchema,
      output: z.string(),
      attempts: z.array(boundedJsonSchema).max(16),
      winner_seq: count.nullable(),
      captured_at: z.string(),
    })
    .nullable(),
  retrieval_error: z
    .strictObject({ code: z.string(), message: z.string() })
    .nullable(),
  cancellation: z.strictObject({
    requested: z.boolean(),
    acknowledged: z.boolean(),
    remote_termination_confirmed: z.boolean(),
  }),
  candidate: z.literal(true),
  review_status: z.literal('unreviewed'),
  selections: z.array(nightshiftSelectionSchema),
  next_poll_at: z.string().nullable(),
  read_failures: count,
  remote_diagnostic: z
    .strictObject({
      execution_state: z.string().max(128).nullable(),
      failure_code: z.string().max(128).nullable(),
    })
    .optional(),
});
export const nightshiftEventSchema = z.strictObject({
  cursor: z.number().int().positive(),
  job_id: z.uuid(),
  chain_id: z.uuid(),
  at: z.string(),
  type: z.string(),
  message: z.string(),
  data: boundedJsonSchema.nullable(),
});
export const nightshiftEventPageSchema = z.strictObject({
  events: z.array(nightshiftEventSchema),
  next_cursor: count,
});
export type NightshiftChain = z.infer<typeof nightshiftChainSchema>;
export type NightshiftJob = z.infer<typeof nightshiftJobSchema>;
export type NightshiftSelection = z.infer<typeof nightshiftSelectionSchema>;
export type NightshiftEventPage = z.infer<typeof nightshiftEventPageSchema>;
