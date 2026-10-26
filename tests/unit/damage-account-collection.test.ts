import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createDamageAccountAssignments,
  createDamageAccountCapability,
} from '../../app/capabilities/damage-account/index.js';
import { createSyntheticDamageArtifact } from '../../app/capabilities/damage-account/fixtures.js';
import {
  exactDamageRef,
  normalizeDamageInputs,
} from '../../app/capabilities/damage-account/inputs.js';
import {
  boundedJsonSchema,
  type Artifact,
} from '../../app/contracts/artifacts.js';
import {
  DAMAGE_WORLD_TOOL_ID,
  damageWorldQuerySchema,
} from '../../app/contracts/damage-world.js';
import { contractHash } from '../../app/contracts/json.js';
import { taskRequestSchema } from '../../app/contracts/tasks.js';
import type { AssignmentServices } from '../../app/orchestration/ports.js';

const collect = createDamageAccountAssignments().find(
  (assignment) => assignment.id === 'damage.collect',
)!;
const gap = {
  status: 'gap',
  reasons: ['Compatible evidence requires backend acquisition.'],
  candidates: [],
};

function servicesFor(inputs: Artifact[], input?: unknown) {
  const source = createSyntheticDamageArtifact();
  const tool = vi.fn(async (id: string) =>
    id === DAMAGE_WORLD_TOOL_ID ? gap : normalizeDamageInputs([source]),
  );
  const save = vi.fn((kind: string, content: unknown): Artifact => ({
    ...source,
    id: randomUUID(),
    kind,
    content: boundedJsonSchema.parse(content),
    sha256: contractHash(content),
    producer: { kind: 'assignment', id: 'collector-test' },
  }));
  const services: AssignmentServices = {
    input,
    context: {
      taskId: randomUUID(),
      runId: randomUUID(),
      assignmentId: randomUUID(),
      assignmentRevision: 2,
      objectiveRevision: 2,
      generation: 2,
      identity: source.identity,
      deadline: '2099-01-01T00:00:00Z',
      signal: new AbortController().signal,
      inputs,
      outputs: [],
      peers: [],
    },
    tool,
    save,
    question: vi.fn(),
    message: vi.fn(),
    inbox: () => [],
    read: () => {
      throw new Error('Unexpected direct artifact read.');
    },
    escalate: vi.fn(),
  };
  return { services, tool, save };
}

describe('damage collection intake routing', () => {
  it('preserves explicit imported-source intake in the generated collection plan', async () => {
    const source = createSyntheticDamageArtifact();
    const ref = exactDamageRef(source);
    const request = taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Build a damage account from the supplied evidence.',
      context_refs: [ref],
    });
    const input =
      createDamageAccountCapability().assignments(request)[0]!.input;
    const { services, tool } = servicesFor([source], input);

    const result = await collect.execute!(services);

    expect(tool).toHaveBeenCalledExactlyOnceWith('damage.read-input', {
      source_refs: [ref],
      method_ids: expect.any(Array),
    });
    expect(result.status).toBe('completed');
  });

  it('refreshes World Model after a correction retaining original non-assignment evidence', async () => {
    const retainedSource = createSyntheticDamageArtifact();
    const expected = { countries: ['Corrected Country'] };
    const { services, tool } = servicesFor([retainedSource], {
      expected_scope: expected,
    });

    await collect.execute!(services);

    expect(tool).toHaveBeenCalledExactlyOnceWith(
      DAMAGE_WORLD_TOOL_ID,
      damageWorldQuerySchema.parse({ expected_scope: expected }),
    );
    expect(services.question).not.toHaveBeenCalled();
  });

  it.each(['damage.world-selection', 'damage.world-inputs'])(
    'refreshes retained %s rather than reusing its sources through legacy intake',
    async (kind) => {
      const source = createSyntheticDamageArtifact();
      const retained: Artifact = {
        ...source,
        id: randomUUID(),
        kind,
        producer: { kind: 'service', id: 'retained-world-context' },
      };
      const { services, tool } = servicesFor([source, retained], {
        intake_refs: [exactDamageRef(source)],
        expected_scope: { countries: ['Corrected Country'] },
      });

      await collect.execute!(services);

      expect(tool).toHaveBeenCalledExactlyOnceWith(
        DAMAGE_WORLD_TOOL_ID,
        damageWorldQuerySchema.parse({
          expected_scope: { countries: ['Corrected Country'] },
        }),
      );
    },
  );
});
