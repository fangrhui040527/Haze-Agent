import { describe, expect, it } from 'vitest';
import {
  acceptanceExpiry,
  isWorldAcceptanceEnabled,
  policyAllows,
  resolveWorldAcceptancePolicy,
} from '../../app/tasks/world-policy.js';

describe('server-owned World Model acceptance policy', () => {
  it('is disabled by default and has no authorized uses', () => {
    const policy = resolveWorldAcceptancePolicy(undefined);
    expect(isWorldAcceptanceEnabled(policy)).toBe(false);
    expect(policy.allowed_capabilities).toEqual([]);
    expect(
      policyAllows(policy, 'pm25-evidence-summary', 'pm25-evidence-summary'),
    ).toBe(false);
  });

  it('pins the research policy identity and hash and permits only registered uses', () => {
    const policy = resolveWorldAcceptancePolicy('research-v1');
    expect(policy.id).toBe('research-v1');
    expect(policy.version).toBe('1');
    expect(policy.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(resolveWorldAcceptancePolicy('research-v1').sha256).toBe(
      policy.sha256,
    );
    expect(
      policyAllows(policy, 'pm25-evidence-summary', 'pm25-evidence-summary'),
    ).toBe(true);
    expect(
      policyAllows(policy, 'damage-account-intake', 'damage-account:social'),
    ).toBe(true);
    expect(
      policyAllows(policy, 'episode-investigation', 'pm25-evidence-summary'),
    ).toBe(false);
    expect(acceptanceExpiry(policy, '2026-10-01T00:00:00.000Z')).toBe(
      '2026-10-31T00:00:00.000Z',
    );
  });

  it('fails closed for unknown configured policy versions', () => {
    expect(() => resolveWorldAcceptancePolicy('research-v2')).toThrow(
      'Unknown World Model acceptance policy',
    );
    expect(() => resolveWorldAcceptancePolicy({ id: 'research-v1' })).toThrow(
      'Unknown World Model acceptance policy',
    );
  });
});
