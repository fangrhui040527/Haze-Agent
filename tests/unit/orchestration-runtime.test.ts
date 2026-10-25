import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentModelCompletion,
  AgentModelInput,
} from '../../app/adapters/agent-model.js';
import { contractHash } from '../../app/contracts/json.js';
import {
  orchestrationRequestSchema,
  orchestrationTaskSchema,
  type ArtifactRef,
  type OrchestrationRequest,
} from '../../app/orchestration/contracts.js';
import {
  createFixtureCapture,
  createFixturePorts,
  type FixturePortOptions,
} from '../../app/orchestration/fixtures.js';
import {
  createUnavailableHMemPort,
  createUnavailableWorldModelPort,
  type IntegrationPorts,
  type IntegrationRef,
  type NightShiftPort,
  type ZetarisPort,
} from '../../app/orchestration/ports.js';
import { OrchestrationRuntime } from '../../app/orchestration/runtime.js';
import {
  taskRecordSchema,
  type TaskIdentity,
} from '../../app/tasks/contracts.js';
import type {
  EvidenceCapture,
  EvidenceScope,
} from '../../app/tasks/evidence.js';
import { createTaskHandler } from '../../app/tasks/http.js';
import { localTaskIdentity } from '../../app/tasks/runtime.js';
import { TaskStore } from '../../app/tasks/store.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function directory() {
  const path = mkdtempSync(join(tmpdir(), 'haze-hybrid-test-'));
  cleanups.push(() => {
    const target = resolve(path);
    const within = relative(resolve(tmpdir()), target);
    if (within.startsWith('..') || resolve(tmpdir()) === target)
      throw new Error('Refusing cleanup outside the test temporary root.');
    rmSync(target, { recursive: true, force: true });
  });
  return path;
}

function request(
  overrides: Partial<OrchestrationRequest> = {},
): OrchestrationRequest {
  return orchestrationRequestSchema.parse({
    schema_version: 'haze.task.request.v2',
    objective:
      'Summarize PM2.5 evidence for the explicit scope, distinguish modeled values from observations and identify gaps.',
    scope: {
      location: 'Integration Fixture Town',
      period: { start: '2026-10-24T00:00:00Z', end: '2026-10-24T03:00:00Z' },
    },
    ...overrides,
  });
}

function phase(input: AgentModelInput): string {
  return (input.context as { phase: string }).phase;
}

function completion(value: unknown): AgentModelCompletion {
  return {
    text: JSON.stringify(value),
    receipt: {
      response_model: null,
      response_id: null,
      input_tokens: null,
      output_tokens: null,
    },
  };
}

const defaultExecutor: NightShiftPort['execute'] = (input) => {
  switch (phase(input)) {
    case 'ManagerPlan':
      return Promise.resolve(
        completion({
          capability: 'pm25-evidence-summary',
          roles: ['HazeOps', 'WorkerShield', 'EvidenceCritic'],
        }),
      );
    case 'EvidenceCritic':
      return Promise.resolve(
        completion({ verdict: 'supported', findings: [], limitations: [] }),
      );
    case 'ManagerSynthesis':
      return Promise.resolve(
        completion({
          answer:
            'The exact selection contains instantaneous modeled PM2.5 [E1]. Observations were not queried and provider issuance remains unknown. See coverage and review limitations.',
        }),
      );
    default:
      return Promise.resolve(
        completion({
          summary:
            'The supplied modeled selection and calculation [E1] retain source and missingness limitations.',
        }),
      );
  }
};

function deferred<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    release = resolvePromise;
  });
  return { promise, release };
}

