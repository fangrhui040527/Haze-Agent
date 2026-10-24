import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { AgentModel } from '../../app/adapters/agent-model.js';
import type { openHazeEngines } from '../../app/adapters/meterless/index.js';
import type {
  MemoryRecord,
  WorldEntity,
} from '../../app/adapters/meterless/ports.js';
import {
  demoAgentIds,
  demoAgentStreamFrameSchema,
  type DemoAgentStreamFrame,
} from '../../app/demo/agent-contract.js';
import { demoChatSampleSchema } from '../../app/demo/chat-contract.js';
import { createDemoChatHandler } from '../../app/demo/chat-http.js';

type Engines = Awaited<ReturnType<typeof openHazeEngines>>;
type HandlerOptions = Parameters<typeof createDemoChatHandler>[0];
const endpoint = '/api/demo/crew-scheduling';

function fakeEngines() {
  const record: MemoryRecord = {
    id: 'fictional-run-constraint',
    content:
      'Preserve the fictional checked schedule and human review requirement.',
    confidence: 1,
    source: 'user_correction',
    provenance: {
      origin: 'user_correction',
      learnedAt: 1,
      label: 'test constraint',
    },
    tags: ['fictional'],
  };
  const pin = {
    repository: 'https://example.invalid/test-engine',
    revision: '1'.repeat(40),
    sha256: '2'.repeat(64),
    entrypoint: 'vendor/test-engine.js',
    entrypointSha256: '3'.repeat(64),
    loadedSource: 'test-engine',
  };
  let stored: WorldEntity | undefined;
  return {
    provenance: { starter: pin, hmem: pin, world_model: pin },
    memory: {
      mine: vi.fn<Engines['memory']['mine']>().mockResolvedValue([record]),
      query: vi.fn<Engines['memory']['query']>().mockReturnValue({
        memories: [{ memory: record, relevance: 1 }],
        context: record.content,
        trace: {
          retrievalReason: 'test recall',
          strategy: 'minimal',
          scores: { [record.id]: 1 },
        },
      }),
      feedback: vi.fn<Engines['memory']['feedback']>(),
      audit: vi.fn<Engines['memory']['audit']>().mockReturnValue([]),
      history: vi.fn<Engines['memory']['history']>().mockReturnValue([]),
    },
    world: {
      entityId: vi
        .fn<Engines['world']['entityId']>()
        .mockReturnValue('fictional-comparison'),
      externalId: vi
        .fn<Engines['world']['externalId']>()
        .mockReturnValue('fictional-comparison'),
      nameSimilarity: vi
        .fn<Engines['world']['nameSimilarity']>()
        .mockReturnValue(1),
      resolutionDecision: vi
        .fn<Engines['world']['resolutionDecision']>()
        .mockReturnValue('new'),
      upsertEntity: vi.fn<Engines['world']['upsertEntity']>((input) => {
        stored = {
          id: 'fictional-comparison',
          type: input.type,
          ...(input.name ? { name: input.name } : {}),
          attrs: { ...input.attrs },
          aliases: [],
          schemaVersion: 1,
          source: {
            ...input.source,
            at: new Date(input.source.at).toISOString(),
          },
        };
        return Promise.resolve(stored);
      }),
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
      audit: vi.fn<Engines['world']['audit']>().mockReturnValue([]),
      projectionCanonical: vi
        .fn<Engines['world']['projectionCanonical']>()
        .mockReturnValue('{}'),
    },
  } satisfies Engines;
}

function fakeModel() {
  return {
    selection: { provider: 'test-provider', model: 'test-model' },
    complete: vi.fn<AgentModel['complete']>(() =>
      Promise.resolve(
        JSON.stringify({ fact_ids: ['sample_scope', 'pending_review'] }),
      ),
    ),
  };
}

