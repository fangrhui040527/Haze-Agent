import { randomUUID } from 'node:crypto';

/** The only evidence tool admitted by the first general-task milestone. */
export const PM25_SOURCE_ID = 'zetaris-smokeledger-pm25';
const SOURCE_FILTER = 'open-meteo-air-quality';
const UNIT_REFERENCE = 'https://open-meteo.com/en/docs/air-quality-api';
const ROW_LIMIT = 1_500;
const MAX_RESPONSE_BYTES = 524_288;

export interface EvidenceScope {
  location: string;
  period: { start: string; end: string };
}

export interface EvidenceRow {
  /** These are instantaneous samples, not hour-long concentration averages. */
  start: string;
  end: string;
  value: number | null;
  issued_at: string | null;
  location: string;
  ingested_at: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface EvidenceCapture {
  source: string;
  kind: 'modeled';
  units: string;
  location: string;
  retrieved_at: string;
  issued_at: null;
  rows: EvidenceRow[];
  /** Exact HTTP response text; the task artifact pins its immutable hash. */
  raw: string;
  selection: {
    backend: 'zetaris-rest';
    query: string;
    request_id: string;
    row_limit: number;
    returned_rows: number;
    truncated: boolean;
    source_filter: string;
    selected_raw_row_indices: number[];
  };
  limitations: string[];
  mode: 'live';
  temporal_support: 'instantaneous';
  sample_interval_minutes: 60;
  units_reference: string;
}

export interface EvidenceSource {
  readonly id: string;
  retrieve(scope: EvidenceScope, signal: AbortSignal): Promise<EvidenceCapture>;
}

export class EvidenceSourceError extends Error {
  constructor(
    message: string,
    readonly code: 'unavailable' | 'provider_failure' | 'invalid_evidence',
  ) {
    super(message);
    this.name = 'EvidenceSourceError';
  }
}

function invalid(message: string): never {
  throw new EvidenceSourceError(message, 'invalid_evidence');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A bounded literal; callers cannot provide SQL identifiers or expressions. */
function locationLiteral(location: string): string {
  if (
    !location.trim() ||
    location.length > 200 ||
    [...location].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 || character === '\\';
    })
  ) {
    invalid('The evidence location must be a bounded town name.');
  }
  return `'${location.trim().replaceAll("'", "''")}'`;
}

function instant(value: unknown, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || value.length > 80) {
    return invalid('Zetaris returned an invalid UTC timestamp.');
  }
  // The _utc fields have a UTC schema contract. Zetaris may serialize SQL
  // TIMESTAMP without an offset; this interpretation is disclosed below.
  const iso = value.replace(' ', 'T');
  const normalized = /(?:Z|[+-]\d\d:?\d\d)$/iu.test(iso) ? iso : `${iso}Z`;
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) {
    return invalid('Zetaris returned an invalid UTC timestamp.');
  }
  return new Date(milliseconds).toISOString();
}

function requestInstant(value: string): string {
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/u.test(
      value,
    )
  ) {
    return invalid(
      'The evidence period requires explicit timestamps with UTC offsets.',
    );
  }
  const normalized = instant(value) as string;
  const calendarDate = `${value.slice(0, 10)}T00:00:00Z`;
  if (
    value.slice(0, 10) !== new Date(calendarDate).toISOString().slice(0, 10)
  ) {
    return invalid('The evidence period contains an invalid calendar date.');
  }
  return normalized;
}

function coordinate(value: unknown, maximum: number): number | null {
  if (value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Math.abs(value) > maximum
  ) {
    return invalid('Zetaris returned invalid town coordinates.');
  }
  return value;
}

