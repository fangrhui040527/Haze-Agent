import { z } from 'zod';
import { artifactRefSchema, boundedJsonSchema } from './artifacts.js';

/** Includes the JSON envelope added for the one permitted correction turn. */
export const MANAGER_DECISION_FEEDBACK_MAX_BYTES = 1024;

const text = z.string().min(1).max(4096);
const revision = z.number().int().nonnegative();
export const managerInterpretationSchema = z.strictObject({
  scope: z.string().min(1).max(16000),
  deliverables: z.array(text).max(32),
  assumptions: z.array(text).max(64),
  intended_use: text,
  stopping_conditions: z.array(text).max(32),
});
export const managerAssignmentPlanSchema = z.strictObject({
  key: z.string().min(1).max(128),
  definition_id: z.string().min(1).max(256),
  brief: z.string().min(1).max(16000),
  depends_on: z.array(z.string().min(1)).max(64),
  input: boundedJsonSchema.optional(),
  max_model_calls: revision.optional(),
});
export const managerActionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('inspect'),
    artifacts: z.array(artifactRefSchema).min(1).max(32),
  }),
  z.strictObject({
    type: z.literal('lookup'),
    tool: text,
    input: boundedJsonSchema,
  }),
  z.strictObject({
    type: z.literal('apply_plan'),
    assignments: z.array(managerAssignmentPlanSchema).max(16),
    retain_assignment_ids: z.array(z.uuid()).max(64),
    reason: text,
  }),
  z.strictObject({
    type: z.literal('steer'),
    assignment_id: z.uuid(),
    operation: z.enum(['retire', 'rebrief']),
    brief: text.optional(),
    input: boundedJsonSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('coordinate'),
    participants: z.tuple([
      z.strictObject({
        assignment_id: z.uuid(),
        revision: z.number().int().positive(),
      }),
      z.strictObject({
        assignment_id: z.uuid(),
        revision: z.number().int().positive(),
      }),
    ]),
    purpose: z.string().min(1).max(256),
  }),
  z.strictObject({
    type: z.literal('applicability'),
    artifact: artifactRefSchema,
    applicable: z.boolean(),
    reason: text,
  }),
  z.strictObject({
    type: z.literal('question'),
    prompt: z.string().min(1).max(2000),
  }),
  z.strictObject({ type: z.literal('wait'), reason: text }),
  z.strictObject({
    type: z.literal('finalize'),
    answer: z.string().min(1).max(32000),
    work_products: z.array(artifactRefSchema).max(256),
    sources: z.array(artifactRefSchema).max(256),
    uncertainty: z.array(text).max(64),
    unfinished: z.array(text).max(64),
    nightshift_unresolved_jobs: z.array(z.uuid()).max(4).optional(),
  }),
]);
export const managerDecisionSchema = z.strictObject({
  id: z.string().min(1).max(128),
  recovery_of: z.string().min(1).max(128).optional(),
  run_id: z.uuid(),
  generation: z.number().int().positive(),
  objective_revision: z.number().int().positive(),
  plan_revision: revision,
  event_cursor: revision,
  explanation: text,
  references: z.array(artifactRefSchema).max(256),
  interpretation: managerInterpretationSchema.optional(),
  action: managerActionSchema,
});
export const managerInspectionSchema = z.strictObject({
  artifact: artifactRefSchema,
  run_id: z.uuid(),
  objective_revision: z.number().int().positive(),
  plan_revision: revision,
  excerpt: z.string().max(12000),
  inspected_at: z.string(),
});
export const managerPlanRevisionSchema = z.strictObject({
  revision: revision,
  objective_revision: z.number().int().positive(),
  decision_id: z.string(),
  reason: text,
  assignment_revisions: z
    .array(
      z.strictObject({ id: z.uuid(), revision: z.number().int().positive() }),
    )
    .max(256),
  created_at: z.string(),
});
export const managerDispatchReceiptSchema = z.strictObject({
  decision_id: z.string(),
  run_id: z.uuid(),
  objective_revision: z.number().int().positive(),
  plan_revision: revision,
  applied_plan_revision: revision,
  status: z.literal('applied'),
  result: boundedJsonSchema,
  created_at: z.string(),
});
export const managerStateSchema = z.strictObject({
  version: z.literal('manager.v4'),
  run_id: z.uuid(),
  plan_revision: revision,
  last_handled_event_cursor: revision,
  coordinator_assignment_id: z.uuid().optional(),
  interpretation: managerInterpretationSchema.optional(),
  plans: z.array(managerPlanRevisionSchema),
  decisions: z.array(
    z.strictObject({ decision: managerDecisionSchema, created_at: z.string() }),
  ),
  inspections: z.array(managerInspectionSchema),
  pending_events: z.array(boundedJsonSchema),
  dispatch_receipts: z.array(managerDispatchReceiptSchema),
  upgrade_required: z.string().optional(),
});
export const artifactReviewCheckSchema = z.strictObject({
  artifact: artifactRefSchema,
  producer_assignment_id: z.uuid(),
  producer_revision: z.number().int().positive(),
  reviewer_assignment_id: z.uuid().optional(),
  reviewer_revision: z.number().int().positive().optional(),
  verdict: z.enum(['supported', 'rejected', 'needs_review']),
  review_artifact: artifactRefSchema.optional(),
  limitations: z.array(text).max(64),
});
export type ManagerInterpretation = z.infer<typeof managerInterpretationSchema>;
export type ManagerDecision = z.infer<typeof managerDecisionSchema>;
export type ManagerAction = z.infer<typeof managerActionSchema>;
export type ManagerState = z.infer<typeof managerStateSchema>;
export type ManagerInspection = z.infer<typeof managerInspectionSchema>;
export type ManagerDispatchReceipt = z.infer<
  typeof managerDispatchReceiptSchema
