import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentModel } from '../../app/adapters/agent-model.js';
import { openHazeEngines } from '../../app/adapters/meterless/index.js';
import type {
  EntityInput,
  MemoryRecord,
  WorldEntity,
} from '../../app/adapters/meterless/ports.js';
import {
  demoAgentEventSchema,
  demoAgentIds,
  demoAgentStreamFrameSchema,
  type DemoAgentEvent,
} from '../../app/demo/agent-contract.js';
import { runDemoAgents } from '../../app/demo/agent-run.js';
import { createDemoChatHarness } from '../../app/demo/chat-harness.js';
import type { DemoChatCase } from '../../app/demo/chat-harness.js';

type Engines = Awaited<ReturnType<typeof openHazeEngines>>;
const timestamp = '2026-10-24T10:00:00.000Z';
const question =
  'WHY_THIS_PLAN_SENTINEL: compare the fictional Klang schedules.';

function fixture(kind: DemoChatCase = 'named-set') {
  const harness = createDemoChatHarness();
  return harness.read(harness.run(harness.sample(kind).request).run_id);
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function fakeEngines() {
  const record: MemoryRecord = {
    id: 'memory-fictional-constraints',
    content: 'HMEM_RETRIEVAL_SENTINEL: the fictional activities stay fixed.',
    confidence: 0.8,
    source: 'user_correction',
    provenance: {
      origin: 'user_correction',
      learnedAt: Date.parse(timestamp),
      label: 'fictional fixture constraint',
    },
    tags: ['fictional'],
  };
  const pin = {
    repository: 'https://example.invalid/pinned-engine',
    revision: '1'.repeat(40),
    sha256: '2'.repeat(64),
    entrypoint: 'vendor/fake-engine.js',
    entrypointSha256: '3'.repeat(64),
    loadedSource: 'test-engine',
  };
  let stored: WorldEntity | undefined;
  const engines = {
    provenance: { starter: pin, hmem: pin, world_model: pin },
    memory: {
      mine: vi.fn<Engines['memory']['mine']>().mockResolvedValue([record]),
      query: vi.fn<Engines['memory']['query']>().mockReturnValue({
        memories: [{ memory: record, relevance: 0.9 }],
        context: record.content,
        trace: {
          retrievalReason: 'retrieved fictional constraints',
          strategy: 'minimal',
          scores: { [record.id]: 0.9 },
        },
      }),
      feedback: vi.fn<Engines['memory']['feedback']>(),
      audit: vi.fn<Engines['memory']['audit']>().mockReturnValue([
        {
          memoryId: record.id,
          action: 'read',
          actor: 'haze',
          timestamp: Date.parse(timestamp),
        },
      ]),
      history: vi.fn<Engines['memory']['history']>().mockReturnValue([]),
    },
    world: {
      entityId: vi
        .fn<Engines['world']['entityId']>()
        .mockReturnValue('fictional-planning'),
      externalId: vi
        .fn<Engines['world']['externalId']>()
        .mockReturnValue('fictional-planning'),
      nameSimilarity: vi
        .fn<Engines['world']['nameSimilarity']>()
        .mockReturnValue(1),
      resolutionDecision: vi
        .fn<Engines['world']['resolutionDecision']>()
        .mockReturnValue('new'),
      upsertEntity: vi.fn<Engines['world']['upsertEntity']>(
        (input: EntityInput) => {
          stored = {
            id: 'fictional-planning',
            type: input.type,
            ...(input.name ? { name: input.name } : {}),
            attrs: { ...input.attrs, readback: 'WORLD_READBACK_SENTINEL' },
            aliases: [],
            schemaVersion: 1,
            source: {
              ...input.source,
              at: new Date(input.source.at).toISOString(),
            },
          };
          return Promise.resolve(stored);
        },
      ),
      ingest: vi.fn<Engines['world']['ingest']>().mockResolvedValue({
        runId: 'fictional-ingest',
        processed: 1,
        skippedUnchanged: 0,
        clusters: 1,
        eventsAppended: 1,
        changed: true,
      }),
      entity: vi.fn<Engines['world']['entity']>(() => stored),
      entities: vi.fn<Engines['world']['entities']>(() =>
        stored ? [stored] : [],
      ),
      events: vi.fn<Engines['world']['events']>().mockReturnValue([]),
      audit: vi.fn<Engines['world']['audit']>().mockReturnValue([
        {
          seq: 1,
          at: timestamp,
          kind: 'upsert',
          actor: 'haze',
          summary: 'fictional snapshot',
        },
      ]),
      projectionCanonical: vi
        .fn<Engines['world']['projectionCanonical']>()
        .mockReturnValue('{}'),
    },
  } satisfies Engines;
  return engines;
}

function fakeModel() {
  const responses: string[] = [];
  const complete = vi.fn<AgentModel['complete']>((input) => {
    const selected =
      {
        manager: responses.length ? 'pending_review' : 'sample_scope',
        hazeops: 'checked_comparison',
        evidencecritic: 'evidence_status',
        workershield: 'worker_constraints',
      }[input.role] ?? 'sample_scope';
    const response = JSON.stringify({ fact_ids: [selected] });
    responses.push(response);
    return Promise.resolve(response);
  });
  return {
    selection: { provider: 'test-provider', model: 'test-model' },
    complete,
    responses,
  };
}

describe('live fictional crew agent graph', () => {
  it('executes model roles and real engine ports, carrying their outputs into later work', async () => {
    const scheduling = freezeDeep(fixture());
    const unchanged = JSON.stringify(scheduling);
    const engines = fakeEngines();
    const model = fakeModel();
    const events: DemoAgentEvent[] = [];
    const result = await runDemoAgents({
      scheduling,
      question,
      model,
      engines,
      onEvent: (event) => events.push(event),
      signal: new AbortController().signal,
    });

    expect(model.complete.mock.calls.map(([input]) => input.role)).toEqual([
      'manager',
      'hazeops',
      'evidencecritic',
      'workershield',
      'manager',
    ]);
    const contexts = model.complete.mock.calls.map(([input]) =>
      JSON.stringify(input.context),
    );
    expect(contexts[0]).toContain(question);
    const summary = (agent: string) => {
      const text = result.execution.steps.find(
        (step) => step.agent === agent,
      )?.summary;
      expect(typeof text).toBe('string');
      return JSON.stringify(text).slice(1, -1);
    };
    expect(contexts[2]).toContain(summary('hazeops'));
    expect(contexts[2]).toContain('WORLD_READBACK_SENTINEL');
    expect(contexts[2]).toContain('HMEM_RETRIEVAL_SENTINEL');
    expect(contexts[3]).toContain(summary('evidencecritic'));
    expect(contexts[4]).toContain(summary('workershield'));
    expect(result.paragraphs).toEqual([
      result.execution.steps.find((step) => step.agent === 'manager')?.summary,
    ]);
    expect(JSON.stringify(result.paragraphs)).not.toContain('fact_ids');
    expect(
      JSON.stringify(result.execution.steps.map((step) => step.summary)),
    ).not.toContain('fact_ids');
    expect(
      result.execution.steps
        .filter((step) => step.kind === 'model')
        .map((step) => step.fact_ids),
    ).toEqual([
      ['checked_comparison'],
      ['evidence_status'],
      ['worker_constraints'],
      ['pending_review'],
    ]);
    expect(engines.world.upsertEntity).toHaveBeenCalledOnce();
    expect(engines.world.entity).toHaveBeenCalledWith('fictional-planning');
    expect(engines.world.audit).toHaveBeenCalled();
    expect(engines.memory.mine).toHaveBeenCalledWith(
      'user_correction',
      expect.any(String),
      { chatId: scheduling.result.run_id },
    );
    expect(engines.memory.query).toHaveBeenCalledOnce();
    expect(engines.memory.audit).toHaveBeenCalled();
    expect(
      events.every((event) => demoAgentEventSchema.safeParse(event).success),
    ).toBe(true);
    expect(
      events.every((event) => event.runId === scheduling.result.run_id),
    ).toBe(true);
    expect(events[0]).toMatchObject({
      type: 'run_started',
      executionKind: 'agents',
    });
    expect(
      events
        .filter((event) => event.type === 'agent_completed')
        .map((event) => event.agent)
        .sort(),
    ).toEqual([...demoAgentIds].sort());
    expect(events.at(-1)?.type).toBe('run_completed');
    expect(result.execution).toMatchObject({
      provider: 'test-provider',
      model: 'test-model',
    });
    expect(result.execution.steps).toHaveLength(6);
    expect(demoAgentStreamFrameSchema.safeParse(result).success).toBe(true);
    expect(result.scheduling).toEqual(scheduling);
    expect(JSON.stringify(scheduling)).toBe(unchanged);
    expect(result.scheduling.result.result.quantified?.nominal).toMatchObject({
      baseline: 440,
      candidate: 340,
      absolute_gain: 100,
    });
    expect(result.scheduling.result.result).toMatchObject({
      publication_status: 'publication_disabled',
      recommendation_eligible: false,
      review_status: 'pending',
    });
  });

  it('reports the failed role without completing it or executing downstream roles', async () => {
    const model = fakeModel();
    model.complete.mockImplementation((input) => {
      if (input.role === 'hazeops')
        return Promise.reject(new Error('provider unavailable'));
      return Promise.resolve(JSON.stringify({ fact_ids: ['sample_scope'] }));
    });
    const engines = fakeEngines();
    const events: DemoAgentEvent[] = [];
    await expect(
      runDemoAgents({
        scheduling: fixture(),
        question,
        model,
        engines,
        onEvent: (event) => events.push(event),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(model.complete.mock.calls.map(([input]) => input.role)).toEqual([
      'manager',
      'hazeops',
    ]);
    expect(engines.world.upsertEntity).not.toHaveBeenCalled();
    expect(engines.memory.mine).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: 'run_failed',
      agent: 'hazeops',
    });
    expect(
      events.some(
        (event) =>
          event.type === 'agent_completed' && event.agent === 'hazeops',
      ),
    ).toBe(false);
    expect(events.some((event) => event.type === 'run_completed')).toBe(false);
  });

  it.each([
    ['free prose', 'RAW_MODEL_SENTINEL: invent an approved schedule at noon.'],
    ['unknown fact', '{"fact_ids":["invented_approval"]}'],
    ['engine fact before execution', '{"fact_ids":["world_readback"]}'],
    ['duplicate fact', '{"fact_ids":["sample_scope","sample_scope"]}'],
    ['empty facts', '{"fact_ids":[]}'],
    [
      'extra commentary',
      '{"fact_ids":["sample_scope"],"commentary":"RAW_MODEL_SENTINEL"}',
    ],
    [
      'duplicate JSON keys',
      '{"fact_ids":["sample_scope"],"fact_ids":["pending_review"]}',
    ],
  ])(
    'rejects %s instead of exposing unchecked model prose or facts',
    async (_label, output) => {
      const model = fakeModel();
      model.complete.mockResolvedValueOnce(output);
      const engines = fakeEngines();
      const events: DemoAgentEvent[] = [];
      await expect(
        runDemoAgents({
          scheduling: fixture(),
          question,
          model,
          engines,
          onEvent: (event) => events.push(event),
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow();
      expect(model.complete).toHaveBeenCalledOnce();
      expect(engines.world.upsertEntity).not.toHaveBeenCalled();
      expect(events.at(-1)).toMatchObject({
        type: 'run_failed',
        agent: 'manager',
      });
      expect(
        events.some(
          (event) =>
            event.type === 'run_completed' || event.type === 'agent_completed',
        ),
      ).toBe(false);
      expect(JSON.stringify(events)).not.toContain('RAW_MODEL_SENTINEL');
      expect(JSON.stringify(events)).not.toContain('invented_approval');
    },
  );

  it('does not start later work after cancellation even if an in-flight model resolves late', async () => {
    const entered = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<string>();
    const model = fakeModel();
    model.complete.mockImplementation(async () => {
      entered.resolve();
      return completion.promise;
    });
    const controller = new AbortController();
    const engines = fakeEngines();
    const events: DemoAgentEvent[] = [];
    const pending = runDemoAgents({
      scheduling: fixture(),
      question,
      model,
      engines,
      onEvent: (event) => events.push(event),
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort();
    completion.resolve('Late completion must not advance the graph.');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(model.complete).toHaveBeenCalledOnce();
    expect(engines.world.upsertEntity).not.toHaveBeenCalled();
    expect(engines.memory.mine).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe('run_cancelled');
    expect(
      events.some(
        (event) =>
          event.type === 'agent_completed' || event.type === 'run_completed',
      ),
    ).toBe(false);
  });

  it.each(['worldmodel', 'hmem'] as const)(
    'does not begin the %s engine operation if cancellation arrives with its working event',
    async (agent) => {
      const model = fakeModel();
      const engines = fakeEngines();
      const controller = new AbortController();
      const events: DemoAgentEvent[] = [];
      await expect(
        runDemoAgents({
          scheduling: fixture(),
          question,
          model,
          engines,
          signal: controller.signal,
          onEvent: (event) => {
            events.push(event);
            if (event.type === 'agent_working' && event.agent === agent)
              controller.abort();
          },
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      if (agent === 'worldmodel')
        expect(engines.world.upsertEntity).not.toHaveBeenCalled();
      else expect(engines.world.upsertEntity).toHaveBeenCalledOnce();
      expect(engines.memory.mine).not.toHaveBeenCalled();
      expect(events.at(-1)?.type).toBe('run_cancelled');
      expect(
        events.some(
          (event) => event.type === 'agent_completed' && event.agent === agent,
        ),
      ).toBe(false);
      expect(events.some((event) => event.type === 'run_completed')).toBe(
        false,
      );
    },
  );

  it('retains missing coverage and an unquantified baseline after agents review it', async () => {
    const scheduling = freezeDeep(fixture('missing-evidence'));
    const result = await runDemoAgents({
      scheduling,
      question,
      model: fakeModel(),
      engines: fakeEngines(),
      onEvent: () => undefined,
      signal: new AbortController().signal,
    });
    expect(result.scheduling).toEqual(scheduling);
    expect(result.scheduling.result.result).toMatchObject({
      decision_outcome: 'insufficient_evidence',
      selected_plan_ref: null,
      comparison_plan_ref: null,
      quantified: null,
      publication_status: 'publication_disabled',
      recommendation_eligible: false,
    });
    expect(result.scheduling.result.evidence.gaps.length).toBeGreaterThan(0);
    expect(result.execution.steps).toHaveLength(6);
  });

  it('executes the pinned engines in isolated run storage without inventing prior episodes', async () => {
    const temporaryRoot = resolve(tmpdir());
    const directory = await mkdtemp(join(temporaryRoot, 'haze-live-agent-'));
    if (
      dirname(directory) !== temporaryRoot ||
      !directory.startsWith(join(temporaryRoot, 'haze-live-agent-'))
    ) {
      throw new Error(
        'Unexpected temporary engine directory; refusing cleanup.',
      );
    }
    try {
      const previous = await openHazeEngines({
        memoryDirectory: join(directory, 'previous', 'memory'),
        worldDirectory: join(directory, 'previous', 'world'),
        namespace: 'previous_fictional_run',
      });
      const previousRecords = await previous.memory.mine(
        'user_correction',
        'Always retain PAST_EPISODE_SENTINEL for the previous fictional crew run.',
        { chatId: 'previous-run' },
      );
      expect(previousRecords.length).toBeGreaterThan(0);

      const engines = await openHazeEngines({
        memoryDirectory: join(directory, 'current', 'memory'),
        worldDirectory: join(directory, 'current', 'world'),
        namespace: 'current_fictional_run',
      });
      const recall = vi.spyOn(engines.memory, 'query');
      const model = fakeModel();
      const scheduling = fixture();
      const result = await runDemoAgents({
        scheduling,
        question,
        model,
        engines,
        onEvent: () => undefined,
        signal: new AbortController().signal,
      });

      expect(engines.provenance.hmem.loadedSource).toBe('vendor/hmem');
      expect(engines.provenance.world_model.loadedSource).toBe(
        'world-model/reference',
      );
      expect(engines.world.audit().length).toBeGreaterThan(0);
      expect(engines.memory.audit().length).toBeGreaterThan(0);
      const records = engines.world.entities({
        type: 'fictional_crew_comparison',
      });
      expect(records).toHaveLength(1);
      expect(records[0]?.attrs).toMatchObject({
        fictional: true,
        bundle_ref: scheduling.result.decision_ref.bundle_ref,
        selected_plan_ref: scheduling.result.result.selected_plan_ref,
      });
      expect(recall).toHaveBeenCalledOnce();
      const recalledValue: unknown = recall.mock.results[0]?.value;
      const recalled = recalledValue as
        ReturnType<Engines['memory']['query']> | undefined;
      expect(recalled?.memories.length).toBeGreaterThan(0);
      expect(recalled?.context).toContain('fictional');
      for (const previousRecord of previousRecords) {
        expect(
          recalled?.memories.some(
            (hit) => hit.memory.content === previousRecord.content,
          ),
        ).toBe(false);
      }
      const reviewContexts = JSON.stringify(
        model.complete.mock.calls.map(([input]) => input.context),
      );
      expect(reviewContexts).not.toContain('PAST_EPISODE_SENTINEL');
      expect(
        result.execution.steps
          .filter((step) => step.kind === 'engine')
          .map((step) => step.agent),
      ).toEqual(['worldmodel', 'hmem']);
      expect(
        result.execution.steps.find((step) => step.agent === 'worldmodel')
          ?.summary,
      ).toContain(`audit contains ${engines.world.audit().length} entries`);
      expect(
        result.execution.steps.find((step) => step.agent === 'hmem')?.summary,
      ).toContain(`${engines.memory.audit().length} audit entries`);
      expect(result.scheduling).toEqual(scheduling);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
