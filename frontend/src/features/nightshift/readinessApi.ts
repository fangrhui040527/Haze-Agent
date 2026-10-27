import {
  modelReadinessSchema,
  type ModelReadiness,
} from '../../../../app/contracts/model-routes.ts';

const MAX_BYTES = 64 * 1024;

/** Read-only inspection; this never submits an inference request or a job. */
export async function fetchModelReadiness(
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ModelReadiness> {
  signal.throwIfAborted();
  const response = await fetcher('/api/nightshift/readiness', {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    redirect: 'error',
  });
  if (
    !response.ok ||
    !response.headers.get('content-type')?.includes('application/json') ||
    !response.body
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(
      'Agent route readiness is unavailable. Retry when the local Haze server is running.',
    );
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES)
        throw new Error('Agent route readiness exceeded its response limit.');
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new Error('Agent route readiness returned invalid JSON.');
    }
    const parsed = modelReadinessSchema.safeParse(value);
    if (!parsed.success)
      throw new Error(
        'Agent route readiness returned an unsupported response.',
      );
    return parsed.data;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (signal.aborted) signal.throwIfAborted();
    throw error instanceof Error
      ? error
      : new Error('Agent route readiness is unavailable.');
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
