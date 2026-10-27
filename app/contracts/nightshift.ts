import { z } from 'zod';
import { artifactRefSchema } from './artifacts.js';
import { agentRoleSchema } from './capabilities.js';
import {
  nightshiftProgressSchema,
  nightshiftPurposeSchema,
} from './nightshift-chains.js';

export const NIGHTSHIFT_LIMITS = Object.freeze({
  prompt_characters: 12_000,
  result_characters: 65_536,
  metadata_bytes: 65_536,
  attempts: 16,
});
export const nightshiftPrivacySchema = z.enum(['local-only', 'cloud-ok']);
// The installed Nightshift CLI supports uncapped cloud jobs or local-only $0
// jobs. It cannot enforce a positive monetary cap before a provider call.
export const nightshiftSpendSchema = z.literal(0).nullable();
export function validateNightshiftPolicy(
  value: { privacy: string; max_spend_usd: number | null },
  context: z.RefinementCtx,
): void {
  if ((value.privacy === 'local-only') !== (value.max_spend_usd === 0))
    context.addIssue({
      code: 'custom',
      path: ['max_spend_usd'],
      message:
        'Local-only jobs require $0 cloud spend; cloud jobs require null (no monetary cap).',
    });
}
export const nightshiftAuthorityShape = {
  expected_run_id: z.uuid(),
  expected_generation: z.number().int().positive(),
  expected_objective_revision: z.number().int().positive(),
  expected_state_revision: z.number().int().nonnegative(),
  expected_assignment_id: z.uuid().optional(),
  expected_assignment_revision: z.number().int().positive().optional(),
};
export const manualChainAdmissionSchema = z
  .strictObject({
    schema_version: z.literal('haze.nightshift.chain.admission.v1'),
    task_id: z.uuid(),
    ...nightshiftAuthorityShape,
    total_runs: z.number().int().min(1).max(4).default(1),
    max_jobs: z.number().int().min(1).max(4).default(4),
    max_attempts: z.number().int().min(1).max(16).default(16),
    lifetime_seconds: z.number().int().min(1).max(86_400).default(86_400),
    privacy: nightshiftPrivacySchema.default('cloud-ok'),
    max_spend_usd: nightshiftSpendSchema.default(null),
    automatic_followup_runs: z.literal(0).default(0),
  })
  .superRefine(validateNightshiftPolicy);
export const automaticChainAdmissionSchema = z
  .strictObject({
    ...manualChainAdmissionSchema.shape,
    schema_version: z.literal('haze.nightshift.chain.admission.v2'),
    automatic_opt_in: z.literal(true),
    automatic_followup_runs: z.number().int().min(1).max(3),
    initial_progress: nightshiftProgressSchema,
    previous_chain_id: z.uuid().optional(),
  })
  .refine((value) => value.automatic_followup_runs < value.total_runs, {
    message: 'Automatic follow-ups must fit inside the total run grant.',
    path: ['automatic_followup_runs'],
  })
  .superRefine(validateNightshiftPolicy);
export const chainAdmissionSchema = z.discriminatedUnion('schema_version', [
  manualChainAdmissionSchema,
  automaticChainAdmissionSchema,
]);
export const manualChainControlSchema = z.strictObject({
  schema_version: z.literal('haze.nightshift.chain.control.v1'),
  ...nightshiftAuthorityShape,
  expected_chain_revision: z.number().int().positive(),
  action: z.enum(['pause', 'resume', 'cancel', 'close']),
});
export const automaticChainControlSchema = manualChainControlSchema.extend({
  schema_version: z.literal('haze.nightshift.chain.control.v2'),
});
export const chainControlSchema = z.discriminatedUnion('schema_version', [
  manualChainControlSchema,
  automaticChainControlSchema,
]);
export const chainProgressProposalSchema = z.strictObject({
  schema_version: z.literal('haze.nightshift.chain.progress.proposal.v1'),
  ...nightshiftAuthorityShape,
  expected_chain_revision: z.number().int().positive(),
  progress: nightshiftProgressSchema,
});
export const nightshiftJobOptionsSchema = z
  .strictObject({
    prompt: z.string().trim().min(1).max(NIGHTSHIFT_LIMITS.prompt_characters),
    n: z.number().int().min(1).max(16).default(4),
    judge: z
      .enum(['accuracy', 'consistency', 'creative', 'quality'])
      .default('accuracy'),
    budget: z.enum(['low', 'mid', 'high', 'max']).default('low'),
    window: z.enum(['now', 'quiet']).default('now'),
    fleet: z.string().trim().min(1).max(128).optional(),
    privacy: nightshiftPrivacySchema.default('cloud-ok'),
    max_spend_usd: nightshiftSpendSchema.default(null),
  })
  .superRefine(validateNightshiftPolicy);
