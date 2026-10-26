import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';
import { ExecutionRegistry } from '../../app/orchestration/ports.js';
import { managerAgent } from '../../app/agents/manager/index.js';

const instances: { runtime: TaskRuntime; directory: string }[] = [];
afterEach(async () => {
  for (const { runtime, directory } of instances.splice(0)) {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

describe('task-family extensibility', () => {
  it('executes seven non-PM2.5 assignments with different scope and artifact data through registration alone', async () => {
    const registry = new ExecutionRegistry();
    for (const id of [
      'Manager',
      'HazeOps',
      'WorkerShield',
      'EvidenceCritic',
    ] as const)
      registry.registerAgent(
        id === 'Manager'
          ? managerAgent
          : {
              id,
              version: 'test.v1',
              instructions: 'Use registered methods only.',
            },
      );
    registry.registerCapability({
      card: {
        id: 'vocabulary-test',
        version: '1',
        purpose: 'Analyze a small vocabulary.',
        work_products: ['vocabulary.analysis'],
        required_tools: [],
        roles: ['WorkerShield'],
        readiness: 'implemented',
        limitations: ['Test capability.'],
      },
      matches: (request) => request.objective.includes('vocabulary'),
      assignments: (request) =>
        Array.from({ length: 7 }, (_, index) => ({
          key: `part-${index}`,
          definition_id: 'vocabulary.part',
          brief: `Count vocabulary part ${index}.`,
          depends_on: index ? [`part-${index - 1}`] : [],
          input: request.scope,
        })),
    });
    registry.registerAssignment({
      id: 'vocabulary.part',
      version: '1',
      capability: 'vocabulary-test',
      agent: 'WorkerShield',
      tools: [],
      instructions: 'Use the supplied vocabulary.',
      execute: (services) => {
        const input = services.input as { vocabulary: string[] };
        const artifact = services.save('vocabulary.analysis', {
          words: input.vocabulary.length,
          characters: input.vocabulary.reduce(
            (sum, word) => sum + word.length,
            0,
          ),
          previous_artifacts: services.context.inputs.length,
        });
        return {
          status: 'completed',
          summary: 'The registered vocabulary calculation completed.',
          support: 'supported',
          uncertainty: [],
          outputs: [artifact],
        };
      },
    });
    const directory = await mkdtemp(join(tmpdir(), 'haze-extension-'));
    const runtime = new TaskRuntime({
      stateDirectory: directory,
      registry,
      mode: 'fixture',
    });
    instances.push({ runtime, directory });
    const { task_id } = runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Analyze this vocabulary.',
        scope: { vocabulary: ['rain', 'wind', 'forest'] },
      },
      'seven-assignments',
    );
    await expect
      .poll(
        () => {
          const t = runtime.store.read(task_id, localTaskIdentity);
          return { status: t.status, error: t.error };
        },
        { timeout: 10000 },
      )
      .toEqual({ status: 'completed', error: undefined });
    const task = runtime.store.read(task_id, localTaskIdentity);
    const specialist = task.assignments.filter(
      (assignment) => assignment.role !== 'Manager',
    );
    expect(specialist).toHaveLength(7);
    expect(task.result?.covered_scope).toEqual({
      vocabulary: ['rain', 'wind', 'forest'],
    });
    expect(task.result?.work_products).toHaveLength(7);
    expect(task.result?.provenance.mode).toBe('fixture');
    const product = runtime.store.artifact(
      task.result!.work_products[6]!.id,
      localTaskIdentity,
    );
    expect(product.content).toMatchObject({ words: 3, characters: 14 });
    expect(
      task.assignments.every(
        (assignment) =>
          assignment.definition_version === '1' ||
          assignment.role === 'Manager',
      ),
    ).toBe(true);
  });
});
