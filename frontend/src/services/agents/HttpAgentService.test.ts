import { describe, expect, it, vi } from 'vitest';
import type { TaskEvent, TaskRecord } from '../../../../app/tasks/contracts.ts';
import type {
  OrchestrationEvent,
  OrchestrationTask,
} from '../../../../app/orchestration/contracts.ts';
import type { AgentEvent } from '../../shared/types/agents.ts';
import { HttpAgentService } from './HttpAgentService.ts';

const id = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const path = `/api/tasks/${id}`;
const at = '2026-10-24T00:00:00Z';
const scope = {
  location: 'Kuala Lumpur',
  period: { start: '2026-10-23T00:00:00Z', end: at },
};
const request = {
  question:
    'Summarize the PM2.5 evidence available for Kuala Lumpur during 2026-10-23 to 2026-10-24, distinguish modeled values from observations, and identify coverage gaps.',
  focusItemId: null,
  idempotencyKey: 'submission-for-fixture-only',
};
const admitted = {
  task_id: id,
  status_url: path,
  events_url: `${path}/events`,
  reused: false,
};

/** Captured-shape fixture verifies browser wiring, never live integration readiness. */
function fixtureTask(): TaskRecord {
  return {
    schema_version: 'haze.task.v1',
    id,
    objective_revision: 1,
    original_request: {
      schema_version: 'haze.task.request.v1',
      objective: request.question,
      context_refs: [],
      constraints: [],
      desired_deliverables: [],
    },
    scope,
    identity: { principal: 'fixture', workspace: 'fixture' },
    permissions: { tools: ['evidence.read'], effects: [] },
    limits: {
      deadline: '2099-01-01T00:00:00Z',
      max_tool_calls: 1,
      max_model_calls: 1,
      max_model_input_bytes: 50000,
      max_model_output_tokens: 2000,
      max_artifacts: 6,
    },
    usage: { tool_calls: 1, model_calls: 1, artifacts: 3 },
    created_at: at,
    updated_at: at,
    status: 'completed',
    mode: 'live',
    result: {
      answer:
        'One modeled PM2.5 row is available. No observations establish local exposure. [source-1]',
      findings: [
        {
          text: 'One modeled row; no observations.',
          citation_ids: ['source-1'],
        },
      ],
      citations: [
        {
          id: 'source-1',
          artifact_id: artifactId,
          sha256: 'a'.repeat(64),
          url: `${path}/artifacts/${artifactId}`,
          label: 'Exact PM2.5 selection',
          selection: { row_ids: ['one'] },
        },
      ],
      coverage: {
        requested: scope,
        row_count: 1,
        usable_row_count: 1,
        modeled_count: 1,
        observation_count: 0,
        unknown_kind_count: 0,
        missing_intervals: [{ start: '2026-10-23T01:00:00Z', end: at }],
        status: 'partial',
      },
      assumptions: ['Coverage uses explicit source intervals.'],
      unresolved_gaps: ['No observations.'],
      review: {
        status: 'deterministic_checks',
        scope: 'Citation and interval validation only.',
        limitations: ['No independent scientific review.'],
        artifact_id: artifactId,
      },
      provenance: {
        mode: 'live',
        source: 'test-only-fixture',
        retrieved_at: at,
        model: {
          provider: 'fixture-provider',
          model: 'fixture-model',
          calls: 1,
          max_output_tokens: 2000,
          usage: 'not_reported_by_adapter',
        },
        tool_calls: 1,
        method: 'haze.pm25.coverage.v1',
      },
    },
  };
}

