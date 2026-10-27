import { z } from 'zod';
import { agentRoleSchema } from './capabilities.js';
import type { AgentRole } from './capabilities.js';

export const modelProviderSchema = z.enum([
  'offline',
  'nvidia',
  'openai-compatible',
  'nightshift',
  'injected',
]);
export const modelRouteProfileSchema = z.strictObject({
  provider: z.enum(['nvidia', 'openai-compatible', 'nightshift']),
  model: z.string().trim().min(1).max(256),
  base_url: z.string().min(1).max(2048).optional(),
  credential_env: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u)
    .optional(),
  policy: z
    .enum(['provider-default', 'local-only'])
    .default('provider-default'),
});
export const modelRoutesConfigurationSchema = z.strictObject({
  version: z.literal(1),
  profiles: z.record(
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u),
    modelRouteProfileSchema,
  ),
});
export const agentRoutesConfigurationSchema = z.strictObject({
  version: z.literal(1),
  routes: z.partialRecord(agentRoleSchema, z.string().min(1).max(64)),
});
export const effectiveModelRouteSchema = z.strictObject({
  version: z.literal(1),
  route_id: z.string().min(1).max(160),
  profile: z.string().min(1).max(64),
  provider: modelProviderSchema,
  requested_model: z.string().min(1).max(256).nullable(),
  base_url: z.string().max(2048).nullable(),
  credential_ref: z.string().max(4096).nullable(),
  capability_contract: z.strictObject({
    version: z.literal(1),
    id: z.string().min(1).max(160),
    hash: z.string().min(1).max(160),
  }),
  policy: z.enum(['provider-default', 'local-only']),
});
export const modelRouteSnapshotSchema = z.strictObject({
  version: z.literal(1),
  routes: z.record(agentRoleSchema, effectiveModelRouteSchema),
});
export type EffectiveModelRoute = z.infer<typeof effectiveModelRouteSchema>;
export type ModelRouteSnapshot = z.infer<typeof modelRouteSnapshotSchema>;

export const modelReadinessSchema = z.strictObject({
  version: z.literal(1),
  checked_at: z.iso.datetime(),
  routes: z
    .array(
      z.strictObject({
        role: agentRoleSchema,
        profile: z.string().min(1).max(64),
        route_id: z.string().min(1).max(160),
        provider: modelProviderSchema,
        requested_model: z.string().min(1).max(256).nullable(),
        configured: z.boolean(),
        schema_compatible: z.boolean(),
        reachability: z.enum([
          'unchecked',
          'reachable',
          'unreachable',
          'blocked',
        ]),
        live_verified: z.literal(false),
        role_evaluation: z.literal('unverified'),
        policy: z.enum(['provider-default', 'local-only']),
        reason: z.string().max(1024).nullable(),
      }),
    )
    .length(5)
    .refine(
      (routes) => new Set(routes.map((route) => route.role)).size === 5,
      'Each registered role must appear once.',
    ),
});
export type ModelReadiness = z.infer<typeof modelReadinessSchema>;

function fixedSnapshot(
  provider: 'offline' | 'injected',
  model: string | null,
): ModelRouteSnapshot {
  // Browser-safe deterministic identity for explicitly synthetic test routes.
  let identity = 0xcbf29ce484222325n;
  for (const character of model ?? 'none') {
    identity ^= BigInt(character.codePointAt(0)!);
    identity = BigInt.asUintN(64, identity * 0x100000001b3n);
  }
  const route: EffectiveModelRoute = Object.freeze({
    version: 1,
    route_id: `${provider}-v1-${identity.toString(16).padStart(16, '0')}`,
    profile: provider,
    provider,
    requested_model: model,
    base_url: null,
    credential_ref: null,
    capability_contract: Object.freeze({
      version: 1,
      id: `${provider}-v1`,
      hash: `${provider}-v1`,
    }),
    policy: 'provider-default',
  });
  const routes = Object.fromEntries(
    agentRoleSchema.options.map((role) => [role, route]),
  ) as Record<AgentRole, EffectiveModelRoute>;
  return Object.freeze({ version: 1, routes: Object.freeze(routes) });
}
export function createOfflineRouteSnapshot(): ModelRouteSnapshot {
  return fixedSnapshot('offline', null);
}
/** Injected models are synthetic test authority, never an inferred live route. */
export function createInjectedRouteSnapshot(selection?: {
  provider: string;
  model: string;
}): ModelRouteSnapshot {
  return fixedSnapshot('injected', selection?.model ?? 'injected');
}
