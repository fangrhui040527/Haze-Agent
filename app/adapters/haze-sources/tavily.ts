import { boundedFetch, type FetchedBytes } from './http.js';
import { WEB_SEARCH_RESPONSE_BYTES } from '../../contracts/web-search.js';

/**
 * Tavily search retrieval. The credential travels in the Authorization header,
 * never in the URL or the request body, so it cannot reach the error label or
 * any retained artifact. `label` is printed instead of the URL by boundedFetch.
 */

export const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

export interface TavilySearchRequest {
  query: string;
  max_results: number;
  recency_days?: number;
  include_domains?: readonly string[];
  topic?: 'general' | 'news';
  start_date?: string;
  end_date?: string;
  time_range?: 'day' | 'week' | 'month' | 'year';
  filter_by_published_date?: boolean;
  language?: 'en' | 'ms';
}

export function fetchTavilySearch(
  apiKey: string,
  request: TavilySearchRequest,
  signal: AbortSignal,
): Promise<FetchedBytes> {
  if (!apiKey) throw new Error('A Tavily API key is required.');
  return boundedFetch(TAVILY_SEARCH_URL, {
    method: 'POST',
    signal,
    label: 'Tavily search',
    maxBytes: WEB_SEARCH_RESPONSE_BYTES,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      query: request.query,
      max_results: request.max_results,
      // Snippets only: this tool deliberately does not pull page bodies.
      search_depth: 'basic',
      topic: request.topic ?? 'general',
      include_published_date: true,
      filter_by_published_date: request.filter_by_published_date ?? false,
      include_usage: true,
      include_answer: false,
      include_raw_content: false,
      ...(request.recency_days === undefined
        ? {}
        : {
            start_date: new Date(Date.now() - request.recency_days * 86_400_000)
              .toISOString()
              .slice(0, 10),
          }),
      ...(request.start_date ? { start_date: request.start_date } : {}),
      ...(request.end_date ? { end_date: request.end_date } : {}),
      ...(request.time_range ? { time_range: request.time_range } : {}),
      ...(request.language ? { language: request.language } : {}),
      ...(request.include_domains === undefined
        ? {}
        : { include_domains: [...request.include_domains] }),
    }),
  });
}
