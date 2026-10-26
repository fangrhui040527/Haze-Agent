import { z } from 'zod';
import { contractHash } from '../../contracts/json.js';
import {
  pm25ScopeSchema as taskScopeSchema,
  pm25CoverageSchema,
} from './contracts.js';
export { framePm25Scope } from './contracts.js';
import {
  EvidenceSourceError,
  PM25_SOURCE_ID,
  LEGACY_PM25_SOURCE_ID,
  type EvidenceCapture,
  type EvidenceRow,
  type EvidenceScope,
} from './evidence.js';

const HOUR = 3_600_000;
const SOURCE_FILTER = 'open-meteo-air-quality';
const boundedText = z.string().min(1).max(2000);
const timestamp = z.iso.datetime({ offset: true });

/** Domain rules live in this capability, rather than in the shared runtime. */
export const pm25Capability = {
  id: 'pm25-evidence-summary',
  version: '2',
  purpose:
    'Summarize a bounded location/period selection of modeled PM2.5 evidence.',
  work_products: ['evidence-selection', 'coverage-analysis', 'evidence-review'],
  required_tools: [PM25_SOURCE_ID],
  roles: ['HazeOps', 'WorkerShield', 'EvidenceCritic'],
  readiness: 'implemented',
  limitations: [
    'Read-only Open-Meteo/CAMS modeled instantaneous samples; observations are not queried.',
    'No scientific qualification, causal attribution, health advice or operational effects.',
    'Fixture tests establish integration behavior; live readiness requires a real execution.',
  ],
} as const;

export const captureSchema = z.strictObject({
  source: z.string().min(1).max(200),
  kind: z.literal('modeled'),
  units: z.literal('µg/m³'),
  location: taskScopeSchema.shape.location,
  retrieved_at: timestamp,
  issued_at: z.null(),
  rows: z
    .array(
      z.strictObject({
        start: timestamp,
        end: timestamp,
        value: z.number().nonnegative().nullable(),
        issued_at: z.null(),
        location: taskScopeSchema.shape.location,
        ingested_at: timestamp.nullable(),
        latitude: z.number().min(-90).max(90).nullable(),
        longitude: z.number().min(-180).max(180).nullable(),
      }),
    )
    .max(1500),
  raw: z.string().min(1).max(524_288),
  selection: z.strictObject({
    backend: z.literal('zetaris-rest'),
    query: z.string().min(1).max(16_000),
    request_id: z.string().min(1).max(200),
    row_limit: z.number().int().min(1).max(1500),
    returned_rows: z.number().int().nonnegative().max(1501),
    truncated: z.boolean(),
    source_filter: z.literal(SOURCE_FILTER),
    selected_raw_row_indices: z.array(z.number().int().nonnegative()).max(1500),
  }),
  limitations: z.array(boundedText).max(32),
  mode: z.enum(['live', 'fixture', 'replay']),
  evidence_origin: z.enum(['modeled', 'synthetic_fixture']).optional(),
  temporal_support: z.literal('instantaneous'),
  sample_interval_minutes: z.literal(60),
  units_reference: z.url().max(2000),
});

function invalid(message: string): never {
  throw new EvidenceSourceError(message, 'invalid_evidence');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The raw SQL schema permits timestamp strings without an offset, meaning UTC. */
function rawInstant(value: unknown, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || value.length > 80)
    return invalid('The raw evidence contains an invalid timestamp.');
  const iso = value.replace(' ', 'T');
  const normalized = /(?:Z|[+-]\d\d:?\d\d)$/iu.test(iso) ? iso : `${iso}Z`;
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds))
    return invalid('The raw evidence contains an invalid timestamp.');
  return new Date(milliseconds).toISOString();
}

function rawNumeric(value: unknown): unknown {
  // Reconstruct numeric REST strings independently from the retained raw bytes.
  return typeof value === 'string' &&
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value.trim())
    ? Number(value)
    : value;
}

