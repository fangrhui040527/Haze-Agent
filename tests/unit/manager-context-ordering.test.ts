import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assembleManagerContext } from '../../app/agents/manager/context.js';
import { ExecutionRegistry } from '../../app/orchestration/ports.js';
import { TaskStore } from '../../app/tasks/store.js';

const identity = { principal: 'catalogue-test', workspace: 'catalogue-test' };
const opened: { store: TaskStore; directory: string }[] = [];
afterEach(() => {
  for (const { store, directory } of opened.splice(0)) {
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(directory));
    if (!inside || inside.startsWith('..'))
      throw new Error('Unsafe test directory.');
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(objective = 'Perform catalogue evaluation.') {
  const directory = mkdtempSync(join(tmpdir(), 'haze-context-ordering-'));
  const store = new TaskStore(directory);
  opened.push({ store, directory });
  const { task } = store.admit(
    {
      schema_version: 'haze.task.request.v3',
      objective,
      context_refs: [],
      constraints: [],
      desired_deliverables: [],
    },
    identity,
    randomUUID(),
    { mode: 'live' },
  );
  const registry = new ExecutionRegistry();
  for (const id of ['background', 'matching-two', 'other', 'matching-one'])
    registry.registerCapability({
      card: {
        id,
        version: '1',
        purpose: `Describe ${id}.`,
        work_products: ['catalogue.result'],
        required_tools: [],
        roles: ['HazeOps'],
        readiness: 'implemented',
        limitations: [],
      },
      matches: (request) =>
        request.objective.includes('catalogue evaluation') &&
        id.startsWith('matching-'),
      assignments: () => [],
    });
  for (const [id, capability] of [
    ['background.first', 'background'],
    ['matching-one.first', 'matching-one'],
    ['other.first', 'other'],
    ['matching-two.first', 'matching-two'],
    ['matching-one.second', 'matching-one'],
  ])
    registry.registerAssignment({
      id: id!,
      version: '1',
      capability: capability!,
      agent: 'HazeOps',
      tools: [],
      instructions: 'Inspect the requested evidence.',
    });
  const context = () =>
    assembleManagerContext(
      store.read(task.id, identity),
      registry,
      store.managerState(task.id, identity)!,
      { artifacts: [], events: [], maxBytes: 100_000 },
    );
  return { store, task, registry, context };
}

it('puts matching entries first with stable ordering while preserving the entire catalogue', () => {
  const { task, registry, context } = setup();
  const before = structuredClone(task);
  const capabilities = [...registry.capabilities.keys()];
  const definitions = [...registry.definitions.keys()];
  const assembled = context();
  expect(assembled.capabilities.map(({ card }) => card.id)).toEqual([
    'matching-two',
    'matching-one',
    'background',
    'other',
  ]);
  expect(assembled.definitions.map(({ id }) => id)).toEqual([
    'matching-one.first',
    'matching-two.first',
    'matching-one.second',
    'background.first',
    'other.first',
  ]);
  expect(assembled.capabilities.every(({ available }) => available)).toBe(true);
  expect(assembled.capabilities.map(({ card }) => card.id).sort()).toEqual(
    [...capabilities].sort(),
  );
  expect(assembled.definitions.map(({ id }) => id).sort()).toEqual(
    [...definitions].sort(),
  );
  expect([...registry.capabilities.keys()]).toEqual(capabilities);
  expect([...registry.definitions.keys()]).toEqual(definitions);
  expect(task).toEqual(before);
});

it('prioritizes a capability with current admitted work even without a new objective match', () => {
  const { store, task, context } = setup('Continue the admitted work.');
  store.createAssignments(
    task.id,
    task.current_run_id,
    task.objective_revision,
    [
      {
        role: 'HazeOps',
        definition_id: 'other.first',
        definition_version: '1',
        capability: 'other',
        brief: 'Continue existing evidence analysis.',
      },
    ],
  );
  const assembled = context();
  expect(assembled.capabilities.map(({ card }) => card.id)).toEqual([
    'other',
    'background',
    'matching-two',
    'matching-one',
  ]);
  expect(assembled.definitions.map(({ id }) => id)).toEqual([
    'other.first',
    'background.first',
    'matching-one.first',
    'matching-two.first',
    'matching-one.second',
  ]);
});

it('keeps registration order when there is no matching or active capability', () => {
  const { registry, context } = setup('Explain a general concept.');
  const assembled = context();
  expect(assembled.capabilities.map(({ card }) => card.id)).toEqual([
    ...registry.capabilities.keys(),
  ]);
  expect(assembled.definitions.map(({ id }) => id)).toEqual([
    ...registry.definitions.keys(),
  ]);
});
