import { z } from 'zod';
import { identifierSchema } from './common.js';

export const agentRoleSchema = z.enum([
  'Manager',
  'HazeOps',
  'WorkerShield',
  'EvidenceCritic',
]);
export const capabilityCardSchema = z.strictObject({
  id: identifierSchema,
  version: identifierSchema,
  purpose: z.string().min(1).max(4096),
  work_products: z.array(z.string().min(1).max(4096)).max(64),
  required_tools: z.array(identifierSchema).max(64),
  roles: z.array(agentRoleSchema).max(4),
  readiness: z.enum([
    'specified',
    'implemented',
    'fixture-tested',
    'live-executed',
    'independently-checked',
  ]),
  limitations: z.array(z.string().max(4096)).max(64),
});
export type AgentRole = z.infer<typeof agentRoleSchema>;
export type CapabilityCard = z.infer<typeof capabilityCardSchema>;
