import { createStore, readLocal, writeLocal } from '../shared/lib/store.ts';
import type { Scenario } from './generator/simulate.ts';

/**
 * Knobs for the mock services, edited on the Demo Data page and remembered per browser.
 * Real services ignore these.
 */
export interface MockSettings {
  /** Add simulated live events automatically. */
  autoSimulate: boolean;
  intervalSec: number;
  scenario: Scenario;
  /** Fake network delay for data loads. */
  latencyMs: number;
  /** Make the next dashboard load fail once (to see the error state). */
  failNextLoad: boolean;
  /** Animation/event speed multiplier for the mock agents. */
  agentSpeed: number;
  /** 0–1 chance that a mock agent run fails at a random agent. */
  agentFailureRate: number;
  /**
   * full      = per-agent events (level A)
   * run_state = only run state, no per-agent detail (level B)
   * fail      = always fails at EvidenceCritic
   */
  agentMode: 'full' | 'run_state' | 'fail';
}

export const DEFAULT_MOCK_SETTINGS: MockSettings = {
  autoSimulate: true,
  intervalSec: 20,
  scenario: 'normal',
  latencyMs: 600,
  failNextLoad: false,
  agentSpeed: 1,
  agentFailureRate: 0,
  agentMode: 'full',
};

const KEY = 'hazewatch.mock.settings.v1';

export const mockSettings = createStore<MockSettings>({
  ...DEFAULT_MOCK_SETTINGS,
  ...readLocal<Partial<MockSettings>>(KEY, {}),
});

mockSettings.subscribe(() => writeLocal(KEY, mockSettings.get()));

export function updateMockSettings(patch: Partial<MockSettings>): void {
  mockSettings.set((previous) => ({ ...previous, ...patch }));
}
