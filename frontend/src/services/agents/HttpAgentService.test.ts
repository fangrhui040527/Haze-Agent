import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../shared/types/agents.ts';
import { HttpAgentService } from './HttpAgentService.ts';
import {
  worldRecordReadResponseSchema,
  worldTaskResponseSchema,
} from '../../../../app/contracts/world-api.ts';
import {
  admitted,
  artifactId,
  artifactRef,
  at,
  controlReceipt,
  expectation,
  fixtureTask,
  receipt,
  request,
  taskId,
  taskPath,
} from './testFixtures.ts';
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function completedFetch() {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json(admitted, 202))
    .mockResolvedValueOnce(
      json({
        events: [receipt(1, 'task_completed')],
        next_cursor: 1,
        status: 'completed',
      }),
    )
    .mockResolvedValueOnce(json(fixtureTask()));
}
describe('general task browser service (fixture wiring)', () => {
  it('submits objective-only v3 intake and exposes actual receipts and pinned sources', async () => {
    const fetcher = completedFetch();
    const events: AgentEvent[] = [];
    const onTask = vi.fn();
    const answer = await new HttpAgentService('', fetcher, 0).ask(
      request,
      (event) => events.push(event),
      new AbortController().signal,
      onTask,
    );
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({
      schema_version: 'haze.task.request.v3',
      objective: request.question,
    });
    expect(fetcher.mock.calls[0][1]!.headers).toMatchObject({
      'Idempotency-Key': request.idempotencyKey,
    });
    expect(answer.evidence?.result.covered_scope).toEqual({
      topic: 'evidence',
    });
    expect(answer.citations[0]).toMatchObject({
      href: `/api/artifacts/${artifactId}`,
      sha256: artifactRef.sha256,
    });
    expect(answer.source).toBe('evidence_fixture');
    expect(events).toHaveLength(1);
    expect(onTask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        schemaVersion: 'haze.task.v3',
        record: fixtureTask(),
      }),
    );
  });
  it('attaches optional source refs and arbitrary capability scope', async () => {
    const fetcher = completedFetch();
    await new HttpAgentService('', fetcher, 0).ask(
      { ...request, contextRefs: [artifactRef], scope: { topic: 'forest' } },
      () => {},
      new AbortController().signal,
    );
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({
      context_refs: [artifactRef],
      scope: { topic: 'forest' },
    });
  });
  it('drains global receipt cursor gaps through a terminal status race', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(admitted))
      .mockResolvedValueOnce(
        json({
          events: [receipt(1, 'task_admitted')],
          next_cursor: 1,
          status: 'running',
        }),
      )
      .mockResolvedValueOnce(json(fixtureTask()))
      .mockResolvedValueOnce(
        json({
          events: [receipt(5, 'task_completed')],
          next_cursor: 5,
          status: 'completed',
        }),
      )
      .mockResolvedValueOnce(json(fixtureTask()));
    const events: AgentEvent[] = [];
    await new HttpAgentService('', fetcher, 0).ask(
      request,
      (event) => events.push(event),
      new AbortController().signal,
    );
    expect(fetcher.mock.calls[3][0]).toBe(`${taskPath}/events?after=1`);
    expect(events).toHaveLength(2);
  });
  it('sends exact corrections and revision-fenced controls with stable delivery keys', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(json(controlReceipt)));
    const service = new HttpAgentService('', fetcher);
    const correction = {
      schema_version: 'haze.task.update.v3' as const,
      ...expectation,
      kind: 'correction' as const,
      passage: '  Use the revised scope.  ',
      scope: { topic: 'new' },
    };
    await service.updateTask(taskId, correction, 'correction-operation');
    expect(fetcher.mock.calls[0][0]).toBe(`${taskPath}/updates`);
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual(
      correction,
    );
    for (const action of ['pause', 'cancel', 'resume', 'continue'] as const) {
      await service.controlTask(
        taskId,
        { schema_version: 'haze.task.control.v3', ...expectation, action },
        'same-operation',
      );
      expect(
        JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string),
      ).toMatchObject({ ...expectation, action });
      expect(fetcher.mock.calls.at(-1)![1]!.headers).toMatchObject({
        'Idempotency-Key': 'same-operation',
      });
    }
  });
  it('imports bounded source material separately from task admission', async () => {
    const artifact = {
      schema_version: 'haze.artifact.v3',
      ...artifactRef,
      identity: { principal: 'fixture', workspace: 'fixture' },
      kind: 'source',
      producer: { kind: 'user', id: 'fixture' },
      created_at: at,
      dependencies: [],
      content: 'hello',
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(artifact));
    const imported = await new HttpAgentService('', fetcher).importSource(
      {
        schema_version: 'haze.artifact.import.v3',
        filename: 'notes.md',
        media_type: 'text/markdown',
        content_base64: 'aGVsbG8=',
      },
      'source-operation',
    );
    expect(imported.id).toBe(artifactId);
    expect(fetcher.mock.calls[0][0]).toBe('/api/artifacts');
  });
  it('rejects old protocol records, invalid cursor order, and source identity mismatches', async () => {
    for (const final of [
      { ...fixtureTask(), schema_version: 'haze.task.v2' },
      {
        ...fixtureTask(),
        result: {
          ...fixtureTask().result,
          sources: [
            {
              id: 'E1',
              artifact: artifactRef,
              label: 'bad',
              url: 'https://unrelated.invalid',
            },
          ],
        },
      },
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json(admitted))
        .mockResolvedValueOnce(
          json({ events: [], next_cursor: 0, status: 'completed' }),
        )
        .mockResolvedValueOnce(json(final));
      await expect(
        new HttpAgentService('', fetcher, 0).ask(
          request,
          () => {},
          new AbortController().signal,
        ),
      ).rejects.toThrow('failed contract validation');
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(admitted))
      .mockResolvedValueOnce(
        json({
          events: [receipt(2, 'task_started'), receipt(1, 'task_completed')],
          next_cursor: 1,
          status: 'completed',
        }),
      );
    await expect(
      new HttpAgentService('', fetcher, 0).ask(
        request,
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow('failed contract validation');
  });
  it('keeps permission and stale-operation failures explicit without fallback', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ error: { message: 'Objective revision is stale.' } }, 409),
      );
    await expect(
      new HttpAgentService('', fetcher).controlTask(
        taskId,
        {
          schema_version: 'haze.task.control.v3',
          ...expectation,
          action: 'pause',
        },
        'operation',
      ),
    ).rejects.toThrow('Objective revision is stale.');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('stops a browser wait without inventing server cancellation', async () => {
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
  it('reads schema-checked current World Model status and paginated lineage', async () => {
    const taskWorld = worldTaskResponseSchema.parse({
      schema_version: 'haze.world.task-view.v1',
      task_id: taskId,
      mode: 'fixture',
      records: [],
      current_acceptances: [],
      truncated: false,
    });
    const lineage = worldRecordReadResponseSchema.parse({
      view: 'lineage',
      lineage: {
        schema_version: 'haze.world.lineage-page.v1',
        record: { id: 'wmr:lineage', revision: 1, sha256: 'a'.repeat(64) },
        entries: [],
        page: { limit: 10, has_more: false },
      },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(taskWorld))
      .mockResolvedValueOnce(json(lineage));
    const service = new HttpAgentService('/backend', fetcher);
    expect(await service.readWorldTask(taskId)).toEqual(taskWorld);
    expect(
      await service.readWorldRecord(
        'wmr:lineage',
        'lineage',
        { limit: 10 },
      ),
    ).toEqual(lineage);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `/backend/api/tasks/${taskId}/world`,
      '/backend/api/world/records/wmr%3Alineage?view=lineage&limit=10',
    ]);
  });
  it('shows invalid current World Model responses as explicit service errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({}));
    await expect(
      new HttpAgentService('', fetcher).readWorldTask(taskId),
    ).rejects.toThrow('current World Model status response failed validation');
  });
});