export const jobSubmitSchema = z
  .strictObject({
    schema_version: z.literal('haze.nightshift.job.submit.v1'),
    chain_id: z.uuid(),
    ...nightshiftAuthorityShape,
    expected_chain_revision: z.number().int().positive(),
    ...nightshiftJobOptionsSchema.shape,
    input_refs: z.array(artifactRefSchema).max(32).default([]),
    role: agentRoleSchema.default('Manager'),
    purpose: nightshiftPurposeSchema.optional(),
  })
  .superRefine(validateNightshiftPolicy);
const jobControlShape = {
  ...nightshiftAuthorityShape,
  expected_chain_revision: z.number().int().positive(),
  expected_job_revision: z.number().int().positive(),
};
export const jobCancelSchema = z.strictObject({
  schema_version: z.literal('haze.nightshift.job.cancel.v1'),
  ...jobControlShape,
});
export const jobReconcileSchema = z.strictObject({
  schema_version: z.literal('haze.nightshift.job.reconcile.v1'),
  ...jobControlShape,
  remote_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/u),
});
export const jobSelectSchema = z.strictObject({
  schema_version: z.literal('haze.nightshift.job.select.v1'),
  ...jobControlShape,
  candidate: artifactRefSchema,
  input_refs: z.array(artifactRefSchema).max(32),
  reviewed: z.literal(false).default(false),
});
export type NightshiftAuthority = z.infer<typeof chainControlSchema>;
export type NightshiftChainAdmission = z.infer<typeof chainAdmissionSchema>;
export type NightshiftChainControl = z.infer<typeof chainControlSchema>;
export type NightshiftJobSubmission = z.infer<typeof jobSubmitSchema>;
export type NightshiftJobCancel = z.infer<typeof jobCancelSchema>;
export type NightshiftJobReconcile = z.infer<typeof jobReconcileSchema>;
export type NightshiftJobSelect = z.infer<typeof jobSelectSchema>;
export type NightshiftSubmitRequest = z.infer<
  typeof nightshiftJobOptionsSchema
>;

export const jobsReadinessSchema = z.strictObject({
  schema_version: z.literal('haze.nightshift.jobs.readiness.v1'),
  checked_at: z.string(),
  cli_available: z.boolean(),
  schema_compatible: z.boolean(),
  runtime_reachable: z.boolean(),
  local_only_enforced: z.boolean(),
  local_compute_available: z.boolean().optional(),
  cloud_compute_available: z.boolean().optional(),
  cloud_enforced: z.boolean(),
  ready: z.boolean(),
  runtime_version: z.string().nullable(),
  adapter_version: z.string(),
  schema_hash: z.string().nullable(),
  can_reconcile: z.boolean(),
  reason: z.string().nullable(),
  /** Reviewed source-set and ready cloud-lane fingerprints bound by release evidence. */
  installation_fingerprint: z.string().nullable().optional(),
  roster_fingerprint: z.string().nullable().optional(),
  cancellation_idempotent: z.literal(false),
  options: z.strictObject({
    judges: z.array(z.string()),
    budgets: z.array(z.string()),
    windows: z.array(z.string()),
    max_attempts: z.number().int().positive(),
    fleets: z.array(z.string()).default([]),
  }),
});
export type NightshiftJobReadiness = z.infer<typeof jobsReadinessSchema>;
export interface NightshiftRemoteJob {
  remote_id: string;
  execution_state: string;
  terminal: boolean;
  generated: number | null;
  requested_attempts: number | null;
  privacy: string | null;
  fleet: string | null;
  runtime_version: string | null;
  native_execution_state?: string | null;
  failure_code?: string | null;
}
export interface NightshiftRemoteOutcome {
  status: 'accepted' | 'rejected' | 'undecided' | 'unknown';
  basis: string | null;
  explanation: string | null;
}
export interface NightshiftAttemptMetadata {
  seq: number;
  lane: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  reported_tokens?: number | null;
  tokens_source?: string | null;
  finish_reason: string | null;
  receipt_id: string | null;
  prompt_sha256: string | null;
}
export interface NightshiftRemoteResult {
  text: string | null;
  attempts: NightshiftAttemptMetadata[];
  winner_seq: number | null;
  retrieval_error: string | null;
  truncated: false;
}
