import { z } from 'zod';
import { executionModeSchema } from './tasks.js';
import { toolPreviewSchema } from './tool-preview.js';

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
/** Leaves room for base64 original bytes and metadata inside a 1 MiB artifact. */
export const WEB_SEARCH_RESPONSE_BYTES = 524_288;

const date = z.iso.date();

export const webSearchQuerySchema = z
  .strictObject({
    schema_version: z.literal('haze.websearch.query.v1'),
    query: z.string().trim().min(3).max(400),
    max_results: z.number().int().min(1).max(WEB_SEARCH_MAX_RESULTS).default(5),
    /** Restrict to recently published pages; omitted means the provider default. */
    recency_days: z.number().int().min(1).max(365).optional(),
    topic: z.enum(['general', 'news']).optional(),
    start_date: date.optional(),
    end_date: date.optional(),
    time_range: z.enum(['day', 'week', 'month', 'year']).optional(),
    /** Publication/update dates are document metadata, never observation periods. */
    filter_by_published_date: z.boolean().optional(),
    language: z.enum(['en', 'ms']).optional(),
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
  })
  .superRefine((value, context) => {
    if (value.start_date && value.end_date && value.start_date > value.end_date)
      context.addIssue({
        code: 'custom',
        message: 'start_date must precede end_date.',
      });
    if (
      value.recency_days !== undefined &&
      (value.start_date || value.end_date || value.time_range)
    )
      context.addIssue({
        code: 'custom',
        message: 'Use recency_days or explicit date filters, not both.',
      });
  });
export type WebSearchQuery = z.infer<typeof webSearchQuerySchema>;

export const webSearchResultSchema = z.strictObject({
  title: z.string().trim().min(1).max(400),
  url: z
    .string()
    .url()
    .max(2048)
    .refine((value) => {
      const parsed = new URL(value);
      return (
        ['https:', 'http:'].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password
      );
    }, 'Search results require an HTTP(S) URL without credentials.'),
  snippet: z.string().trim().min(1).max(4000),
  published_date: z.string().trim().min(4).max(40).optional(),
  /** Provider relevance score; opaque and not comparable across providers. */
  score: z.number().optional(),
  reference: z
    .strictObject({
      response_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      result_index: z
        .number()
        .int()
        .min(0)
        .max(WEB_SEARCH_MAX_RESULTS - 1),
    })
    .optional(),
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
  /** Optional for legacy captures; new captures preserve exact provider bytes. */
  raw_response_base64: z.string().max(699_052).optional(),
  request: webSearchQuerySchema.optional(),
  provider_request_id: z.string().max(200).optional(),
  usage: z.strictObject({ credits: z.number().nonnegative() }).optional(),
  attempts: z
    .array(
      z.strictObject({ at: z.string().max(40), outcome: z.string().max(200) }),
    )
    .max(20)
    .optional(),
  model_preview: toolPreviewSchema.optional(),
});
export type WebSearchCapture = z.infer<typeof webSearchCaptureSchema>;
