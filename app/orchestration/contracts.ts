import { z } from 'zod';
import { artifactRefSchema } from '../contracts/artifacts.js';
export const assignmentOutputSchema = z.strictObject({
  status: z.enum(['completed', 'waiting_human', 'waiting_peer']),
  summary: z.string().min(1).max(10000),
  support: z.enum(['supported', 'partial', 'gap']),
  uncertainty: z.array(z.string().min(1).max(4096)).max(64),
  outputs: z.array(artifactRefSchema).max(256),
});
export const agentActionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    id: z.string().min(1).max(128),
    type: z.literal('tool'),
    tool: z.string().min(1),
    input: z.unknown(),
  }),
  z.strictObject({
    id: z.string().min(1).max(128),
    type: z.literal('save'),
    kind: z.string().min(1).max(128),
    content: z.unknown(),
  }),
  z.strictObject({
    id: z.string().min(1).max(128),
    type: z.literal('question'),
    prompt: z.string().min(1).max(2000),
  }),
  z.strictObject({
    id: z.string().min(1).max(128),
    type: z.literal('message'),
    recipient: z.string().min(1),
    purpose: z.string().min(1).max(256),
    text: z.string().min(1).max(2048),
  }),
  z.strictObject({ id: z.string().min(1).max(128), type: z.literal('wait') }),
  z.strictObject({
    id: z.string().min(1).max(128),
    type: z.literal('finish'),
    summary: z.string().min(1).max(10000),
    support: z.enum(['supported', 'partial', 'gap']),
    uncertainty: z.array(z.string().max(2000)).max(32),
    outputs: z.array(artifactRefSchema).max(64),
  }),
]);
export const managerPlanSchema = z.discriminatedUnion('type', [
  z.strictObject({
    id: z.string().min(1).max(128),
    type: z.literal('delegate'),
    capability: z.string().min(1),
    assignments: z
      .array(
        z.strictObject({
          key: z.string().min(1).max(128),
          definition_id: z.string().min(1),
          brief: z.string().min(1).max(2000),
          depends_on: z.array(z.string()).max(16),
          input: z.unknown().optional(),
        }),
      )
      .min(1)
      .max(16),
  }),
  z.strictObject({
    id: z.string().min(1).max(128),
    type: z.literal('question'),
    prompt: z.string().min(1).max(2000),
  }),
  z.strictObject({
    id: z.string().min(1).max(128),
    type: z.literal('respond'),
    answer: z.string().min(1).max(10000),
    uncertainty: z.array(z.string()).max(32),
  }),
]);
export type AgentAction = z.infer<typeof agentActionSchema>;