function receipt(
  cursor: number,
  type: string,
  actor: TaskEvent['actor'] = 'Manager',
): TaskEvent {
  return { cursor, task_id: id, at, type, actor, message: `Actual ${type}` };
}
function orchestrationReceipt(
  cursor: number,
  type: string,
  actor: OrchestrationEvent['actor'] = 'Manager',
): OrchestrationEvent {
  return {
    ...receipt(cursor, type),
    schema_version: 'haze.task.event.v2',
    actor,
    objective_revision: 1,
    generation: 1,
    assignment_id: artifactId,
  };
}
function fixtureOrchestrationTask(): OrchestrationTask {
  const old = fixtureTask();
  if (!old.result) throw new Error('Missing fixture result.');
  return {
    ...old,
    schema_version: 'haze.task.v2',
    generation: 1,
    mode: 'fixture',
    original_request: {
      ...old.original_request,
      schema_version: 'haze.task.request.v2',
    },
    limits: { ...old.limits, max_model_output_tokens: 700 },
    assignments: [],
    result: {
      ...old.result,
      schema_version: 'haze.task.result.v2',
      completion: 'partial',
      review: { ...old.result.review, status: 'needs_review' },
      provenance: { ...old.result.provenance, mode: 'fixture' },
    },
  };
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('HttpAgentService evidence task wiring (fixtures only)', () => {
  it('opts in to v2, reports exact assignments and preserves fixture and review limits', async () => {
    const final = fixtureOrchestrationTask();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(admitted, 202))
      .mockResolvedValueOnce(
        json({
          events: [
            orchestrationReceipt(1, 'assignment_started', 'WorkerShield'),
            orchestrationReceipt(2, 'task_completed', 'Runtime'),
          ],
          next_cursor: 2,
          status: 'completed',
        }),
      )
      .mockResolvedValueOnce(json(final));
    const events: AgentEvent[] = [];
    const onTask = vi.fn();
    const answer = await new HttpAgentService('', fetcher, 0, true).ask(
      request,
      (event) => events.push(event),
      new AbortController().signal,
      onTask,
    );
    expect(answer.source).toBe('evidence_fixture');
    expect(answer.fictional).toBe(true);
    expect(answer.evidence?.result).toMatchObject({
      completion: 'partial',
      review: { status: 'needs_review' },
    });
    expect(events[0]).toMatchObject({
      receipt: { actor: 'WorkerShield', assignment_id: artifactId },
    });
    expect(events[1]).toMatchObject({ receipt: { actor: 'Runtime' } });
    expect(onTask).toHaveBeenNthCalledWith(1, {
      id,
      taskUrl: path,
      schemaVersion: 'haze.task.v2',
      status: 'queued',
    });
    expect(onTask).toHaveBeenLastCalledWith({
      id,
      taskUrl: path,
      schemaVersion: 'haze.task.v2',
      status: 'completed',
      mode: 'fixture',
    });
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({
      schema_version: 'haze.task.request.v2',
      objective: request.question,
      context_refs: [],
      constraints: [],
      desired_deliverables: [],
    });
  });

  it('does not accept v1 records or receipts as a replacement for an opt-in v2 task', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(admitted, 202))
      .mockResolvedValueOnce(
        json({
          events: [receipt(1, 'task_completed')],
          next_cursor: 1,
          status: 'completed',
        }),
      );
    await expect(
      new HttpAgentService('', fetcher, 0, true).ask(
        request,
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow('failed contract validation');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('sends an explicit idempotent cancellation and validates the returned identity', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          json({ task_id: id, status: 'cancelled', generation: 2 }),
        ),
      );
    const service = new HttpAgentService('', fetcher, 0, true);
    const key = 'stable-cancellation-operation';
    await expect(service.cancelTask(id, key)).resolves.toEqual({
      task_id: id,
      status: 'cancelled',
      generation: 2,
    });
    await service.cancelTask(id, key);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toBe(`${path}/cancel`);
      expect(init).toMatchObject({
        method: 'POST',
        body: '{}',
        credentials: 'same-origin',
        headers: { 'Idempotency-Key': key },
      });
    }
    await expect(
      new HttpAgentService('', fetcher).cancelTask(id, key),
    ).rejects.toThrow('admitted v2 task');
    const mismatch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ task_id: artifactId, status: 'cancelled', generation: 2 }),
      );
    await expect(
      new HttpAgentService('', mismatch, 0, true).cancelTask(id, key),
    ).rejects.toThrow('failed validation');
  });

  it('distinguishes a durable server cancellation from a stopped browser wait', async () => {
    const final = fixtureOrchestrationTask();
    final.status = 'cancelled';
    delete final.result;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(admitted, 202))
      .mockResolvedValueOnce(
        json({
          events: [orchestrationReceipt(1, 'task_cancelled', 'Runtime')],
          next_cursor: 1,
          status: 'cancelled',
        }),
      )
      .mockResolvedValueOnce(json(final));
    await expect(
      new HttpAgentService('', fetcher, 0, true).ask(
        request,
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'AgentTaskCancelledError' });
    expect(
      fetcher.mock.calls.some(
        ([url]) => typeof url === 'string' && url.endsWith('/cancel'),
      ),
    ).toBe(false);
  });

  it('drains monotonic global cursors through a status race and returns exact citations and gaps', async () => {
    const final = fixtureTask();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(admitted, 202))
      .mockResolvedValueOnce(
        json({
          events: [receipt(1, 'task_admitted')],
          next_cursor: 1,
          status: 'running',
        }),
      )
      .mockResolvedValueOnce(json(final))
      .mockResolvedValueOnce(
        json({
          events: [
            receipt(4, 'tool_started', 'HazeOps'),
            receipt(6, 'tool_completed', 'HazeOps'),
            receipt(7, 'model_completed'),
            receipt(9, 'task_completed'),
          ],
          next_cursor: 9,
          status: 'completed',
        }),
      )
      .mockResolvedValueOnce(json(final));
    const events: AgentEvent[] = [];
    const answer = await new HttpAgentService('', fetcher, 0).ask(
      request,
      (event) => events.push(event),
      new AbortController().signal,
    );
    expect(answer.source).toBe('evidence_model');
    expect(answer.citations[0]).toMatchObject({
      href: `${path}/artifacts/${artifactId}`,
      sha256: 'a'.repeat(64),
      itemId: null,
    });
    expect(answer.evidence?.result.coverage?.missing_intervals).toHaveLength(1);
    expect(events).toHaveLength(5);
    expect(events.every((event) => event.type === 'task_event')).toBe(true);
    expect(fetcher.mock.calls[3]?.[0]).toBe(`${path}/events?after=1`);
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({
      'Idempotency-Key': request.idempotencyKey,
    });
    const submittedBody = init?.body;
    if (typeof submittedBody !== 'string')
      throw new Error('Expected a JSON request body.');
    expect(JSON.parse(submittedBody)).toEqual({
      schema_version: 'haze.task.request.v1',
      objective: request.question,
    });
  });

  it('keeps a provider failure explicit without creating a success or synthetic receipt', async () => {
    const failed = fixtureTask();
    failed.status = 'failed';
    delete failed.result;
    failed.error = {
      code: 'provider_failure',
      message: 'Provider rejected this execution.',
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(admitted, 202))
      .mockResolvedValueOnce(
        json({
          events: [receipt(1, 'task_failed')],
          next_cursor: 1,
          status: 'failed',
        }),
      )
      .mockResolvedValueOnce(json(failed));
    const events: AgentEvent[] = [];
    await expect(
      new HttpAgentService('', fetcher, 0).ask(
        request,
        (event) => events.push(event),
        new AbortController().signal,
      ),
    ).rejects.toThrow('Provider rejected this execution.');
    expect(events).toEqual([
      {
        type: 'task_event',
        runId: id,
        at,
        message: 'Actual task_failed',
        receipt: receipt(1, 'task_failed'),
      },
    ]);
  });

  it('does not start a local fallback after malformed or denied admission', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json(
        {
          error: {
            code: 'scope_required',
            message: 'Explicit location and period required.',
          },
        },
        422,
      ),
    );
    const events: AgentEvent[] = [];
    await expect(
      new HttpAgentService('', fetcher, 0).ask(
        request,
        (event) => events.push(event),
        new AbortController().signal,
      ),
    ).rejects.toThrow('Explicit location and period required.');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });

  it('rejects nonmonotonic event cursors and citations outside this task', async () => {
    const skipped = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(admitted, 202))
      .mockResolvedValueOnce(
        json({
          events: [receipt(2, 'task_admitted'), receipt(1, 'task_completed')],
          next_cursor: 1,
          status: 'completed',
        }),
      );
    await expect(
      new HttpAgentService('', skipped, 0).ask(
        request,
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow('failed contract validation');
    const invalid = fixtureTask();
    invalid.result!.citations[0].url = 'https://unrelated.invalid/';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(admitted, 202))
      .mockResolvedValueOnce(
        json({
          events: [receipt(1, 'task_completed')],
          next_cursor: 1,
          status: 'completed',
        }),
      )
      .mockResolvedValueOnce(json(invalid));
    await expect(
      new HttpAgentService('', fetcher, 0).ask(
        request,
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow('failed contract validation');
  });

  it('stops a wait promptly without inventing a server cancellation', async () => {
    const controller = new AbortController();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise(() => {}));
    const events: AgentEvent[] = [];
    const pending = new HttpAgentService('', fetcher).ask(
      request,
      (event) => events.push(event),
      controller.signal,
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(events).toEqual([]);
  });
});