function rawRow(value: unknown, scope: EvidenceScope): EvidenceRow {
  const columns = [
    'town',
    'valid_utc',
    'kind',
    'issued_utc',
    'pm25',
    'source',
    'ingested_utc',
    'lat',
    'lon',
  ];
  const row =
    Array.isArray(value) && value.length === columns.length
      ? Object.fromEntries(
          columns.map((column, index) => [column, value[index]]),
        )
      : value;
  if (
    !record(row) ||
    row['kind'] !== 'model' ||
    row['source'] !== SOURCE_FILTER ||
    typeof row['town'] !== 'string' ||
    row['town'].toLowerCase() !== scope.location.toLowerCase()
  )
    return invalid(
      'The raw evidence does not match the authorized source selection.',
    );
  const start = rawInstant(row['valid_utc']) as string;
  const parsed = captureSchema.shape.rows.element.safeParse({
    start,
    end: start,
    value: rawNumeric(row['pm25']),
    issued_at: null,
    location: row['town'],
    ingested_at: rawInstant(row['ingested_utc'], true),
    latitude: rawNumeric(row['lat']),
    longitude: rawNumeric(row['lon']),
  });
  if (
    !parsed.success ||
    Date.parse(start) < Date.parse(scope.period.start) ||
    Date.parse(start) >= Date.parse(scope.period.end)
  )
    return invalid(
      'The raw evidence contains an invalid or out-of-scope sample.',
    );
  return parsed.data;
}

/** Validate untrusted adapters before persisting or calculating their captures. */
export function validateCapture(
  capture: unknown,
  scope: EvidenceScope,
  sourceId = PM25_SOURCE_ID,
): asserts capture is EvidenceCapture {
  if (!taskScopeSchema.safeParse(scope).success)
    return invalid('The evidence scope is invalid.');
  const parsed = captureSchema.safeParse(capture);
  if (!parsed.success)
    return invalid(
      'The evidence adapter returned an invalid capture shape or source semantics.',
    );
  const selected = parsed.data;
  const sourceMatches =
    selected.source === sourceId ||
    (sourceId === PM25_SOURCE_ID && selected.source === LEGACY_PM25_SOURCE_ID);
  if (
    !sourceMatches ||
    selected.location.toLowerCase() !== scope.location.toLowerCase() ||
    Buffer.byteLength(selected.raw, 'utf8') > 524_288
  )
    return invalid(
      'The evidence capture does not match the authorized selection.',
    );
  const indices = selected.selection.selected_raw_row_indices;
  if (
    indices.length !== selected.rows.length ||
    new Set(indices).size !== indices.length ||
    selected.selection.truncated !==
      selected.selection.returned_rows > selected.selection.row_limit
  )
    return invalid('The evidence selection receipt is inconsistent.');
  let payload: unknown;
  try {
    payload = JSON.parse(selected.raw);
  } catch {
    return invalid('The evidence raw response is invalid JSON.');
  }
  if (
    !record(payload) ||
    !Array.isArray(payload['data']) ||
    payload['error'] ||
    payload['success'] === false ||
    payload['data'].length !== selected.selection.returned_rows ||
    payload['data'].length > selected.selection.row_limit + 1
  )
    return invalid(
      'The evidence raw response does not match its selection receipt.',
    );

  // Verify the same stated selection policy against the exact retained raw rows.
  const expected = new Map<string, { row: EvidenceRow; index: number }>();
  payload['data']
    .slice(0, selected.selection.row_limit)
    .forEach((value: unknown, index) => {
      const row = rawRow(value, scope);
      const previous = expected.get(row.start);
      if (
        !previous ||
        (row.ingested_at ?? '') > (previous.row.ingested_at ?? '')
      )
        expected.set(row.start, { row, index });
    });
  const ordered = [...expected.values()].sort(
    (left, right) => Date.parse(left.row.start) - Date.parse(right.row.start),
  );
  if (ordered.length !== selected.rows.length)
    return invalid(
      'The evidence selection omits or duplicates retained sample times.',
    );
  for (let index = 0; index < ordered.length; index++) {
    const actual = selected.rows[index]!;
    const expectedRow = ordered[index]!;
    if (
      Date.parse(actual.start) !== Date.parse(actual.end) ||
      indices[index] !== expectedRow.index ||
      contractHash({
        ...actual,
        start: rawInstant(actual.start),
        end: rawInstant(actual.end),
        ingested_at: rawInstant(actual.ingested_at, true),
      }) !== contractHash(expectedRow.row)
    )
      return invalid(
        'The selected evidence row is not linked to its exact raw source row.',
      );
  }
}

