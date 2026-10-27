import { describe, expect, it, vi, type Mock } from 'vitest';
import { createHash } from 'node:crypto';
import {
  WEB_SEARCH_TOOL_ID,
  WebSearchUnavailableError,
  createWebSearchTools,
} from '../../app/capabilities/evidence-collection/web-search.js';
import type { ToolContext } from '../../app/orchestration/ports.js';
import type { FetchedBytes } from '../../app/adapters/haze-sources/http.js';
import type { TavilySearchRequest } from '../../app/adapters/haze-sources/tavily.js';

/** The host-injected transport the tool accepts for tests and replay. */
type SearchFn = (
  request: TavilySearchRequest,
  signal: AbortSignal,
) => Promise<FetchedBytes>;

const KEY = 'tavily-secret-key-value';

const context = (): ToolContext => ({
  taskId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  assignmentId: '33333333-3333-4333-8333-333333333333',
  assignmentRevision: 1,
  objectiveRevision: 1,
  generation: 1,
  identity: { principal: 'test-user', workspace: 'test-workspace' },
  deadline: new Date(Date.now() + 60_000).toISOString(),
  signal: AbortSignal.timeout(30_000),
  inputs: [],
  peers: [],
  outputs: [],
});

const bytes = (value: unknown): FetchedBytes => {
  const raw = Buffer.from(JSON.stringify(value), 'utf8');
  return {
    status: 200,
    raw,
    sha256: createHash('sha256').update(raw).digest('hex'),
    retrievedAt: '2026-10-27T12:00:00.000Z',
    attempts: [{ at: '2026-10-27T12:00:00.000Z', outcome: 'HTTP 200' }],
  };
};

const upstream = (count: number) => ({
  query: 'malaysia haze transboundary smoke october 2026',
  results: Array.from({ length: count }, (_, index) => ({
    title: `Result ${index + 1}`,
    url: `https://example.invalid/article-${index + 1}`,
    content: `Reported haze conditions, item ${index + 1}.`,
    published_date: '2026-10-20',
    score: 0.9 - index / 100,
  })),
});

const query = (over: Record<string, unknown> = {}) => ({
  schema_version: 'haze.websearch.query.v1',
  query: 'malaysia haze transboundary smoke october 2026',
  max_results: 3,
  ...over,
});

const tool = (
  mode: 'live' | 'fixture' | 'replay',
  search?: Mock<SearchFn>,
  env: NodeJS.ProcessEnv = { TAVILY_API_KEY: KEY },
) => {
  const tools = createWebSearchTools({
    mode,
    env,
    ...(search ? { search } : {}),
  });
  const found = tools.find((t) => t.id === WEB_SEARCH_TOOL_ID);
  if (!found) throw new Error('web search tool was not registered');
  return found;
};

