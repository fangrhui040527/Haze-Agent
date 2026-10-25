import { z } from 'zod';

/**
 * SmokeLedger applicability is domain-owned. Coverage (supported towns, the
 * 72-hour window limit) stays with the sidecar, which answers unsupported scope
 * with a structured error that becomes an explicit evidence gap here.
 */
export const smokeLedgerScopeSchema = z.strictObject({
  town: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[\p{L}\p{N} .'-]+$/u, 'Town may contain letters, digits, spaces, dots, apostrophes and hyphens only.'),
  window: z
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
export type SmokeLedgerScope = z.infer<typeof smokeLedgerScopeSchema>;

export const SMOKELEDGER_OPERATIONS = {
  'haze.air_outlook': 'assess_haze',
  'haze.trace_sources': 'trace_sources',
} as const;
export type SmokeLedgerRunTool = keyof typeof SMOKELEDGER_OPERATIONS;

const evidenceIdSchema = z.string().regex(/^E-[a-f0-9]{10}$/);
const countsSchema = z.record(z.string(), z.number().int().nonnegative());

/** The sidecar response is retained verbatim; only fields this capability reads are typed. */
export const runResponseSchema = z.looseObject({
  run_id: z.string().min(1),
  status: z.enum(['success', 'partial', 'error']),
  mode: z.enum(['live', 'cached_live', 'offline_sample']),
  output: z
    .looseObject({
      summary: z.string().optional(),
      claims: z
        .array(
          z.looseObject({
            id: z.string(),
            kind: z.string(),
            text: z.string(),
            evidence_ids: z.array(z.string()),
          }),
        )
        .optional(),
      evidence: z
        .array(z.looseObject({ evidence_id: z.string(), sha256: z.string() }))
        .optional(),
      limitations: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
  critic: z.unknown().optional(),
  sponsor_integration_evidence: z.record(z.string(), z.unknown()).optional(),
  engine_operations_executed: countsSchema.optional(),
  remote_calls_executed: countsSchema.optional(),
  remote_calls_skipped: countsSchema.optional(),
  log_file: z.string().nullable().optional(),
  error: z
    .looseObject({ type: z.string(), message: z.string().optional() })
    .nullable()
    .optional(),
});
export type RunResponse = z.infer<typeof runResponseSchema>;

export const runToolOutputSchema = z.strictObject({
  operation: z.enum(['assess_haze', 'trace_sources']),
  scope: smokeLedgerScopeSchema,
  run_id: z.string(),
  response: runResponseSchema,
});
export type RunToolOutput = z.infer<typeof runToolOutputSchema>;

const provenanceSchema = z.looseObject({
  mode: z.string(),
  engine_operations_executed: countsSchema,
  remote_calls_executed: countsSchema,
  remote_calls_skipped: countsSchema,
  remote_call_ids: z.array(z.string()),
  failures: z.array(z.unknown()),
});

export const verifyInputSchema = z.strictObject({
  evidence_ids: z.array(evidenceIdSchema).min(1).max(40),
});
export const verifyOutputSchema = z.strictObject({
  results: z.array(
    z.strictObject({
      evidence_id: evidenceIdSchema,
      verified: z.boolean(),
      stored_sha256: z.string().nullable(),
      current_sha256: z.string().nullable(),
      reason: z.string().nullable(),
      provenance: provenanceSchema.nullable(),
    }),
  ),
});
export type VerifyOutput = z.infer<typeof verifyOutputSchema>;

export const claimCheckInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(20_000),
  evidence_ids: z.array(evidenceIdSchema).max(200),
});
export const claimCheckOutputSchema = z.strictObject({
  ok: z.boolean(),
  problems: z.array(z.string()),
  checked_evidence_ids: z.array(z.string()),
  lanes: z.array(z.enum(['deterministic', 'nemotron_judge'])),
  judge_model: z.string().nullable(),
  provenance: provenanceSchema,
});
export type ClaimCheckOutput = z.infer<typeof claimCheckOutputSchema>;

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/**
 * Explicit scope (the request's or a correction's revised scope) wins; otherwise
 * read "over|in|for|at TOWN on D[–D] Month YYYY" as whole Malaysian days
 * [D 00:00, last day + 1 00:00) +08:00. Anything else needs an explicit scope.
 */
export function frameSmokeLedgerScope(request: {
  objective: string;
  scope?: unknown;
}): SmokeLedgerScope {
  if (request.scope !== undefined)
    return smokeLedgerScopeSchema.parse(request.scope);
  const match =
    /\b(?:over|in|for|at)\s+([A-Z][\p{L} .'-]*?)\s+(?:on|during|between|from)\s+(\d{1,2})(?:\s*(?:[–-]|to|and)\s*(\d{1,2}))?\s+([A-Za-z]+)\s+(\d{4})\b/u.exec(
      request.objective,
    );
  const month = match ? MONTHS.indexOf(match[4]!.toLowerCase()) : -1;
  if (!match || month < 0)
    throw new Error(
      'SmokeLedger needs a town and a date range, e.g. "over Batu Pahat on 6–7 October 2026", or an explicit scope.',
    );
  const year = Number(match[5]);
  const first = Number(match[2]);
  const last = Number(match[3] ?? match[2]);
  const day = (d: number) => {
    const date = new Date(Date.UTC(year, month, d));
    if (date.getUTCMonth() !== month)
      throw new Error(`${d} ${match[4]} ${year} is not a calendar date.`);
    return date;
  };
  const start = day(first);
  const end = new Date(day(last).getTime() + 86_400_000);
  const local = (date: Date) =>
    `${date.toISOString().slice(0, 10)}T00:00:00+08:00`;
  return smokeLedgerScopeSchema.parse({
    town: match[1]!.trim(),
    window: { start: local(start), end: local(end) },
  });
}