>;
export type ArtifactReviewCheck = z.infer<typeof artifactReviewCheckSchema>;

import type { ArtifactRef } from './artifacts.js';
import type { CapabilityCard } from './capabilities.js';
import type {
  Assignment,
  Correction,
  TaskEvent,
  TaskRecord,
  TaskRequest,
} from './tasks.js';
type AssignmentPlan = z.infer<typeof managerAssignmentPlanSchema>;
export interface ManagerContext {
  purpose: 'decision';
  /** Runtime-provided identifier for this exact decision checkpoint. */
  decision_id?: string;
  run_id: string;
  generation: number;
  objective_revision: number;
  plan_revision: number;
  event_cursor: number;
  plan_objective_revision: number;
  source_applicability: { id: string; current: boolean }[];
  /** Exact CURRENT source.import originals, indexed into request refs then correction refs, in that order. */
  current_import_context_ref_indices?: number[];
  request: TaskRequest;
  corrections: Correction[];
  interpretation?: Partial<ManagerInterpretation>;
  capabilities: {
    card: Pick<CapabilityCard, 'id'> &
      Partial<Pick<CapabilityCard, 'version' | 'purpose' | 'readiness'>>;
    available: boolean;
    reasons?: string[];
    templates?: AssignmentPlan[];
    exact_templates?: boolean;
    renders_answer?: boolean;
    peer_requirements?: { definitions: [string, string]; purpose: string }[];
    prerequisites?: {
      definition_id: string;
      depends_on_definitions: string[];
    }[];
    review_requirements?: {
      artifact_kind: string;
      review_definition_id: string;
      producer_definition_ids?: string[];
    }[];
  }[];
  definitions: {
    id: string;
    capability: string;
    agent: string;
    tools: string[];
  }[];
  lookups: { id: string; description: string }[];
  assignments: (Pick<
    Assignment,
    'id' | 'role' | 'revision' | 'status' | 'support' | 'usability' | 'error'
  > &
    Partial<
      Pick<
        Assignment,
        | 'definition_id'
        | 'capability'
        | 'objective_revision'
        | 'brief'
        | 'dependencies'
        | 'gaps'
      >
    >)[];
  artifacts: {
    ref: ArtifactRef;
    kind: string;
    assignment_id?: string;
    /** Compact context-only producer link into the zero-based assignments array. */
    assignment_index?: number;
    assignment_revision?: number;
    current: boolean;
    excerpt?: string;
    truncated?: boolean;
    /** Final-synthesis citation letter: S for imported sources, E for captures. */
    /** Present (S) only for user-supplied sources; every other artifact cites as E. */
    citation_letter?: 'S';
  }[];
  inspections: ManagerInspection[];
  peer_grants: {
    participants: { assignment_id: string; revision: number }[];
    purpose: string;
  }[];
  /** Compact checks may point to an exact artifact catalog entry by ID. */
  reviews: (Omit<
    ArtifactReviewCheck,
    'artifact' | 'producer_assignment_id' | 'producer_revision'
  > & {
    artifact: ArtifactRef | Pick<ArtifactRef, 'id'>;
    producer_assignment_id?: string;
    producer_revision?: number;
  })[];
  resources: {
    limits: TaskRecord['limits'];
    usage: TaskRecord['usage'];
    remaining_model_calls: number;
    remaining_tool_calls: number;
  };
  events: Pick<
    TaskEvent,
    'cursor' | 'type' | 'message' | 'assignment_id' | 'data'
  >[];
  context_status: {
    truncated: boolean;
    omitted_artifacts: number;
    omitted_events: number;
    missing: string[];
    bytes: number;
  };
}