function parseRow(value: unknown, scope: EvidenceScope): EvidenceRow {
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
  let row: Record<string, unknown>;
  if (Array.isArray(value) && value.length === columns.length) {
    row = Object.fromEntries(
      columns.map((column, index) => [column, value[index]]),
    );
  } else if (record(value)) {
    row = value;
  } else {
    return invalid('Zetaris returned an invalid PM2.5 row.');
  }
  if (
    typeof row['town'] !== 'string' ||
    row['town'].toLocaleLowerCase() !==
      scope.location.trim().toLocaleLowerCase() ||
    row['kind'] !== 'model' ||
    row['source'] !== SOURCE_FILTER
  ) {
    return invalid(
      'The returned PM2.5 rows do not match the authorized source selection.',
    );
  }
  const start = instant(row['valid_utc']) as string;
  if (start < scope.period.start || start >= scope.period.end) {
    return invalid('Zetaris returned a sample outside the requested period.');
  }
  const concentration = row['pm25'];
  if (
    concentration !== null &&
    (typeof concentration !== 'number' ||
      !Number.isFinite(concentration) ||
      concentration < 0)
  ) {
    return invalid('Zetaris returned an invalid PM2.5 concentration.');
  }
  // Historical ingestion wrote collection time into issued_utc. It is retained
  // in raw evidence, but cannot establish provider issuance for this source.
  return {
    start,
    end: start,
    value: concentration,
    issued_at: null,
    location: row['town'],
    ingested_at: instant(row['ingested_utc'], true),
    latitude: coordinate(row['lat'], 90),
    longitude: coordinate(row['lon'], 180),
  };
}

async function readBounded(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) return invalid('Zetaris returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        return invalid('Zetaris returned an invalid response body.');
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return invalid('Zetaris evidence exceeded the response byte limit.');
      }
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/**
 * Uses the configured direct REST boundary documented by the existing Zetaris
 * runner. No UI login, direct Postgres access, public API, or sample fallback.
 */
