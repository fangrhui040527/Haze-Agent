import { expect, it } from 'vitest';
import { NightshiftClient } from './jobsApi.ts';

const runtimeEnv = (
  globalThis as { process?: { env?: Record<string, string | undefined> } }
).process?.env;
const origin = runtimeEnv?.HAZE_NIGHTSHIFT_UI_URL;
const jobId = runtimeEnv?.HAZE_NIGHTSHIFT_UI_JOB;
it.skipIf(!origin || !jobId)(
  'reads a real local server inbox and deep-linked job without mutations',
  async () => {
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin!).hostname)
    )
      throw new Error(
        'Readback verification requires an explicitly configured local server.',
      );
    const client = new NightshiftClient((input, init) => {
      const path =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return fetch(new URL(path, origin), init);
    });
    const signal = AbortSignal.timeout(30000);
    const results = await Promise.allSettled([
      client.chains(signal),
      client.jobs(signal),
      client.readiness(signal),
      client.job(jobId!, signal),
      client.events(jobId!, 0, signal),
    ]);
    results.forEach((result, index) => {
      if (result.status === 'rejected')
        throw new Error(
          `Readback ${index} failed: ${result.reason instanceof Error ? result.reason.message : 'unknown'}`,
        );
      expect(result.value).toBeDefined();
    });
  },
  35000,
);
