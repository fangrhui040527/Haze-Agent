import { z } from 'zod';
import { artifactRefSchema } from './artifacts.js';
import { reductionPreviewRequestSchema } from './damage-reduction-plan.js';
import { reductionPreviewViewSchema } from './damage-reduction-view.js';
import { executionModeSchema, taskStatusSchema } from './tasks.js';
import {
  pilotRecordBodySchema,
  pilotTaskViewSchema,
  pilotProgrammeProjectionSchema,
} from './damage-reduction-pilot.js';
import {
  evaluationRecordBodySchema,
  evaluationTaskViewSchema,
  programmeEvaluationProjectionSchema,
} from './damage-reduction-evaluation.js';

const text = z.string().trim().min(1).max(4096);
const revision = z.number().int().positive();
export const reductionProgrammePhaseSchema = z.enum([
  'assessment',
  'planning',
  'pilot',
  'evaluation',
]);
export const reductionProgrammeBudgetSchema = z.strictObject({
  max_model_calls: z.number().int().min(0).max(400).default(400),
  max_tool_calls: z.number().int().min(0).max(400).default(400),
  max_runs: z.number().int().min(1).max(12).default(12),
  max_attempts_per_phase: z.number().int().min(1).max(3).default(3),
});
export const DEFAULT_REDUCTION_PROGRAMME_BUDGET = {
  max_model_calls: 400,
  max_tool_calls: 400,
  max_runs: 12,
  max_attempts_per_phase: 3,
} as const;
export const reductionProgrammeCreateSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.programme.create.v1'),
  expected_revision: z.literal(0),
  title: z.string().trim().min(1).max(256),
  accountable_owner: text,
  scientific_owner: text.nullable(),
  preview: reductionPreviewRequestSchema,
  pilot_input_ref: artifactRefSchema.nullable().optional(),
  evaluation_input_ref: artifactRefSchema.nullable().optional(),
  evaluation_dossier_ref: artifactRefSchema.nullable().optional(),
  budget: reductionProgrammeBudgetSchema.default(
    DEFAULT_REDUCTION_PROGRAMME_BUDGET,
  ),
});
export const reductionProgrammeRevisionRequestSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.programme.revise.v1'),
  expected_revision: revision,
  reason: text,
  title: z.string().trim().min(1).max(256).optional(),
  accountable_owner: text.optional(),
  scientific_owner: text.nullable().optional(),
  preview: reductionPreviewRequestSchema.optional(),
  pilot_input_ref: artifactRefSchema.nullable().optional(),
  evaluation_input_ref: artifactRefSchema.nullable().optional(),
  evaluation_dossier_ref: artifactRefSchema.nullable().optional(),
  budget: reductionProgrammeBudgetSchema.optional(),
});
export const reductionProgrammePhaseRequestSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.programme.phase.v1'),
  expected_revision: revision,
  phase: reductionProgrammePhaseSchema,
  assessment_attempt_id: z.uuid().optional(),
  planning_attempt_id: z.uuid().optional(),
  registration_id: z.uuid().optional(),
});
export const reductionProgrammeRecordBodySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('note'), text }),
  z.strictObject({
    kind: z.literal('attachment'),
    artifact: artifactRefSchema,
    description: text,
  }),
  ...pilotRecordBodySchema.options,
  ...evaluationRecordBodySchema.options,
]);
export const reductionProgrammeRecordRequestSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.programme.record-request.v1'),
  expected_revision: revision,
  record: reductionProgrammeRecordBodySchema,
});
export const reductionProgrammeSnapshotSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.programme.v1'),
  id: z.uuid(),
  revision,
  mode: executionModeSchema,
  title: z.string().trim().min(1).max(256),
  accountable_owner: text,
  scientific_owner: text.nullable(),
  preview: reductionPreviewRequestSchema,
  pilot_input_ref: artifactRefSchema.nullable().optional(),
  evaluation_input_ref: artifactRefSchema.nullable().optional(),
  evaluation_dossier_ref: artifactRefSchema.nullable().optional(),
  pilot_record_revision: z.number().int().nonnegative().optional(),
  budget: reductionProgrammeBudgetSchema,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export const reductionProgrammeAttemptSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.programme.attempt.v1'),
  id: z.uuid(),
  programme_id: z.uuid(),
  programme_revision: revision,
  phase: reductionProgrammePhaseSchema,
  task_id: z.uuid(),
  run_id: z.uuid(),
  objective_revision: revision,
  input_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  selected_refs: z.array(artifactRefSchema).min(1).max(72),
  predecessor_attempt_id: z.uuid().nullable(),
  assessment_attempt_id: z.uuid().nullable(),
  planning_attempt_id: z.uuid().optional(),
  pilot_input_ref: artifactRefSchema.optional(),
  evaluation_input_ref: artifactRefSchema.optional(),
  evaluation_dossier_ref: artifactRefSchema.nullable().optional(),
  registration_id: z.uuid().optional(),
  reservation: z.strictObject({
    model_calls: z.number().int().nonnegative(),
    tool_calls: z.number().int().nonnegative(),
  }),
  created_at: z.iso.datetime(),
});
export const reductionProgrammeRecordSchema = z.strictObject({
  id: z.uuid(),
  programme_id: z.uuid(),
  programme_revision: revision,
  created_at: z.iso.datetime(),
  record: reductionProgrammeRecordBodySchema,
  task_binding: z
    .strictObject({
      task_id: z.uuid(),
      run_id: z.uuid(),
      objective_revision: revision,
    })
    .nullable(),
  applicability: z.enum(['historical_context', 'programme_record']),
});
export const reductionProgrammeRevisionSchema = z.strictObject({
  programme_id: z.uuid(),
  revision,
  previous_revision: z.number().int().nonnegative(),
  kind: z.enum([
    'create',
    'inputs',
    'metadata',
    'phase',
    'record',
    'task_mutation',
  ]),
  reason: text,
  snapshot: reductionProgrammeSnapshotSchema,
  invalidated_phases: z.array(reductionProgrammePhaseSchema).max(4),
  created_at: z.iso.datetime(),
});
export const reductionProgrammeCapacitySchema = z.strictObject({
  remaining_model_calls: z.number().int().nonnegative(),
  remaining_tool_calls: z.number().int().nonnegative(),
  charged_model_calls: z.number().int().nonnegative(),
  charged_tool_calls: z.number().int().nonnegative(),
  reserved_model_calls: z.number().int().nonnegative(),
  reserved_tool_calls: z.number().int().nonnegative(),
  remaining_runs: z.number().int().nonnegative(),
  remaining_attempts: z.strictObject({
    assessment: z.number().int().nonnegative(),
    planning: z.number().int().nonnegative(),
    pilot: z.number().int().nonnegative().optional(),
    evaluation: z.number().int().nonnegative().optional(),
  }),
  active_attempt_id: z.uuid().nullable(),
});
export const reductionProgrammeAttemptViewSchema = z.strictObject({
  attempt: reductionProgrammeAttemptSchema,
  execution_status: z.union([taskStatusSchema, z.literal('unavailable')]),
  currency: z.enum(['current', 'stale', 'historical']),
  result_status: z.enum(['pending', 'available', 'gap', 'unavailable']),
  preview: reductionPreviewViewSchema.nullable(),
  pilot: pilotTaskViewSchema.nullable().optional(),
  evaluation: evaluationTaskViewSchema.nullable().optional(),
  historical_artifact_refs: z.array(artifactRefSchema).max(128),
  reasons: z.array(text).max(32),
});
export const reductionProgrammeViewSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.programme.view.v1'),
  programme: reductionProgrammeSnapshotSchema,
  capacity: reductionProgrammeCapacitySchema,
  attempts: z.array(reductionProgrammeAttemptViewSchema).max(12),
  records: z.array(reductionProgrammeRecordSchema).max(256),
  pilot: pilotProgrammeProjectionSchema.optional(),
  evaluation: programmeEvaluationProjectionSchema.optional(),
  scientific_qualification: z.enum([
    'unqualified',
    'conditional',
    'qualified',
    'withdrawn',
  ]),
  achieved_reduction: z.boolean(),
});
export const reductionProgrammeListSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.programme.list.v1'),
  programmes: z.array(reductionProgrammeSnapshotSchema).max(100),
  next_offset: z.number().int().nonnegative().nullable(),
});
export const reductionProgrammeHistorySchema = z.strictObject({
  schema_version: z.literal('haze.reduction.programme.history.v1'),
  revisions: z.array(reductionProgrammeRevisionSchema).max(100),
  attempts: z.array(reductionProgrammeAttemptSchema).max(12),
  records: z.array(reductionProgrammeRecordSchema).max(256),
  next_offset: z.number().int().nonnegative().nullable(),
});
export const reductionProgrammeMutationReceiptSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.programme.receipt.v1'),
  programme_id: z.uuid(),
  revision,
  operation: z.enum(['create', 'revise', 'phase', 'record', 'task_mutation']),
  attempt: reductionProgrammeAttemptSchema.nullable(),
});
export type ReductionProgrammePhase = z.infer<
  typeof reductionProgrammePhaseSchema
