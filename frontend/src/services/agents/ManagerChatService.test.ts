import { describe, expect, it, vi } from 'vitest';
import {
  MANAGER_CHAT_MAX_TIMEOUT_MS,
  type ManagerChatRequest,
  type ManagerChatResponse,
} from '../../../../app/contracts/manager-chat.ts';
import { HttpAgentService } from './HttpAgentService.ts';
import { taskId, runId } from './testFixtures.ts';

const request: ManagerChatRequest = {
  schema_version: 'haze.manager.chat.request.v1',
  conversation_id: taskId,
  turn_id: runId,
  message: 'Hi',
  history: [],
  task_questions: [],
};
const reply: ManagerChatResponse = {
  schema_version: 'haze.manager.chat.response.v1',
  kind: 'reply',
  paragraphs: ['Hello. How can I help?'],
  citations: [],
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('Manager conversational transport', () => {
  it('accepts replies after the former 130-second timeout and bounds a stalled request', async () => {
    vi.useFakeTimers();
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), ms);
        return controller.signal;
      });
    try {
      let respond!: (response: Response) => void;
      const delayed = new Promise<Response>((resolve) => {
        respond = resolve;
      });
      const fetcher = vi
        .fn<typeof fetch>()
        .mockReturnValueOnce(delayed)
        .mockReturnValueOnce(new Promise<Response>(() => {}));
      const service = new HttpAgentService('', fetcher);
      const pending = service.managerChat(request);
      const accepted = expect(pending).resolves.toEqual(reply);
      const replySignal = timeout.mock.results[0].value as AbortSignal;

      await vi.advanceTimersByTimeAsync(130_001);
      expect(replySignal.aborted).toBe(false);
      respond(json(reply));
      await accepted;

      const stalled = service.managerChat(request);
      const rejected = expect(stalled).rejects.toMatchObject({
        name: 'AbortError',
      });
      const stalledSignal = timeout.mock.results[1].value as AbortSignal;
      await vi.advanceTimersByTimeAsync(MANAGER_CHAT_MAX_TIMEOUT_MS + 9_999);
      expect(stalledSignal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(stalledSignal.aborted).toBe(true);
      await rejected;
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      timeout.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('sends ordinary conversation to the Manager endpoint without admitting or observing a task', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(reply));
    const result = await new HttpAgentService('', fetcher).managerChat(request);
    expect(result).toEqual(reply);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('/api/manager/chat');
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual(
      request,
    );
    expect(fetcher.mock.calls[0][1]!.headers).toMatchObject({
      'Idempotency-Key': runId,
    });
  });
  it('finishes immediately on task admission and preserves exact retry bodies', async () => {
    const admitted: ManagerChatResponse = {
      ...reply,
      kind: 'task_admitted',
      task: {
        task_id: taskId,
        title: 'Investigation',
        summary: 'Queued.',
        status_url: `/api/tasks/${taskId}`,
      },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(json(admitted)));
    const service = new HttpAgentService('', fetcher);
    expect(await service.managerChat(request)).toEqual(admitted);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await service.managerChat(
      JSON.parse(JSON.stringify(request)) as ManagerChatRequest,
    );
    expect(fetcher.mock.calls[0][1]!.body).toBe(fetcher.mock.calls[1][1]!.body);
    expect(
      fetcher.mock.calls.every(([url]) => url === '/api/manager/chat'),
    ).toBe(true);
  });
  it('distinguishes unavailable sources from malformed conversation responses', async () => {
    const sourceFailure: ManagerChatResponse = {
      ...reply,
      paragraphs: ['That source is unavailable.'],
      error: { category: 'source_unavailable', retryable: true },
    };
    expect(
      await new HttpAgentService(
        '',
        vi.fn<typeof fetch>().mockResolvedValue(json(sourceFailure)),
      ).managerChat(request),
    ).toEqual(sourceFailure);
    const malformed = new HttpAgentService(
      '',
      vi.fn<typeof fetch>().mockResolvedValue(json({ paragraphs: 'invalid' })),
    );
    await expect(malformed.managerChat(request)).rejects.toThrow(
      'conversation response failed validation',
    );
  });
  it('rejects task responses with another status path', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        ...reply,
        kind: 'task_admitted',
        task: {
          task_id: taskId,
          title: 'Investigation',
          summary: 'Queued.',
          status_url: '/api/tasks/other',
        },
      }),
    );
    await expect(
      new HttpAgentService('', fetcher).managerChat(request),
    ).rejects.toThrow('does not match its saved task identity');
  });
  it('reports HTTP and transport failures without switching to task admission', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ error: { message: 'Manager is unavailable.' } }, 503),
      );
    await expect(
      new HttpAgentService('', fetcher).managerChat(request),
    ).rejects.toThrow('Manager is unavailable');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(
      new HttpAgentService(
        '',
        vi
          .fn<typeof fetch>()
          .mockRejectedValue(new TypeError('Network unavailable')),
      ).managerChat(request),
    ).rejects.toMatchObject({
      category: 'transport',
      cause: new TypeError('Network unavailable'),
    });
  });
});
