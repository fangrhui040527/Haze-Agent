import { z } from 'zod';
import type { ToolPreview } from '../../contracts/tool-preview.js';
import {
  WEB_SEARCH_MAX_RESULTS,
  WEB_SEARCH_RESPONSE_BYTES,
  webSearchCaptureSchema,
  webSearchQuerySchema,
  type WebSearchQuery,
  type WebSearchResult,
} from '../../contracts/web-search.js';
import type { FetchedBytes } from '../../adapters/haze-sources/http.js';
import {
  fetchTavilySearch,
  type TavilySearchRequest,
} from '../../adapters/haze-sources/tavily.js';
import type {
  ExecutionMode,
  ToolDefinition,
} from '../../orchestration/ports.js';

/**
 * HazeOps web-search evidence tool.
 *
 * Deliberately NOT a SourceAdapter: that interface emits stations and facts
 * through unit, value and resolution checks, which are measurement semantics. A
 * search hit is a document, so it is retained as its own artifact kind with the
 * provider response hash and retrieval time pinned, and nothing else asserted.
 *
 * Retained results stay unreviewed. `evidence-collection` is intentionally
 * absent from the research acceptance policy's allowed capabilities, so web
 * content can never be auto-accepted into either World Model.
 */

export const WEB_SEARCH_TOOL_ID = 'haze-web-search';
export const WEB_SEARCH_ARTIFACT_KIND = 'websearch.capture';

export class WebSearchUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebSearchUnavailableError';
  }
}

export interface WebSearchToolOptions {
  mode?: ExecutionMode;
  env?: NodeJS.ProcessEnv;
  /** Trusted host injection for tests/replay; never supplied by the task request. */
  search?: (
    request: TavilySearchRequest,
    signal: AbortSignal,
  ) => Promise<FetchedBytes>;
}

/** Tavily returns more fields than are retained; only these are read. */
const upstreamSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string().optional(),
        url: z.string(),
        content: z.string().optional(),
        published_date: z.string().nullable().optional(),
        score: z.number().optional(),
      }),
    )
    .max(200),
  request_id: z.string().max(200).nullable().optional(),
  usage: z.object({ credits: z.number().nonnegative() }).nullable().optional(),
});

const FIXTURE_RETRIEVED_AT = '2026-10-24T12:00:00.000Z';
/** Deterministic, visibly synthetic results; no network in fixture mode. */
const FIXTURE_RESULTS: WebSearchResult[] = [
  {
    title: 'Synthetic fixture: regional haze advisory',
    url: 'https://fixture.invalid/haze-advisory',
    snippet:
      'Synthetic fixture text standing in for a regional haze advisory. Not a real source and carries no findings.',
    published_date: '2026-10-23',
  },
  {
    title: 'Synthetic fixture: transboundary smoke summary',
    url: 'https://fixture.invalid/transboundary-smoke',
    snippet:
      'Synthetic fixture text standing in for a transboundary smoke summary. Not a real source and carries no findings.',
    published_date: '2026-10-22',
  },
];

/**
 * Keep a credential out of the message a caller or artifact could see.
 *
 * This is defence in depth, not the primary protection. The key travels in the
 * Authorization header, never the URL or body, and boundedFetch prints its
 * `label` instead of the URL for exactly this reason -- so a transport error
 * cannot carry the credential, and the caught error is safe to attach as `cause`.
 */
