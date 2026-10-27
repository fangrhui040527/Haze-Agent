import { z } from 'zod';
import { identifierSchema, timestampSchema } from './common.js';
import {
  artifactRefSchema,
  artifactApplicabilitySchema,
  boundedJsonSchema,
} from './artifacts.js';
import { agentRoleSchema } from './capabilities.js';
import { managerStateSchema, artifactReviewCheckSchema } from './manager.js';
import { evidenceResearchToolIdSchema } from './evidence-tools.js';

const text = z.string().min(1).max(4096);
const count = z.number().int().nonnegative();
const revision = z.number().int().positive();
export const taskIdentitySchema = z.strictObject({
  principal: identifierSchema,
  workspace: identifierSchema,
});
export const taskRequestSchema = z.strictObject({
  schema_version: z.literal('haze.task.request.v3'),
  objective: z.string().trim().min(1).max(16000),
  scope: boundedJsonSchema.optional(),
  context_refs: z.array(artifactRefSchema).max(64).default([]),
  constraints: z.array(text).max(32).default([]),
  desired_deliverables: z.array(text).max(32).default([]),
  /** Explicit research opt-in; an explicit research capability scope also grants these tools. */
  evidence_tools: z.array(evidenceResearchToolIdSchema).max(5).optional(),
  /** Explicit opt-in; registration alone grants no external job authority. */
  nightshift_tools: z
    .array(
      z.enum(['nightshift.submit', 'nightshift.result', 'nightshift.cancel']),
    )
    .max(3)
    .optional(),
});
export const taskStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'paused',
  'completed',
  'failed',
  'timed_out',
  'cancelled',
]);
export const executionModeSchema = z.enum(['live', 'fixture', 'replay']);
export const resourceLimitsSchema = z.strictObject({
  deadline: timestampSchema,
  max_model_calls: count,
  max_tool_calls: count,
  max_assignments: count,
  max_artifacts: count,
  max_model_input_bytes: z.number().int().positive(),
  max_model_output_tokens: z.number().int().positive(),
  reserved_model_calls: count.default(2),
});
export const usageSchema = z.strictObject({
  model_calls: count,
  tool_calls: count,
  artifacts: count,
  assignments: count,
});
export const permissionsSchema = z.strictObject({
  tools: z.array(identifierSchema).max(128),
  effects: z.array(identifierSchema).max(0),
});
export const runSchema = z.strictObject({
  id: z.uuid(),
  task_id: z.uuid(),
  predecessor_run_id: z.uuid().optional(),
  objective_revision: revision,
  generation: revision,
  state_revision: revision,
  status: taskStatusSchema,
  limits: resourceLimitsSchema,
  usage: usageSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export const assignmentSchema = z.strictObject({
  id: z.uuid(),
  task_id: z.uuid(),
  run_id: z.uuid(),
  role: agentRoleSchema,
  definition_id: identifierSchema,
  definition_version: identifierSchema,
  agent_version: identifierSchema,
  capability_version: identifierSchema,
  capability: identifierSchema,
  input: boundedJsonSchema.optional(),
  revision,
  objective_revision: revision,
  generation: revision,
  acknowledged_revision: count,
  brief: z.string().min(1).max(16000),
  dependencies: z.array(z.uuid()).max(64),
  inputs: z.array(artifactRefSchema).max(256),
  tools: z.array(identifierSchema).max(64),
  status: z.enum([
    'queued',
    'running',
    'waiting',
    'completed',
    'failed',
    'cancelled',
    'timed_out',
    'stale',
    'paused',
  ]),
  deadline: timestampSchema,
  max_model_calls: count,
  usage: z.strictObject({ model_calls: count, tool_calls: count }),
  outputs: z.array(artifactRefSchema).max(256),
  assumptions: z.array(text).max(64),
  gaps: z.array(text).max(64),
  lease_token: z.uuid().optional(),
  support: z
    .enum(['supported', 'partial', 'gap', 'unknown'])
    .default('unknown'),
  usability: z
    .enum(['usable', 'needs_review', 'rejected', 'stale'])
    .default('needs_review'),
  error: z.strictObject({ code: text, message: text }).optional(),
});
export const questionSchema = z.strictObject({
  id: z.uuid(),
  task_id: z.uuid(),
  run_id: z.uuid(),
  assignment_id: z.uuid().optional(),
  objective_revision: revision,
  question: text,
  kind: z.enum(['human', 'data']),
  status: z.enum(['open', 'answered', 'obsolete']),
  answer: z.string().max(16000).optional(),
  created_at: timestampSchema,
});
export const correctionSchema = z.strictObject({
  id: z.uuid(),
  objective_revision: revision,
  kind: z.enum(['correction', 'clarification']),
  passage: z.string().min(1).max(16000),
  scope: boundedJsonSchema.optional(),
  question_id: z.uuid().optional(),
  affected_assignment_ids: z.array(z.uuid()),
  created_at: timestampSchema,
  context_refs: z.array(artifactRefSchema).max(64).optional(),
});
export const citationSchema = z.strictObject({
  id: identifierSchema,
  artifact: artifactRefSchema,
  label: text,
  url: z.string().max(4096).optional(),
  selection: boundedJsonSchema.optional(),
});
export const taskResultSchema = z.strictObject({
  schema_version: z.literal('haze.task.result.v3'),
  answer: z.string().min(1).max(32000),
  completion: z.enum(['full', 'partial', 'blocked']),
  work_products: z.array(artifactRefSchema).max(256),
  sources: z.array(citationSchema).max(256),
  covered_scope: boundedJsonSchema,
  uncertainty: z.array(text).max(64),
  review: z.strictObject({
    status: z.enum(['supported', 'needs_review', 'rejected', 'not_required']),
    reviewer_assignment_id: z.uuid().optional(),
    artifact: artifactRefSchema.optional(),
    scope: text,
    limitations: z.array(text).max(64),
    checks: z.array(artifactReviewCheckSchema).max(256).optional(),
  }),
  currency: z.enum(['current', 'stale']),
  next_requirements: z.array(text).max(64),
  provenance: z.strictObject({
    mode: executionModeSchema,
    model_calls: count,
    tool_calls: count,
    capabilities: z
      .array(
        z.strictObject({ id: identifierSchema, version: identifierSchema }),
      )
      .max(64),
    receipts: z.array(boundedJsonSchema).max(256),
  }),
});
export const taskEventSchema = z.strictObject({
  schema_version: z.literal('haze.task.event.v3'),
  cursor: z.number().int().positive(),
  task_id: z.uuid(),
  run_id: z.uuid(),
  objective_revision: revision,
  generation: revision,
  at: timestampSchema,
  type: text,
  actor: z.union([agentRoleSchema, z.literal('Runtime'), z.literal('User')]),
  message: text,
  assignment_id: z.uuid().optional(),
  data: boundedJsonSchema.optional(),
});
export const taskEventPageSchema = z.strictObject({
  events: z.array(taskEventSchema),
  next_cursor: count,
  status: taskStatusSchema,
});
export const taskRecordSchema = z.strictObject({
  schema_version: z.literal('haze.task.v3'),
  id: z.uuid(),
  original_request: taskRequestSchema,
  objective_revision: revision,
  current_run_id: z.uuid(),
  generation: revision,
  state_revision: revision,
  identity: taskIdentitySchema,
  permissions: permissionsSchema,
  mode: executionModeSchema,
  status: taskStatusSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  limits: resourceLimitsSchema,
  usage: usageSchema,
  runs: z.array(runSchema),
  assignments: z.array(assignmentSchema),
  corrections: z.array(correctionSchema),
  questions: z.array(questionSchema),
  artifacts: z.array(artifactApplicabilitySchema),
  manager: managerStateSchema.optional(),
  result: taskResultSchema.optional(),
  error: z.strictObject({ code: text, message: text }).optional(),
});
export const taskAdmissionSchema = z.strictObject({
  task_id: z.uuid(),
  status_url: z.string(),
  events_url: z.string(),
  reused: z.boolean(),
});
export type TaskRequest = z.infer<typeof taskRequestSchema>;
export type TaskRecord = z.infer<typeof taskRecordSchema>;
export type TaskIdentity = z.infer<typeof taskIdentitySchema>;
export type TaskResult = z.infer<typeof taskResultSchema>;
export type TaskEvent = z.infer<typeof taskEventSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type ResourceLimits = z.infer<typeof resourceLimitsSchema>;
export type RunRecord = z.infer<typeof runSchema>;
export type Assignment = z.infer<typeof assignmentSchema>;
export type Question = z.infer<typeof questionSchema>;
export type Correction = z.infer<typeof correctionSchema>;
export class TaskError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
