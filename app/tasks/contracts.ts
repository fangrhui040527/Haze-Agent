import { z } from 'zod';

const text = z.string().min(1).max(2000);
const instant = z.iso.datetime({ offset: true });
export const taskScopeSchema = z.strictObject({
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
    .strictObject({ start: instant, end: instant })
    .refine(
      ({ start, end }) =>
        Date.parse(end) > Date.parse(start) &&
        Date.parse(end) - Date.parse(start) <= 31 * 86400000,
      'Use a positive interval of at most 31 days; end is exclusive.',
    ),
});
export const taskRefSchema = z.strictObject({
  id: z.uuid(),
  version: z.literal(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const taskRequestSchema = z.strictObject({
  schema_version: z.literal('haze.task.request.v1'),
  objective: z.string().min(1).max(4000),
  scope: taskScopeSchema.optional(),
  context_refs: z.array(taskRefSchema).max(8).default([]),
  constraints: z.array(text).max(16).default([]),
  desired_deliverables: z.array(text).max(8).default([]),
});
export const taskAdmissionSchema = z.strictObject({
  task_id: z.uuid(),
  status_url: z.string(),
  events_url: z.string(),
  reused: z.boolean(),
});
export const taskStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'timed_out',
  'cancelled',
]);
export const taskEventSchema = z.strictObject({
  cursor: z.number().int().positive(),
  task_id: z.uuid(),
  at: instant,
  type: z.string(),
  actor: z.enum(['Manager', 'HazeOps', 'EvidenceCritic']),
  message: text,
  data: z.unknown().optional(),
});
export const taskEventPageSchema = z.strictObject({
  events: z.array(taskEventSchema),
  next_cursor: z.number().int().nonnegative(),
  status: taskStatusSchema,
});
export const taskResultSchema = z.strictObject({
  answer: z.string().min(1).max(12000),
  findings: z.array(
    z.strictObject({ text, citation_ids: z.array(z.string()) }),
  ),
  citations: z.array(
    z.strictObject({
      id: z.string(),
      artifact_id: z.uuid(),
      sha256: z.string(),
      url: z.string(),
      label: text,
      selection: z.unknown(),
    }),
  ),
  coverage: z.strictObject({
    requested: taskScopeSchema,
    row_count: z.number().int(),
    usable_row_count: z.number().int(),
    modeled_count: z.number().int(),
    observation_count: z.number().int(),
    unknown_kind_count: z.number().int(),
    missing_intervals: z.array(
      z.strictObject({ start: instant, end: instant }),
    ),
    status: z.enum(['available', 'partial', 'insufficient_evidence']),
  }),
  assumptions: z.array(text),
  unresolved_gaps: z.array(text),
  review: z.strictObject({
    status: z.literal('deterministic_checks'),
    scope: text,
    limitations: z.array(text),
    artifact_id: z.uuid(),
  }),
  provenance: z.strictObject({
    mode: z.literal('live'),
    source: z.string(),
    retrieved_at: instant,
    model: z.strictObject({
      provider: z.string(),
      model: z.string(),
      calls: z.number().int(),
      max_output_tokens: z.number().int(),
      usage: z.enum(['reported_by_provider', 'not_reported_by_adapter']),
      receipt: z
        .strictObject({
          response_model: z.string().nullable(),
          response_id: z.string().nullable(),
          input_tokens: z.number().int().nonnegative().nullable(),
          output_tokens: z.number().int().nonnegative().nullable(),
        })
        .optional(),
    }),
    tool_calls: z.number().int(),
    method: z.literal('haze.pm25.coverage.v1'),
  }),
});
export const taskRecordSchema = z.strictObject({
  schema_version: z.literal('haze.task.v1'),
  id: z.uuid(),
  objective_revision: z.literal(1),
  original_request: taskRequestSchema,
  scope: taskScopeSchema,
  identity: z.strictObject({ principal: z.string(), workspace: z.string() }),
  permissions: z.strictObject({
    tools: z.array(z.string()),
    effects: z.array(z.string()),
  }),
  limits: z.strictObject({
    deadline: instant,
    max_tool_calls: z.number().int(),
    max_model_calls: z.number().int(),
    max_model_input_bytes: z.number().int(),
    max_model_output_tokens: z.number().int(),
    max_artifacts: z.number().int(),
  }),
  usage: z.strictObject({
    tool_calls: z.number().int(),
    model_calls: z.number().int(),
    artifacts: z.number().int(),
  }),
  created_at: instant,
  updated_at: instant,
  status: taskStatusSchema,
  mode: z.literal('live'),
  result: taskResultSchema.optional(),
  error: z.strictObject({ code: z.string(), message: text }).optional(),
});
export type TaskRequest = z.infer<typeof taskRequestSchema>;
export type TaskScope = z.infer<typeof taskScopeSchema>;
export type TaskRecord = z.infer<typeof taskRecordSchema>;
export type TaskEvent = z.infer<typeof taskEventSchema>;
export type TaskResult = z.infer<typeof taskResultSchema>;
export type TaskIdentity = TaskRecord['identity'];

/** Explicit, deliberately narrow parser. Ambiguous prose never picks a default place or time. */
export function frameScope(request: TaskRequest): TaskScope {
  if (!/PM2[.]5/i.test(request.objective))
    throw new TaskError(
      422,
      'unsupported_capability',
      'This milestone supports PM2.5 evidence summaries only.',
    );
  const match =
    /for\s+(.+?)\s+during\s+(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?)\s+(?:to|until)\s+(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?)/i.exec(
      request.objective,
    );
  if (!match && request.scope) return request.scope;
  if (!match)
    throw new TaskError(
      422,
      'scope_required',
      'Provide a location and explicit UTC start/end (end exclusive), using scope or “for LOCATION during YYYY-MM-DD to YYYY-MM-DD”.',
    );
  const date = (v: string) => (v.length === 10 ? `${v}T00:00:00Z` : v);
  const parsed = taskScopeSchema.safeParse({
    location: match[1],
    period: { start: date(match[2]!), end: date(match[3]!) },
  });
  if (!parsed.success)
    throw new TaskError(
      422,
      'invalid_scope',
      'Use valid UTC dates and an interval of at most 31 days.',
    );
  if (
    request.scope &&
    (parsed.data.location.toLowerCase() !==
      request.scope.location.toLowerCase() ||
      Date.parse(parsed.data.period.start) !==
        Date.parse(request.scope.period.start) ||
      Date.parse(parsed.data.period.end) !==
        Date.parse(request.scope.period.end))
  )
    throw new TaskError(
      422,
      'scope_conflict',
      'The explicit scope conflicts with the location or period in the original objective.',
    );
  return request.scope ?? parsed.data;
}

export class TaskError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
