import { z } from 'zod';
import { identifierSchema } from '../contracts/common.js';
import { demoChatResponseSchema } from './chat-contract.js';

export const demoAgentIds = [
  'manager',
  'hazeops',
  'worldmodel',
  'hmem',
  'evidencecritic',
  'workershield',
] as const;
export const demoAgentFactIds = [
  'sample_scope',
  'checked_comparison',
  'selected_candidate',
  'worker_constraints',
  'evidence_status',
  'pending_review',
  'world_readback',
  'memory_recall',
] as const;
const agentId = z.enum(demoAgentIds);
const base = {
  runId: identifierSchema,
  at: z.iso.datetime(),
  message: z.string().max(2000),
};

/** Shared browser/server events. Activity is emitted around actual work, never timers. */
export const demoAgentEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...base,
    type: z.literal('run_started'),
    executionKind: z.enum(['agents', 'local_check']).optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('run_state'),
    state: z.enum(['queued', 'running']),
  }),
  z.strictObject({
    ...base,
    type: z.literal('agent_thinking'),
    agent: agentId,
  }),
  z.strictObject({
    ...base,
    type: z.literal('agent_moving'),
    agent: agentId,
    to: z.enum(['office', 'reception']),
  }),
  z.strictObject({
    ...base,
    type: z.literal('handoff'),
    from: agentId,
    to: z.array(agentId).min(1).max(6),
    payloadLabel: z.string().max(200),
  }),
  z.strictObject({ ...base, type: z.literal('agent_working'), agent: agentId }),
  z.strictObject({
    ...base,
    type: z.literal('agent_completed'),
    agent: agentId,
  }),
  z.strictObject({ ...base, type: z.literal('run_completed') }),
  z.strictObject({
    ...base,
    type: z.literal('run_failed'),
    agent: agentId.nullable(),
    error: z.string().max(2000),
    retryable: z.boolean(),
  }),
  z.strictObject({ ...base, type: z.literal('run_cancelled') }),
]);

/** Live execution receipts are separate from the unchanged historical domain artifacts. */
export const demoAgentExecutionSchema = z
  .strictObject({
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
    steps: z
      .array(
        z.strictObject({
          agent: agentId,
          kind: z.enum(['model', 'engine']),
          summary: z.string().trim().min(1).max(8000),
          fact_ids: z.array(z.enum(demoAgentFactIds)).min(1).max(8).optional(),
        }),
      )
      .length(6),
  })
  .superRefine((execution, context) => {
    for (const id of demoAgentIds) {
      const matches = execution.steps.filter((step) => step.agent === id);
      if (
        matches.length !== 1 ||
        matches[0]?.kind !==
          (id === 'worldmodel' || id === 'hmem' ? 'engine' : 'model')
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Each displayed role must have exactly one truthful execution receipt',
        });
      }
    }
  });

export const demoAgentStreamFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('event'), event: demoAgentEventSchema }),
  z.strictObject({
    type: z.literal('result'),
    run_id: identifierSchema,
    paragraphs: z.array(z.string().trim().min(1).max(8000)).min(1).max(8),
    scheduling: demoChatResponseSchema,
    execution: demoAgentExecutionSchema,
  }),
]);

export type DemoAgentEvent = z.infer<typeof demoAgentEventSchema>;
export type DemoAgentExecution = z.infer<typeof demoAgentExecutionSchema>;
export type DemoAgentStreamFrame = z.infer<typeof demoAgentStreamFrameSchema>;
export type DemoAgentResult = Extract<DemoAgentStreamFrame, { type: 'result' }>;
