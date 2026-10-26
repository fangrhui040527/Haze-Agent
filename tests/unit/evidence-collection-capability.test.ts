import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  artifactContentSchema,
  type Artifact,
} from '../../app/contracts/artifacts.js';
import { taskRequestSchema } from '../../app/contracts/tasks.js';
import { createExecutionRegistry } from '../../app/composition.js';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';
import type {
  AssignmentServices,
  ToolContext,
} from '../../app/orchestration/ports.js';
import {
  CollectionUnavailableError,
  createEvidenceCollectionAssignments,
  createEvidenceCollectionCapability,
  createEvidenceCollectionTools,
  EVIDENCE_COLLECTION_TOOL_ID,
} from '../../app/capabilities/evidence-collection/index.js';
import {
  collectionCaptureSchema,
  evidenceCollectionScopeSchema,
  type EvidenceCollectionScope,
} from '../../app/capabilities/evidence-collection/contracts.js';
import { createFixtureCollectionAdapter } from '../../app/capabilities/evidence-collection/fixtures.js';

const scope: EvidenceCollectionScope = {
  capability: 'evidence-collection',
  provider: 'open-meteo',
  locations: [
    {
      id: 'fixture-town',
      name: 'Fixture Town',
      region: 'Southeast Asia',
      country: 'Malaysia',
      countryCode: 'MY',
      lat: 3,
      lon: 101,
      timeZone: 'Asia/Kuala_Lumpur',
      aqiStandard: 'Malaysia API',
      populationBand: 'small',
    },
  ],
};

function context(signal = new AbortController().signal): ToolContext {
  return {
    taskId: randomUUID(),
    runId: randomUUID(),
    assignmentId: randomUUID(),
    assignmentRevision: 1,
    objectiveRevision: 1,
    generation: 1,
    identity: localTaskIdentity,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal,
    inputs: [],
    peers: [],
    outputs: [],
  };
}