export const pm25AnalysisSchema = z.strictObject({
  method: z.literal('haze.pm25.coverage.v1'),
  scope: taskScopeSchema,
  coverage: pm25CoverageSchema,
  range: z.strictObject({
    min: z.number().nonnegative().nullable(),
    max: z.number().nonnegative().nullable(),
  }),
  findings: z
    .array(
      z.strictObject({
        id: z.string().regex(/^F[1-9]\d*$/u),
        text: boundedText,
        citation_ids: z.array(z.literal('E1')).length(1),
      }),
    )
    .min(1)
    .max(8),
  assumptions: z.array(boundedText).max(32),
  unresolved_gaps: z.array(boundedText).max(40),
});
export type Pm25Analysis = z.infer<typeof pm25AnalysisSchema>;

/** Producer method. The checker below deliberately does not call this function. */
export function analyzePm25(
  capture: EvidenceCapture,
  scope: EvidenceScope,
): Pm25Analysis {
  validateCapture(capture, scope);
  const values = capture.rows.flatMap((row) =>
    row.value === null ? [] : [row.value],
  );
  const times = new Set(
    capture.rows
      .filter((row) => row.value !== null)
      .map((row) => Date.parse(row.start)),
  );
  const missing: { start: string; end: string }[] = [];
  const to = Date.parse(scope.period.end);
  for (
    let at = Math.ceil(Date.parse(scope.period.start) / HOUR) * HOUR;
    at < to;
    at += HOUR
  ) {
    if (times.has(at)) continue;
    const until = Math.min(at + HOUR, to);
    const previous = missing.at(-1);
    if (previous && Date.parse(previous.end) === at)
      previous.end = new Date(until).toISOString();
    else
      missing.push({
        start: new Date(at).toISOString(),
        end: new Date(until).toISOString(),
      });
  }
  const range = {
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
  };
  const coverage: z.infer<typeof pm25CoverageSchema> = {
    requested: scope,
    row_count: capture.rows.length,
    usable_row_count: values.length,
    modeled_count: values.length,
    observation_count: 0,
    unknown_kind_count: 0,
    missing_intervals: missing,
    status: !values.length
      ? 'insufficient_evidence'
      : missing.length || capture.selection.truncated
        ? 'partial'
        : 'available',
  };
  return {
    method: 'haze.pm25.coverage.v1',
    scope,
    coverage,
    range,
    findings: [
      {
        id: 'F1',
        text: values.length
          ? `${values.length} modeled instantaneous PM2.5 samples for ${scope.location}; range ${range.min} to ${range.max} ${capture.units}. These are model output, not observations or hourly averages.`
          : `No usable modeled PM2.5 values in this exact selection for ${scope.location}; evidence is insufficient within this selection.`,
        citation_ids: ['E1'],
      },
      {
        id: 'F2',
        text: 'Only modeled evidence was queried. Observation availability and coverage remain unresolved.',
        citation_ids: ['E1'],
      },
    ],
    assumptions: [
      'The UTC interval includes its start and excludes its end. Coverage describes expected hourly sample timestamps, not continuous measurements or hourly averages.',
      'No causal attribution, health advice, scientific qualification or operational decision is inferred.',
      'Supporting context does not change the authorized scope, evidence source or permissions.',
    ],
    unresolved_gaps: [
      ...capture.limitations,
      ...(missing.length
        ? [
            `${missing.length} missing span(s) of expected hourly sample timestamps; see coverage.missing_intervals (end exclusive).`,
          ]
        : []),
      ...(values.length
        ? []
        : [
            'No usable modeled values in this exact source selection; absence elsewhere has not been established.',
          ]),
      ...(capture.selection.truncated
        ? [
            'The retained source selection was truncated; coverage outside retained rows is unknown.',
          ]
        : []),
      'Provider issuance time is unknown; local collection, ingestion and retrieval times do not establish provider issuance.',
      'Observational coverage was not assessed; model grid-cell support and town-wide representativeness remain unverified.',
    ],
  };
}

