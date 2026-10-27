import { z } from 'zod';
import {
  nightshiftJobSchema,
  type NightshiftJob,
} from './nightshift-records.js';

/** Inbox rows never carry prompt/output/attempt bodies; details are read explicitly. */
export const nightshiftJobSummarySchema = nightshiftJobSchema
  .pick({
    id: true,
    task_id: true,
    chain_id: true,
    revision: true,
    created_at: true,
    updated_at: true,
    execution_state: true,
    cancellation: true,
    candidate: true,
    review_status: true,
  })
  .extend({
    schema_version: z.literal('haze.nightshift.job.summary.v1'),
    judge_status: z.enum(['accepted', 'rejected', 'undecided', 'unknown']),
    receipt_available: z.boolean(),
  });
export type NightshiftJobSummary = z.infer<typeof nightshiftJobSummarySchema>;
export function summarizeNightshiftJob(
  job: NightshiftJob,
): NightshiftJobSummary {
  return {
    schema_version: 'haze.nightshift.job.summary.v1',
    id: job.id,
    task_id: job.task_id,
    chain_id: job.chain_id,
    revision: job.revision,
    created_at: job.created_at,
    updated_at: job.updated_at,
    execution_state: job.execution_state,
    cancellation: job.cancellation,
    candidate: true,
    review_status: 'unreviewed',
    judge_status: job.judge_outcome.status,
    receipt_available: job.receipt !== null,
  };
}
