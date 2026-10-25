import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});
describe('one general agent service', () => {
  it.each(['true', 'false', undefined])(
    'uses v3 regardless of retired configuration (%s)',
    async (value) => {
      vi.stubEnv('VITE_HAZE_ORCHESTRATION', value);
      vi.stubEnv('VITE_HAZE_HYBRID', value);
      vi.stubEnv('VITE_API_BASE_URL', '');
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Denied.' } }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetcher);
      const { agentService } = await import('./index.ts');
      await expect(
        agentService.ask(
          { question: 'Explain this topic.', focusItemId: null },
          vi.fn(),
          new AbortController().signal,
        ),
      ).rejects.toThrow('Denied.');
      expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({
        schema_version: 'haze.task.request.v3',
        objective: 'Explain this topic.',
      });
    },
  );
});