>;
export type ReductionProgrammeBudget = z.infer<
  typeof reductionProgrammeBudgetSchema
>;
export type ReductionProgrammeSnapshot = z.infer<
  typeof reductionProgrammeSnapshotSchema
>;
export type ReductionProgrammeAttempt = z.infer<
  typeof reductionProgrammeAttemptSchema
>;
export type ReductionProgrammeRecord = z.infer<
  typeof reductionProgrammeRecordSchema
>;
export type ReductionProgrammeRevision = z.infer<
  typeof reductionProgrammeRevisionSchema
>;
export type ReductionProgrammeCapacity = z.infer<
  typeof reductionProgrammeCapacitySchema
>;
export type ReductionProgrammeAttemptView = z.infer<
  typeof reductionProgrammeAttemptViewSchema
>;
export type ReductionProgrammeView = z.infer<
  typeof reductionProgrammeViewSchema
>;
export type ReductionProgrammeMutationReceipt = z.infer<
  typeof reductionProgrammeMutationReceiptSchema
>;
export type ReductionProgrammeCreate = z.infer<
  typeof reductionProgrammeCreateSchema
>;
export type ReductionProgrammeRevisionRequest = z.infer<
  typeof reductionProgrammeRevisionRequestSchema
>;
export type ReductionProgrammePhaseRequest = z.infer<
  typeof reductionProgrammePhaseRequestSchema
>;
export type ReductionProgrammeRecordRequest = z.infer<
  typeof reductionProgrammeRecordRequestSchema
>;
export type ReductionProgrammeList = z.infer<
  typeof reductionProgrammeListSchema
>;
export type ReductionProgrammeHistory = z.infer<
  typeof reductionProgrammeHistorySchema
>;
