import type { TaskRecord } from '../../../../app/contracts/tasks.ts';
import type { ArtifactImport } from '../../../../app/contracts/artifacts.ts';
import {
  MANAGER_CHAT_MAX_TIMEOUT_MS,
  type ManagerChatRequest,
} from '../../../../app/contracts/manager-chat.ts';
import type {
  TaskControl,
  TaskUpdate,
} from '../../../../app/contracts/controls.ts';
import {
  worldRecordReadResponseSchema,
  worldTaskResponseSchema,
} from '../../../../app/contracts/world-api.ts';
import { abortError, delay, isAbortError } from '../../shared/lib/delay.ts';
import type {
  AgentAnswer,
  AgentEvent,
  AskRequest,
  AgentTaskHandle,
} from '../../shared/types/agents.ts';
import {
  AgentRunError,
  AgentTaskCancelledError,
  type AgentService,
} from './AgentService.ts';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
class TaskResponseValidationError extends Error {}
/** Abort even when an injected transport does not implement AbortSignal. */
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

export class HttpAgentService implements AgentService {
  readonly label = 'General task API - actual execution receipts';
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly pollMs: number;
  constructor(
    baseUrl = '',
    fetcher: typeof fetch = (input, init) => fetch(input, init),
    pollMs = 750,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetcher = fetcher;
    this.pollMs = pollMs;
  }
  private async read(
    path: string,
    init: RequestInit = {},
    suppliedSignal?: AbortSignal,
  ): Promise<unknown> {
    const signal = suppliedSignal ?? AbortSignal.timeout(15_000);
    const apiName = path.startsWith('/api/manager/chat')
      ? 'Manager conversation'
      : 'task';
    let response: Response;
    try {
      response = await abortable(
        this.fetcher(`${this.baseUrl}${path}`, {
          ...init,
          signal,
          cache: 'no-store',
          credentials: 'same-origin',
        }),
        signal,
      );
    } catch (cause) {
      if (signal.aborted || isAbortError(cause)) throw abortError();
      throw new AgentRunError(
        'The API could not be reached. Check the connection and retry the same request.',
        true,
        { category: 'transport', cause },
      );
    }
    if (!response.headers.get('content-type')?.includes('application/json')) {
      void response.body?.cancel().catch(() => {});
      throw new AgentRunError(
        `The ${apiName} API is unavailable on this host. Start the configured Haze backend and retry.`,
        false,
        { category: 'response_validation' },
      );
    }
    let raw: string;
    try {
      raw = await abortable(response.text(), signal);
    } catch (cause) {
      if (signal.aborted || isAbortError(cause)) throw abortError();
      throw new AgentRunError(
        'The API response was interrupted. Retry the same request.',
        true,
        { category: 'transport', cause },
      );
    }
    const responseBound = path.startsWith('/api/artifacts')
      ? 8 * 1024 * 1024
      : MAX_RESPONSE_BYTES;
    if (new TextEncoder().encode(raw).byteLength > responseBound)
      throw new AgentRunError(
        `The ${apiName} response exceeds the browser response bound.`,
        false,
        { category: 'response_validation' },
      );
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (cause) {
      throw new AgentRunError(
        `The ${apiName} API returned invalid JSON. Retry the same request to recover any saved response.`,
        true,
        { category: 'response_validation', cause },
      );
    }
    if (!response.ok) {
      const error = value as { error?: { message?: unknown } } | null;
      throw new AgentRunError(
        typeof error?.error?.message === 'string'
          ? error.error.message.slice(0, 2000)
          : `Task request failed (${response.status}).`,
        response.status >= 500 || response.status === 429,
      );
    }
    return value;
  }
  private post(path: string, body: unknown, key: string, signal?: AbortSignal) {
    return this.read(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(body),
      },
      signal,
    );
  }
  async managerChat(
    request: ManagerChatRequest,
    signal = AbortSignal.timeout(MANAGER_CHAT_MAX_TIMEOUT_MS + 10_000),
  ) {
    const { managerChatRequestSchema, managerChatResponseSchema } =
      await import('../../../../app/contracts/manager-chat.ts');
    const parsedRequest = managerChatRequestSchema.safeParse(request);
    if (!parsedRequest.success)
      throw new AgentRunError(
        'This message or its conversation context exceeds the supported size. Shorten the message or start a fresh conversation.',
        false,
      );
    const body = parsedRequest.data;
    const response = managerChatResponseSchema.safeParse(
      await this.post('/api/manager/chat', body, body.turn_id, signal),
    );
    if (!response.success)
      throw new AgentRunError(
        'The Manager conversation response failed validation. Retry this same turn after updating the backend.',
        true,
        { category: 'response_validation', cause: response.error },
      );
    if (response.data.task) {
      const expected = `/api/tasks/${response.data.task.task_id}`;
      if (response.data.task.status_url !== expected)
        throw new AgentRunError(
          'The Manager task response does not match its saved task identity.',
          true,
          { category: 'task_response_validation' },
        );
    }
    return response.data;
  }
  async ask(
    request: AskRequest,
    onEvent: (event: AgentEvent) => void,
    signal: AbortSignal,
    onTask?: (task: AgentTaskHandle) => void,
  ): Promise<AgentAnswer> {
    const { taskAdmissionSchema } = await abortable(
      import('../../../../app/contracts/tasks.ts'),
      signal,
    );
    const admission = taskAdmissionSchema.safeParse(
      await this.post(
        '/api/tasks',
        {
          schema_version: 'haze.task.request.v3',
          objective: request.question,
          ...(request.contextRefs?.length
            ? { context_refs: request.contextRefs }
            : {}),
          ...(request.scope !== undefined ? { scope: request.scope } : {}),
          ...(request.nightshiftTools?.length
            ? { nightshift_tools: request.nightshiftTools }
            : {}),
        },
        request.idempotencyKey ?? crypto.randomUUID(),
        signal,
      ),
    );
    if (!admission.success)
      throw new AgentRunError(
        'The task admission response failed contract validation. Retry the same request to recover any saved admission.',
        true,
        { category: 'task_response_validation', cause: admission.error },
      );
    const admitted = admission.data;
    const path = `/api/tasks/${admitted.task_id}`;
    if (
      admitted.status_url !== path ||
      admitted.events_url !== `${path}/events`
    )
      throw new AgentRunError(
        'Task admission paths do not match the admitted identity.',
        false,
        { category: 'task_response_validation' },
      );
    onTask?.({
      id: admitted.task_id,
      schemaVersion: 'haze.task.v3',
      taskUrl: `${this.baseUrl}${path}`,
      status: 'queued',
    });
    return this.watchTask(admitted.task_id, onEvent, signal, onTask);
  }
  async readTask(taskId: string, signal?: AbortSignal): Promise<TaskRecord> {
    const { taskRecordSchema } =
      await import('../../../../app/contracts/tasks.ts');
    const parsed = taskRecordSchema.safeParse(
      await this.read(`/api/tasks/${encodeURIComponent(taskId)}`, {}, signal),
    );
    if (!parsed.success)
      throw new AgentRunError(
        'The saved task response failed contract validation for the general protocol. Refresh the application after updating the backend.',
        false,
        { category: 'task_response_validation', cause: parsed.error },
      );
    const record = parsed.data;
    if (record.id !== taskId)
      throw new AgentRunError(
        'The task response belongs to another task.',
        false,
        { category: 'task_response_validation' },
      );
    return record;
  }
  async readReductionPreview(taskId: string, signal?: AbortSignal) {
    const { reductionPreviewViewSchema } =
      await import('../../../../app/contracts/damage-reduction-view.ts');
    const view = reductionPreviewViewSchema.parse(
      await this.read(
        `/api/tasks/${encodeURIComponent(taskId)}/views/reduction-preview`,
        {},
        signal,
      ),
    );
    if (view.task_id !== taskId)
      throw new AgentRunError(
        'The planning preview belongs to another saved task.',
        false,
      );
    return view;
  }
  async watchTask(
    taskId: string,
    onEvent: (event: AgentEvent) => void,
    signal: AbortSignal,
    onTask?: (task: AgentTaskHandle) => void,
  ): Promise<AgentAnswer> {
    const { taskEventPageSchema } = await abortable(
      import('../../../../app/contracts/tasks.ts'),
      signal,
    );
    const started = Date.now();
    let cursor = 0;
    const path = `/api/tasks/${taskId}`;
    try {
      while (true) {
        const parsedPage = taskEventPageSchema.safeParse(
          await this.read(`${path}/events?after=${cursor}`, {}, signal),
        );
        if (!parsedPage.success)
          throw new TaskResponseValidationError(
            'The task event response has an invalid shape.',
            { cause: parsedPage.error },
          );
        const page = parsedPage.data;
        for (const event of page.events) {
          if (event.task_id !== taskId || event.cursor <= cursor)
            throw new TaskResponseValidationError(
              'Invalid event identity or cursor.',
            );
          cursor = event.cursor;
          onEvent({
            type: 'task_event',
            runId: event.run_id,
            at: event.at,
            message: event.message,
            receipt: event,
          });
        }
        if (page.next_cursor !== cursor)
          throw new TaskResponseValidationError('Event page skipped receipts.');
        const record = await this.readTask(taskId, signal);
        onTask?.({
          id: record.id,
          schemaVersion: 'haze.task.v3',
          taskUrl: `${this.baseUrl}${path}`,
          status: record.status,
          mode: record.mode,
          record,
        });
        if (
          ['completed', 'failed', 'timed_out', 'cancelled'].includes(
            record.status,
          )
        ) {
          if (page.status !== record.status) continue;
          if (record.status === 'cancelled')
            throw new AgentTaskCancelledError();
          if (record.status !== 'completed' || !record.result)
            throw new AgentRunError(
              record.error?.message ??
                `Task ended with status ${record.status}.`,
              false,
            );
          const result = record.result;
          return {
            runId: record.current_run_id,
            paragraphs: result.answer.split(/\n\s*\n/).filter(Boolean),
            citations: result.sources.map((source) => {
              const exact = `/api/artifacts/${source.artifact.id}`;
              if (source.url && source.url !== exact)
                throw new TaskResponseValidationError(
                  'A source does not point to its exact artifact.',
                );
              return {
                id: source.id,
                label: source.label,
                itemId: null,
                href: `${this.baseUrl}${exact}`,
                artifactId: source.artifact.id,
                sha256: source.artifact.sha256,
                selection: source.selection,
              };
            }),
            source:
              result.provenance.mode === 'live'
                ? 'evidence_model'
                : 'evidence_fixture',
            fictional: result.provenance.mode === 'fixture',
            durationMs: Date.now() - started,
            evidence: {
              taskUrl: `${this.baseUrl}${path}`,
              result,
              objectiveRevision: record.objective_revision,
              runId: record.current_run_id,
            },
          };
        }
        // Pauses and persisted questions remain observable without triggering new work.
        await delay(this.pollMs, signal);
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw abortError();
      if (error instanceof AgentTaskCancelledError) throw error;
      if (error instanceof AgentRunError) throw error;
      if (error instanceof TaskResponseValidationError)
        throw new AgentRunError(
          `The task response failed contract validation. Persisted task: ${this.baseUrl}${path}.`,
          false,
          { category: 'task_response_validation', cause: error },
        );
      throw new AgentRunError(
        'Task progress could not be read. The last confirmed saved task state is retained.',
        true,
        { category: 'unexpected', cause: error },
      );
    }
  }
  async updateTask(
    taskId: string,
    update: TaskUpdate,
    key: string,
    signal?: AbortSignal,
  ) {
    const { controlReceiptSchema, taskUpdateSchema } =
      await import('../../../../app/contracts/controls.ts');
    const receipt = controlReceiptSchema.parse(
      await this.post(
        `/api/tasks/${taskId}/updates`,
        taskUpdateSchema.parse(update),
        key,
        signal,
      ),
    );
    if (receipt.task_id !== taskId)
      throw new AgentRunError(
        'The correction receipt belongs to another task.',
        false,
      );
    return receipt;
  }
  async controlTask(
    taskId: string,
    control: TaskControl,
    key: string,
    signal?: AbortSignal,
  ) {
    const { controlReceiptSchema, taskControlSchema } =
      await import('../../../../app/contracts/controls.ts');
    const receipt = controlReceiptSchema.parse(
      await this.post(
        `/api/tasks/${taskId}/control`,
        taskControlSchema.parse(control),
        key,
        signal,
      ),
    );
    if (receipt.task_id !== taskId)
      throw new AgentRunError(
        'The control receipt belongs to another task.',
        false,
      );
    return receipt;
  }
  async importSource(
    source: ArtifactImport,
    key: string,
    signal?: AbortSignal,
  ) {
    const { artifactSchema, artifactImportSchema } =
      await import('../../../../app/contracts/artifacts.ts');
    return artifactSchema.parse(
      await this.post(
        '/api/artifacts',
        artifactImportSchema.parse(source),
        key,
        signal,
      ),
    );
  }
  async readArtifact(artifactId: string, signal?: AbortSignal) {
    const { artifactSchema } =
      await import('../../../../app/contracts/artifacts.ts');
    const artifact = artifactSchema.parse(
      await this.read(
        `/api/artifacts/${encodeURIComponent(artifactId)}`,
        {},
        signal,
      ),
    );
    if (artifact.id !== artifactId)
      throw new AgentRunError(
        'The artifact response belongs to another artifact.',
        false,
      );
    return artifact;
  }
  async readWorldTask(taskId: string, signal?: AbortSignal) {
    const parsed = worldTaskResponseSchema.safeParse(
      await this.read(
        `/api/tasks/${encodeURIComponent(taskId)}/world`,
        {},
        signal,
      ),
    );
    if (!parsed.success || parsed.data.task_id !== taskId)
      throw new AgentRunError(
        'The current World Model status response failed validation.',
        false,
      );
    return parsed.data;
  }
  async readWorldRecord(
    recordId: string,
    view: 'detail' | 'history' | 'lineage',
    options: { limit?: number; cursor?: string } = {},
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({ view });
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    const parsed = worldRecordReadResponseSchema.safeParse(
      await this.read(
        `/api/world/records/${encodeURIComponent(recordId)}?${query}`,
        {},
        signal,
      ),
    );
    if (!parsed.success)
      throw new AgentRunError(
        'The World Model record response failed validation.',
        false,
      );
    if (parsed.data.view !== view)
      throw new AgentRunError(
        'The World Model record response did not match the requested view.',
        false,
      );
    return parsed.data;
  }
  async capabilities(signal?: AbortSignal) {
    const { capabilityCardSchema } =
      await import('../../../../app/contracts/capabilities.ts');
    const value = await this.read('/api/capabilities', {}, signal);
    return capabilityCardSchema.array().parse(value);
  }
}
