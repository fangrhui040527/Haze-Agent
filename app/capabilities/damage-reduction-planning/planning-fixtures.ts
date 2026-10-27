import type { ReductionCandidate } from '../../contracts/damage-reduction-plan.js';
import { SYNTHETIC_REDUCTION_TARGET } from './fixtures.js';

/** Frozen before planning methods/prompt changes. No empirical or live readiness. */
export const FROZEN_PLANNING_CASES = Object.freeze([
  {
    id: 'supported',
    supplied_baseline: '1000',
    supplied_intervention: '880',
    expected_point_estimate_label: 'meets',
    expected_state: 'conditional',
  },
  {
    id: 'below_target',
    supplied_baseline: '1000',
    supplied_intervention: '950',
    expected_point_estimate_label: 'does_not_meet',
    expected_state: 'conditional',
  },
  {
    id: 'insufficient_evidence',
    supplied_baseline: '1000',
    supplied_intervention: null,
    expected_point_estimate_label: 'unavailable',
    expected_state: 'evidence_gap',
  },
  {
    id: 'hard_subgroup_violation',
    supplied_baseline: '1000',
    supplied_intervention: '880',
    expected_point_estimate_label: 'meets',
    expected_state: 'blocked',
  },
  {
    id: 'unsupported_effect_claim',
    supplied_baseline: '1000',
    supplied_intervention: '880',
    expected_point_estimate_label: 'meets',
    expected_state: 'blocked',
  },
] as const);

export function syntheticReductionCandidate(): ReductionCandidate {
  return {
    id: 'synthetic-alert-service',
    version: '1',
    name: SYNTHETIC_REDUCTION_TARGET.intervention,
    kind: 'exposure_alert',
    description:
      'Synthetic proposed alert service; no delivered action or established efficacy.',
    rule_owner: null,
    trigger_rule: null,
    action_rule: null,
    approval: {
      status: 'proposed',
      approver: null,
      approved_at: null,
      evidence: [],
    },
    constraints: [],
    costs: [
      {
        id: 'service-cost',
        description: 'Service deployment and operating cost',
        amount: null,
        unit: 'unpriced',
        evidence: [],
        prerequisite:
          'Obtain a scoped supplied cost estimate and budget decision.',
      },
    ],
    dependencies: [
      {
        id: 'service-capacity',
        description: 'Authorized service configuration and delivery capacity',
        status: 'unknown',
        evidence: [],
      },
    ],
    claims: [],
  };
}