function runtime(
  ports: FixturePortOptions = {},
  options: Partial<
    Pick<
      ConstructorParameters<typeof OrchestrationRuntime>[0],
      'profile' | 'otherActiveTasks'
    >
  > = {},
) {
  const stateDirectory = directory();
  const taskStore = new TaskStore(stateDirectory);
  const execute = vi.fn<NightShiftPort['execute']>(
    ports.execute ?? defaultExecutor,
  );
  const retrieve = vi.fn<ZetarisPort['retrieve']>(
    ports.retrieve ?? ((scope) => Promise.resolve(createFixtureCapture(scope))),
  );
  const instance = new OrchestrationRuntime({
    taskStore,
    stateDirectory,
    ports: createFixturePorts({ ...ports, execute, retrieve }),
    ...options,
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await instance.close();
    taskStore.close();
  };
  cleanups.push(close);
  return { instance, taskStore, execute, retrieve, stateDirectory, close };
}

async function settled(
  instance: OrchestrationRuntime,
  id: string,
  identity = localTaskIdentity,
) {
  await vi.waitFor(
    () => {
      expect(['queued', 'running']).not.toContain(
        instance.store.read(id, identity).status,
      );
    },
    { timeout: 3000, interval: 5 },
  );
  return instance.store.read(id, identity);
}

function repinRows(capture: EvidenceCapture) {
  capture.raw = JSON.stringify({
    data: capture.rows.map((row) => ({
      town: row.location,
      valid_utc: row.start,
      kind: 'model',
      issued_utc: null,
      pm25: row.value,
      source: 'open-meteo-air-quality',
      ingested_utc: row.ingested_at,
      lat: row.latitude,
      lon: row.longitude,
    })),
  });
  capture.selection.returned_rows = capture.rows.length;
  capture.selection.selected_raw_row_indices = capture.rows.map(
    (_, index) => index,
  );
  return capture;
}

function seedV1Context(taskStore: TaskStore): ArtifactRef {
  const original = request();
  const now = new Date().toISOString();
  const task = taskRecordSchema.parse({
    schema_version: 'haze.task.v1',
    id: randomUUID(),
    objective_revision: 1,
    original_request: { ...original, schema_version: 'haze.task.request.v1' },
    scope: original.scope,
    identity: localTaskIdentity,
    permissions: { tools: [], effects: [] },
    limits: {
      deadline: new Date(Date.now() + 60_000).toISOString(),
      max_tool_calls: 1,
      max_model_calls: 1,
      max_model_input_bytes: 16_000,
      max_model_output_tokens: 700,
      max_artifacts: 4,
    },
    usage: { tool_calls: 0, model_calls: 0, artifacts: 0 },
    created_at: now,
    updated_at: now,
    status: 'running',
    mode: 'live',
  });
  taskStore.admit(task, 'v1-context-fixture', task.original_request);
  const artifact = taskStore.saveArtifact(
    task,
    'supporting-note',
    {
      note: 'Prior versioned supporting fixture; it does not expand the evidence scope.',
    },
    'Manager',
  );
  task.status = 'completed';
  taskStore.transition(
    task,
    'task_completed',
    'Manager',
    'Created prior supporting fixture.',
  );
  return {
    id: artifact.id,
    version: artifact.version,
    sha256: artifact.sha256,
  };
}

describe('bounded Manager and specialist integration runtime', () => {
  it('isolates mutable model inputs from the server-owned request, scope and frozen identity', async () => {
    const original = request({
      constraints: ['Preserve the requested evidence boundary.'],
    });
    const expected = structuredClone(original);
    const { instance, execute } = runtime({
      execute: (input, context) => {
        expect(Object.isFrozen(context.identity)).toBe(true);
        expect(Object.isFrozen(context.modelLimits)).toBe(true);
        expect(() => {
          context.identity.principal = 'adapter-injected-principal';
        }).toThrow(TypeError);
        if (phase(input) === 'ManagerPlan') {
          const modelContext = input.context as {
            constraints: string[];
            material: { scope: EvidenceScope };
          };
          modelContext.constraints.push('Adapter-injected constraint.');
          modelContext.material.scope.location = 'Adapter-injected town';
          modelContext.material.scope.period.start = '2026-10-23T00:00:00Z';
        }
        return defaultExecutor(input, context);
      },
    });
    const task = await settled(
      instance,
      instance.admit(original, 'model-alias-isolation', localTaskIdentity)
        .task_id,
    );
    expect(task.status, JSON.stringify(task.error)).toBe('completed');
    expect(task.original_request).toEqual(expected);
    expect(task.scope).toEqual(expected.scope);
    expect(task.identity).toEqual(localTaskIdentity);
    expect(original).toEqual(expected);
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it('rejects evidence for a scope mutated by its adapter while preserving the authorized scope', async () => {
    const original = request();
    const expected = structuredClone(original);
    const { instance, execute, retrieve } = runtime({
      retrieve: (scope, context) => {
        expect(Object.isFrozen(context.identity)).toBe(true);
        scope.location = 'Unrequested adapter town';
        scope.period.end = '2026-10-24T04:00:00Z';
        return Promise.resolve(createFixtureCapture(scope));
      },
    });
    const task = await settled(
      instance,
      instance.admit(original, 'retrieval-alias-isolation', localTaskIdentity)
        .task_id,
    );
    expect(task.status).toBe('failed');
    expect(task.error?.code).toBe('invalid_evidence');
    expect(task.original_request).toEqual(expected);
    expect(task.scope).toEqual(expected.scope);
    expect(task.identity).toEqual(localTaskIdentity);
    expect(task.result).toBeUndefined();
    expect(task.assignments[1]?.outputs).toEqual([]);
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('bounds large optional packets while preserving exact v1 context and optional artifact lineage', async () => {
    const content = { note: 'C'.repeat(60_000) };
    const limitations = Array.from({ length: 32 }, (_, index) =>
      `${index}:`.padEnd(2000, 'L'),
    );
    const refs: IntegrationRef[] = [
      {
        id: 'fixture-large-hmem-record',
        version: 'snapshot-42',
        sha256: contractHash(content),
      },
      {
        id: 'fixture-large-world-snapshot',
        version: 'snapshot-64',
        sha256: contractHash(content),
      },
    ];
    const { instance, taskStore, execute } = runtime({
      hmem: {
        ...createUnavailableHMemPort(),
        id: 'fixture-large-hmem',
        recall: () =>
          Promise.resolve({
            status: 'available',
            ref: refs[0]!,
            content,
            limitations,
          }),
      },
      world: {
        ...createUnavailableWorldModelPort(),
        id: 'fixture-large-world',
        readSnapshot: () =>
          Promise.resolve({
            status: 'available',
            ref: refs[1]!,
            content,
            limitations,
          }),
      },
    });
    const originalRef = seedV1Context(taskStore);
    const original = request({ context_refs: [originalRef] });
    const task = await settled(
      instance,
      instance.admit(original, 'large-optional', localTaskIdentity).task_id,
    );
    expect(task.status, JSON.stringify(task.error)).toBe('completed');
    for (const [input] of execute.mock.calls)
      expect(
        Buffer.byteLength(JSON.stringify(input), 'utf8'),
      ).toBeLessThanOrEqual(task.limits.max_model_input_bytes);
    const planningInput = execute.mock.calls.find(
      ([input]) => phase(input) === 'ManagerPlan',
    )![0];
    const material = (
      planningInput.context as {
        material: {
          context: { ref: ArtifactRef; content: unknown }[];
          enrichment: { artifact_ref: ArtifactRef; ref: IntegrationRef }[];
        };
      }
    ).material;
    expect(material.context[0]?.ref).toEqual(originalRef);
    expect(material.enrichment.map((entry) => entry.ref)).toEqual(refs);
    const planningAssignment = task.assignments[0]!;
    const optionalArtifacts = planningAssignment.outputs
      .map((ref) => instance.store.artifact(ref.id, localTaskIdentity, ref))
      .filter((artifact) => artifact.kind === 'optional-context');
    expect(optionalArtifacts).toHaveLength(2);
    for (const [index, artifact] of optionalArtifacts.entries()) {
      expect(artifact.content).toMatchObject({
        status: 'available',
        ref: refs[index],
        content,
        limitations,
      });
      expect(material.enrichment[index]?.artifact_ref).toEqual({
        id: artifact.id,
        version: 1,
        sha256: artifact.sha256,
      });
    }
    const requiredDependencies = [
      originalRef,
      ...material.enrichment.map((entry) => entry.artifact_ref),
    ];
    expect(planningAssignment.inputs).toEqual(
      expect.arrayContaining(requiredDependencies),
    );
    const planningArtifact = planningAssignment.outputs
      .map((ref) => instance.store.artifact(ref.id, localTaskIdentity, ref))
      .find((artifact) => artifact.kind === 'model-turn');
    expect(planningArtifact?.dependencies).toEqual(
      expect.arrayContaining(requiredDependencies),
    );
    expect(() =>
      instance.admit(
        request({ context_refs: [{ ...originalRef, sha256: '0'.repeat(64) }] }),
        'stale-v1-context',
        localTaskIdentity,
      ),
    ).toThrow('exact accessible artifact');
  });

  it('strips unrecognized metadata from a directly injected raw NightShift receipt before persistence', async () => {
    const { instance } = runtime();
    const extra = 'unrecognized-receipt-metadata-must-not-persist';
    // Bypass factory normalization to exercise the runtime's own adapter boundary.
    instance.ports.nightshift.execute = async (input, context) => {
      const returned = await defaultExecutor(input, context);
      return { ...returned, receipt: { ...returned.receipt, debug: extra } };
    };
    const task = await settled(
      instance,
      instance.admit(request(), 'raw-receipt', localTaskIdentity).task_id,
    );
    expect(task.status, JSON.stringify(task.error)).toBe('completed');
    const turns = task.assignments
      .flatMap((assignment) => assignment.outputs)
      .map((ref) => instance.store.artifact(ref.id, localTaskIdentity, ref))
      .filter((artifact) => artifact.kind === 'model-turn');
    expect(turns).toHaveLength(5);
    for (const turn of turns)
      expect(turn.content).toMatchObject({ receipt: completion({}).receipt });
    expect(JSON.stringify(turns)).not.toContain(extra);
    expect(JSON.stringify(task)).not.toContain(extra);
    expect(
      JSON.stringify(instance.store.events(task.id, localTaskIdentity, 0)),
    ).not.toContain(extra);
  });

  it('bounds the whole model input before charging a directly injected executor', async () => {
    const baseline = runtime();
    await settled(
      baseline.instance,
      baseline.instance.admit(request(), 'input-baseline', localTaskIdentity)
        .task_id,
    );
    const planningInput = baseline.execute.mock.calls[0]![0];
    const contextBytes = Buffer.byteLength(
      JSON.stringify(planningInput.context),
      'utf8',
    );
    const limit = contextBytes + 1;
    expect(
      Buffer.byteLength(JSON.stringify(planningInput), 'utf8'),
    ).toBeGreaterThan(limit);
    const bounded = runtime({}, { profile: { maxModelInputBytes: limit } });
    const rawExecute = vi.fn<NightShiftPort['execute']>(defaultExecutor);
    bounded.instance.ports.nightshift.execute = rawExecute;
    const task = await settled(
      bounded.instance,
      bounded.instance.admit(request(), 'whole-input-limit', localTaskIdentity)
        .task_id,
    );
    expect(task.status).toBe('failed');
    expect(task.usage.model_calls).toBe(0);
    expect(rawExecute).not.toHaveBeenCalled();
    expect(bounded.retrieve).not.toHaveBeenCalled();
  });

  it.each(['invalid-mode', 'conflicting-tool-id'] as const)(
    'rejects malformed integration configuration: %s',
    (variant) => {
      const stateDirectory = directory();
      const taskStore = new TaskStore(stateDirectory);
      cleanups.push(() => taskStore.close());
      const ports = createFixturePorts({ execute: defaultExecutor });
      const malformed =
        variant === 'invalid-mode'
          ? { ...ports, zetaris: { ...ports.zetaris, mode: 'unrecognized' } }
          : { ...ports, hmem: { ...ports.hmem, id: ports.zetaris.id } };
      expect(
        () =>
          new OrchestrationRuntime({
            taskStore,
            stateDirectory,
            ports: malformed as unknown as IntegrationPorts,
          }),
      ).toThrow();
    },
  );

  it('executes five distinct assignments with exact artifacts, separate model receipts and independent checks', async () => {
    const { instance, execute, retrieve } = runtime();
    const original = request({
      constraints: ['Read-only evidence summary.'],
      desired_deliverables: ['Coverage and explicit gaps.'],
    });
    const admitted = instance.admit(original, 'complete', localTaskIdentity);
    const task = await settled(instance, admitted.task_id);
    expect(task.status, JSON.stringify(task.error)).toBe('completed');
    expect(task.usage).toMatchObject({ model_calls: 5, tool_calls: 5 });
    expect(task.assignments.map((assignment) => assignment.role)).toEqual([
      'Manager',
      'HazeOps',
      'WorkerShield',
      'EvidenceCritic',
      'Manager',
    ]);
    expect(
      task.assignments.every(
        (assignment) =>
          assignment.status === 'completed' &&
          assignment.usage.model_calls === 1,
      ),
    ).toBe(true);
    expect(
      task.assignments.map((assignment) => assignment.dependencies),
    ).toEqual([
      [],
      [task.assignments[0]!.id],
      [task.assignments[1]!.id],
      [task.assignments[2]!.id],
      [task.assignments[3]!.id],
    ]);
    expect(task.result).toMatchObject({
      schema_version: 'haze.task.result.v2',
      completion: 'full',
      review: { status: 'supported' },
      provenance: {
        mode: 'fixture',
        model: {
          calls: 5,
          model: 'fixture-nightshift',
          usage: 'not_reported_by_adapter',
        },
      },
    });
    expect(task.result?.provenance.model.receipt?.response_model).toBeNull();
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls.map(([input]) => phase(input))).toEqual([
      'ManagerPlan',
      'HazeOps',
      'WorkerShield',
      'EvidenceCritic',
      'ManagerSynthesis',
    ]);
    for (const [input, context] of execute.mock.calls) {
      expect(input.context).toMatchObject({
        objective: original.objective,
        constraints: original.constraints,
        desired_deliverables: original.desired_deliverables,
      });
      expect(context).toMatchObject({
        taskId: task.id,
        objectiveRevision: 1,
        generation: 1,
        identity: localTaskIdentity,
      });
    }
    const artifacts = task.assignments
      .flatMap((assignment) => assignment.outputs)
      .map((ref) => instance.store.artifact(ref.id, localTaskIdentity, ref));
    const turns = artifacts.filter(
      (artifact) => artifact.kind === 'model-turn',
    );
    expect(turns).toHaveLength(5);
    expect(turns.map((artifact) => artifact.assignment_id)).toEqual(
      task.assignments.map((assignment) => assignment.id),
    );
    for (const artifact of turns)
      expect(artifact.content).toMatchObject({
        receipt: completion({}).receipt,
      });
    const independent = artifacts.find(
      (artifact) => artifact.kind === 'independent-numerical-check',
    );
    expect(independent?.content).toMatchObject({ valid: true, findings: [] });
    expect(independent?.dependencies).toHaveLength(2);
    const citation = task.result!.citations[0]!;
    expect(
      instance.store.artifact(citation.artifact_id, localTaskIdentity).sha256,
    ).toBe(citation.sha256);
    expect(instance.store.events(task.id, localTaskIdentity, 0).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: 'WorkerShield',
          type: 'tool_completed',
        }),
        expect.objectContaining({
          actor: 'EvidenceCritic',
          type: 'model_completed',
        }),
      ]),
    );
  });

  it('reuses admission keys, rejects changed content and isolates task/artifact identities', async () => {
    const { instance, execute } = runtime();
    const original = request();
    const admitted = instance.admit(
      original,
      'same-operation',
      localTaskIdentity,
    );
    expect(
      instance.admit(original, 'same-operation', localTaskIdentity),
    ).toMatchObject({ task_id: admitted.task_id, reused: true });
    expect(() =>
      instance.admit(
        request({ constraints: ['Changed content.'] }),
        'same-operation',
        localTaskIdentity,
      ),
    ).toThrow('different content');
    const task = await settled(instance, admitted.task_id);
    expect(execute).toHaveBeenCalledTimes(5);
    const outsider: TaskIdentity = {
      ...localTaskIdentity,
      workspace: 'different-workspace',
    };
    expect(() => instance.store.read(task.id, outsider)).toThrow('not found');
    expect(() =>
      instance.store.artifact(task.result!.citations[0]!.artifact_id, outsider),
    ).toThrow('not found');
    const separate = instance.admit(original, 'same-operation', outsider);
    expect(separate.reused).toBe(false);
    expect(separate.task_id).not.toBe(task.id);
    expect((await settled(instance, separate.task_id, outsider)).status).toBe(
      'completed',
    );
  });

  it('rejects unsupported scope and self-authorized permissions before model execution', () => {
    const { instance, execute, retrieve } = runtime();
    expect(() =>
      instance.admit(
        request({ objective: 'Summarize rainfall.' }),
        'unsupported',
        localTaskIdentity,
      ),
    ).toThrow('PM2.5');
    expect(() =>
      instance.admit(
        { ...request(), permissions: { tools: ['free-sql'] } },
        'self-grants',
        localTaskIdentity,
      ),
    ).toThrow('haze.task.request.v2');
    expect(execute).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'unknown capability',
      plan: {
        capability: 'unknown',
        roles: ['HazeOps', 'WorkerShield', 'EvidenceCritic'],
      },
      error: 'invalid_model_output',
    },
    {
      label: 'missing review dependency',
      plan: {
        capability: 'pm25-evidence-summary',
        roles: ['HazeOps', 'WorkerShield'],
      },
      error: 'invalid_plan',
    },
    {
      label: 'reordered dependencies',
      plan: {
        capability: 'pm25-evidence-summary',
        roles: ['EvidenceCritic', 'WorkerShield', 'HazeOps'],
      },
      error: 'invalid_plan',
    },
  ])(
    'rejects $label without querying evidence or retrying',
    async ({ plan, error }) => {
      const { instance, execute, retrieve } = runtime({
        execute: () => Promise.resolve(completion(plan)),
      });
      const task = await settled(
        instance,
        instance.admit(request(), 'invalid-plan', localTaskIdentity).task_id,
      );
      expect(task.status).toBe('failed');
      expect(task.error?.code).toBe(error);
      expect(task.usage.model_calls).toBe(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(retrieve).not.toHaveBeenCalled();
    },
  );

  it('withholds rejected claims even when final synthesis tries to reintroduce them', async () => {
    const { instance } = runtime({
      execute: (input, context) => {
        if (phase(input) === 'EvidenceCritic')
          return Promise.resolve(
            completion({
              verdict: 'rejected',
              findings: ['Unsupported proposed claim.'],
              limitations: ['Review is informational.'],
            }),
          );
        if (phase(input) === 'ManagerSynthesis') {
          expect(input.context).toMatchObject({
            material: { analysis: null, allowed_findings: [] },
          });
          return Promise.resolve(
            completion({
              answer: 'Invented claim: concentrations are 999 [E1].',
            }),
          );
        }
        return defaultExecutor(input, context);
      },
    });
    const task = await settled(
      instance,
      instance.admit(request(), 'reject', localTaskIdentity).task_id,
    );
    expect(task.status, JSON.stringify(task.error)).toBe('completed');
    expect(task.result).toMatchObject({
      completion: 'blocked',
      findings: [],
      review: { status: 'rejected' },
    });
    expect(task.result?.answer).toContain('Rejected claims are withheld');
    expect(task.result?.answer).not.toContain('999');
    expect(task.result?.coverage).toBeNull();
  });

  it('preserves needs_review limitations as a partial result', async () => {
    const { instance } = runtime({
      execute: (input, context) =>
        phase(input) === 'EvidenceCritic'
          ? Promise.resolve(
              completion({
                verdict: 'needs_review',
                findings: ['Source ingestion requires review.'],
                limitations: ['Spatial support remains unknown.'],
              }),
            )
          : defaultExecutor(input, context),
    });
    const task = await settled(
      instance,
      instance.admit(request(), 'needs-review', localTaskIdentity).task_id,
    );
    expect(task.status, JSON.stringify(task.error)).toBe('completed');
    expect(task.result).toMatchObject({
      completion: 'partial',
      review: { status: 'needs_review' },
    });
    expect(task.result?.review.limitations).toContain(
      'Spatial support remains unknown.',
    );
    expect(task.result?.unresolved_gaps).toContain(
      'Source ingestion requires review.',
    );
  });

  it.each(['missing', 'null', 'truncated', 'empty'] as const)(
    'completes truthful %s evidence with explicit partial coverage',
    async (variant) => {
      const { instance } = runtime({
        retrieve: (scope) => {
          const evidence = createFixtureCapture(scope);
          if (variant === 'missing') evidence.rows.splice(1, 1);
          if (variant === 'null') evidence.rows[1]!.value = null;
          if (variant === 'empty') evidence.rows = [];
          repinRows(evidence);
          if (variant === 'truncated') {
            const raw = JSON.parse(evidence.raw) as { data: unknown[] };
            raw.data.push(raw.data[0]);
            evidence.raw = JSON.stringify(raw);
            evidence.selection.row_limit = 3;
            evidence.selection.returned_rows = 4;
            evidence.selection.truncated = true;
          }
          return Promise.resolve(evidence);
        },
      });
      const task = await settled(
        instance,
        instance.admit(request(), variant, localTaskIdentity).task_id,
      );
      expect(task.status, JSON.stringify(task.error)).toBe('completed');
      expect(task.result?.completion).toBe('partial');
      expect(task.result?.coverage?.status).toBe(
        variant === 'empty' ? 'insufficient_evidence' : 'partial',
      );
      expect(task.result?.coverage?.observation_count).toBe(0);
      expect(task.result?.unresolved_gaps.join(' ')).toContain(
        'Provider issuance time is unknown',
      );
      if (variant === 'missing' || variant === 'null')
        expect(task.result?.coverage?.missing_intervals).toEqual([
          {
            start: '2026-10-24T01:00:00.000Z',
            end: '2026-10-24T02:00:00.000Z',
          },
        ]);
    },
  );

  it('requires accessible exact context versions and rejects stale hashes before new work', async () => {
    const { instance, execute } = runtime();
    const first = await settled(
      instance,
      instance.admit(request(), 'context-source', localTaskIdentity).task_id,
    );
    const exact = first.assignments[1]!.outputs[0]!;
    expect(() =>
      instance.admit(
        request({ context_refs: [{ ...exact, sha256: '0'.repeat(64) }] }),
        'stale-context',
        localTaskIdentity,
      ),
    ).toThrow('version/hash');
    expect(execute).toHaveBeenCalledTimes(5);
    const second = await settled(
      instance,
      instance.admit(
        request({ context_refs: [exact] }),
        'exact-context',
        localTaskIdentity,
      ).task_id,
    );
    expect(second.status, JSON.stringify(second.error)).toBe('completed');
    expect(execute.mock.calls[5]![0].context).toMatchObject({
      material: { context: [{ ref: exact }] },
    });
  });

  it('cancels an uncooperative in-flight model and fences its eventual output', async () => {
    const late = deferred<AgentModelCompletion>();
    const { instance, execute, retrieve } = runtime({
      execute: () => late.promise,
    });
    const admitted = instance.admit(request(), 'cancel', localTaskIdentity);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1), {
      interval: 5,
    });
    const before = instance.store.read(admitted.task_id, localTaskIdentity);
    expect(before.usage.model_calls).toBe(1);
    const cancelled = instance.cancel(
      admitted.task_id,
      localTaskIdentity,
      'cancel-operation',
    );
    expect(cancelled).toMatchObject({ status: 'cancelled', generation: 2 });
    expect(
      instance.cancel(admitted.task_id, localTaskIdentity, 'cancel-operation'),
    ).toEqual(cancelled);
    expect(
      instance.cancel(
        admitted.task_id,
        localTaskIdentity,
        'another-cancel-operation',
      ),
    ).toEqual(cancelled);
    await vi.waitFor(() => expect(instance.activeCount).toBe(0), {
      interval: 5,
    });
    late.release(
      completion({
        capability: 'pm25-evidence-summary',
        roles: ['HazeOps', 'WorkerShield', 'EvidenceCritic'],
      }),
    );
    await late.promise;
    const after = instance.store.read(admitted.task_id, localTaskIdentity);
    expect(after).toMatchObject({
      status: 'cancelled',
      generation: 2,
      usage: { model_calls: 1, artifacts: 0 },
    });
    expect(after.result).toBeUndefined();
    expect(
      after.assignments.flatMap((assignment) => assignment.outputs),
    ).toEqual([]);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('classifies an adapter-observed deadline as timed out before the root timer fires', async () => {
    const held = deferred<AgentModelCompletion>();
    const { instance, execute } = runtime(
      { execute: () => held.promise },
      { profile: { deadlineMs: 60_000 } },
    );
    const id = instance.admit(request(), 'deadline', localTaskIdentity).task_id;
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1), {
      interval: 5,
    });
    const running = instance.store.read(id, localTaskIdentity);
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(running.limits.deadline) + 1);
    try {
      held.release(
        completion({
          capability: 'pm25-evidence-summary',
          roles: ['HazeOps', 'WorkerShield', 'EvidenceCritic'],
        }),
      );
      const task = await settled(instance, id);
      expect(task.status).toBe('timed_out');
      expect(task.usage.model_calls).toBe(1);
      expect(task.usage.artifacts).toBe(0);
      expect(task.result).toBeUndefined();
      await vi.waitFor(() => expect(instance.activeCount).toBe(0), {
        interval: 5,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('admits at most two active tasks and preserves charged attempts without retries', async () => {
    const held = deferred<AgentModelCompletion>();
    const { instance, execute } = runtime({ execute: () => held.promise });
    const first = instance.admit(request(), 'slot-1', localTaskIdentity);
    const second = instance.admit(request(), 'slot-2', localTaskIdentity);
    const rejected = instance.admit(request(), 'slot-3', localTaskIdentity);
    expect(
      instance.store.read(rejected.task_id, localTaskIdentity),
    ).toMatchObject({
      status: 'failed',
      error: { code: 'capacity_exhausted' },
      usage: { model_calls: 0, tool_calls: 0 },
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2), {
      interval: 5,
    });
    expect(instance.activeCount).toBe(2);
    instance.cancel(first.task_id, localTaskIdentity, 'release-1');
    instance.cancel(second.task_id, localTaskIdentity, 'release-2');
    await vi.waitFor(() => expect(instance.activeCount).toBe(0), {
      interval: 5,
    });
    expect(
      instance.store.read(first.task_id, localTaskIdentity).usage.model_calls,
    ).toBe(1);
    expect(
      instance.store.read(second.task_id, localTaskIdentity).usage.model_calls,
    ).toBe(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('shares its admission limit with existing v1 task execution', async () => {
    const { instance, execute } = runtime({}, { otherActiveTasks: () => 2 });
    const task = await settled(
      instance,
      instance.admit(request(), 'legacy-busy', localTaskIdentity).task_id,
    );
    expect(task.error?.code).toBe('capacity_exhausted');
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([{ maxModelCalls: 4 }, { maxToolCalls: 4 }, { maxArtifacts: 8 }])(
    'reserves downstream review and synthesis before starting work: %j',
    async (profile) => {
      const { instance, execute, retrieve } = runtime({}, { profile });
      const task = await settled(
        instance,
        instance.admit(request(), 'insufficient-reservation', localTaskIdentity)
          .task_id,
      );
      expect(task.error?.code).toBe('insufficient_reservation');
      expect(task.usage).toMatchObject({
        model_calls: 0,
        tool_calls: 0,
        artifacts: 0,
      });
      expect(execute).not.toHaveBeenCalled();
      expect(retrieve).not.toHaveBeenCalled();
    },
  );

  it('fails oversized model context before charging a turn instead of silently truncating it', async () => {
    const { instance, execute } = runtime(
      {},
      { profile: { maxModelInputBytes: 100 } },
    );
    const task = await settled(
      instance,
      instance.admit(request(), 'context-limit', localTaskIdentity).task_id,
    );
    expect(task.error?.code).toBe('model_context_limit');
    expect(task.usage.model_calls).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves interrupted artifacts and charged ledger across restart without replay', async () => {
    const held = deferred<AgentModelCompletion>();
    const original = runtime({
      execute: (input, context) =>
        phase(input) === 'HazeOps'
          ? held.promise
          : defaultExecutor(input, context),
    });
    const id = original.instance.admit(
      request(),
      'restart',
      localTaskIdentity,
    ).task_id;
    await vi.waitFor(
      () =>
        expect(
          original.execute.mock.calls.some(
            ([input]) => phase(input) === 'HazeOps',
          ),
        ).toBe(true),
      { interval: 5 },
    );
    const interrupted = original.instance.store.read(id, localTaskIdentity);
    const evidence = interrupted.assignments[1]!.outputs[0]!;
    expect(interrupted.usage.model_calls).toBe(2);
    await original.instance.close();
    // Restore the last running row to model a process crash before the terminal fence committed.
    original.taskStore.db
      .prepare('UPDATE hybrid_tasks SET body=? WHERE id=?')
      .run(JSON.stringify(interrupted), id);
    await original.close();
    const taskStore = new TaskStore(original.stateDirectory);
    const execute = vi.fn<NightShiftPort['execute']>(defaultExecutor);
    const restarted = new OrchestrationRuntime({
      taskStore,
      stateDirectory: original.stateDirectory,
      ports: createFixturePorts({ execute }),
    });
    cleanups.push(async () => {
      await restarted.close();
      taskStore.close();
    });
    const restored = restarted.store.read(id, localTaskIdentity);
    expect(restored).toMatchObject({
      status: 'failed',
      error: { code: 'restart_interrupted' },
      usage: interrupted.usage,
    });
    expect(
      restarted.store.artifact(evidence.id, localTaskIdentity, evidence).kind,
    ).toBe('evidence-capture');
    expect(
      restarted.admit(request(), 'restart', localTaskIdentity),
    ).toMatchObject({ task_id: id, reused: true });
    expect(execute).not.toHaveBeenCalled();
    expect(restarted.activeCount).toBe(0);
  });

  it('uses separate v1/v2 ledgers and rolls back a failed admission atomically', async () => {
    const { instance, taskStore } = runtime();
    const task = await settled(
      instance,
      instance.admit(request(), 'shared-key', localTaskIdentity).task_id,
    );
    const v1Request = { ...request(), schema_version: 'haze.task.request.v1' };
    const v1 = taskRecordSchema.parse({
      schema_version: 'haze.task.v1',
      id: randomUUID(),
      objective_revision: 1,
      original_request: v1Request,
      scope: task.scope,
      identity: localTaskIdentity,
      permissions: { tools: [], effects: [] },
      limits: task.limits,
      usage: { tool_calls: 0, model_calls: 0, artifacts: 0 },
      created_at: task.created_at,
      updated_at: task.updated_at,
      status: 'failed',
      mode: 'live',
    });
    expect(taskStore.admit(v1, 'shared-key', v1Request).reused).toBe(false);
    expect(taskStore.read(v1.id, localTaskIdentity).schema_version).toBe(
      'haze.task.v1',
    );
    expect(instance.store.read(task.id, localTaskIdentity).schema_version).toBe(
      'haze.task.v2',
    );
    const before = taskStore.db
      .prepare('SELECT COUNT(*) AS count FROM hybrid_operations')
      .get();
    expect(() =>
      instance.store.admit(task, 'must-rollback', request()),
    ).toThrow();
    expect(
      taskStore.db
        .prepare('SELECT COUNT(*) AS count FROM hybrid_operations')
        .get(),
    ).toEqual(before);
    expect(
      taskStore.db
        .prepare('SELECT key FROM hybrid_operations WHERE key=?')
        .get('must-rollback'),
    ).toBeUndefined();
    expect(instance.store.read(task.id, localTaskIdentity).usage).toEqual(
      task.usage,
    );
  });

  it('routes v2 admission, durable readback, events, artifacts and cancellation through the existing local API', async () => {
    const stateDirectory = directory();
    const execute = vi.fn<NightShiftPort['execute']>(defaultExecutor);
    const handler = createTaskHandler({
      stateDirectory,
      orchestrationPorts: createFixturePorts({ execute }),
    });
    const server = createServer((incoming, outgoing) =>
      handler(incoming, outgoing),
    );
    await new Promise<void>((ready) => {
      server.listen(0, '127.0.0.1', ready);
    });
    cleanups.push(async () => {
      await new Promise<void>((done, reject) => {
        server.close((error) => (error ? reject(error) : done()));
      });
      await handler.close();
    });
    const address = server.address();
    if (typeof address !== 'object' || address === null)
      throw new Error('Missing loopback address.');
    const base = `http://127.0.0.1:${address.port}`;
    const headers = {
      Origin: base,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'http-v2',
    };
    const admittedResponse = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request()),
    });
    expect(admittedResponse.status).toBe(202);
    const admitted = (await admittedResponse.json()) as {
      task_id: string;
      status_url: string;
      events_url: string;
    };
    const task = await settled(handler.orchestration, admitted.task_id);
    const readback = await fetch(`${base}${admitted.status_url}`);
    expect(orchestrationTaskSchema.parse(await readback.json()).status).toBe(
      'completed',
    );
    const events = await fetch(`${base}${admitted.events_url}`);
    expect(events.status).toBe(200);
    const citation = task.result!.citations[0]!;
    const artifact = await fetch(`${base}${citation.url}`);
    expect(artifact.status).toBe(200);
    expect(await artifact.json()).toMatchObject({
      id: citation.artifact_id,
      sha256: citation.sha256,
    });
    const forbidden = await fetch(`${base}${admitted.status_url}/cancel`, {
      method: 'POST',
      headers: { ...headers, Origin: 'https://outside.invalid' },
      body: '{}',
    });
    expect(forbidden.status).toBe(403);
    const cancelled = await fetch(`${base}${admitted.status_url}/cancel`, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'http-cancel' },
      body: '{}',
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({
      status: 'completed',
      generation: 1,
    });
  });
});