describe('HazeOps web search evidence tool', () => {
  it('is specialist-only and declares its retained artifact kind', () => {
    const definition = tool('live');
    expect(definition.manager_read_only).toBeUndefined();
    expect(definition.output_artifact_kind).toBe('websearch.capture');
    expect(definition.version).toMatch(/^websearch\./u);
  });

  it('returns a synthetic capture in fixture mode without touching the network', async () => {
    const search = vi.fn<SearchFn>();
    const result = (await tool('fixture', search).execute(
      query(),
      context(),
    )) as Record<string, unknown>;
    expect(search).not.toHaveBeenCalled();
    expect(result.evidence_origin).toBe('synthetic_fixture');
    expect(result.mode).toBe('fixture');
    expect(Array.isArray(result.results)).toBe(true);
    expect((result.results as unknown[]).length).toBeGreaterThan(0);
    // A deterministic timestamp keeps the offline suite reproducible.
    expect(result.retrieved_at).toBe('2026-10-24T12:00:00.000Z');
  });

  it('fails closed before any transport when the provider key is missing', async () => {
    // The real misconfiguration: live mode, no host resolver, no key. The
    // failure must be the typed unavailable error raised before the HTTP client
    // is ever constructed, so a misconfigured run never spends a charged attempt.
    await expect(
      tool('live', undefined, {}).execute(query(), context()),
    ).rejects.toThrow(WebSearchUnavailableError);
  });

  it('uses a host-supplied resolver without requiring a key, since it is the transport', async () => {
    // Mirrors `resolveSource` in evidence-collection: trusted host injection for
    // tests and replay. The resolver replaces the HTTP client, so demanding a
    // provider credential alongside it would be meaningless.
    const search = vi.fn<SearchFn>().mockResolvedValue(bytes(upstream(1)));
    const result = (await tool('live', search, {}).execute(
      query({ max_results: 1 }),
      context(),
    )) as Record<string, unknown>;
    expect(search).toHaveBeenCalledTimes(1);
    expect(result.result_count).toBe(1);
  });

  it('refuses live search when SAMPLE_MODE forces offline operation', async () => {
    const search = vi.fn<SearchFn>();
    await expect(
      tool('live', search, {
        TAVILY_API_KEY: KEY,
        SAMPLE_MODE: 'true',
      }).execute(query(), context()),
    ).rejects.toThrow(WebSearchUnavailableError);
    expect(search).not.toHaveBeenCalled();
  });

  it('refuses replay without a host-supplied resolver', async () => {
    await expect(
      tool('replay', undefined, { TAVILY_API_KEY: KEY }).execute(
        query(),
        context(),
      ),
    ).rejects.toThrow(WebSearchUnavailableError);
  });

  it('maps provider results, pins the response hash and caps the count', async () => {
    const fetched = bytes(upstream(9));
    const search = vi.fn<SearchFn>().mockResolvedValue(fetched);
    const result = (await tool('live', search).execute(
      query({ max_results: 3 }),
      context(),
    )) as Record<string, unknown>;
    expect(search).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe('tavily');
    expect(result.evidence_origin).toBe('external_source');
    expect(result.response_sha256).toBe(fetched.sha256);
    expect(result.retrieved_at).toBe(fetched.retrievedAt);
    const results = result.results as { url: string; snippet: string }[];
    expect(results).toHaveLength(3);
    expect(results[0]?.url).toBe('https://example.invalid/article-1');
    expect(results[0]?.snippet).toContain('Reported haze conditions');
    expect(result.result_count).toBe(3);
  });

  it('never leaks the provider key into a thrown error', async () => {
    const search = vi
      .fn<SearchFn>()
      .mockRejectedValue(
        new Error(`upstream rejected token ${KEY} for https://api.tavily.com`),
      );
    const error: unknown = await tool('live', search)
      .execute(query(), context())
      .catch((failure: unknown) => failure);
    expect(String(error)).not.toContain(KEY);
    expect(String(error)).toContain('<redacted>');
  });

  it('preserves original bytes, provider usage and missing publication dates separately from observations', async () => {
    const fetched = bytes({
      results: [
        {
          title: 'Official source',
          url: 'https://example.invalid/undated',
          content: 'A retained discovery lead.',
          published_date: null,
        },
        {
          title: 'Updated source',
          url: 'https://example.invalid/updated',
          content: 'Another lead.',
          published_date: 'Tue, 27 Oct 2026 12:00:00 GMT',
        },
      ],
      request_id: 'provider-request-123',
      usage: { credits: 1 },
    });
    const search = vi.fn<SearchFn>().mockResolvedValue(fetched);
    const result = (await tool('live', search).execute(
      query({ topic: 'general', language: 'ms', start_date: '2026-01-01' }),
      context(),
    )) as Record<string, unknown>;
    expect(Buffer.from(result.raw_response_base64 as string, 'base64')).toEqual(
      fetched.raw,
    );
    expect(result.usage).toEqual({ credits: 1 });
    expect(result.provider_request_id).toBe('provider-request-123');
    expect((result.results as Record<string, unknown>[])[0]).not.toHaveProperty(
      'published_date',
    );
    expect((result.results as Record<string, unknown>[])[0]?.reference).toEqual(
      { response_sha256: fetched.sha256, result_index: 0 },
    );
    expect(result).not.toHaveProperty('observation_period');
    expect(search.mock.calls[0]?.[0]).toMatchObject({
      topic: 'general',
      language: 'ms',
      start_date: '2026-01-01',
    });
  });

  it('refuses an oversize provider response', async () => {
    const huge = Buffer.alloc(1024 * 1024 + 1, 0x20);
    const search = vi.fn<SearchFn>().mockResolvedValue({
      status: 200,
      raw: huge,
      sha256: createHash('sha256').update(huge).digest('hex'),
      retrievedAt: '2026-10-27T12:00:00.000Z',
      attempts: [],
    } satisfies FetchedBytes);
    await expect(
      tool('live', search).execute(query(), context()),
    ).rejects.toThrow(/too large|exceeds/iu);
  });

  it('refuses a malformed provider response', async () => {
    const search = vi
      .fn<SearchFn>()
      .mockResolvedValue(bytes({ unexpected: 'no results array' }));
    await expect(
      tool('live', search).execute(query(), context()),
    ).rejects.toThrow();
  });

  it('rejects executable result links and credentials in source URLs', async () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,test',
      'https://user:password@example.invalid/source',
    ]) {
      const search = vi.fn<SearchFn>().mockResolvedValue(
        bytes({
          results: [
            { url, title: 'Unsafe result', content: 'Untrusted text.' },
          ],
        }),
      );
      await expect(
        tool('live', search).execute(query(), context()),
      ).rejects.toThrow();
    }
  });

  it('rejects an unusable query or an out-of-range result count', () => {
    const definition = tool('live', vi.fn<SearchFn>());
    for (const bad of [
      query({ query: 'ab' }),
      query({ max_results: 0 }),
      query({ max_results: 50 }),
      query({ schema_version: 'haze.websearch.query.v2' }),
      { ...query(), unexpected_key: true },
    ])
      expect(() => definition.inputSchema.parse(bad)).toThrow();
  });
});
