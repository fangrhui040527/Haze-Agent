import { z } from 'zod';

/** PM2.5 applicability is domain-owned; general tasks have no place/date requirement. */
export const pm25ScopeSchema = z.strictObject({
  location: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine(
      (value) =>
        ![...value].some(
          (character) =>
            character.codePointAt(0)! < 32 ||
            character.codePointAt(0) === 127 ||
            character === '\\',
        ),
      'Location cannot contain control characters or backslashes.',
    ),
  period: z
    .strictObject({
      start: z.iso.datetime({ offset: true }),
      end: z.iso.datetime({ offset: true }),
    })
    .refine(
      ({ start, end }) =>
        Date.parse(end) > Date.parse(start) &&
        Date.parse(end) - Date.parse(start) <= 31 * 86_400_000,
      'Use a positive interval of at most 31 days; end is exclusive.',
    ),
});

export const pm25CoverageSchema = z.strictObject({
  requested: pm25ScopeSchema,
  row_count: z.number().int().nonnegative(),
  usable_row_count: z.number().int().nonnegative(),
  modeled_count: z.number().int().nonnegative(),
  observation_count: z.number().int().nonnegative(),
  unknown_kind_count: z.number().int().nonnegative(),
  missing_intervals: z
    .array(
      z.strictObject({
        start: z.iso.datetime({ offset: true }),
        end: z.iso.datetime({ offset: true }),
      }),
    )
    .max(1500),
  status: z.enum(['available', 'partial', 'insufficient_evidence']),
});

export type Pm25Scope = z.infer<typeof pm25ScopeSchema>;

export function framePm25Scope(request: {
  objective: string;
  scope?: unknown;
}): Pm25Scope {
  if (request.scope === undefined && !/PM2[.]?5/iu.test(request.objective))
    throw new Error(
      'The PM2.5 method requires a PM2.5 objective or an explicit revised scope.',
    );
  const match =
    /for\s+(.+?)\s+during\s+(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?)\s+(?:to|until)\s+(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?)/i.exec(
      request.objective,
    );
  const date = (v: string) => (v.length === 10 ? `${v}T00:00:00Z` : v);
  const inferred = match
    ? pm25ScopeSchema.parse({
        location: match[1],
        period: { start: date(match[2]!), end: date(match[3]!) },
      })
    : undefined;
  const explicit =
    request.scope === undefined
      ? undefined
      : pm25ScopeSchema.parse(request.scope);
  if (
    explicit &&
    inferred &&
    (explicit.location.toLowerCase() !== inferred.location.toLowerCase() ||
      Date.parse(explicit.period.start) !== Date.parse(inferred.period.start) ||
      Date.parse(explicit.period.end) !== Date.parse(inferred.period.end))
  )
    throw new Error(
      'The explicit scope conflicts with the location or period in the objective.',
    );
  const scope = explicit ?? inferred;
  if (!scope)
    throw new Error(
      'PM2.5 investigation needs a location and explicit UTC start/end (end exclusive).',
    );
  return scope;
}
