import { z } from 'zod';
import { timestampSchema } from './common.js';
import { boundedJsonSchema, artifactRefSchema } from './artifacts.js';

export const mutationExpectationSchema = z.strictObject({
  expected_objective_revision: z.number().int().positive(),
  expected_run_id: z.uuid(),
  expected_generation: z.number().int().positive(),
  expected_state_revision: z.number().int().positive(),
});
export const taskUpdateSchema = z.strictObject({
  schema_version: z.literal('haze.task.update.v3'),
  ...mutationExpectationSchema.shape,
  kind: z.enum(['correction', 'clarification']),
  passage: z.string().min(1).max(16000),
  scope: boundedJsonSchema.optional(),
  question_id: z.uuid().optional(),
  affected_assignment_ids: z.array(z.uuid()).max(16).optional(),
  context_refs: z.array(artifactRefSchema).max(64).optional(),
});
export const taskControlSchema = z.strictObject({
  schema_version: z.literal('haze.task.control.v3'),
  ...mutationExpectationSchema.shape,
  action: z.enum(['pause', 'cancel', 'resume', 'continue', 'revoke']),
  reason: z.string().max(4096).optional(),
  revoked_tools: z.array(z.string().min(1).max(128)).max(64).optional(),
});
export const controlReceiptSchema = z.strictObject({
  schema_version: z.literal('haze.task.control.receipt.v3'),
  operation_id: z.uuid(),
  task_id: z.uuid(),
  run_id: z.uuid(),
  requested: z.string(),
  confirmed: z.string(),
  objective_revision: z.number().int().positive(),
  generation: z.number().int().positive(),
  state_revision: z.number().int().positive(),
  at: timestampSchema,
  remote_termination_confirmed: z.literal(false),
});
export type MutationExpectation = z.infer<typeof mutationExpectationSchema>;
export type TaskUpdate = z.infer<typeof taskUpdateSchema>;
export type TaskControl = z.infer<typeof taskControlSchema>;
export type ControlReceipt = z.infer<typeof controlReceiptSchema>;
