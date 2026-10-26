import { describe, expect, it } from 'vitest';
import {
  artifactSchema,
  type Artifact,
} from '../../app/contracts/artifacts.js';
import { contractHash } from '../../app/contracts/json.js';
import { taskRequestSchema } from '../../app/contracts/tasks.js';
import { createExecutionRegistry } from '../../app/composition.js';
import { pm25WorldModelAdapter } from '../../app/capabilities/pm25/world.js';
import { damageAccountIntakeWorldModelAdapter } from '../../app/capabilities/damage-account-intake/world.js';
import { episodeInvestigationWorldModelAdapter } from '../../app/capabilities/episode-investigation/world.js';
import { evidenceSynthesisWorldModelAdapter } from '../../app/capabilities/evidence-synthesis/world.js';
import type { CapabilityWorldModelAdapter } from '../../app/orchestration/ports.js';

const request = taskRequestSchema.parse({
  schema_version: 'haze.task.request.v3',
  objective: 'Review the supplied evidence.',
});
const unrelated = artifactSchema.parse({
  schema_version: 'haze.artifact.v3',
  id: '00000000-0000-4000-8000-000000000051',
  version: 1,
  sha256: contractHash({ note: 'unrelated input' }),
  identity: {
    principal: 'adapter-contract-test',
    workspace: 'adapter-contract-test',
  },
  task_id: '00000000-0000-4000-8000-000000000052',
  run_id: '00000000-0000-4000-8000-000000000053',
  objective_revision: 1,
  generation: 1,
  kind: 'unrelated.input',
  producer: { kind: 'user', id: 'adapter-contract-test' },
  created_at: '2026-10-02T00:00:00.000Z',
  dependencies: [],
  required_tools: [],
  content: { note: 'unrelated input' },
}) satisfies Artifact;

const adapters: {
  capability: string;
  adapter: CapabilityWorldModelAdapter;
}[] = [
  { capability: 'pm25-evidence-summary', adapter: pm25WorldModelAdapter },
  {
    capability: 'damage-account-intake',
    adapter: damageAccountIntakeWorldModelAdapter,
  },
  {
    capability: 'episode-investigation',
    adapter: episodeInvestigationWorldModelAdapter,
  },
  {
    capability: 'evidence-synthesis',
    adapter: evidenceSynthesisWorldModelAdapter,
  },
];

describe('capability World Model adapter contract', () => {
  it('registers every implemented adapter and refuses unrelated or empty evidence', () => {
    const registry = createExecutionRegistry({ mode: 'fixture' });
    for (const { capability, adapter } of adapters) {
      expect(registry.capabilities.get(capability)?.worldModel).toBe(adapter);
      const artifacts = [unrelated];
      const drafts = adapter.extract({ request, artifacts });
      expect(drafts, capability).toEqual([]);
      expect(
        adapter.requiredReviewCoverage({
          request,
          assignments: [],
          artifacts,
        }),
        capability,
      ).toEqual([]);
      expect(
        adapter.buildAcceptanceCandidate({
          request,
          records: [],
          assessments: [],
          artifacts,
          assignments: [],
        }),
        capability,
      ).toBeUndefined();
    }
  });
});
