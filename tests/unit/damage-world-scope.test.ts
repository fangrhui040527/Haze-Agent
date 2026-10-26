import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSyntheticDamageArtifact } from '../../app/capabilities/damage-account/fixtures.js';
import {
  normalizeDamageInputs,
  exactDamageRef,
} from '../../app/capabilities/damage-account/inputs.js';
import { WorldModelDamageInputAdapter } from '../../app/adapters/damage-input-adapter/index.js';
import { damageWorldInputPolicy } from '../../app/capabilities/damage-account/world-input-policy.js';
import {
  DAMAGE_WORLD_ADAPTER_ID,
  DAMAGE_WORLD_TOOL_ID,
  damageWorldQuerySchema,
  type DamageWorldQuery,
} from '../../app/contracts/damage-world.js';
import { contractHash } from '../../app/contracts/json.js';
import type {
  StatefulToolStore,
  ToolContext,
} from '../../app/orchestration/ports.js';

function resolveRequest(
  objective: string,
  start: string,
  end: string,
  query: DamageWorldQuery = {},
  correction?: string,
  history?: {
    originalScope?: unknown;
    earlierScope?: unknown;
  },
) {
  const source = createSyntheticDamageArtifact();
  const inputs = normalizeDamageInputs([source]);
  inputs.scope.effect_period = { start, end };
  const capture = {
    ...source,
    kind: 'damage.inputs',
    content: inputs,
    sha256: contractHash(inputs),
  };
  const record = {
    kind: 'artifact_reference',
    payload: { artifact: exactDamageRef(capture) },
  };
  const worldContext = vi.fn(() => ({ record, acceptances: [] }));
  const store = {
    read: () => ({
      original_request: { objective, scope: history?.originalScope },
      corrections: [
        ...(history?.earlierScope
          ? [
              {
                passage: 'Use the declared scope.',
                scope: history.earlierScope,
              },
            ]
          : []),
        ...(correction ? [{ passage: correction }] : []),
      ],
    }),
    clearWorldContextPins: () => {},
    worldLookup: () => ({
      records: [record],
    }),
    artifact: () => capture,
    worldContext,
  } as unknown as StatefulToolStore;
  const context: ToolContext = {
    taskId: 'test-task',
    runId: 'test-run',
    assignmentId: 'test-assignment',
    assignmentRevision: 1,
    objectiveRevision: 1,
    generation: 1,
    identity: source.identity,
    deadline: '2099-01-01T00:00:00Z',
    signal: new AbortController().signal,
    inputs: [],
    outputs: [],
    peers: [],
  };
  const result = new WorldModelDamageInputAdapter(
    store,
    'fixture',
    damageWorldInputPolicy,
  ).resolve(query, context);
  // A model's proposed ID cannot bypass discovery or reach candidate reuse
  // after the user's scope is rejected, even if a later check would also fail.
  expect(worldContext).toHaveBeenCalledTimes(0);
  return result;
}

