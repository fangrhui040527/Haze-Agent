import { createHash } from 'node:crypto';
import type { ReadableStreamDefaultReader } from 'node:stream/web';

/**
 * Bounded retrieval (Spec §13.1): each logical source operation gets at most three
 * charged attempts including the first, each capped at 20 seconds and shortened by
 * the caller's remaining time. Only transient failures (network errors, 429, 502–504)
 * are retried; configuration and auth errors are not.
 */

export const SOURCE_TIMEOUT_MS = 20_000;
export const MAX_ATTEMPTS = 3;

export interface FetchAttempt {
  at: string;
  outcome: string;
}

export interface FetchedBytes {
  status: number;
  raw: Buffer;
  sha256: string;
  retrievedAt: string;
  attempts: FetchAttempt[];
}

export class SourceError extends Error {
  readonly attempts: FetchAttempt[];
  readonly retryable: boolean;
  constructor(message: string, attempts: FetchAttempt[], retryable: boolean) {
    super(message);
    this.name = 'SourceError';
    this.attempts = attempts;
    this.retryable = retryable;
  }
}

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export async function boundedFetch(
  url: string,
  options: {
    headers?: Record<string, string>;
    method?: 'GET' | 'POST';
    body?: string;
    signal: AbortSignal;
    /** Printed instead of the URL in errors (hides credentials in paths). */
    label: string;
    timeoutMs?: number;
    /** Optional decoded-byte bound enforced while reading the response stream. */
    maxBytes?: number;
  },
): Promise<FetchedBytes> {
  const attempts: FetchAttempt[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (options.signal.aborted) {
      throw new SourceError(`${options.label}: cancelled`, attempts, false);
    }
    const at = new Date().toISOString();
    const timeout = AbortSignal.timeout(options.timeoutMs ?? SOURCE_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        ...(options.body === undefined ? {} : { body: options.body }),
        signal: AbortSignal.any([options.signal, timeout]),
      });
      let raw: Buffer;
      if (options.maxBytes !== undefined) {
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body?.getReader() as
          ReadableStreamDefaultReader<Uint8Array> | undefined;
        if (reader) {
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.byteLength;
              if (size > options.maxBytes) {
                await reader.cancel();
                attempts.push({ at, outcome: 'response_too_large' });
                throw new SourceError(
                  `${options.label}: response exceeds ${options.maxBytes} bytes.`,
                  attempts,
                  false,
                );
              }
              chunks.push(chunk.value);
            }
          } finally {
            reader.releaseLock();
          }
        }
        raw = Buffer.concat(chunks, size);
      } else raw = Buffer.from(await response.arrayBuffer());
      if (response.ok) {
        attempts.push({ at, outcome: `HTTP ${response.status}` });
        return {
          status: response.status,
          raw,
          sha256: sha256(raw),
          retrievedAt: new Date().toISOString(),
          attempts,
        };
      }
      attempts.push({ at, outcome: `HTTP ${response.status}` });
      if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_ATTEMPTS) {
        throw new SourceError(
          `${options.label}: HTTP ${response.status} ${raw.toString('utf8').slice(0, 160)}`,
          attempts,
          RETRYABLE_STATUS.has(response.status),
        );
      }
    } catch (error) {
      if (error instanceof SourceError) throw error;
      const reason = timeout.aborted
        ? 'timed out'
        : error instanceof Error
          ? error.message
          : String(error);
      attempts.push({ at, outcome: reason });
      if (options.signal.aborted || attempt === MAX_ATTEMPTS) {
        throw new SourceError(`${options.label}: ${reason}`, attempts, true);
      }
    }
    // Backoff consumes the same budget as the attempts (1 s, then 2 s).
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
  throw new SourceError(`${options.label}: no attempt made`, attempts, false);
}
