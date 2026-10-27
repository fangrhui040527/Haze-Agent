import { z } from 'zod';
import { artifactRefSchema } from './artifacts.js';

const revision = z.number().int().positive();
export const externalDependencySchema = z.strictObject({
  job_id: z.uuid(),
  required: z.boolean(),
});
const dependenciesSchema = z
  .array(externalDependencySchema)
  .min(1)
  .max(4)
  .refine(
    (items) => new Set(items.map((item) => item.job_id)).size === items.length,
    'External job handles must be unique.',
  );
export const externalWaitActionSchema = z.strictObject({
  id: z.string().min(1).max(128),
  type: z.literal('external_wait'),
  schema_version: z.literal('haze.external.wait.action.v1'),
  dependencies: dependenciesSchema,
});
export const externalAuthoritySchema = z.strictObject({
  task_id: z.uuid(),
  run_id: z.uuid(),
  generation: revision,
  objective_revision: revision,
  assignment_id: z.uuid(),
  assignment_revision: revision,
});
export const externalWaitSchema = z.strictObject({
  id: z.uuid(),
  thread_id: z.string().min(1).max(512),
  authority: externalAuthoritySchema,
  after_cursor: z.number().int().nonnegative(),
  dependencies: dependenciesSchema,
  state: z.enum(['waiting', 'ready', 'consumed', 'fenced']),
  reason: z.string().max(512).nullable(),
  created_at: z.string(),
});
export const externalDeliverySchema = z.strictObject({
  id: z.uuid(),
  wait_id: z.uuid(),
  job_id: z.uuid(),
  execution_state: z.string().max(64),
  artifact: artifactRefSchema.nullable(),
  event_cursor: z.number().int().positive(),
  state: z.enum(['retained', 'consumed', 'fenced']),
  reason: z.string().max(512).nullable(),
});
export const externalWaitViewSchema = z.strictObject({
  schema_version: z.literal('haze.external.wait.view.v1'),
  task_id: z.uuid(),
  capacity: z.strictObject({
    permit: z.enum(['held', 'released']),
    wait_reason: z.enum(['compute', 'capacity', 'human', 'stopped']).nullable(),
    queue: z
      .strictObject({
        sequence: revision,
        thread_id: z.string(),
        status: z.enum(['eligible', 'suspended', 'dispatched', 'removed']),
        reason: z.string().nullable(),
      })
      .nullable(),
  }),
  waits: z.array(externalWaitSchema).max(256),
  deliveries: z.array(externalDeliverySchema).max(1024),
});
export type ExternalWaitAction = z.infer<typeof externalWaitActionSchema>;
export type ExternalAuthority = z.infer<typeof externalAuthoritySchema>;
export type ExternalWait = z.infer<typeof externalWaitSchema>;
export type ExternalDelivery = z.infer<typeof externalDeliverySchema>;
export type ExternalWaitView = z.infer<typeof externalWaitViewSchema>;
