import reviewPackage from '../../../../examples/demo-review/package.json';
import { describe, expect, it, vi } from 'vitest';
import {
  demoAgentIds,
  type DemoAgentExecution,
} from '../../../../app/demo/agent-contract.ts';
import { demoChatResponseSchema } from '../../../../app/demo/chat-contract.ts';
import type * as DemoChatContracts from '../../../../app/demo/chat-contract.ts';
import type { RunRequest } from '../../../../app/contracts/planning.ts';
import type { AgentAnswer, AgentEvent } from '../../shared/types/agents.ts';
import { AgentRunError, type AgentService } from './AgentService.ts';
import { SchedulingAgentService } from './SchedulingAgentService.ts';
import {
  isCrewSchedulingRequest,
  KLANG_CREW_EXAMPLE,
} from './schedulingIntent.ts';

const packageValue = reviewPackage as unknown as {
  requests: { named_set: RunRequest };
  results: { named_set: unknown };
  records: {
    ref: { id: string; revision: number; sha256: string };
    record: Record<string, unknown>;
  }[];
};
const request = packageValue.requests.named_set;
const response = demoChatResponseSchema.parse({
  schema_version: 'haze.demo_chat.v1',
  result: packageValue.results.named_set,
  planning: packageValue.records.find(
    (entry) => entry.ref.id === request.input.bundle_ref.id,
  )?.record,
  plans: packageValue.records
    .filter(
      (entry) =>
        typeof entry.record.plan_id === 'string' &&
        Array.isArray(entry.record.assignments),
    )
    .map((entry) => ({
      ref: entry.ref,
      plan_id: entry.record.plan_id,
      assignments: entry.record.assignments,
    })),
});
const sampleAsk = { question: KLANG_CREW_EXAMPLE, focusItemId: null };
const generalAnswer: AgentAnswer = {
  runId: 'general',
  paragraphs: ['General answer'],
  citations: [],
  source: 'mock_template',
  fictional: true,
  durationMs: 0,
};
const generalService = () => ({
  label: 'General',
  ask: vi.fn<AgentService['ask']>().mockResolvedValue(generalAnswer),
});
const execution: DemoAgentExecution = {
  provider: 'test-provider',
  model: 'test-model',
  steps: demoAgentIds.map((agent) => ({
    agent,
    kind: agent === 'worldmodel' || agent === 'hmem' ? 'engine' : 'model',
    summary: `${agent} executed ✓`,
  })),
};
const event = (value: Record<string, unknown>) => ({
  type: 'event',
  event: {
    runId: response.result.run_id,
    at: '2026-10-24T00:00:00.000Z',
    message: 'Live progress ✓',
    ...value,
  },
});
const start = () => event({ type: 'run_started', executionKind: 'agents' });
const completed = () => event({ type: 'run_completed' });
const result = () => ({
  type: 'result',
  run_id: response.result.run_id,
  paragraphs: ['Manager commentary ✓'],
  scheduling: structuredClone(response),
  execution: structuredClone(execution),
});
const frames = () => [
  start(),
  event({ type: 'agent_working', agent: 'manager' }),
  completed(),
  result(),
];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const encoder = new TextEncoder();
const ndjson = (values: unknown[], trailingNewline = true) =>
  values.map((value) => JSON.stringify(value)).join('\n') +
  (trailingNewline ? '\n' : '');
const stream = (values: unknown[] = frames(), trailingNewline = true) =>
  new Response(ndjson(values, trailingNewline), {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
  });
const network = (reply = stream()) =>
  vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ request }))
    .mockResolvedValueOnce(reply);
const ask = (fetcher: typeof fetch, events: AgentEvent[] = []) =>
  new SchedulingAgentService(generalService(), fetcher).ask(
    sampleAsk,
    (value) => events.push(value),
    new AbortController().signal,
  );