function redact(value: unknown, secret: string | undefined): string {
  const text = value instanceof Error ? value.message : String(value);
  return secret ? text.split(secret).join('<redacted>') : text;
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function searchPreview(
  results: WebSearchResult[],
  responseHash: string,
): ToolPreview {
  const preview: ToolPreview = {
    schema_version: 'haze.tool.preview.v1',
    notice:
      'Untrusted discovery excerpts. Publication/update dates are not dataset observation periods. Save the exact tool result before selecting a passage; original numerical inputs require acquisition.',
    items: [],
  };
  for (const [index, item] of results.slice(0, 5).entries()) {
    const entry = {
      title: truncate(item.title, 200),
      url: item.url,
      excerpt: truncate(item.snippet, 500),
      published_date: item.published_date ?? null,
      reference: `sha256:${responseHash}:results[${index}]`,
      result_index: index,
    };
    if (
      Buffer.byteLength(
        JSON.stringify({ ...preview, items: [...preview.items, entry] }),
        'utf8',
      ) > 9000
    )
      break;
    preview.items.push(entry);
  }
  return preview;
}

export function createWebSearchTools(
  options: WebSearchToolOptions = {},
): ToolDefinition[] {
  const mode = options.mode ?? 'live';
  return [
    {
      id: WEB_SEARCH_TOOL_ID,
      version: 'websearch.v1',
      description:
        'Search the public web for up to 10 documents matching one bounded query. Retains titles, URLs, snippets and the exact provider response hash as unreviewed evidence; never page bodies, and never accepted into the World Model.',
      mode,
      // No manager_read_only grant: this is specialist-only by design.
      inputSchema: webSearchQuerySchema,
      outputSchema: webSearchCaptureSchema,
      output_artifact_kind: WEB_SEARCH_ARTIFACT_KIND,
      max_calls_per_assignment: 1,
      async execute(input, context) {
        const request: WebSearchQuery = webSearchQuerySchema.parse(input);
        context.signal.throwIfAborted();

        if (mode === 'fixture')
          return webSearchCaptureSchema.parse({
            schema_version: 'haze.websearch.capture.v1',
            mode,
            evidence_origin: 'synthetic_fixture',
            provider: 'tavily',
            query: request.query,
            retrieved_at: FIXTURE_RETRIEVED_AT,
            // A stable placeholder hash: no provider bytes were retrieved.
            response_sha256: 'f'.repeat(64),
            result_count: Math.min(FIXTURE_RESULTS.length, request.max_results),
            results: FIXTURE_RESULTS.slice(0, request.max_results),
            request,
            model_preview: searchPreview(
              FIXTURE_RESULTS.slice(0, request.max_results),
              'f'.repeat(64),
            ),
          });

        if (options.env?.SAMPLE_MODE === 'true')
          throw new WebSearchUnavailableError(
            'SAMPLE_MODE=true disables live web search.',
          );
        if (mode === 'replay' && !options.search)
          throw new WebSearchUnavailableError(
            'Replay web search needs an explicit host-supplied resolver; no live request was made.',
          );

        const apiKey = options.env?.TAVILY_API_KEY?.trim();
        // Checked before any request so a misconfigured run never spends an attempt.
        if (!options.search && !apiKey)
          throw new WebSearchUnavailableError(
            'TAVILY_API_KEY is required for live web search.',
          );

        const upstreamRequest: TavilySearchRequest = {
          query: request.query,
          max_results: request.max_results,
          ...(request.recency_days === undefined
            ? {}
            : { recency_days: request.recency_days }),
          ...(request.include_domains === undefined
            ? {}
            : { include_domains: request.include_domains }),
          ...(request.topic ? { topic: request.topic } : {}),
          ...(request.start_date ? { start_date: request.start_date } : {}),
          ...(request.end_date ? { end_date: request.end_date } : {}),
          ...(request.time_range ? { time_range: request.time_range } : {}),
          ...(request.language ? { language: request.language } : {}),
          ...(request.filter_by_published_date === undefined
            ? {}
            : { filter_by_published_date: request.filter_by_published_date }),
        };

        let fetched: FetchedBytes;
        try {
          fetched = options.search
            ? await options.search(upstreamRequest, context.signal)
            : await fetchTavilySearch(apiKey!, upstreamRequest, context.signal);
        } catch (error) {
          throw new Error(`Web search failed: ${redact(error, apiKey)}`, {
            cause: error,
          });
        }

        if (fetched.raw.length > WEB_SEARCH_RESPONSE_BYTES)
          throw new Error(
            `Web search response is too large: ${fetched.raw.length} bytes exceeds the ${WEB_SEARCH_RESPONSE_BYTES} byte bound.`,
          );

        let parsed: z.infer<typeof upstreamSchema>;
        try {
          parsed = upstreamSchema.parse(
            JSON.parse(fetched.raw.toString('utf8')),
          );
        } catch (error) {
          throw new Error(
            `Web search returned an unusable response: ${redact(error, apiKey)}`,
            { cause: error },
          );
        }

        const results: WebSearchResult[] = parsed.results
          .slice(0, Math.min(request.max_results, WEB_SEARCH_MAX_RESULTS))
          .map((item, result_index) => ({
            title: truncate(item.title?.trim() || item.url, 400),
            url: item.url,
            snippet: truncate(
              item.content?.trim() ||
                'No snippet was supplied for this result.',
              4000,
            ),
            ...(item.published_date == null || !item.published_date.trim()
              ? {}
              : { published_date: truncate(item.published_date, 40) }),
            ...(item.score === undefined ? {} : { score: item.score }),
            reference: { response_sha256: fetched.sha256, result_index },
          }));

        return webSearchCaptureSchema.parse({
          schema_version: 'haze.websearch.capture.v1',
          mode,
          evidence_origin: 'external_source',
          provider: 'tavily',
          query: request.query,
          retrieved_at: fetched.retrievedAt,
          response_sha256: fetched.sha256,
          result_count: results.length,
          results,
          model_preview: searchPreview(results, fetched.sha256),
          raw_response_base64: fetched.raw.toString('base64'),
          request,
          attempts: fetched.attempts.map(({ at, outcome }) => ({
            at,
            outcome: truncate(outcome, 200),
          })),
          ...(parsed.request_id
            ? { provider_request_id: parsed.request_id }
            : {}),
          ...(parsed.usage ? { usage: parsed.usage } : {}),
        });
      },
    },
  ];
}
