import { createFixturePorts } from './fixtures.js';

/** Explicit, deterministic integration example. Never imported by the live factory. */
export function createPm25FixturePorts() {
  return createFixturePorts({
    execute: (input) => {
      const phase = (input.context as { phase: string }).phase;
      const outputs: Record<string, unknown> = {
        ManagerPlan: {
          capability: 'pm25-evidence-summary',
          roles: ['HazeOps', 'WorkerShield', 'EvidenceCritic'],
        },
        HazeOps: {
          summary:
            'The synthetic selection [E1] contains instantaneous modeled samples. No live retrieval or observations were used; issuance and spatial support are unknown.',
        },
        WorkerShield: {
          summary:
            'The deterministic fixture calculation counts hourly sample timestamps and reports its exact coverage and range [E1]. It does not establish continuous exposure or health effects.',
        },
        EvidenceCritic: {
          verdict: 'supported',
          findings: [],
          limitations: [
            'Fixture model output only; this is not scientific qualification.',
          ],
        },
        ManagerSynthesis: {
          answer:
            'This is a synthetic integration example [E1]. Its deterministic analysis reports the modeled sample coverage and range for the requested period. No observations or live evidence were queried; provider issuance and spatial support remain unknown.',
        },
      };
      if (!(phase in outputs)) throw new Error('Unsupported fixture phase.');
      return Promise.resolve({
        text: JSON.stringify(outputs[phase]),
        receipt: {
          response_model: 'fixture-model',
          response_id: null,
          input_tokens: null,
          output_tokens: null,
        },
      });
    },
  });
}
