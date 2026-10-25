import type { TaskRecord } from '../../../../app/tasks/contracts.ts';
import type { OrchestrationTask } from '../../../../app/orchestration/contracts.ts';
import { abortError, delay, isAbortError } from '../../shared/lib/delay.ts';
import type {
  AgentAnswer,
  AgentEvent,
  AskRequest,
  AgentTaskHandle,
  AgentTaskCancellation,
} from '../../shared/types/agents.ts';
import {
  AgentRunError,
  AgentTaskCancelledError,
  type AgentService,
} from './AgentService.ts';

const loadTaskContracts = () => import('../../../../app/tasks/contracts.ts');
const loadOrchestrationContracts = () =>
  import('../../../../app/orchestration/contracts.ts');
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** A stopped browser wait never claims that a durable server task was cancelled. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const stop = () => reject(abortError());
    signal.addEventListener('abort', stop, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        if (signal.aborted) reject(abortError());
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(
          signal.aborted
            ? abortError()
            : error instanceof Error
              ? error
              : new Error('Task request failed.'),
        );
      },
    );
  });
}

/** Read-only evidence tasks; no fallback to offline samples or scheduling facts. */
export class HttpAgentService implements AgentService {
  readonly label = 'Evidence task API · actual execution receipts';
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly pollMs: number;
  private readonly orchestration: boolean;

  constructor(
    baseUrl = '',
    fetcher: typeof fetch = (input, init) => fetch(input, init),
    pollMs = 750,
    orchestration = false,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetcher = fetcher;
    this.pollMs = pollMs;
    this.orchestration = orchestration;
  }

