import {
  worldApiBrowseQuerySchema,
  worldApiErrorSchema,
  worldApiRecordParamsSchema,
  worldApiRecordReadQuerySchema,
  worldBrowseResponseSchema,
  worldProjectionRebuildRequestSchema,
  worldProjectionRebuildResponseSchema,
  worldRecordReadResponseSchema,
  type WorldApiBrowseQuery,
  type WorldBrowseResponse,
  type WorldProjectionRebuildResponse,
  type WorldRecordReadResponse,
} from '../../../../app/contracts/world-api.ts';
import { abortError } from '../../shared/lib/delay.ts';

export type {
  WorldBrowseResponse,
  WorldProjectionRebuildResponse,
  WorldRecordReadResponse,
};
export type WorldBrowseFilters = Partial<WorldApiBrowseQuery>;
export type WorldRecordView = WorldRecordReadResponse['view'];
export interface WorldPageOptions {
  limit?: number;
  cursor?: string;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class WorldModelApiError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = 'WorldModelApiError';
    this.status = status;
    this.code = code;
  }
}

/** Reject promptly even when a transport does not implement AbortSignal. */
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
              : new Error('World Model request failed.'),
        );
      },
    );
  });
}

async function boundedText(response: Response, signal: AbortSignal) {
  const length = response.headers.get('content-length');
  if (length && /^\d+$/u.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new WorldModelApiError(
      'The World Model response exceeds the browser response bound.',
      response.status,
    );
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  let completed = false;
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) {
        completed = true;
        return text + decoder.decode();
      }
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw new WorldModelApiError(
          'The World Model response exceeds the browser response bound.',
          response.status,
        );
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    if (!completed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function request(
  path: string,
  init: RequestInit = {},
  suppliedSignal?: AbortSignal,
): Promise<unknown> {
  const signal = suppliedSignal ?? AbortSignal.timeout(15_000);
  if (signal.aborted) throw abortError();
  try {
    const response = await abortable(
      fetch(path, {
        ...init,
        signal,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', ...init.headers },
      }),
      signal,
    );
    if (!response.headers.get('content-type')?.includes('application/json')) {
      void response.body?.cancel().catch(() => {});
      throw new WorldModelApiError(
        'The World Model API is unavailable on this host. Start the configured Haze backend and retry.',
        response.status,
      );
    }
    const raw = await boundedText(response, signal);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new WorldModelApiError(
        'The World Model API returned invalid JSON.',
        response.status,
      );
    }
    if (!response.ok) {
      const parsed = worldApiErrorSchema.safeParse(value);
      throw new WorldModelApiError(
        parsed.success
          ? parsed.data.error.message.replace(/\p{Cc}/gu, ' ')
          : `World Model request failed (${response.status}).`,
        response.status,
        parsed.success ? parsed.data.error.code : undefined,
      );
    }
    return value;
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (error instanceof WorldModelApiError) throw error;
    throw new WorldModelApiError(
      'The World Model API could not be reached. Check the backend and retry.',
    );
  }
}

export async function browseWorldRecords(
  filters: WorldBrowseFilters = {},
  signal?: AbortSignal,
): Promise<WorldBrowseResponse> {
  const query = worldApiBrowseQuerySchema.safeParse(filters);
  if (!query.success)
    throw new WorldModelApiError('The World Model browse filters are invalid.');
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query.data))
    if (value !== undefined) params.set(key, String(value));
  const parsed = worldBrowseResponseSchema.safeParse(
    await request(`/api/world/records?${params}`, {}, signal),
  );
  if (!parsed.success)
    throw new WorldModelApiError(
      'The World Model browse response failed contract validation. Refresh after updating the backend.',
    );
  return parsed.data;
}

export async function readWorldRecord(
  recordId: string,
  view: WorldRecordView = 'detail',
  page: WorldPageOptions = {},
  signal?: AbortSignal,
): Promise<WorldRecordReadResponse> {
  const identity = worldApiRecordParamsSchema.safeParse({
    record_id: recordId,
  });
  const query = worldApiRecordReadQuerySchema.safeParse({ ...page, view });
  if (!identity.success || !query.success)
    throw new WorldModelApiError('The World Model record request is invalid.');
  const params = new URLSearchParams({ view: query.data.view });
  params.set('limit', String(query.data.limit));
  if (query.data.cursor !== undefined) params.set('cursor', query.data.cursor);
  const parsed = worldRecordReadResponseSchema.safeParse(
    await request(
      `/api/world/records/${encodeURIComponent(recordId)}?${params}`,
      {},
      signal,
    ),
  );
  if (!parsed.success)
    throw new WorldModelApiError(
      'The World Model record response failed contract validation.',
    );
  const result = parsed.data;
  const returnedId =
    result.view === 'detail'
      ? result.detail.record.ref.id
      : result.view === 'history'
        ? result.history.record.id
        : result.lineage.record.id;
  if (
    result.view !== view ||
    returnedId !== recordId ||
    (result.view === 'detail' && result.detail.status.record_id !== recordId)
  )
    throw new WorldModelApiError(
      'The World Model record response did not match the requested record and view.',
    );
  return result;
}

export async function rebuildWorldProjections(
  operationKey: string,
  signal?: AbortSignal,
): Promise<WorldProjectionRebuildResponse> {
  if (!/^[\x21-\x7e]{1,200}$/u.test(operationKey))
    throw new WorldModelApiError(
      'The projection rebuild operation key is invalid.',
    );
  const parsed = worldProjectionRebuildResponseSchema.safeParse(
    await request(
      '/api/world/projections/rebuild',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': operationKey,
        },
        body: JSON.stringify(worldProjectionRebuildRequestSchema.parse({})),
      },
      signal,
    ),
  );
  if (!parsed.success)
    throw new WorldModelApiError(
      'The World Model projection rebuild response failed contract validation.',
    );
  return parsed.data;
}
