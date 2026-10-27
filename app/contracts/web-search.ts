import { z } from 'zod';
import { executionModeSchema } from './tasks.js';

/**
 * Browser-safe contracts for retained web-search evidence.
 *
 * A search result is a third-party DOCUMENT, not a measurement. It carries no
 * units, resolution or station identity, so none of the coverage checks that
 * apply to the station and model sources apply here. What it does carry is the
 * exact provider response hash and retrieval time, so a later reader can see
 * precisely which bytes a claim was built on.
 */

/** Upper bound on results a single query may retain. */
export const WEB_SEARCH_MAX_RESULTS = 10;
/** Decoded provider response bound, matching the 1 MiB artifact import limit. */
export const WEB_SEARCH_RESPONSE_BYTES = 1_048_576;

export const webSearchQuerySchema = z.strictObject({
  schema_version: z.literal('haze.websearch.query.v1'),
  query: z.string().trim().min(3).max(400),
  max_results: z.number().int().min(1).max(WEB_SEARCH_MAX_RESULTS).default(5),
  /** Restrict to recently published pages; omitted means the provider default. */
  recency_days: z.number().int().min(1).max(365).optional(),
  /** Optional allow-list of hostnames the provider should confine itself to. */
  include_domains: z
    .array(
      z
        .string()
        .trim()
        .min(3)
        .max(253)
        .regex(/^[a-z0-9.-]+$/iu, 'Use a bare hostname without a scheme.'),
    )
    .max(16)
    .optional(),
});
export type WebSearchQuery = z.infer<typeof webSearchQuerySchema>;

export const webSearchResultSchema = z.strictObject({
  title: z.string().trim().min(1).max(400),
  url: z.string().url().max(2048),
  snippet: z.string().trim().min(1).max(4000),
  published_date: z.string().trim().min(4).max(40).optional(),
  /** Provider relevance score; opaque and not comparable across providers. */
  score: z.number().optional(),
});
export type WebSearchResult = z.infer<typeof webSearchResultSchema>;

export const webSearchCaptureSchema = z.strictObject({
  schema_version: z.literal('haze.websearch.capture.v1'),
  mode: executionModeSchema,
  /** Synthetic fixture origin is never presented as a live retrieval. */
  evidence_origin: z.enum(['synthetic_fixture', 'external_source']),
  provider: z.literal('tavily'),
  query: z.string().trim().min(1).max(400),
  retrieved_at: z.string().trim().min(20).max(40),
  /** SHA-256 over the exact provider response bytes. */
  response_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  result_count: z.number().int().min(0).max(WEB_SEARCH_MAX_RESULTS),
  results: z.array(webSearchResultSchema).max(WEB_SEARCH_MAX_RESULTS),
});
export type WebSearchCapture = z.infer<typeof webSearchCaptureSchema>;
