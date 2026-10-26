import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';
import {
  ExecutionRegistry,
  type CapabilityWorldModelAdapter,
} from '../../app/orchestration/ports.js';
import {
  taskRequestSchema,
  taskResultSchema,
} from '../../app/contracts/tasks.js';

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
      registry.registerAgent({
        id,
        version: 'test.v1',
        instructions: 'Use registered methods only.',
      });
    const request = taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Analyze this vocabulary.',
      scope: { vocabulary: ['rain', 'wind', 'forest'] },
    });
    const worldModel: CapabilityWorldModelAdapter = {
      extract: ({ artifacts }) =>
        artifacts.map((artifact) => ({
          kind: 'vocabulary_claim',
          external_id: `vocabulary:${artifact.id}:${artifact.version}`,
          payload: {
            artifact: {
              id: artifact.id,
              version: artifact.version,
              sha256: artifact.sha256,
            },
          },
          evidence: [
            {
              id: artifact.id,
              version: artifact.version,
              sha256: artifact.sha256,
            },
          ],
        })),
      buildAcceptanceCandidate: ({ request, records, artifacts }) => {
        const subject = records.find(
          (record) => record.kind === 'vocabulary_claim',
        );
        if (!subject) return undefined;
        return {
          subject: subject.ref,
          stated_use: request.objective,
          evidence: artifacts.map(({ id, version, sha256 }) => ({
            id,
            version,
            sha256,
          })),
        };
      },
      requiredReviewCoverage: ({ assignments, artifacts }) =>
        assignments.some(
          (assignment) => assignment.definition_id === 'vocabulary.review',
        )
          ? [
              {
                id: 'vocabulary-independent-review',
                evidence: artifacts.map(({ id, version, sha256 }) => ({
                  id,
                  version,
                  sha256,
                })),
                reviewer_roles: ['EvidenceCritic'],
              },
            ]
          : [],
    };
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
      matches: (candidate) => candidate.objective.includes('vocabulary'),
      assignments: (request) =>
        Array.from({ length: 7 }, (_, index) => ({
          key: `part-${index}`,
          definition_id: 'vocabulary.part',
          brief: `Count vocabulary part ${index}.`,
          depends_on: index ? [`part-${index - 1}`] : [],
          input: request.scope,
        })),
      worldModel,
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
      .poll(() => runtime.store.read(task_id, localTaskIdentity).status)
      .toBe('completed');
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
    const capability = registry.capabilities.get('vocabulary-test')!;
    expect(capability.worldModel).toBe(worldModel);
    const extracted = worldModel.extract({ request, artifacts: [product] });
    const projected = runtime.store.world.putRecord({
      scope: {
        principal: localTaskIdentity.principal,
        workspace: localTaskIdentity.workspace,
        mode: 'fixture',
      },
      operation_key: 'extension-vocabulary-record',
      kind: 'vocabulary_claim',
      external_id: `vocabulary:${product.id}:${product.version}`,
      payload: {
        artifact: {
          id: product.id,
          version: product.version,
          sha256: product.sha256,
        },
      },
      producer: { kind: 'assignment', id: 'vocabulary.part' },
    }).value;
    expect(extracted).toHaveLength(1);
    expect(
      worldModel.buildAcceptanceCandidate({
        request,
        records: [projected],
        assessments: [],
        artifacts: [product],
      }),
    ).toEqual({
      subject: projected.ref,
      stated_use: request.objective,
      evidence: [
        {
          id: product.id,
          version: product.version,
          sha256: product.sha256,
        },
      ],
    });
    expect(
      worldModel.requiredReviewCoverage({
        request,
        assignments: [
          {
            key: 'review',
            definition_id: 'vocabulary.review',
            brief: 'Independently review claims.',
            depends_on: [],
          },
        ],
        artifacts: [product],
      }),
    ).toEqual([
      {
        id: 'vocabulary-independent-review',
        evidence: [
          {
            id: product.id,
            version: product.version,
            sha256: product.sha256,
          },
        ],
        reviewer_roles: ['EvidenceCritic'],
      },
    ]);
    expect(taskResultSchema.parse(task.result)).toEqual(task.result);
    expect(
      task.assignments.every(
        (assignment) =>
          assignment.definition_version === '1' ||
          assignment.role === 'Manager',
      ),
    ).toBe(true);
  });
});
