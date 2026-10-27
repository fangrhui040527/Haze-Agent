import { z } from 'zod';
import { taskRecordSchema } from '../../../../app/contracts/tasks.ts';
import {
  jobsReadinessSchema,
  chainAdmissionSchema,
  chainControlSchema,
  jobSubmitSchema,
  jobCancelSchema,
  jobReconcileSchema,
  jobSelectSchema,
  chainProgressProposalSchema,
  type NightshiftJobReadiness,
} from '../../../../app/contracts/nightshift.ts';
import {
  nightshiftChainSchema,
  nightshiftJobSchema,
  nightshiftEventPageSchema,
} from '../../../../app/contracts/nightshift-records.ts';
import { nightshiftJobSummarySchema } from '../../../../app/contracts/nightshift-list.ts';
import { externalWaitViewSchema } from '../../../../app/contracts/external-waits.ts';
import { automaticReadinessSchema } from '../../../../app/contracts/nightshift-automatic.ts';
import {
  chainAutomationViewSchema,
  nightshiftProgressRecordSchema,
} from '../../../../app/contracts/nightshift-chains.ts';

const chainListSchema = z.strictObject({
  version: z.literal(1),
  chains: z.array(nightshiftChainSchema).max(100),
});
const jobListSchema = z.strictObject({
  version: z.literal(1),
  jobs: z.array(nightshiftJobSummarySchema).max(100),
});
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Linking accepted work needs proof and reachability, independently of new generation. */
export function canReconcileNightshiftJob(
  readiness: NightshiftJobReadiness | null,
): boolean {
  return Boolean(readiness?.can_reconcile && readiness.runtime_reachable);
}

/** Every retry of an unchanged mutation keeps its identity; no retry is automatic. */
export class MutationIntent {
  private prepared:
    { identity: string; body: unknown; key: string } | undefined;
  async prepare(
    identity: string,
    build: () => unknown,
    create: () => string = () => crypto.randomUUID(),
  ) {
    if (this.prepared?.identity !== identity)
      this.prepared = { identity, body: await build(), key: create() };
    return this.prepared;
  }
  clear() {
    this.prepared = undefined;
  }
}

export class NightshiftClient {
  private readonly fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    this.fetcher = fetcher;
  }

  private async read<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    mutation?: { body: unknown; key: string },
  ): Promise<T> {
    signal.throwIfAborted();
    const response = await this.fetcher(path, {
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
      throw new Error('The Nightshift API is unavailable on this host.');
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
        const part = await reader.read();
        signal.throwIfAborted();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_RESPONSE_BYTES)
          throw new Error(
            'The Nightshift response exceeded its browser size limit.',
          );
        chunks.push(part.value);
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
        throw new Error('The Nightshift API returned invalid JSON.');
      }
      if (!response.ok) {
        const error = z
          .object({ error: z.object({ message: z.string().max(4096) }) })
          .safeParse(value);
        throw new Error(
          error.success
            ? error.data.error.message
            : `Nightshift request failed (${response.status}).`,
        );
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success)
        throw new Error('The Nightshift API returned an unsupported response.');
      return parsed.data;
    } finally {
      cancel();
      signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  }
  readiness(signal: AbortSignal) {
    return this.read(
      '/api/nightshift/jobs/readiness',
      jobsReadinessSchema,
      signal,
    );
  }
  chains(signal: AbortSignal) {
    return this.read('/api/nightshift/chains', chainListSchema, signal);
  }
  automationReadiness(signal: AbortSignal) {
    return this.read(
      '/api/nightshift/automation/readiness',
      automaticReadinessSchema,
      signal,
    );
  }
  chainAutomation(id: string, signal: AbortSignal) {
    return this.read(
      `/api/nightshift/chains/${encodeURIComponent(id)}/automation`,
      chainAutomationViewSchema,
      signal,
    );
  }
  proposeProgress(
    id: string,
    value: unknown,
    key: string,
    signal: AbortSignal,
  ) {
    return this.read(
      `/api/nightshift/chains/${encodeURIComponent(id)}/progress`,
      nightshiftProgressRecordSchema,
      signal,
      { body: chainProgressProposalSchema.parse(value), key },
    );
  }
  jobs(signal: AbortSignal) {
    return this.read('/api/nightshift/jobs', jobListSchema, signal);
  }
  chain(id: string, signal: AbortSignal) {
    return this.read(
      `/api/nightshift/chains/${encodeURIComponent(id)}`,
      nightshiftChainSchema,
      signal,
    );
  }
  job(id: string, signal: AbortSignal) {
    return this.read(
      `/api/nightshift/jobs/${encodeURIComponent(id)}`,
      nightshiftJobSchema,
      signal,
    );
  }
  task(id: string, signal: AbortSignal) {
    return this.read(
      `/api/tasks/${encodeURIComponent(id)}`,
      taskRecordSchema,
      signal,
    );
  }
  externalWaits(taskId: string, signal: AbortSignal) {
    return this.read(
      `/api/nightshift/tasks/${encodeURIComponent(taskId)}/waits`,
      externalWaitViewSchema,
      signal,
    );
  }
  events(id: string, after: number, signal: AbortSignal) {
    return this.read(
      `/api/nightshift/jobs/${encodeURIComponent(id)}/events?after=${after}`,
      nightshiftEventPageSchema,
      signal,
    );
  }
  admitChain(value: unknown, key: string, signal: AbortSignal) {
    return this.read('/api/nightshift/chains', nightshiftChainSchema, signal, {
      body: chainAdmissionSchema.parse(value),
      key,
    });
  }
  controlChain(id: string, value: unknown, key: string, signal: AbortSignal) {
    return this.read(
      `/api/nightshift/chains/${encodeURIComponent(id)}/control`,
      nightshiftChainSchema,
      signal,
      { body: chainControlSchema.parse(value), key },
    );
  }
  submitJob(value: unknown, key: string, signal: AbortSignal) {
    return this.read('/api/nightshift/jobs', nightshiftJobSchema, signal, {
      body: jobSubmitSchema.parse(value),
      key,
    });
  }
  cancelJob(id: string, value: unknown, key: string, signal: AbortSignal) {
    return this.read(
      `/api/nightshift/jobs/${encodeURIComponent(id)}/cancel`,
      nightshiftJobSchema,
      signal,
      { body: jobCancelSchema.parse(value), key },
    );
  }
  reconcileJob(id: string, value: unknown, key: string, signal: AbortSignal) {
    return this.read(
      `/api/nightshift/jobs/${encodeURIComponent(id)}/reconcile`,
      nightshiftJobSchema,
      signal,
      { body: jobReconcileSchema.parse(value), key },
    );
  }
  selectResult(id: string, value: unknown, key: string, signal: AbortSignal) {
    return this.read(
      `/api/nightshift/jobs/${encodeURIComponent(id)}/select`,
      nightshiftJobSchema,
      signal,
      { body: jobSelectSchema.parse(value), key },
    );
  }
}