  async ask(
    request: AskRequest,
    onEvent: (event: AgentEvent) => void,
    signal: AbortSignal,
    onTask?: (task: AgentTaskHandle) => void,
  ): Promise<AgentAnswer> {
    const started = Date.now();
    let taskPath: string | undefined;
    try {
      const { taskAdmissionSchema, taskEventPageSchema, taskRecordSchema } =
        await abortable(loadTaskContracts(), signal);
      const orchestrationContracts = this.orchestration
        ? await abortable(loadOrchestrationContracts(), signal)
        : undefined;
      const read = async (
        path: string,
        init: RequestInit = {},
      ): Promise<unknown> => {
        const response = await abortable(
          this.fetcher(`${this.baseUrl}${path}`, {
            ...init,
            signal,
            cache: 'no-store',
            credentials: 'same-origin',
          }),
          signal,
        );
        if (
          !response.headers.get('content-type')?.includes('application/json')
        ) {
          void response.body?.cancel().catch(() => {});
          throw new AgentRunError(
            'The evidence task API is unavailable on this host. Start the configured Haze backend and retry.',
            false,
          );
        }
        const raw = await abortable(response.text(), signal);
        if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES)
          throw new AgentRunError(
            'The task response exceeds the browser response bound.',
            false,
          );
        const value: unknown = JSON.parse(raw);
        if (!response.ok) {
          const error = value as { error?: { message?: unknown } } | null;
          throw new AgentRunError(
            typeof error?.error?.message === 'string'
              ? error.error.message.slice(0, 2000)
              : `Evidence task request failed (${response.status}).`,
            response.status >= 500 || response.status === 429,
          );
        }
        return value;
      };

      const admitted = taskAdmissionSchema.parse(
        await read('/api/tasks', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': request.idempotencyKey ?? crypto.randomUUID(),
          },
          body: JSON.stringify({
            schema_version: this.orchestration
              ? 'haze.task.request.v2'
              : 'haze.task.request.v1',
            objective: request.question,
            ...(this.orchestration
              ? { context_refs: [], constraints: [], desired_deliverables: [] }
              : {}),
          }),
        }),
      );
      taskPath = `/api/tasks/${admitted.task_id}`;
      if (
        admitted.status_url !== taskPath ||
        admitted.events_url !== `${taskPath}/events`
      )
        throw new Error(
          'Task admission paths do not match the admitted identity.',
        );
      onTask?.({
        id: admitted.task_id,
        schemaVersion: this.orchestration ? 'haze.task.v2' : 'haze.task.v1',
        taskUrl: `${this.baseUrl}${taskPath}`,
        status: 'queued',
      });
      let cursor = 0;
      let record: TaskRecord | OrchestrationTask;
      while (true) {
        const rawPage = await read(`${taskPath}/events?after=${cursor}`);
        const page = orchestrationContracts
          ? orchestrationContracts.orchestrationEventPageSchema.parse(rawPage)
          : taskEventPageSchema.parse(rawPage);
        for (const event of page.events) {
          // Cursors are global durable IDs; other tasks can create legitimate gaps.
          if (event.task_id !== admitted.task_id || event.cursor <= cursor)
            throw new Error(
              'The durable task event cursor or identity is invalid.',
            );
          cursor = event.cursor;
          onEvent({
            type: 'task_event',
            runId: event.task_id,
            at: event.at,
            message: event.message,
            receipt: event,
          });
        }
        if (page.next_cursor !== cursor)
          throw new Error('The durable task event page skipped receipts.');
        const rawRecord = await read(taskPath);
        record = orchestrationContracts
          ? orchestrationContracts.orchestrationTaskSchema.parse(rawRecord)
          : taskRecordSchema.parse(rawRecord);
        if (
          record.id !== admitted.task_id ||
          record.original_request.objective !== request.question
        )
          throw new Error(
            'The task record does not belong to this submission.',
          );
        onTask?.({
          id: record.id,
          schemaVersion: record.schema_version,
          taskUrl: `${this.baseUrl}${taskPath}`,
          status: record.status,
          mode: record.mode,
        });
        if (record.status !== 'queued' && record.status !== 'running') {
          // Drain events written between the event page and terminal status read.
          if (page.status !== record.status) continue;
          break;
        }
        if (Date.now() > Date.parse(record.limits.deadline) + 10_000)
          throw new AgentRunError(
            'The browser stopped waiting after the task deadline. Open the persisted task to inspect its status.',
            false,
          );
        await delay(this.pollMs, signal);
      }
      if (record.status === 'cancelled') throw new AgentTaskCancelledError();
      if (record.status !== 'completed' || !record.result)
        throw new AgentRunError(
          record.error?.message ??
            `Evidence task ended with status ${record.status}.`,
          false,
        );
      const result = record.result;
      for (const citation of result.citations) {
        if (citation.url !== `${taskPath}/artifacts/${citation.artifact_id}`)
          throw new Error(
            'A citation does not point to this task’s exact artifact.',
          );
      }
      return {
        runId: record.id,
        paragraphs: result.answer.split(/\n\s*\n/).filter(Boolean),
        citations: result.citations.map((citation) => ({
          id: citation.id,
          label: citation.label,
          itemId: null,
          href: `${this.baseUrl}${citation.url}`,
          artifactId: citation.artifact_id,
          sha256: citation.sha256,
          selection: citation.selection,
        })),
        source:
          result.provenance.mode === 'fixture'
            ? 'evidence_fixture'
            : 'evidence_model',
        fictional: result.provenance.mode === 'fixture',
        durationMs: Date.now() - started,
        evidence: { taskUrl: `${this.baseUrl}${taskPath}`, result },
      };
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw abortError();
      if (error instanceof AgentTaskCancelledError) throw error;
      const suffix = taskPath
        ? ` Persisted task: ${this.baseUrl}${taskPath}.`
        : '';
      if (error instanceof AgentRunError)
        throw new AgentRunError(`${error.message}${suffix}`, error.retryable);
      throw new AgentRunError(
        `The evidence task could not be read or failed contract validation. No answer was substituted.${suffix}`,
        false,
      );
    }
  }

  async cancelTask(
    taskId: string,
    operationKey: string,
    parentSignal?: AbortSignal,
  ): Promise<AgentTaskCancellation> {
    const signal = parentSignal
      ? AbortSignal.any([parentSignal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000);
    if (
      !this.orchestration ||
      !/^[a-f0-9-]{36}$/i.test(taskId) ||
      !operationKey
    )
      throw new AgentRunError(
        'Server cancellation requires an admitted v2 task.',
        false,
      );
    const response = await abortable(
      this.fetcher(`${this.baseUrl}/api/tasks/${taskId}/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': operationKey,
        },
        body: '{}',
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
      }),
      signal,
    );
    if (!response.headers.get('content-type')?.includes('application/json')) {
      void response.body?.cancel().catch(() => {});
      throw new AgentRunError(
        'The task cancellation API is unavailable. The server task may still be running.',
        false,
      );
    }
    const raw = await abortable(response.text(), signal);
    if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES)
      throw new AgentRunError(
        'The cancellation response exceeds the browser response bound.',
        false,
      );
    const value: unknown = JSON.parse(raw);
    if (!response.ok) {
      const error = value as { error?: { message?: unknown } } | null;
      throw new AgentRunError(
        typeof error?.error?.message === 'string'
          ? error.error.message.slice(0, 2000)
          : `Task cancellation failed (${response.status}). The server task may still be running.`,
        response.status >= 500,
      );
    }
    const { cancellationSchema } = await abortable(
      loadOrchestrationContracts(),
      signal,
    );
    const parsed = cancellationSchema.safeParse(value);
    if (!parsed.success || parsed.data.task_id !== taskId)
      throw new AgentRunError(
        'The task cancellation response failed validation. Check the saved task status.',
        false,
      );
    return parsed.data;
  }
}