function services(
  tool: AssignmentServices['tool'],
  signal = new AbortController().signal,
) {
  const saved: Artifact[] = [];
  const service: AssignmentServices = {
    context: context(signal),
    input: scope,
    tool,
    save(kind, content, metadata) {
      const artifact: Artifact = {
        schema_version: 'haze.artifact.v3',
        id: randomUUID(),
        version: 1,
        sha256: 'a'.repeat(64),
        identity: localTaskIdentity,
        kind,
        producer: { kind: 'assignment', id: 'collection-test' },
        created_at: new Date().toISOString(),
        dependencies: [],
        required_tools: [EVIDENCE_COLLECTION_TOOL_ID],
        content: artifactContentSchema.parse(content),
        ...(metadata ?? {}),
      };
      saved.push(artifact);
      return artifact;
    },
    question: vi.fn(),
    message: vi.fn(),
    inbox: () => [],
    read: () => {
      throw new Error('No input artifacts in this test.');
    },
  };
  return { service, saved };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('one-shot evidence collection capability', () => {
  it('requires an explicit bounded provider/location scope and retains separate PM2.5 matching', () => {
    const capability = createEvidenceCollectionCapability();
    expect(
      capability.matches(
        taskRequestSchema.parse({
          schema_version: 'haze.task.request.v3',
          objective: 'Summarize PM2.5 for Klang.',
        }),
      ),
    ).toBe(false);
    expect(
      capability.matches(
        taskRequestSchema.parse({
          schema_version: 'haze.task.request.v3',
          objective: 'Collect PM2.5 evidence.',
          scope,
        }),
      ),
    ).toBe(true);
    expect(
      evidenceCollectionScopeSchema.safeParse({
        ...scope,
        locations: [...scope.locations, ...scope.locations],
      }).success,
    ).toBe(false);
    expect(
      evidenceCollectionScopeSchema.safeParse({
        ...scope,
        period: { start: '2026-10-01', end: '2026-10-02' },
      }).success,
    ).toBe(false);
    expect(
      evidenceCollectionScopeSchema.safeParse({
        ...scope,
        sql: 'SELECT * FROM anything',
      }).success,
    ).toBe(false);
    expect(
      evidenceCollectionScopeSchema.safeParse({
        ...scope,
        locations: Array.from({ length: 26 }, (_, index) => ({
          ...scope.locations[0],
          id: `place-${index}`,
        })),
      }).success,
    ).toBe(false);
    const registry = createExecutionRegistry({ mode: 'fixture' });
    const request = taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Collect PM2.5 evidence.',
      scope,
    });
    const matching = [...registry.capabilities.values()]
      .filter((item) => item.matches(request))
      .map((item) => item.card.id);
    expect(matching[0]).toBe('evidence-collection');
    expect(matching).not.toContain('pm25-evidence-summary');
    expect(
      registry.definitions.get('evidence-collection.collect')?.tools,
    ).toEqual([EVIDENCE_COLLECTION_TOOL_ID]);
    expect(
      registry.tools.get(EVIDENCE_COLLECTION_TOOL_ID)?.manager_read_only,
    ).toBeUndefined();
  });

  it('keeps fixture collection offline and preserves exact bytes and synthetic artifact origin', async () => {
    const fetch = vi.fn(() => {
      throw new Error('Unexpected network request.');
    });
    vi.stubGlobal('fetch', fetch);
    const resolver = vi.fn(() => {
      throw new Error('Fixture must not resolve a live source.');
    });
    const tool = createEvidenceCollectionTools({
      mode: 'fixture',
      resolveSource: resolver,
    })[0]!;
    const capture = collectionCaptureSchema.parse(
      await tool.execute(scope, context()),
    );
    expect(capture).toMatchObject({
      mode: 'fixture',
      evidence_origin: 'synthetic_fixture',
      scope,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        Buffer.from(capture.evidence[0]!.raw_base64, 'base64').toString('utf8'),
      ),
    ).toMatchObject({ synthetic: true, provider: scope.provider });
    const { service, saved } = services(() => Promise.resolve(capture));
    const result =
      await createEvidenceCollectionAssignments()[0]!.execute!(service);
    expect(result).toMatchObject({ status: 'completed', support: 'partial' });
    expect(saved[0]).toMatchObject({
      kind: 'evidence.collection.capture',
      evidence_origin: 'synthetic_fixture',
    });
    const corrupted = structuredClone(capture);
    corrupted.evidence[0]!.raw_base64 =
      Buffer.from('different bytes').toString('base64');
    expect(collectionCaptureSchema.safeParse(corrupted).success).toBe(false);
    const wrongSource = structuredClone(capture);
    wrongSource.evidence[0]!.record.sourceId = 'other-source';
    expect(collectionCaptureSchema.safeParse(wrongSource).success).toBe(false);
    const wrongLocation = structuredClone(capture);
    wrongLocation.facts[0]!.about.id = 'outside-scope';
    expect(collectionCaptureSchema.safeParse(wrongLocation).success).toBe(
      false,
    );
  });

  it('reports definite configuration gaps and never falls back on unavailable live or replay sources', async () => {
    const fetch = vi.fn(() => {
      throw new Error('Unexpected network request.');
    });
    vi.stubGlobal('fetch', fetch);
    const noKey = createEvidenceCollectionTools({ mode: 'live', env: {} })[0]!;
    await expect(
      noKey.execute({ ...scope, provider: 'openaq' }, context()),
    ).rejects.toThrow('OPEN_AQ_KEY');
    const replay = createEvidenceCollectionTools({ mode: 'replay' })[0]!;
    await expect(replay.execute(scope, context())).rejects.toThrow(
      'explicit source resolver',
    );
    const sample = createEvidenceCollectionTools({
      mode: 'live',
      env: { SAMPLE_MODE: 'true' },
    })[0]!;
    await expect(sample.execute(scope, context())).rejects.toThrow(
      'SAMPLE_MODE',
    );
    const injected = vi.fn(() => createFixtureCollectionAdapter(scope));
    const sampleInjected = createEvidenceCollectionTools({
      mode: 'live',
      env: { SAMPLE_MODE: 'true' },
      resolveSource: injected,
    })[0]!;
    await expect(sampleInjected.execute(scope, context())).rejects.toThrow(
      'SAMPLE_MODE',
    );
    expect(injected).not.toHaveBeenCalled();
    const zetaris = createEvidenceCollectionTools({
      mode: 'live',
      env: { ZETARIS_USERNAME: 'test', ZETARIS_PASSWORD: 'test' },
    })[0]!;
    await expect(
      zetaris.execute({ ...scope, provider: 'zetaris' }, context()),
    ).rejects.toThrow('pinned Zetaris queries');
    const { service, saved } = services(() =>
      Promise.reject(
        new CollectionUnavailableError('Source credentials unavailable.'),
      ),
    );
    const result =
      await createEvidenceCollectionAssignments()[0]!.execute!(service);
    expect(result.support).toBe('gap');
    expect(saved).toHaveLength(1);
    expect(saved[0]?.kind).toBe('evidence.gap');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires an explicit replay source and propagates unknown outcomes without saving a gap', async () => {
    const resolveSource = vi.fn(() => createFixtureCollectionAdapter(scope));
    const tool = createEvidenceCollectionTools({
      mode: 'replay',
      resolveSource,
      evidenceOrigin: 'synthetic_fixture',
    })[0]!;
    const capture = collectionCaptureSchema.parse(
      await tool.execute(scope, context()),
    );
    expect(resolveSource).toHaveBeenCalledWith(scope);
    expect(capture).toMatchObject({
      mode: 'replay',
      evidence_origin: 'synthetic_fixture',
    });
    const unknown = Object.assign(new Error('Unknown transport outcome.'), {
      outcome: 'unknown',
    });
    const { service, saved } = services(() => Promise.reject(unknown));
    await expect(
      createEvidenceCollectionAssignments()[0]!.execute!(service),
    ).rejects.toBe(unknown);
    expect(saved).toEqual([]);
  });

  it('does not retain a result after cancellation or for another assignment scope', async () => {
    const capture = collectionCaptureSchema.parse(
      await createEvidenceCollectionTools({ mode: 'fixture' })[0]!.execute(
        scope,
        context(),
      ),
    );
    const controller = new AbortController();
    const cancelled = services(() => {
      controller.abort(new Error('Stopped.'));
      return Promise.resolve(capture);
    }, controller.signal);
    await expect(
      createEvidenceCollectionAssignments()[0]!.execute!(cancelled.service),
    ).rejects.toThrow('Stopped.');
    expect(cancelled.saved).toEqual([]);
    const changedScope = structuredClone(capture);
    changedScope.scope.locations[0]!.name = 'A different requested place';
    const wrong = services(() => Promise.resolve(changedScope));
    await expect(
      createEvidenceCollectionAssignments()[0]!.execute!(wrong.service),
    ).rejects.toThrow('assignment scope');
    expect(wrong.saved).toEqual([]);
  });

  it('executes a registered fixture task through the durable runtime and saves a governed capture', async () => {
    const fetch = vi.fn(() => {
      throw new Error('Unexpected network request.');
    });
    vi.stubGlobal('fetch', fetch);
    const directory = await mkdtemp(join(tmpdir(), 'haze-collection-task-'));
    const runtime = new TaskRuntime({
      stateDirectory: directory,
      registry: createExecutionRegistry({ mode: 'fixture' }),
      mode: 'fixture',
    });
    cleanups.push(async () => {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    });
    const admitted = runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective:
          'Collect current PM2.5 evidence for the supplied fixture location.',
        scope,
      },
      'collection-fixture',
    );
    const deadline = Date.now() + 8000;
    let task = runtime.store.read(admitted.task_id, localTaskIdentity);
    while (
      !['completed', 'failed', 'waiting', 'paused'].includes(task.status) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      task = runtime.store.read(admitted.task_id, localTaskIdentity);
    }
    expect(task.status, task.error?.message).toBe('completed');
    expect(task.usage.tool_calls).toBe(1);
    const assignment = task.assignments.find(
      (item) => item.definition_id === 'evidence-collection.collect',
    );
    expect(assignment?.role).toBe('HazeOps');
    const artifacts = (assignment?.outputs ?? []).map((ref) =>
      runtime.store.artifact(ref.id, localTaskIdentity, ref),
    );
    const capture = artifacts.find(
      (item) => item.kind === 'evidence.collection.capture',
    );
    expect(capture?.evidence_origin).toBe('synthetic_fixture');
    expect(capture?.required_tools).toContain(EVIDENCE_COLLECTION_TOOL_ID);
    expect(collectionCaptureSchema.parse(capture?.content).scope).toEqual(
      scope,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