describe('World Model request scope boundaries', () => {
  it('does not silently use an episode for a full-year request', () => {
    expect(
      resolveRequest(
        'Build a damage account for Fixture Region in 2015.',
        '2015-09-01',
        '2015-10-31',
      ).status,
    ).toBe('gap');
  });
  it('does not silently use part of a requested calendar month', () => {
    expect(
      resolveRequest(
        'Build a damage account for Fixture Region in September 2015.',
        '2015-09-01',
        '2015-09-15',
      ).status,
    ).toBe('gap');
  });
  it('does not silently drop an additional requested country', () => {
    expect(
      resolveRequest(
        'Build a damage account for Fixture Region and Malaysia for September to October 2015.',
        '2015-09-01',
        '2015-10-31',
      ).status,
    ).toBe('gap');
  });
  it('requires clarification for an unsupported partial-day request', () => {
    expect(
      resolveRequest(
        'Build a damage account for Fixture Region in September 1 to 15 2015.',
        '2015-09-01',
        '2015-09-15',
      ).status,
    ).toBe('scope_required');
  });
  it('requires dates rather than assuming the retained period', () => {
    expect(
      resolveRequest(
        'Build a damage account for Fixture Region.',
        '2015-09-01',
        '2015-10-31',
      ).status,
    ).toBe('scope_required');
  });
  it('preserves an explicitly requested ISO date window', () => {
    expect(
      resolveRequest(
        'Build a damage account for Fixture Region from 2015-09-01 to 2015-09-30.',
        '2015-09-01',
        '2015-10-31',
      ).status,
    ).toBe('gap');
  });
  it('does not insert default precision into a partial scope query', () => {
    expect(
      damageWorldQuerySchema.parse({
        expected_scope: { countries: ['Fixture Region'] },
      }),
    ).toEqual({ expected_scope: { countries: ['Fixture Region'] } });
  });
  it('keeps a model-proposed record selection subordinate to the user location', () => {
    expect(
      resolveRequest(
        'Build a damage account for Malaysia for September to October 2015.',
        '2015-09-01',
        '2015-10-31',
        { record_id: 'wm:' + 'a'.repeat(64) },
      ).status,
    ).toBe('gap');
  });
  it('keeps a model-proposed structured selector subordinate to the user location', () => {
    expect(
      resolveRequest(
        'Build a damage account for Malaysia for September to October 2015.',
        '2015-09-01',
        '2015-10-31',
        {
          expected_scope: {
            countries: ['Fixture Region'],
            effect_period: { start: '2015-09-01', end: '2015-10-31' },
          },
        },
      ).status,
    ).toBe('gap');
  });
  it.each(['Use October instead.', 'Malaysia instead.', 'Exclude production.'])(
    'does not silently discard the short correction: %s',
    (passage) => {
      expect(
        resolveRequest(
          'Build a damage account for Fixture Region for September to October 2015.',
          '2015-09-01',
          '2015-10-31',
          {},
          passage,
        ).status,
      ).toBe('scope_required');
    },
  );
  it.each(['originalScope', 'earlierScope'] as const)(
    'does not inherit %s through a later prose-only correction',
    (scopeLocation) => {
      const originalScope = normalizeDamageInputs([
        createSyntheticDamageArtifact(),
      ]).scope;
      expect(
        resolveRequest(
          'Build a damage account using the declared scope.',
          '2015-09-01',
          '2015-10-31',
          {},
          'Use October instead.',
          { [scopeLocation]: originalScope },
        ).status,
      ).toBe('scope_required');
    },
  );
  it('does not relax an exact full-scope plan binding after a prose correction', () => {
    const originalScope = normalizeDamageInputs([
      createSyntheticDamageArtifact(),
    ]).scope;
    expect(() =>
      resolveRequest(
        'Build a damage account using the declared scope.',
        '2015-09-01',
        '2015-10-31',
        { expected_scope_sha256: contractHash(originalScope) },
        'Use October instead.',
        { originalScope },
      ),
    ).toThrow('scope binding differs');
  });
  it('rechecks a prose correction before reusing a retained selection receipt', () => {
    const source = createSyntheticDamageArtifact();
    const inputs = normalizeDamageInputs([source]);
    const capture = {
      ...source,
      id: randomUUID(),
      kind: 'damage.inputs',
      content: inputs,
      sha256: contractHash(inputs),
    };
    const record = {
      id: 'wm:' + 'a'.repeat(64),
      revision: 1,
      sha256: 'a'.repeat(64),
    };
    const snapshot = exactDamageRef({ ...source, id: randomUUID() });
    const receipt = {
      schema_version: 'haze.damage.world-selection.v1',
      adapter: DAMAGE_WORLD_ADAPTER_ID,
      version: '1',
      record,
      capture: exactDamageRef(capture),
      snapshot,
      source_refs: [exactDamageRef(source)],
      scope_sha256: contractHash(inputs.scope),
      limitations: [],
    };
    const selection = {
      ...source,
      id: randomUUID(),
      kind: 'damage.world-selection',
      producer: { kind: 'service', id: DAMAGE_WORLD_ADAPTER_ID },
      content: receipt,
      sha256: contractHash(receipt),
      required_tools: [DAMAGE_WORLD_TOOL_ID],
      dependencies: [receipt.capture, snapshot, ...receipt.source_refs],
    };
    const pinWorldContext = vi.fn();
    const store = {
      read: () => ({
        original_request: {
          objective: 'Build a damage account using the declared scope.',
          scope: inputs.scope,
        },
        corrections: [{ passage: 'Use October instead.' }],
      }),
      artifact: (id: string) => (id === selection.id ? selection : capture),
      worldContext: () => ({ record: { ref: record }, acceptances: [] }),
      pinWorldContext,
    } as unknown as StatefulToolStore;
    const context: ToolContext = {
      taskId: 'test-task',
      runId: 'test-run',
      assignmentId: 'test-assignment',
      assignmentRevision: 1,
      objectiveRevision: 1,
      generation: 1,
      identity: source.identity,
      deadline: '2099-01-01T00:00:00Z',
      signal: new AbortController().signal,
      outputs: [],
      peers: [],
      inputs: [
        {
          ...source,
          kind: 'damage.world-inputs',
          content: {
            schema_version: 'haze.damage.world-inputs.v1',
            selection: exactDamageRef(selection),
          },
          dependencies: [exactDamageRef(selection)],
        },
      ],
    };

    const result = new WorldModelDamageInputAdapter(
      store,
      'fixture',
      damageWorldInputPolicy,
    ).resolve({ selection_ref: exactDamageRef(selection) }, context);

    expect(result.status).toBe('scope_required');
    expect(pinWorldContext).not.toHaveBeenCalled();
  });
});