describe('crew scheduling in generic chat', () => {
  it('calls browser fetch without a service-object receiver', async () => {
    const fetcher = network();
    const original = globalThis.fetch;
    globalThis.fetch = function (this: unknown, input, init) {
      if (this !== undefined && this !== globalThis)
        throw new TypeError('Illegal invocation');
      return fetcher(input, init);
    };
    try {
      expect(
        (
          await new SchedulingAgentService(generalService()).ask(
            sampleAsk,
            () => {},
            new AbortController().signal,
          )
        ).source,
      ).toBe('model');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('keeps ordinary city comparison on the general chat service', async () => {
    const general = generalService();
    const fetcher = vi.fn<typeof fetch>();
    const question = {
      question: 'Compare Kuala Lumpur and Klang air quality',
      focusItemId: null,
    };
    expect(isCrewSchedulingRequest(question.question)).toBe(false);
    expect(
      await new SchedulingAgentService(general, fetcher).ask(
        question,
        () => {},
        new AbortController().signal,
      ),
    ).toEqual(generalAnswer);
    expect(general.ask).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requires planning input for a real crew request without executing sample roles', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const events: AgentEvent[] = [];
    const answer = await new SchedulingAgentService(
      generalService(),
      fetcher,
    ).ask(
      { question: 'Schedule my crew in Klang tomorrow', focusItemId: null },
      (value) => events.push(value),
      new AbortController().signal,
    );
    expect(answer.source).toBe('input_required');
    expect(answer.scheduling).toBeUndefined();
    expect(events[0]).toMatchObject({
      type: 'run_started',
      executionKind: 'local_check',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('submits the issued run contract to live roles and returns matching receipts and checked numbers', async () => {
    const fetcher = network();
    const events: AgentEvent[] = [];
    const answer = await ask(fetcher, events);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toBe(
      '/api/demo/crew-scheduling/agent-runs',
    );
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string)).toEqual({
      ...request,
      input: { ...request.input, query: KLANG_CREW_EXAMPLE },
    });
    expect(answer.scheduling?.result.result.selected_plan_ref).toEqual(
      response.result.result.selected_plan_ref,
    );
    expect(answer.source).toBe('model');
    expect(answer.fictional).toBe(true);
    expect(answer.agentExecution).toEqual(execution);
    expect(answer.scheduling?.result.result.recommendation_eligible).toBe(
      false,
    );
    expect(events.map((value) => value.type)).toEqual([
      'run_started',
      'agent_working',
      'run_completed',
    ]);
  });

  it('decodes arbitrary byte, UTF-8, CRLF and frame splits and accepts a final line at EOF', async () => {
    const bytes = encoder.encode(
      ndjson(frames(), false).replaceAll('\n', '\r\n'),
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // One-byte chunks split all multi-byte characters and newline pairs.
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const answer = await ask(
      network(
        new Response(body, {
          headers: { 'content-type': 'application/x-ndjson' },
        }),
      ),
    );
    expect(answer.paragraphs).toEqual(['Manager commentary ✓']);
    expect(answer.agentExecution?.steps[0]?.summary).toContain('✓');
  });

  it('forwards actual progress before the result is available', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const events: AgentEvent[] = [];
    const pending = ask(
      network(
        new Response(body, {
          headers: { 'content-type': 'application/x-ndjson' },
        }),
      ),
      events,
    );
    controller.enqueue(
      encoder.encode(
        ndjson([start(), event({ type: 'agent_working', agent: 'hazeops' })]),
      ),
    );
    await vi.waitFor(() =>
      expect(events.map((value) => value.type)).toEqual([
        'run_started',
        'agent_working',
      ]),
    );
    controller.enqueue(encoder.encode(ndjson([completed(), result()])));
    controller.close();
    expect((await pending).agentExecution).toEqual(execution);
    expect(events.at(-1)?.type).toBe('run_completed');
  });

  it.each([
    [
      'missing start',
      () => [
        event({ type: 'agent_working', agent: 'manager' }),
        completed(),
        result(),
      ],
    ],
    [
      'local-check start',
      () => [
        event({ type: 'run_started', executionKind: 'local_check' }),
        completed(),
        result(),
      ],
    ],
    ['duplicate start', () => [start(), start(), completed(), result()]],
    [
      'foreign event run',
      () => [
        start(),
        event({
          type: 'agent_working',
          agent: 'manager',
          runId: 'foreign-run',
        }),
        completed(),
        result(),
      ],
    ],
    ['missing completion', () => [start(), result()]],
    ['missing result', () => [start(), completed()]],
    [
      'foreign result run',
      () => [start(), completed(), { ...result(), run_id: 'foreign-run' }],
    ],
    [
      'foreign schedule run',
      () => {
        const value = result();
        value.scheduling.result.run_id = 'foreign-run';
        return [start(), completed(), value];
      },
    ],
    [
      'foreign planning bundle',
      () => {
        const value = result();
        value.scheduling.result.decision_ref.bundle_ref.sha256 = 'f'.repeat(64);
        return [start(), completed(), value];
      },
    ],
    [
      'foreign programme',
      () => {
        const value = result();
        value.scheduling.result.programme_id = 'other-programme';
        value.scheduling.planning.programme_id = 'other-programme';
        return [start(), completed(), value];
      },
    ],
    [
      'missing role receipt',
      () => {
        const value = result();
        value.execution.steps.pop();
        return [start(), completed(), value];
      },
    ],
    [
      'untruthful engine receipt',
      () => {
        const value = result();
        value.execution.steps.find(
          (step) => step.agent === 'worldmodel',
        )!.kind = 'model';
        return [start(), completed(), value];
      },
    ],
    [
      'extra data after result',
      () => [...frames(), event({ type: 'agent_completed', agent: 'manager' })],
    ],
  ])('rejects %s before displaying an answer', async (_name, values) => {
    const events: AgentEvent[] = [];
    await expect(ask(network(stream(values())), events)).rejects.toThrow(
      'contract validation',
    );
    expect(events.some((value) => value.type === 'run_completed')).toBe(false);
    expect(events.at(-1)?.type).toBe('run_failed');
  });

  it('rejects truncated JSON and invalid UTF-8 without completing a run', async () => {
    for (const body of [
      encoder.encode(`${ndjson([start(), completed()])}{"type":"result"`),
      Uint8Array.of(0xff),
    ]) {
      const events: AgentEvent[] = [];
      await expect(
        ask(
          network(
            new Response(body, {
              headers: { 'content-type': 'application/x-ndjson' },
            }),
          ),
          events,
        ),
      ).rejects.toThrow('contract validation');
      expect(events.some((value) => value.type === 'run_completed')).toBe(
        false,
      );
    }
  });

  it('bounds the stream size', async () => {
    await expect(
      ask(
        network(
          new Response(new Uint8Array(512 * 1024 + 1).fill(32), {
            headers: { 'content-type': 'application/x-ndjson' },
          }),
        ),
      ),
    ).rejects.toThrow('contract validation');
  });

  it('uses the server failure event once and never falls back to mock or local calculations', async () => {
    const general = generalService();
    const events: AgentEvent[] = [];
    const fetcher = network(
      stream([
        start(),
        event({
          type: 'run_failed',
          agent: 'manager',
          error: 'The configured model provider is unavailable.',
          retryable: true,
          message: 'The configured model provider is unavailable.',
        }),
      ]),
    );
    await expect(
      new SchedulingAgentService(general, fetcher).ask(
        sampleAsk,
        (value) => events.push(value),
        new AbortController().signal,
      ),
    ).rejects.toThrow('configured model provider');
    expect(events.map((value) => value.type)).toEqual([
      'run_started',
      'run_failed',
    ]);
    expect(general.ask).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('handles server cancellation as an abort without duplicating the terminal event', async () => {
    const events: AgentEvent[] = [];
    await expect(
      ask(network(stream([start(), event({ type: 'run_cancelled' })])), events),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(events.map((value) => value.type)).toEqual([
      'run_started',
      'run_cancelled',
    ]);
  });

  it('cancels promptly when fetch ignores abort and suppresses its late response', async () => {
    let resolve!: (value: Response) => void;
    const deferred = new Promise<Response>((done) => {
      resolve = done;
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request }))
      .mockReturnValueOnce(deferred);
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const pending = new SchedulingAgentService(generalService(), fetcher).ask(
      sampleAsk,
      (value) => events.push(value),
      controller.signal,
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    resolve(stream());
    await Promise.resolve();
    expect(events.map((value) => value.type)).toEqual(['run_cancelled']);
  });

  it('cancels an open stream without waiting for further bytes', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      cancel: cancelled,
    });
    const events: AgentEvent[] = [];
    const abort = new AbortController();
    const pending = new SchedulingAgentService(
      generalService(),
      network(
        new Response(body, {
          headers: { 'content-type': 'application/x-ndjson' },
        }),
      ),
    ).ask(sampleAsk, (value) => events.push(value), abort.signal);
    controller.enqueue(encoder.encode(ndjson([start()])));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(events.map((value) => value.type)).toEqual([
      'run_started',
      'run_cancelled',
    ]);
  });

  it('reports a sanitized JSON configuration error before stream startup', async () => {
    const events: AgentEvent[] = [];
    const fetcher = network(
      json(
        {
          error: { message: 'Set HAZE_AGENT_MODEL before running the sample.' },
        },
        503,
      ),
    );
    await expect(ask(fetcher, events)).rejects.toThrow('Set HAZE_AGENT_MODEL');
    expect(events.map((value) => value.type)).toEqual(['run_failed']);
  });

  it('reports an unavailable service instead of fabricating an answer', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('<html>Static site</html>', {
        headers: { 'content-type': 'text/html' },
      }),
    );
    await expect(ask(fetcher)).rejects.toThrow('static hosting');
    await expect(
      ask(
        vi
          .fn<typeof fetch>()
          .mockRejectedValue(new TypeError('Failed to fetch')),
      ),
    ).rejects.toThrow('could not be reached');
    await expect(
      ask(
        network(
          new Response('<html>Static site</html>', {
            headers: { 'content-type': 'text/html' },
          }),
        ),
      ),
    ).rejects.toThrow('agent stream is unavailable');
  });

  it('reports an unavailable interface chunk before fetching or sending a run', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const general = generalService();
    const events: AgentEvent[] = [];
    const loadContracts = vi
      .fn<() => Promise<typeof DemoChatContracts>>()
      .mockRejectedValue(
        new TypeError('Failed to fetch dynamically imported module'),
      );
    const failure: unknown = await new SchedulingAgentService(
      general,
      fetcher,
      loadContracts,
    )
      .ask(
        sampleAsk,
        (value) => events.push(value),
        new AbortController().signal,
      )
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentRunError);
    expect(failure).toMatchObject({ retryable: false });
    if (!(failure instanceof AgentRunError))
      throw new Error('Expected a resource-load failure');
    expect(failure.message).toContain(
      'Keep the local frontend server running and reload this page',
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(general.ask).not.toHaveBeenCalled();
    expect(events.map((value) => value.type)).toEqual(['run_failed']);
  });
});