/** A separate numerical implementation; it never calls producer calculations. */
export function independentlyCheckPm25(
  capture: unknown,
  analysis: unknown,
  scope: EvidenceScope,
): {
  checks: string[];
  findings: string[];
  valid: boolean;
  limitations: string[];
} {
  const checks: string[] = [];
  const findings: string[] = [];
  const limitations = [
    'Deterministic checks validate selection, sample counts, ranges and citations; they do not prove prose entailment or provide scientific qualification.',
    'Provider issuance, native grid support, observations and source ingestion limitations remain unresolved.',
  ];
  try {
    validateCapture(capture, scope);
  } catch {
    return {
      checks,
      findings: [
        'Evidence shape, scope, semantics or raw selection linkage failed.',
      ],
      valid: false,
      limitations,
    };
  }
  checks.push(
    'Evidence runtime shape, authorized scope, instantaneous model semantics and exact raw row selection.',
  );
  const parsed = pm25AnalysisSchema.safeParse(analysis);
  if (!parsed.success)
    return {
      checks,
      findings: ['Analysis does not conform to the PM2.5 method contract.'],
      valid: false,
      limitations,
    };
  const actual = parsed.data;
  if (
    contractHash(actual.scope) !== contractHash(scope) ||
    contractHash(actual.coverage.requested) !== contractHash(scope)
  )
    findings.push(
      'Analysis scope differs from the authorized requested scope.',
    );
  let count = 0;
  let minimum: number | null = null;
  let maximum: number | null = null;
  const usableTimes: number[] = [];
  for (const row of capture.rows) {
    if (row.value === null) continue;
    count++;
    minimum = minimum === null ? row.value : Math.min(minimum, row.value);
    maximum = maximum === null ? row.value : Math.max(maximum, row.value);
    usableTimes.push(Date.parse(row.start));
  }
  if (actual.range.min !== minimum || actual.range.max !== maximum)
    findings.push(
      'Reported range does not match independently scanned usable values.',
    );
  if (
    actual.coverage.row_count !== capture.rows.length ||
    actual.coverage.usable_row_count !== count ||
    actual.coverage.modeled_count !== count ||
    actual.coverage.observation_count !== 0 ||
    actual.coverage.unknown_kind_count !== 0
  )
    findings.push(
      'Reported sample counts do not match the retained modeled selection.',
    );
  checks.push(
    'Independent scan of finite nonnegative values, modeled/observation counts and minimum/maximum.',
  );

  const slots: { at: number; until: number }[] = [];
  const lower = Date.parse(scope.period.start);
  const upper = Date.parse(scope.period.end);
  const expectedSlots = Math.ceil(upper / HOUR) - Math.ceil(lower / HOUR);
  for (let index = 0; index < expectedSlots; index++) {
    const at = (Math.ceil(lower / HOUR) + index) * HOUR;
    if (!usableTimes.includes(at))
      slots.push({ at, until: Math.min(at + HOUR, upper) });
  }
  const spans: { start: string; end: string }[] = [];
  let position = 0;
  while (position < slots.length) {
    const first = slots[position]!;
    let last = first;
    while (
      position + 1 < slots.length &&
      slots[position + 1]!.at === last.until
    ) {
      last = slots[++position]!;
    }
    spans.push({
      start: new Date(first.at).toISOString(),
      end: new Date(last.until).toISOString(),
    });
    position++;
  }
  if (contractHash(actual.coverage.missing_intervals) !== contractHash(spans))
    findings.push(
      'Reported missing sample intervals differ from independently enumerated hourly slots.',
    );
  const status =
    count === 0
      ? 'insufficient_evidence'
      : slots.length > 0 || capture.selection.truncated
        ? 'partial'
        : 'available';
  if (actual.coverage.status !== status)
    findings.push(
      'Reported availability does not account for missingness or truncation.',
    );
  if (
    new Set(actual.findings.map((finding) => finding.id)).size !==
    actual.findings.length
  )
    findings.push('Finding identities are duplicated.');
  checks.push(
    'Independent expected-hour enumeration, missing-span merging, truncation status and E1-only finding citations.',
  );
  return { checks, findings, valid: findings.length === 0, limitations };
}
