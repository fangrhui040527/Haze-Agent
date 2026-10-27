import { boundedFetch, type FetchedBytes } from './http.js';

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
      include_answer: false,
      include_raw_content: false,
      ...(request.recency_days === undefined
        ? {}
        : { days: request.recency_days }),
      ...(request.include_domains === undefined
        ? {}
        : { include_domains: [...request.include_domains] }),
    }),
  });
}
