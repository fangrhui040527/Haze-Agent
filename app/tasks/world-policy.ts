import { contractHash } from '../contracts/json.js';
import type { WorldAcceptanceOutcome } from '../contracts/world.js';

const researchPolicyContent = {
  id: 'research-v1',
  version: '1',
  allowed_capabilities: [
    'pm25-evidence-summary',
    'damage-account-intake',
    'episode-investigation',
    'evidence-synthesis',
  ],
  allowed_uses: {
    'pm25-evidence-summary': ['pm25-evidence-summary'],
    'damage-account-intake': ['damage-account:*'],
    'episode-investigation': ['episode-investigation-context'],
    'evidence-synthesis': ['evidence-synthesis'],
  },
  maximum_age_ms: 30 * 24 * 60 * 60 * 1000,
} as const;

export interface WorldAcceptancePolicy {
  id: string;
  version: string;
  sha256: string;
  allowed_capabilities: readonly string[];
  allowed_uses: Readonly<Record<string, readonly string[]>>;
  maximum_age_ms: number;
}

const researchPolicy: WorldAcceptancePolicy = Object.freeze({
  ...researchPolicyContent,
  allowed_capabilities: Object.freeze([
    ...researchPolicyContent.allowed_capabilities,
  ]),
  allowed_uses: Object.freeze(
    Object.fromEntries(
      Object.entries(researchPolicyContent.allowed_uses).map(([key, uses]) => [
        key,
        Object.freeze([...uses]),
      ]),
    ),
  ),
  sha256: contractHash(researchPolicyContent),
});

const disabledPolicy: WorldAcceptancePolicy = Object.freeze({
  id: 'disabled',
  version: '0',
  sha256: contractHash({ id: 'disabled', version: '0' }),
  allowed_capabilities: Object.freeze([]),
  allowed_uses: Object.freeze({}),
  maximum_age_ms: 0,
});

/** Only server configuration may select this policy; task requests are never consulted. */
export function resolveWorldAcceptancePolicy(
  configured: unknown,
): WorldAcceptancePolicy {
  if (configured === undefined || configured === null || configured === false)
    return disabledPolicy;
  // `HAZE_WORLD_ACCEPTANCE_POLICY=` in server configuration yields '' from
  // process.env. That declares the setting without selecting a policy, which
  // means "leave acceptance off" — not "unknown policy". Whitespace-only is the
  // same case. Any other value still fails closed.
  const selected =
    typeof configured === 'string' ? configured.trim() : configured;
  if (selected === '') return disabledPolicy;
  if (selected === 'research-v1') return researchPolicy;
  throw new Error('Unknown World Model acceptance policy; refusing to start.');
}

export function isWorldAcceptanceEnabled(
  policy: WorldAcceptancePolicy,
): boolean {
  return policy.id !== 'disabled';
}

export function policyAllows(
  policy: WorldAcceptancePolicy,
  capability: string,
  statedUse: string,
): boolean {
  return (
    isWorldAcceptanceEnabled(policy) &&
    policy.allowed_capabilities.includes(capability) &&
    policy.allowed_uses[capability]?.some((use) => {
      if (use.endsWith('*')) return statedUse.startsWith(use.slice(0, -1));
      return use === statedUse;
    }) === true
  );
}

export function acceptanceExpiry(
  policy: WorldAcceptancePolicy,
  evaluatedAt: string,
): string | undefined {
  if (!policy.maximum_age_ms) return undefined;
  return new Date(
    Date.parse(evaluatedAt) + policy.maximum_age_ms,
  ).toISOString();
}

export function ineligibilityOutcome(
  input: Omit<
    Extract<WorldAcceptanceOutcome, { status: 'not_eligible' }>,
    'schema_version'
  >,
): WorldAcceptanceOutcome {
  return { schema_version: 'haze.world.acceptance.v1', ...input };
}