export function resolveEvidenceSource(
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch = fetch,
): EvidenceSource {
  return {
    id: PM25_SOURCE_ID,
    async retrieve(requestedScope, signal) {
      signal.throwIfAborted();
      const sampleMode = env['SAMPLE_MODE']?.trim().toLowerCase();
      if (sampleMode && sampleMode !== '0' && sampleMode !== 'false') {
        throw new EvidenceSourceError(
          'SAMPLE_MODE disables live evidence retrieval; no sample substitution was performed.',
          'unavailable',
        );
      }
      const key = env['ZETARIS_API_KEY']?.trim();
      if (!key) {
        throw new EvidenceSourceError(
          'The Zetaris SmokeLedger PM2.5 adapter is unavailable: ZETARIS_API_KEY is missing. No other source was queried.',
          'unavailable',
        );
      }
      let base: URL;
      try {
        base = new URL(
          env['ZETARIS_REST_URL'] ?? 'http://localhost:8888/api/v1.0',
        );
      } catch {
        throw new EvidenceSourceError(
          'ZETARIS_REST_URL must be an HTTP(S) API base URL.',
          'unavailable',
        );
      }
      if (
        !['http:', 'https:'].includes(base.protocol) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        base.port === '8889'
      ) {
        throw new EvidenceSourceError(
          'ZETARIS_REST_URL must use HTTP(S) without credentials, query, fragment, or port 8889.',
          'unavailable',
        );
      }
      const organization = env['ZETARIS_ORG_ID'] ?? '1';
      if (!/^\d+$/u.test(organization)) {
        throw new EvidenceSourceError(
          'ZETARIS_ORG_ID must be a numeric organization ID.',
          'unavailable',
        );
      }
      const scope = {
        location: requestedScope.location.trim(),
        period: {
          start: requestInstant(requestedScope.period.start),
          end: requestInstant(requestedScope.period.end),
        },
      };
      if (
        scope.period.start >= scope.period.end ||
        Date.parse(scope.period.end) - Date.parse(scope.period.start) >
          31 * 86_400_000
      ) {
        invalid('The evidence period must be increasing and at most 31 days.');
      }
      const town = locationLiteral(scope.location);
      const query = [
        'SELECT p.town, p.valid_utc, p.kind, p.issued_utc, p.pm25, p.`source`, p.ingested_utc, t.lat, t.lon',
        'FROM sl_pg.pm25 p LEFT JOIN sl_pg.towns t ON p.town = t.town',
        `WHERE LOWER(p.town) = LOWER(${town})`,
        `AND p.valid_utc >= TIMESTAMP '${scope.period.start.replace('T', ' ').replace('Z', '')}'`,
        `AND p.valid_utc < TIMESTAMP '${scope.period.end.replace('T', ' ').replace('Z', '')}'`,
        `AND p.kind = 'model' AND p.\`source\` = '${SOURCE_FILTER}'`,
        'ORDER BY p.valid_utc ASC, p.ingested_utc DESC, p.pm25 ASC',
        `LIMIT ${ROW_LIMIT + 1}`,
      ].join('\n');
      const requestId = randomUUID();
      base.pathname = `${base.pathname.replace(/\/+$/u, '')}/sql-editor/sqls/run`;
      let response: Response;
      const boundedSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(30_000),
      ]);
      try {
        response = await fetcher(base, {
          method: 'POST',
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${key}`,
            'X-Org-ID': organization,
            'X-Request-ID': requestId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            queryId: requestId,
            sql: query,
            source: 'SqlEditor',
            limit: ROW_LIMIT + 1,
          }),
          signal: boundedSignal,
        });
      } catch {
        signal.throwIfAborted();
        throw new EvidenceSourceError(
          'Zetaris evidence retrieval failed or timed out; no alternate source was queried.',
          'provider_failure',
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new EvidenceSourceError(
          `Zetaris evidence retrieval failed (HTTP ${response.status}); no alternate source was queried.`,
          'provider_failure',
        );
      }
      let raw: string;
      try {
        raw = await readBounded(response, boundedSignal);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof EvidenceSourceError) throw error;
        throw new EvidenceSourceError(
          'Zetaris evidence response failed or timed out.',
          'provider_failure',
        );
      }
      if (raw.includes(key)) {
        return invalid(
          'Zetaris evidence echoed a server credential and cannot be persisted.',
        );
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return invalid('Zetaris returned invalid evidence JSON.');
      }
      if (
        !record(payload) ||
        !Array.isArray(payload['data']) ||
        payload['error'] ||
        payload['success'] === false
      ) {
        return invalid(
          'Zetaris did not return a successful tabular evidence response.',
        );
      }
      const data: unknown[] = payload['data'];
      const selected = new Map<
        string,
        { row: EvidenceRow; rawIndex: number }
      >();
      const truncated = data.length > ROW_LIMIT;
      data.slice(0, ROW_LIMIT).forEach((item, rawIndex) => {
        const row = parseRow(item, scope);
        const previous = selected.get(row.start);
        // Pin the latest locally ingested capture for each sample time. This
        // is a retrieval selection, never a claim about provider model runs.
        if (
          !previous ||
          (row.ingested_at ?? '') > (previous.row.ingested_at ?? '')
        ) {
          selected.set(row.start, { row, rawIndex });
        }
      });
      const rows = [...selected.values()].sort((left, right) =>
        left.row.start.localeCompare(right.row.start),
      );
      return {
        source: PM25_SOURCE_ID,
        kind: 'modeled',
        units: 'µg/m³',
        location: scope.location,
        retrieved_at: new Date().toISOString(),
        issued_at: null,
        rows: rows.map(({ row }) => row),
        raw,
        selection: {
          backend: 'zetaris-rest',
          query,
          request_id: requestId,
          row_limit: ROW_LIMIT,
          returned_rows: data.length,
          truncated,
          source_filter: SOURCE_FILTER,
          selected_raw_row_indices: rows.map(({ rawIndex }) => rawIndex),
        },
        mode: 'live',
        temporal_support: 'instantaneous',
        sample_interval_minutes: 60,
        units_reference: UNIT_REFERENCE,
        limitations: [
          'Only stored Open-Meteo/CAMS modeled PM2.5 was queried through Zetaris sl_pg. Ground-station observations and other sources were not searched.',
          'Samples are instantaneous concentrations at stored hourly timestamps, not measured observations or hourly averages. Hourly output does not establish native model resolution.',
          'Units follow the Open-Meteo pm2_5 source definition; the legacy SmokeLedger table does not retain provider unit metadata.',
          'Town coordinates are requested target coordinates. The legacy ingestion does not retain returned model grid-cell coordinates or native spatial support; town-wide representativeness is unverified.',
          'Provider issuance time is unknown. Legacy issued_utc values may be local collection times and are retained only in the raw capture; ingested_utc is local receipt time.',
          'Timestamp fields without an explicit offset are interpreted as UTC under the SmokeLedger _utc schema contract.',
          'For duplicate sample times the most recently ingested stored row is selected; this is not a provider-issued model version. Exact raw rows and selection indices are retained.',
          ...(truncated
            ? [
                `The raw selection exceeded ${ROW_LIMIT} rows and is truncated. Coverage beyond retained rows is unknown.`,
              ]
            : []),
        ],
      };
    },
  };
}