async function withServer<T>(
  options: HandlerOptions,
  test: (origin: string) => Promise<T>,
) {
  const server = createServer(createDemoChatHandler(options));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing_test_port');
    return await test(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function postSample(origin: string, signal?: AbortSignal) {
  const sampleResponse = await fetch(`${origin}${endpoint}/sample`);
  expect(sampleResponse.status).toBe(200);
  const sample = demoChatSampleSchema.parse(await sampleResponse.json());
  return fetch(`${origin}${endpoint}/agent-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(sample.request),
    ...(signal ? { signal } : {}),
  });
}

function streamFrames(response: Response) {
  if (!response.body) throw new Error('missing_test_response_body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  const frames: DemoAgentStreamFrame[] = [];
  const next = async (): Promise<DemoAgentStreamFrame | undefined> => {
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const frame = demoAgentStreamFrameSchema.parse(
          JSON.parse(line) as unknown,
        );
        frames.push(frame);
        return frame;
      }
      if (ended) {
        expect(buffer).toBe('');
        return undefined;
      }
      const chunk = await reader.read();
      if (chunk.done) {
        ended = true;
        buffer += decoder.decode();
      } else {
        const value: unknown = chunk.value;
        if (!(value instanceof Uint8Array))
          throw new Error('invalid_test_stream_chunk');
        buffer += decoder.decode(value, { stream: true });
      }
    }
  };
  return {
    frames,
    async until(predicate: (frame: DemoAgentStreamFrame) => boolean) {
      while (true) {
        const frame = await next();
        if (!frame) throw new Error('stream_ended_before_expected_frame');
        if (predicate(frame)) return frame;
      }
    },
    async all() {
      while (await next()) {
        /* Read all terminal frames. */
      }
      return frames;
    },
  };
}

describe('live crew agent HTTP stream', () => {
  it('streams actual work before the first model resolves, then completes every displayed role and returns the checked result', async () => {
    const entered = Promise.withResolvers<void>();
    const firstCompletion = Promise.withResolvers<string>();
    const model = fakeModel();
    model.complete.mockImplementationOnce(async () => {
      entered.resolve();
      return firstCompletion.promise;
    });
    const engines = fakeEngines();
    await withServer({ model, engines }, async (origin) => {
      const response = await postSample(origin);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(
        'application/x-ndjson; charset=utf-8',
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-accel-buffering')).toBe('no');
      const stream = streamFrames(response);
      await entered.promise;
      await stream.until(
        (frame) =>
          frame.type === 'event' &&
          frame.event.type === 'agent_working' &&
          frame.event.agent === 'manager',
      );
      expect(stream.frames[0]).toMatchObject({
        type: 'event',
        event: { type: 'run_started', executionKind: 'agents' },
      });
      expect(stream.frames.some((frame) => frame.type === 'result')).toBe(
        false,
      );
      expect(model.complete).toHaveBeenCalledOnce();
      expect(engines.world.upsertEntity).not.toHaveBeenCalled();
      expect(engines.memory.mine).not.toHaveBeenCalled();

      firstCompletion.resolve(
        JSON.stringify({ fact_ids: ['sample_scope', 'pending_review'] }),
      );
      const frames = await stream.all();
      const events = frames.flatMap((frame) =>
        frame.type === 'event' ? [frame.event] : [],
      );
      const working = events.flatMap((event) =>
        event.type === 'agent_working' ? [event.agent] : [],
      );
      const completed = events.flatMap((event) =>
        event.type === 'agent_completed' ? [event.agent] : [],
      );
      expect([...new Set(working)].sort()).toEqual([...demoAgentIds].sort());
      expect(completed.sort()).toEqual([...demoAgentIds].sort());
      expect(model.complete.mock.calls.map(([input]) => input.role)).toEqual([
        'manager',
        'hazeops',
        'evidencecritic',
        'workershield',
        'manager',
      ]);
      expect(engines.world.upsertEntity).toHaveBeenCalledOnce();
      expect(engines.world.entity).toHaveBeenCalledWith('fictional-comparison');
      expect(engines.memory.mine).toHaveBeenCalledOnce();
      expect(engines.memory.query).toHaveBeenCalledOnce();
      expect(events.at(-1)?.type).toBe('run_completed');
      const results = frames.filter((frame) => frame.type === 'result');
      expect(results).toHaveLength(1);
      const result = results[0]!;
      expect(frames.at(-1)).toBe(result);
      expect(result.execution).toMatchObject({
        provider: 'test-provider',
        model: 'test-model',
      });
      expect(result.execution.steps).toHaveLength(6);
      expect(result.execution.steps.map((step) => step.agent).sort()).toEqual(
        [...demoAgentIds].sort(),
      );
      expect(result.scheduling.result.run_id).toBe(result.run_id);
      expect(events.every((event) => event.runId === result.run_id)).toBe(true);
      expect(result.scheduling.result.result.quantified?.nominal).toMatchObject(
        { baseline: 440, candidate: 340, absolute_gain: 100 },
      );
      expect(result.scheduling.result.result).toMatchObject({
        publication_status: 'publication_disabled',
        recommendation_eligible: false,
        review_status: 'pending',
      });
      expect(result.paragraphs.join(' ')).toContain('fictional');
      expect(result.paragraphs.join(' ')).toContain('pending');
    });
  });

  it.each([
    { HAZE_PROVIDER: 'offline' },
    {
      HAZE_PROVIDER: 'nvidia',
      SAMPLE_MODE: 'true',
      NVIDIA_API_KEY: 'unused-test-secret',
    },
    { HAZE_PROVIDER: 'nvidia' },
    {
      HAZE_PROVIDER: 'openai-compatible',
      HAZE_MODEL: 'test-model',
      HAZE_PROVIDER_BASE_URL: 'https://example.invalid/v1',
    },
  ])(
    'returns JSON 503 before opening a stream or engines for configuration %j',
    async (env) => {
      const engines = fakeEngines();
      await withServer({ env, engines }, async (origin) => {
        const response = await postSample(origin);
        expect(response.status).toBe(503);
        expect(response.headers.get('content-type')).toBe(
          'application/json; charset=utf-8',
        );
        const text = await response.text();
        expect(JSON.parse(text) as unknown).toMatchObject({
          error: {
            code: 'agent_configuration_required',
            message: expect.any(String) as string,
          },
        });
        expect(text).not.toContain('unused-test-secret');
        expect(text).not.toContain('run_started');
        expect(engines.world.upsertEntity).not.toHaveBeenCalled();
        expect(engines.memory.mine).not.toHaveBeenCalled();
      });
    },
  );

  it('ends a failed model stream with run_failed and never sends a completed result or upstream error text', async () => {
    const model = fakeModel();
    model.complete.mockRejectedValueOnce(new Error('private-upstream-secret'));
    const engines = fakeEngines();
    await withServer({ model, engines }, async (origin) => {
      const response = await postSample(origin);
      expect(response.status).toBe(200);
      const frames = await streamFrames(response).all();
      expect(frames.at(-1)).toMatchObject({
        type: 'event',
        event: { type: 'run_failed', agent: 'manager', retryable: true },
      });
      expect(frames.some((frame) => frame.type === 'result')).toBe(false);
      expect(
        frames.some(
          (frame) =>
            frame.type === 'event' &&
            (frame.event.type === 'agent_completed' ||
              frame.event.type === 'run_completed'),
        ),
      ).toBe(false);
      expect(JSON.stringify(frames)).not.toContain('private-upstream-secret');
      expect(model.complete).toHaveBeenCalledOnce();
      expect(engines.world.upsertEntity).not.toHaveBeenCalled();
      expect(engines.memory.mine).not.toHaveBeenCalled();
    });
  });

  it.each([
    'unsafe-raw-model-commentary',
    JSON.stringify({ fact_ids: ['unsafe-raw-model-commentary'] }),
    JSON.stringify({ fact_ids: ['sample_scope', 'sample_scope'] }),
  ])(
    'fails a stream rather than displaying invalid model facts %s',
    async (text) => {
      const model = fakeModel();
      model.complete.mockResolvedValueOnce(text);
      const engines = fakeEngines();
      await withServer({ model, engines }, async (origin) => {
        const response = await postSample(origin);
        const frames = await streamFrames(response).all();
        expect(frames.at(-1)).toMatchObject({
          type: 'event',
          event: { type: 'run_failed', agent: 'manager' },
        });
        expect(frames.some((frame) => frame.type === 'result')).toBe(false);
        expect(JSON.stringify(frames)).not.toContain(
          'unsafe-raw-model-commentary',
        );
        expect(model.complete).toHaveBeenCalledOnce();
        expect(engines.world.upsertEntity).not.toHaveBeenCalled();
        expect(engines.memory.mine).not.toHaveBeenCalled();
      });
    },
  );

  it('cancels the in-flight model when the browser aborts the response', async () => {
    const entered = Promise.withResolvers<AbortSignal>();
    const cancelled = Promise.withResolvers<void>();
    const model = fakeModel();
    model.complete.mockImplementation(async (_input, signal) => {
      entered.resolve(signal);
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            cancelled.resolve();
            reject(new DOMException('test request cancelled', 'AbortError'));
          },
          { once: true },
        );
      });
    });
    const engines = fakeEngines();
    await withServer({ model, engines }, async (origin) => {
      const browser = new AbortController();
      const response = await postSample(origin, browser.signal);
      const signal = await entered.promise;
      const stream = streamFrames(response);
      await stream.until(
        (frame) =>
          frame.type === 'event' && frame.event.type === 'agent_working',
      );
      browser.abort();
      await cancelled.promise;
      expect(signal.aborted).toBe(true);
      expect(model.complete).toHaveBeenCalledOnce();
      expect(engines.world.upsertEntity).not.toHaveBeenCalled();
      expect(engines.memory.mine).not.toHaveBeenCalled();
    });
  });
});
