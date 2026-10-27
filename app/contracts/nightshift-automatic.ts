import { z } from 'zod';

const gatesSchema = z
  .array(
    z.strictObject({
      id: z.string().min(1).max(128),
      label: z.string().min(1).max(256),
      passed: z.boolean(),
      reason: z.string().max(1000).nullable(),
    }),
  )
  .min(1)
  .max(16);

/**
 * Grant ceilings a released automatic chain may never exceed. Cloud execution
 * keeps the runtime's supported monetary policy: no enforceable dollar ceiling.
 */
export const automaticScopeSchema = z.strictObject({
  privacy: z.array(z.literal('cloud-ok')).length(1),
  monetary_policy: z.literal('cloud-uncapped-runtime-policy'),
  max_total_runs: z.number().int().min(2).max(4),
  max_automatic_followups: z.number().int().min(1).max(3),
  max_concurrent_jobs: z.number().int().min(1).max(4),
  max_jobs: z.number().int().min(1).max(4),
  max_attempts_per_job: z.number().int().min(1).max(16),
  max_lifetime_seconds: z.number().int().min(60).max(86_400),
});
export type AutomaticScope = z.infer<typeof automaticScopeSchema>;
/** The initial release supports only this bounded cloud scenario. */
export const INITIAL_AUTOMATIC_SCOPE: AutomaticScope = Object.freeze({
  privacy: Object.freeze(['cloud-ok']) as unknown as ['cloud-ok'],
  monetary_policy: 'cloud-uncapped-runtime-policy',
  max_total_runs: 2,
  max_automatic_followups: 1,
  max_concurrent_jobs: 1,
  max_jobs: 2,
  max_attempts_per_job: 1,
  max_lifetime_seconds: 1_800,
});
/** True when every ceiling in `scope` is within the supported initial release. */
export function withinInitialScope(scope: AutomaticScope): boolean {
  const limit = INITIAL_AUTOMATIC_SCOPE;
  return (
    scope.privacy.every((value) => limit.privacy.includes(value)) &&
    scope.monetary_policy === limit.monetary_policy &&
    scope.max_total_runs <= limit.max_total_runs &&
    scope.max_automatic_followups <= limit.max_automatic_followups &&
    scope.max_concurrent_jobs <= limit.max_concurrent_jobs &&
    scope.max_jobs <= limit.max_jobs &&
    scope.max_attempts_per_job <= limit.max_attempts_per_job &&
    scope.max_lifetime_seconds <= limit.max_lifetime_seconds
  );
}

const releaseRules = (
  value: {
    released: boolean;
    ready: boolean;
    evidence_id: string | null;
    evidence_kind: string | null;
    gates: { passed: boolean }[];
  },
  context: z.RefinementCtx,
) => {
  if (
    (value.released || value.ready) &&
    (!value.evidence_id ||
      !value.evidence_kind ||
      value.gates.some((gate) => !gate.passed))
  )
    context.addIssue({
      code: 'custom',
      message:
        'Release requires verified evidence and every prerequisite gate.',
    });
  if (value.ready && !value.released)
    context.addIssue({
      code: 'custom',
      message: 'Unreleased automatic execution cannot be ready.',
    });
};
const readinessShape = {
  released: z.boolean(),
  ready: z.boolean(),
  reason: z.string().max(2000).nullable(),
  evidence_id: z.string().min(1).max(256).nullable(),
  evidence_kind: z.enum(['live', 'fixture']).nullable(),
  gates: gatesSchema,
};
/** Retained for trusted injected policies that predate scoped release. */
export const automaticReadinessV1Schema = z
  .strictObject({
    schema_version: z.literal('haze.nightshift.automatic.readiness.v1'),
    ...readinessShape,
  })
  .superRefine(releaseRules);
export const automaticReadinessV2Schema = z
  .strictObject({
    schema_version: z.literal('haze.nightshift.automatic.readiness.v2'),
    ...readinessShape,
    scope: automaticScopeSchema,
  })
  .superRefine(releaseRules);
export const automaticReadinessSchema = z.union([
  automaticReadinessV2Schema,
  automaticReadinessV1Schema,
]);
export type AutomaticReadiness = z.infer<typeof automaticReadinessSchema>;
/** Trusted server dependency. This capability is never accepted from HTTP or a model. */
export type AutomaticReleasePolicy = () => Promise<AutomaticReadiness>;

export const AUTOMATIC_RELEASE_GATES = Object.freeze([
  {
    id: 'routing-live-contracts',
    label: 'Exact strict role routes and current role evaluation',
    reason:
      'A current role evaluation with a separate independent review is required.',
  },
  {
    id: 'cloud-background-generation',
    label: 'Genuine cloud Nightshift generation',
    reason: 'No successful cloud-ok native generation trace has been retained.',
  },
  {
    id: 'wait-and-interactive-latency',
    label: 'Live wait/wakeup trace and interactive latency',
    reason:
      'A genuine specialist wait trace and background-load latency observation are still required.',
  },
  {
    id: 'automatic-chain-live-trace',
    label: 'Opt-in chain live end-to-end evidence',
    reason: 'Fixture verification cannot release production automatic mode.',
  },
  {
    id: 'domain-demonstrations',
    label: 'PM2.5 and damage-accounting demonstrations',
    reason: 'Both live domain demonstrations are still required.',
  },
  {
    id: 'crash-restart',
    label: 'Crash/restart readback',
    reason:
      'Restart verification of identities, accounting and results is required.',
  },
] as const);
export type AutomaticReleaseGateId =
  (typeof AUTOMATIC_RELEASE_GATES)[number]['id'];

export function automaticReleaseBlocked(
  reason: string,
  passed: readonly AutomaticReleaseGateId[] = [],
  failures: Partial<Record<AutomaticReleaseGateId, string>> = {},
): AutomaticReadiness {
  return {
    schema_version: 'haze.nightshift.automatic.readiness.v2',
    released: false,
    ready: false,
    reason,
    evidence_id: null,
    evidence_kind: null,
    scope: structuredClone(INITIAL_AUTOMATIC_SCOPE),
    gates: AUTOMATIC_RELEASE_GATES.map((gate) => ({
      id: gate.id,
      label: gate.label,
      passed: passed.includes(gate.id),
      reason: passed.includes(gate.id)
        ? null
        : (failures[gate.id] ?? gate.reason),
    })),
  };
}
