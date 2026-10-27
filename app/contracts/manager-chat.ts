import { z } from 'zod';
import { timestampSchema } from './common.js';
import { mutationExpectationSchema } from './controls.js';

export const managerChatQuestionSchema = z.strictObject({
  task_id: z.uuid(),
  question_id: z.uuid(),
  ...mutationExpectationSchema.shape,
});

export const managerChatRequestSchema = z
  .strictObject({
    schema_version: z.literal('haze.manager.chat.request.v1'),
    conversation_id: z.uuid(),
    turn_id: z.uuid(),
    message: z.string().trim().min(1).max(16000),
    history: z
      .array(
        z.strictObject({
          role: z.enum(['user', 'manager']),
          text: z.string().min(1).max(16000),
        }),
      )
      .max(24)
      .default([]),
    selected_item_id: z.string().min(1).max(256).optional(),
    task_questions: z.array(managerChatQuestionSchema).max(24).default([]),
    answer_to: managerChatQuestionSchema.optional(),
    nightshift_permission_id: z.uuid().optional(),
    nightshift_tools: z
      .array(
        z.enum(['nightshift.submit', 'nightshift.result', 'nightshift.cancel']),
      )
      .max(3)
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.nightshift_tools?.length && !value.nightshift_permission_id)
      context.addIssue({
        code: 'custom',
        message: 'Next task permissions require a one-use grant identity.',
      });
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536)
      context.addIssue({
        code: 'custom',
        message: 'Conversation context exceeds 64 KiB.',
      });
  });

export const managerChatCitationSchema = z.strictObject({
  id: z.string().min(1).max(256),
  label: z.string().min(1).max(4096),
  href: z.string().min(1).max(4096).optional(),
  observed_at: timestampSchema.optional(),
  retrieved_at: timestampSchema.optional(),
  kind: z
    .enum(['observed', 'modeled', 'stored', 'synthetic_fixture'])
    .optional(),
});

export const managerChatErrorSchema = z.strictObject({
  category: z.enum([
    'model_unavailable',
    'model_output_invalid',
    'source_unavailable',
    'transport_failure',
    'task_response_invalid',
    'task_conflict',
    'task_admission_failed',
  ]),
  retryable: z.boolean(),
});

export const managerChatTaskSchema = z.strictObject({
  task_id: z.uuid(),
  title: z.string().min(1).max(240),
  summary: z.string().min(1).max(4096),
  status_url: z.string().min(1).max(4096),
});

export const managerChatResponseSchema = z
  .strictObject({
    schema_version: z.literal('haze.manager.chat.response.v1'),
    kind: z.enum(['reply', 'clarification', 'task_admitted', 'task_updated']),
    paragraphs: z.array(z.string().min(1).max(16000)).min(1).max(16),
    citations: z.array(managerChatCitationSchema).max(32),
    task: managerChatTaskSchema.optional(),
    error: managerChatErrorSchema.optional(),
  })
  .superRefine((value, context) => {
    if (['task_admitted', 'task_updated'].includes(value.kind) && !value.task)
      context.addIssue({
        code: 'custom',
        message: 'Task responses require a task identity.',
      });
    if (
      new Set(value.citations.map(({ id }) => id)).size !==
      value.citations.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Conversation citations must be unique.',
      });
  });

export type ManagerChatRequest = z.infer<typeof managerChatRequestSchema>;
export type ManagerChatResponse = z.infer<typeof managerChatResponseSchema>;
export type ManagerChatQuestion = z.infer<typeof managerChatQuestionSchema>;
export type ManagerChatCitation = z.infer<typeof managerChatCitationSchema>;
export type ManagerChatError = z.infer<typeof managerChatErrorSchema>;
