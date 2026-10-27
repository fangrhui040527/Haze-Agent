import type { z } from 'zod';
import {
  reductionProgrammeCreateSchema,
  reductionProgrammeHistorySchema,
  reductionProgrammeListSchema,
  reductionProgrammeMutationReceiptSchema,
  reductionProgrammePhaseRequestSchema,
  reductionProgrammeRecordRequestSchema,
  reductionProgrammeRevisionRequestSchema,
  reductionProgrammeViewSchema,
  type ReductionProgrammeMutationReceipt,
} from '../../../../app/contracts/damage-reduction-programme.ts';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const apiPath = '/api/reduction-programmes';

/** An unchanged manual retry preserves the original operation identity. */
export class ProgrammeMutationIntent {
  private prepared: { identity: string; key: string } | null = null;
  key(
    operation: string,
    body: unknown,
    create: () => string = () => crypto.randomUUID(),
  ): string {
    const identity = JSON.stringify([operation, body]);
    if (this.prepared?.identity !== identity)
      this.prepared = { identity, key: create() };
    return this.prepared.key;
  }
  clear() {
    this.prepared = null;
  }
}

export class ReductionProgrammeClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  constructor(
    fetcher: typeof fetch = (input, init) => fetch(input, init),
    baseUrl = typeof import.meta.env.VITE_API_BASE_URL === 'string'
      ? import.meta.env.VITE_API_BASE_URL
      : '',
  ) {
    this.fetcher = fetcher;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async read<T>(
    path: string,
    schema: z.ZodType<T>,
    signal = AbortSignal.timeout(15_000),
    mutation?: { body: unknown; key: string },
  ): Promise<T> {
    signal.throwIfAborted();
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method: mutation ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal,
      ...(mutation
        ? {
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': mutation.key,
            },
            body: JSON.stringify(mutation.body),
          }
        : {}),
    });
    if (
      !response.body ||
      !response.headers.get('content-type')?.includes('application/json')
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error('The programme API is unavailable on this host.');
    }
    const reader = response.body.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES)
          throw new Error(
            'The programme response exceeds the browser size limit. Request a smaller history page.',
          );
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
        value = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        );
      } catch {
        throw new Error('The programme API returned invalid JSON.');
      }
      if (!response.ok) {
        const problem = value as { error?: { message?: unknown } } | null;
        throw new Error(
          typeof problem?.error?.message === 'string'
            ? problem.error.message.slice(0, 4096)
            : `Programme request failed (${response.status}).`,
        );
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success)
        throw new Error(
          'The programme API returned an unsupported response. Update the application and backend together.',
        );
      return parsed.data;
    } finally {
      cancel();
      signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  }

  list(offset = 0, signal?: AbortSignal) {
    this.offset(offset);
    return this.read(
      `${apiPath}?offset=${offset}&limit=10`,
      reductionProgrammeListSchema,
      signal,
    );
  }
  async programme(id: string, signal?: AbortSignal) {
    const view = await this.read(
      `${apiPath}/${encodeURIComponent(id)}`,
      reductionProgrammeViewSchema,
      signal,
    );
    if (view.programme.id !== id)
      throw new Error('The response belongs to another programme.');
    return view;
  }
  async history(id: string, offset = 0, signal?: AbortSignal) {
    this.offset(offset);
    const result = await this.read(
      `${apiPath}/${encodeURIComponent(id)}/history?offset=${offset}&limit=5`,
      reductionProgrammeHistorySchema,
      signal,
    );
    if (
      result.revisions.some(
        (entry) => entry.programme_id !== id || entry.snapshot.id !== id,
      ) ||
      result.attempts.some((entry) => entry.programme_id !== id) ||
      result.records.some((entry) => entry.programme_id !== id)
    )
      throw new Error('The history response belongs to another programme.');
    return result;
  }
  async create(value: unknown, key: string, signal?: AbortSignal) {
    const receipt = await this.read(
      apiPath,
      reductionProgrammeMutationReceiptSchema,
      signal,
      { body: reductionProgrammeCreateSchema.parse(value), key },
    );
    if (receipt.operation !== 'create' || receipt.attempt !== null)
      throw new Error(
        'The programme creation receipt does not match this action.',
      );
    return receipt;
  }
  revise(id: string, value: unknown, key: string, signal?: AbortSignal) {
    return this.mutate(
      id,
      'revisions',
      'revise',
      reductionProgrammeRevisionRequestSchema.parse(value),
      key,
      signal,
    );
  }
  startPhase(id: string, value: unknown, key: string, signal?: AbortSignal) {
    return this.mutate(
      id,
      'phases',
      'phase',
      reductionProgrammePhaseRequestSchema.parse(value),
      key,
      signal,
    );
  }
  record(id: string, value: unknown, key: string, signal?: AbortSignal) {
    return this.mutate(
      id,
      'records',
      'record',
      reductionProgrammeRecordRequestSchema.parse(value),
      key,
      signal,
    );
  }
  private async mutate(
    id: string,
    route: string,
    operation: ReductionProgrammeMutationReceipt['operation'],
    body: unknown,
    key: string,
    signal?: AbortSignal,
  ) {
    const receipt = await this.read(
      `${apiPath}/${encodeURIComponent(id)}/${route}`,
      reductionProgrammeMutationReceiptSchema,
      signal,
      { body, key },
    );
    if (receipt.programme_id !== id || receipt.operation !== operation)
      throw new Error(
        'The programme operation receipt does not match this action.',
      );
    return receipt;
  }
  private offset(value: number) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('Use a nonnegative bounded page offset.');
  }
}

export const reductionProgrammeClient = new ReductionProgrammeClient();
