import { z } from 'zod';
import {
  taskRequestSchema,
  taskResultSchema,
  taskScopeSchema,
  taskStatusSchema,
} from '../tasks/contracts.js';

const text = z.string().min(1).max(2000);
const instant = z.iso.datetime({ offset: true });
export const orchestrationRoleSchema = z.enum([
  'Manager',
  'HazeOps',
  'WorkerShield',
  'EvidenceCritic',
]);
export const artifactRefSchema = z.strictObject({
  id: z.uuid(),
  version: z.literal(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const capabilityCardSchema = z.strictObject({
  id: text,
  version: text,
  purpose: text,
  work_products: z.array(text),
  required_tools: z.array(text),
  roles: z.array(orchestrationRoleSchema),
  readiness: z.enum([
    'specified',
    'implemented',
    'fixture-tested',
    'live-executed',
    'independently-checked',
  ]),
  limitations: z.array(text),
});
export const reviewRecordSchema = z.strictObject({
  schema_version: z.literal('haze.review.v1'),
  reviewer_assignment_id: z.uuid(),
  reviewed_artifacts: z.array(artifactRefSchema),
  checks: z.array(text),
  verdict: z.enum(['supported', 'needs_review', 'rejected']),
  findings: z.array(text),
  limitations: z.array(text),
});
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;
export const orchestrationRequestSchema = taskRequestSchema.extend({
  schema_version: z.literal('haze.task.request.v2'),
});
export const assignmentSchema = z.strictObject({
  id: z.uuid(),
  task_id: z.uuid(),
  role: orchestrationRoleSchema,
  definition_version: z.literal('1'),
  capability: text,
  objective_revision: z.number().int().positive(),
  generation: z.number().int().positive(),
  brief: z.string().min(1).max(8000),
  inputs: z.array(artifactRefSchema),
  dependencies: z.array(z.uuid()),
  tools: z.array(z.string()),
  deadline: instant,
  max_model_calls: z.number().int().nonnegative(),
  status: z.enum([
    'queued',
    'running',
    'completed',
    'failed',
    'cancelled',
    'timed_out',
  ]),
  usage: z.strictObject({
    model_calls: z.number().int().nonnegative(),
    tool_calls: z.number().int().nonnegative(),
  }),
  outputs: z.array(artifactRefSchema),
  assumptions: z.array(text),
  gaps: z.array(text),
  error: z.strictObject({ code: text, message: text }).optional(),
});
export const orchestrationEventSchema = z.strictObject({
  schema_version: z.literal('haze.task.event.v2'),
  cursor: z.number().int().positive(),
  task_id: z.uuid(),
  at: instant,
  type: text,
  actor: z.enum([
    'Manager',
    'HazeOps',
    'WorkerShield',
    'EvidenceCritic',
    'Runtime',
  ]),
  message: text,
  objective_revision: z.number().int().positive(),
  generation: z.number().int().positive(),
  assignment_id: z.uuid().optional(),
  data: z.unknown().optional(),
});
export const orchestrationEventPageSchema = z.strictObject({
  events: z.array(orchestrationEventSchema),
  next_cursor: z.number().int().nonnegative(),
  status: taskStatusSchema,
});
export const orchestrationResultSchema = taskResultSchema.extend({
  coverage: taskResultSchema.shape.coverage.nullable(),
  schema_version: z.literal('haze.task.result.v2'),
  completion: z.enum(['full', 'partial', 'blocked']),
  findings: z.array(
    z.strictObject({
      id: z.string().optional(),
      text,
      citation_ids: z.array(z.string()),
    }),
  ),
  review: z.strictObject({
    status: z.enum(['supported', 'needs_review', 'rejected']),
    scope: text,
    limitations: z.array(text),
    artifact_id: z.uuid(),
  }),
  provenance: taskResultSchema.shape.provenance.extend({
    mode: z.enum(['live', 'fixture']),
  }),
});
export const orchestrationTaskSchema = z.strictObject({
  schema_version: z.literal('haze.task.v2'),
  id: z.uuid(),
  objective_revision: z.number().int().positive(),
  generation: z.number().int().positive(),
  original_request: orchestrationRequestSchema,
  scope: taskScopeSchema,
  identity: z.strictObject({
    principal: z.string().min(1),
    workspace: z.string().min(1),
  }),
  status: taskStatusSchema,
  mode: z.enum(['live', 'fixture']),
  permissions: z.strictObject({
    tools: z.array(z.string()),
    effects: z.array(z.string()).max(0),
  }),
  limits: z.strictObject({
    deadline: instant,
    max_model_calls: z.number().int().positive(),
    max_tool_calls: z.number().int().positive(),
    max_artifacts: z.number().int().positive(),
    max_model_input_bytes: z.number().int().positive(),
    max_model_output_tokens: z.literal(700),
  }),
  usage: z.strictObject({
    model_calls: z.number().int().nonnegative(),
    tool_calls: z.number().int().nonnegative(),
    artifacts: z.number().int().nonnegative(),
  }),
  created_at: instant,
  updated_at: instant,
  assignments: z.array(assignmentSchema).max(5),
  result: orchestrationResultSchema.optional(),
  error: z.strictObject({ code: text, message: text }).optional(),
});
export const orchestrationArtifactSchema = z.strictObject({
  schema_version: z.literal('haze.artifact.v2'),
  ...artifactRefSchema.shape,
  task_id: z.uuid(),
  assignment_id: z.uuid(),
  producer: orchestrationRoleSchema,
  objective_revision: z.number().int().positive(),
  generation: z.number().int().positive(),
  kind: text,
  dependencies: z.array(artifactRefSchema),
  created_at: instant,
  content: z.unknown(),
});
export const cancellationSchema = z.strictObject({
  task_id: z.uuid(),
  status: taskStatusSchema,
  generation: z.number().int().positive(),
});
export type OrchestrationRequest = z.infer<typeof orchestrationRequestSchema>;
export type OrchestrationTask = z.infer<typeof orchestrationTaskSchema>;
export type Assignment = z.infer<typeof assignmentSchema>;
export type ArtifactRef = z.infer<typeof artifactRefSchema>;
export type OrchestrationArtifact = z.infer<typeof orchestrationArtifactSchema>;
export type OrchestrationEvent = z.infer<typeof orchestrationEventSchema>;
export type OrchestrationResult = z.infer<typeof orchestrationResultSchema>;
export type OrchestrationRole = z.infer<typeof orchestrationRoleSchema>;
