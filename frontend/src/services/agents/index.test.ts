import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('configured agent service', () => {
  it.each([
    { preferred: undefined, legacy: undefined, version: 1 },
    { preferred: 'true', legacy: undefined, version: 2 },
    { preferred: 'false', legacy: undefined, version: 1 },
    { preferred: undefined, legacy: 'true', version: 2 },
    { preferred: undefined, legacy: 'false', version: 1 },
    { preferred: 'true', legacy: 'false', version: 2 },
    { preferred: 'false', legacy: 'true', version: 1 },
    { preferred: '', legacy: 'true', version: 1 },
  ])(
    'sends former crew prompts to task v$version (preferred=$preferred, legacy=$legacy)',
    async ({ preferred, legacy, version }) => {
      vi.stubEnv('VITE_API_BASE_URL', '');
      vi.stubEnv('VITE_HAZE_ORCHESTRATION', preferred);
      vi.stubEnv('VITE_HAZE_HYBRID', legacy);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { message: 'Explicit location and period required.' },
          }),
          { status: 422, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetcher);
      const { agentService } = await import('./index.ts');
      const question = 'Compare the fictional Klang crew sample schedules.';
      await expect(
        agentService.ask(
          { question, focusItemId: null, idempotencyKey: 'current-task' },
          vi.fn(),
          new AbortController().signal,
        ),
      ).rejects.toThrow('Explicit location and period required.');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]?.[0]).toBe('/api/tasks');
      expect(
        JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string),
      ).toMatchObject({
        schema_version: `haze.task.request.v${version}`,
        objective: question,
      });
    },
  );
});
