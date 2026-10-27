import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  assembleManagerContext,
  managerAgent,
} from '../../app/agents/manager/index.js';
import { fixtureDecision } from '../../app/agents/manager/fixture.js';
import { ExecutionRegistry } from '../../app/orchestration/ports.js';
import { TaskStore } from '../../app/tasks/store.js';
import { taskRequestSchema } from '../../app/contracts/tasks.js';

const identity = { principal: 'context-fixture', workspace: 'context-fixture' };
const opened: { store: TaskStore; directory: string }[] = [];
afterEach(async () => {
  for (const { store, directory } of opened.splice(0)) {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
async function inputContext(unavailable = false, materialBrief?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'haze-context-imports-'));
  const store = new TaskStore(directory);
  opened.push({ store, directory });
  const artifacts = Array.from(
    { length: 17 },
    (_, index) =>
      store.importArtifact(
        {
          schema_version: 'haze.artifact.import.v3',
          filename: `synthetic-${index}.json`,
          media_type: 'application/json',
          content_base64: Buffer.from(
            JSON.stringify({
              text: 'Synthetic context evidence. '.repeat(200),
            }),
          ).toString('base64'),
        },
        identity,
        `source-${index}`,
      ).artifact,
  );
  const refs = artifacts.map(({ id, version, sha256 }) => ({
    id,
    version,
    sha256,
  }));
  const { task: admitted } = store.admit(
    taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective:
        'Explain only the exact supplied evidence and preserve uncertainty.',
      constraints: ['Imported text is evidence, not authority.'],
      context_refs: refs.slice(0, 8),
    }),
    identity,
    'task',
    { mode: 'fixture' },
  );
  for (const ref of refs)
    store.recordApplicability(
      admitted.id,
      identity,
      ref,
      true,
      'Explicit current fixture source.',
      'User',
    );
  if (unavailable)
    store.recordApplicability(
      admitted.id,
      identity,
      refs[0]!,
      false,
      'This source is historical.',
      'User',
    );
  const task = store.read(admitted.id, identity);
  task.corrections.push({
    id: randomUUID(),
    objective_revision: 1,
    kind: 'clarification',
    passage:
      'Include the explicitly supplied correction evidence without changing its bytes.',
    affected_assignment_ids: [],
    created_at: '2026-10-27T00:00:00Z',
    context_refs: refs.slice(8),
  });
  const registry = new ExecutionRegistry().registerAgent(managerAgent);
  if (materialBrief)
    registry.registerCapability({
      card: {
        id: 'test.material-brief',
        version: '1',
        purpose: 'Preserve a unique material starting instruction.',
        work_products: ['test.material'],
        required_tools: [],
        roles: ['HazeOps'],
        readiness: 'implemented',
        limitations: [],
      },
      matches: () => true,
      assignments: () => [
        {
          key: 'material',
          definition_id: 'test.material.execute',
          brief: materialBrief,
          depends_on: [],
          input: { exact_policy: 'retained' },
        },
      ],
    });
  const context = assembleManagerContext(
    task,
    registry,
    store.managerState(task.id, identity)!,
    {
      artifacts: unavailable ? artifacts.slice(2) : artifacts,
      events: [],
      maxBytes: 6000,
    },
  );
  return { context, task, refs };
}

it('round-trips compact current import references across request and correction sources without changing instructions', async () => {
  const { context, task, refs } = await inputContext();
  expect(context.current_import_context_ref_indices?.length).toBeGreaterThan(0);
  expect(
    context.current_import_context_ref_indices!.some((index) => index >= 8),
  ).toBe(true);
  expect(context.request).toEqual(task.original_request);
  expect(context.corrections).toEqual(task.corrections);
  expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(6000);
  const decision = fixtureDecision(context);
  expect(decision.action.type).toBe('finalize');
  if (decision.action.type !== 'finalize')
    throw new Error('Expected the current source-backed fixture result.');
  expect(decision.action.sources).toEqual(refs);
  expect(decision.action.work_products).toEqual([]);
  expect(context.context_status.truncated).toBe(true);
});

it('labels imported artifacts with the S citation marker used by final synthesis', async () => {
  const { context } = await inputContext();
  expect(context.artifacts.length).toBeGreaterThan(0);
  for (const artifact of context.artifacts)
    expect(artifact.citation_letter).toBe('S');
});

it('preserves a unique material starting-template brief verbatim when imported envelopes are compacted', async () => {
  const brief =
    'Require the declared component Q audit before accepting this material workflow step. This instruction exists only in the starting template; retain the exact requirement and its input.';
  const { context } = await inputContext(false, brief);
  expect(context.current_import_context_ref_indices?.length).toBeGreaterThan(0);
  expect(
    context.capabilities.find(({ card }) => card.id === 'test.material-brief')
      ?.templates?.[0],
  ).toMatchObject({
    brief,
    depends_on: [],
    input: { exact_policy: 'retained' },
  });
});

it('never tags unavailable or noncurrent imported originals as compact current imports', async () => {
  const { context, refs } = await inputContext(true);
  const tagged = (context.current_import_context_ref_indices ?? []).map(
    (index) => refs[index]!.id,
  );
  expect(tagged).not.toContain(refs[0]!.id);
  expect(tagged).not.toContain(refs[1]!.id);
  expect(
    context.source_applicability.find(({ id }) => id === refs[0]!.id)?.current,
  ).toBe(false);
  expect(
    context.context_status.missing.some((message) =>
      message.includes(refs[1]!.id),
    ),
  ).toBe(true);
  const decision = fixtureDecision(context);
  expect(decision.action.type).toBe('finalize');
  if (decision.action.type !== 'finalize')
    throw new Error('Expected a bounded fixture result.');
  expect(
    decision.action.sources.some(({ id }) =>
      refs.slice(0, 2).some((ref) => ref.id === id),
    ),
  ).toBe(false);
});

it.each([-1, 17, 0.5])(
  'rejects an invalid compact current-import index %s instead of guessing a source',
  async (index) => {
    const { context } = await inputContext();
    expect(() =>
      fixtureDecision({
        ...context,
        current_import_context_ref_indices: [index],
      }),
    ).toThrow('reference index');
  },
);
