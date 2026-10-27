import { z } from 'zod';

export const automaticReadinessSchema = z
  .strictObject({
    schema_version: z.literal('haze.nightshift.automatic.readiness.v1'),
    released: z.boolean(),
    ready: z.boolean(),
    reason: z.string().max(2000).nullable(),
    evidence_id: z.string().min(1).max(256).nullable(),
    evidence_kind: z.enum(['live', 'fixture']).nullable(),
    gates: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(128),
          label: z.string().min(1).max(256),
          passed: z.boolean(),
          reason: z.string().max(1000).nullable(),
        }),
      )
      .min(1)
      .max(16),
  })
  .superRefine((value, context) => {
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
  });
export type AutomaticReadiness = z.infer<typeof automaticReadinessSchema>;
/** Trusted server dependency. This capability is never accepted from HTTP or a model. */
export type AutomaticReleasePolicy = () => Promise<AutomaticReadiness>;

export function automaticReleaseBlocked(reason: string): AutomaticReadiness {
  return {
    schema_version: 'haze.nightshift.automatic.readiness.v1',
    released: false,
    ready: false,
    reason,
    evidence_id: null,
    evidence_kind: null,
    gates: [
      {
        id: 'routing-live-contracts',
        label: 'Plan 1 live routing and role evaluation',
        passed: false,
        reason: 'Live provider contract and quality gates remain unmet.',
      },
      {
        id: 'local-background-generation',
        label: 'Plan 2 genuine local generation',
        passed: false,
        reason:
          'No successful eligible local-only generation trace has been retained.',
      },
      {
        id: 'wait-and-interactive-latency',
        label: 'Plan 3 live wait trace and interactive latency',
        passed: false,
        reason:
          'A genuine specialist wait trace and background-load latency observation are still required.',
      },
      {
        id: 'automatic-chain-live-trace',
        label: 'Opt-in chain live end-to-end evidence',
        passed: false,
        reason:
          'Fixture verification cannot release production automatic mode.',
      },
    ],
  };
}
