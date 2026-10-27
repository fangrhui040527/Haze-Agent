import { z } from 'zod';
import { artifactRefSchema } from '../contracts/artifacts.js';
import {
  nightshiftJobOptionsSchema,
  NIGHTSHIFT_LIMITS,
  validateNightshiftPolicy,
} from '../contracts/nightshift.js';
import { TaskError } from '../contracts/tasks.js';
import { nightshiftProgressSchema } from '../contracts/nightshift-chains.js';
import type {
  ExecutionMode,
  ToolContext,
  ToolDefinition,
} from '../orchestration/ports.js';

export const NIGHTSHIFT_TOOL_IDS = [
  'nightshift.submit',
  'nightshift.result',
  'nightshift.cancel',
] as const;
export type NightshiftToolId = (typeof NIGHTSHIFT_TOOL_IDS)[number];

/** Identity, revisions and route authority are supplied by the host, never the model. */
export const nightshiftSubmitToolSchema = z
  .strictObject({
    schema_version: z.literal('haze.nightshift.tool.submit.v1'),
    chain_id: z.uuid(),
    expected_chain_revision: z.number().int().positive(),
    purpose: z.enum([
      'evidence_linked_draft',
      'alternative_explanation',
      'critique_candidate',
    ]),
    ...nightshiftJobOptionsSchema.shape,
    input_refs: z.array(artifactRefSchema).min(1).max(32),
    progress: nightshiftProgressSchema.optional(),
  })
  .superRefine(validateNightshiftPolicy);
export const nightshiftResultToolSchema = z
  .strictObject({
    schema_version: z.literal('haze.nightshift.tool.result.v1'),
    job_id: z.uuid(),
    decision: z
      .enum(['use_candidate', 'partial_result', 'replan', 'supported_failure'])
      .optional(),
    reason: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((value) => !value.decision || Boolean(value.reason), {
    message: 'An explicit result decision needs its bounded reason.',
    path: ['reason'],
  });
export const nightshiftCancelToolSchema = z.strictObject({
  schema_version: z.literal('haze.nightshift.tool.cancel.v1'),
  job_id: z.uuid(),
  expected_job_revision: z.number().int().positive(),
  expected_chain_revision: z.number().int().positive(),
});
export const nightshiftToolOutputSchema = z.strictObject({
  schema_version: z.literal('haze.nightshift.tool.output.v1'),
  job_id: z.uuid(),
  chain_id: z.uuid(),
  chain_revision: z.number().int().positive(),
  job_revision: z.number().int().positive(),
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
  remote_acknowledged: z.boolean(),
  candidate: artifactRefSchema.nullable(),
  output: z.string().max(NIGHTSHIFT_LIMITS.result_characters).nullable(),
  requires_independent_review: z.literal(true),
  stop_reason: z.string().max(2000).nullable(),
});
export type NightshiftSubmitToolInput = z.infer<
  typeof nightshiftSubmitToolSchema
>;
export type NightshiftResultToolInput = z.infer<
  typeof nightshiftResultToolSchema
>;
export type NightshiftCancelToolInput = z.infer<
  typeof nightshiftCancelToolSchema
>;
export type NightshiftToolOutput = z.infer<typeof nightshiftToolOutputSchema>;

/**
 * Registration describes the transport contract only. The runtime dispatches
 * through its receipt-backed operation path and rechecks explicit task and
 * assignment grants. A metadata-only registry cannot perform an external effect.
 */
export function createNightshiftTools(
  mode: ExecutionMode,
  execute?: (
    id: NightshiftToolId,
    input: unknown,
    context: ToolContext,
  ) => Promise<NightshiftToolOutput>,
): ToolDefinition[] {
  const dispatch = (
    id: NightshiftToolId,
    input: unknown,
    context: ToolContext,
  ) => {
    if (!execute)
      throw new TaskError(
        403,
        'nightshift_execution_unavailable',
        'Nightshift tools require the controlled runtime operation boundary.',
      );
    return execute(id, input, context);
  };
  return [
    {
      id: 'nightshift.submit',
      version: 'nightshift-submit.v1',
      mode,
      description:
        'Submit one candidate job inside an existing explicit chain grant, matching its privacy and spending policy. New grants default to cloud-ok with no cloud spend cap; local-only grants require $0 cloud spend. Use exact evidence references. Retrieval, calculations and independent checks require registered Haze capabilities. Returns a local job handle; unknown submission must never be retried automatically.',
      inputSchema: nightshiftSubmitToolSchema,
      outputSchema: nightshiftToolOutputSchema,
      execute: (input, context) =>
        dispatch('nightshift.submit', input, context),
    },
    {
      id: 'nightshift.result',
      version: 'nightshift-result.v1',
      mode,
      description:
        'Read the matching local job and retained unreviewed candidate under current assignment authority. Explicitly resolve a delivered required dependency with a reason. Candidate use does not establish evidence acceptance or applicability; failed or cancelled jobs need a supported_failure, partial_result or replan decision.',
      inputSchema: nightshiftResultToolSchema,
      outputSchema: nightshiftToolOutputSchema,
      execute: (input, context) =>
        dispatch('nightshift.result', input, context),
    },
    {
      id: 'nightshift.cancel',
      version: 'nightshift-cancel.v1',
      mode,
      description:
        'Request cancellation of one acknowledged local job with current revisions. An acknowledgment does not prove remote termination or release unknown charges.',
      inputSchema: nightshiftCancelToolSchema,
      outputSchema: nightshiftToolOutputSchema,
      execute: (input, context) =>
        dispatch('nightshift.cancel', input, context),
    },
  ];
}
