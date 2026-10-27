import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  type DamageEvidenceArchive,
  evidenceRequestKey,
  evidenceSha256,
} from './archive.js';
import {
  acquisitionRequestSchema,
  type AcquisitionAttempt,
  type AcquisitionRequest,
  type AcquisitionSelection,
  type EvidenceCapture,
  type EvidenceSourceDefinition,
  type NormalizedEvidenceValue,
} from './contracts.js';
import { damageEvidenceSource } from './registry.js';
import { boundEvidenceGaps } from './bounds.js';

export interface AcquireDamageEvidenceOptions {
  signal: AbortSignal;
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  evidenceOrigin?: 'external_source' | 'synthetic_fixture';
  /** A host-validated definition for an exact URL in retained search evidence. */
  source?: EvidenceSourceDefinition;
}
export interface DamageEvidenceAcquisition {
  capture: EvidenceCapture;
  attempt: AcquisitionAttempt;
  unchanged: boolean;
}

function selector(value: string | undefined, name: string): string {
  if (!value || !/^[\p{L}\p{N} .()'’/-]+$/u.test(value))
    throw new Error(`An explicit valid ${name} selector is required.`);
  return value;
}

export function damageEvidenceRequestUrl(
  source: EvidenceSourceDefinition,
  selection: AcquisitionSelection,
): string {
  const url = new URL(source.endpoint);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('Only registered public HTTPS endpoints are supported.');
  if (source.kind !== 'numerical' || source.id === 'dosm-district-population')
    return url.toString();
  if (source.id === 'open-meteo-air-quality') {
    if (selection.latitude === undefined || selection.longitude === undefined)
      throw new Error('Explicit latitude and longitude are required.');
    for (const [key, value] of Object.entries({
      latitude: selection.latitude,
      longitude: selection.longitude,
      hourly: 'pm2_5',
      domains: 'cams_global',
      start_date: selection.period.start,
      end_date: selection.period.end,
      timezone: 'GMT',
    }))
      url.searchParams.set(key, String(value));
    return url.toString();
  }
  const filters: string[] = [];
  if (source.id === 'dosm-district-deaths')
    filters.push(
      `${selector(selection.district, 'district')}@district`,
      `${selector(selection.state, 'state')}@state`,
      `${selection.sex}@sex`,
    );
  if (source.id === 'dosm-selangor-wages')
    filters.push(
      `${selector(selection.state, 'state')}@state`,
      `${selection.sex}@sex`,
    );
  if (source.id === 'malaysia-monthly-pollution')
    url.searchParams.set('contains', '2.5@pollutant');
  if (filters.length) url.searchParams.set('filter', filters.join(','));
  url.searchParams.set(
    'date_start',
    `${selection.period.start.slice(0, 4)}-01-01@date`,
  );
  url.searchParams.set(
    'date_end',
    `${selection.period.end.slice(0, 4)}-12-31@date`,
  );
  url.searchParams.set('sort', 'date');
  // One extra record detects a truncated response; it is never silently ignored.
  url.searchParams.set('limit', '201');
  return url.toString();
}

/** RFC4180 records retain the original record number, including the header. */
export function parseEvidenceCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = !quoted;
    } else if (!quoted && character === ',') {
      row.push(field);
      field = '';
    } else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && source[index + 1] === '\n') index++;
      row.push(field);
      if (row.some((value) => value.length)) rows.push(row);
      row = [];
      field = '';
    } else field += character;
  }
  if (quoted) throw new Error('Unterminated CSV quoted field.');
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const finiteNonnegative = (value: unknown): number | null => {
  if (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '') ||
    (typeof value !== 'number' && typeof value !== 'string')
  )
    return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const annualPeriod = (date: string) => ({
  start: `${date.slice(0, 4)}-01-01`,
  end: `${date.slice(0, 4)}-12-31`,
});
const monthlyPeriod = (date: string) => ({
  start: `${date.slice(0, 7)}-01`,
  end: new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10),
});
const overlaps = (
  period: { start: string; end: string },
  selected: AcquisitionSelection['period'],
) => period.start <= selected.end && period.end >= selected.start;

export function normalizeDamageEvidence(
  source: EvidenceSourceDefinition,
  raw: Uint8Array,
  selection: AcquisitionSelection,
): {
  values: NormalizedEvidenceValue[];
  gaps: string[];
  omitted_gap_count?: number;
  excerpt: EvidenceCapture['excerpt'];
} {
  const text = Buffer.from(raw).toString('utf8');
  if (source.kind === 'document') {
    if (
      /checking your browser|verify you are human|cf-chl-|<title>[^<]*(?:access denied|captcha)|enable javascript and cookies to continue/i.test(
        text,
      )
    )
      return {
        values: [],
        gaps: [
          'Document access challenge or denial was returned; retained bytes are not the requested source document.',
        ],
        excerpt: null,
      };
    if (text.startsWith('%PDF'))
      return {
        values: [],
        gaps: [
          'PDF original retained; passage extraction requires a registered PDF parser.',
        ],
        excerpt: null,
      };
    const extracted = text
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      values: [],
      gaps: [],
      excerpt: {
        text: extracted.slice(0, 12_000),
        locator:
          'deterministic HTML-to-text v1; extracted character offsets [0,12000)',
      },
    };
  }
  const values: NormalizedEvidenceValue[] = [],
    gaps: string[] = [];
  if (source.id === 'open-meteo-air-quality') {
    const response = z
      .object({
        latitude: z.number(),
        longitude: z.number(),
        hourly_units: z.object({ pm2_5: z.string() }),
        hourly: z.object({
          time: z.array(z.string().max(32)),
          pm2_5: z.array(z.number().nullable()),
        }),
      })
      .parse(JSON.parse(text));
    if (!['μg/m³', 'µg/m³', 'ug/m3'].includes(response.hourly_units.pm2_5))
      throw new Error(
        'PM2.5 concentration unit mismatch; indices and PM10 cannot be substituted.',
      );
    if (response.hourly.time.length !== response.hourly.pm2_5.length)
      throw new Error('Hourly PM2.5 and time arrays differ in length.');
    for (const [index, timestamp] of response.hourly.time.entries()) {
      const period = {
        start: timestamp.slice(0, 10),
        end: timestamp.slice(0, 10),
      };
      if (!overlaps(period, selection.period)) {
        gaps.push(
          `Response hour outside selected period at /hourly/time/${index}.`,
        );
        continue;
      }
      const value = finiteNonnegative(response.hourly.pm2_5[index]);
      if (value === null) {
        gaps.push(
          `Missing or invalid PM2.5 at /hourly/pm2_5/${index}; not zero.`,
        );
        continue;
      }
      values.push({
        input: 'ambient_pm25',
        value,
        unit: 'ug/m3',
        period,
        geography: {
          level: 'grid',
          name: `${response.latitude},${response.longitude}`,
          boundary_version: null,
        },
        strata: { timestamp, timezone: 'UTC', source_kind: 'modeled' },
        currency: null,
        price_year: null,
        source_locator: `/hourly/pm2_5/${index} with /hourly/time/${index}`,
        transformation: {
          operation: 'identity',
          factor: 1,
          original_value: value,
          original_unit: response.hourly_units.pm2_5,
        },
      });
    }
  } else {
    let rows: { record: Record<string, unknown>; locator: string }[];
    if (source.id === 'dosm-district-population') {
      selector(selection.state, 'state');
      selector(selection.district, 'district');
      const parsed = parseEvidenceCsv(text),
        columns = parsed.shift();
      if (
        !columns ||
        ![
          'state',
          'district',
          'date',
          'sex',
          'age',
          'ethnicity',
          'population',
        ].every((name) => columns.includes(name))
      )
        throw new Error('Population CSV columns changed.');
      rows = parsed.map((row, index) => ({
        record: Object.fromEntries(
          columns.map((column, columnIndex) => [column, row[columnIndex]]),
        ),
        locator: `/csv/record/${index + 2}`,
      }));
    } else {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed))
        throw new Error('Expected original provider JSON array.');
      if (parsed.length > 200)
        throw new Error(
          'Provider response may be truncated; narrow the selected period.',
        );
      rows = parsed.map((record: unknown, index) => ({
        record: z.record(z.string(), z.unknown()).parse(record),
        locator: `/${index}`,
      }));
    }
    const seen = new Set<string>();
    for (const { record, locator } of rows) {
      if (
        source.id !== 'malaysia-monthly-pollution' &&
        (record.state !== selection.state ||
          (source.id !== 'dosm-selangor-wages' &&
            record.district !== selection.district) ||
          record.sex !== selection.sex)
      )
        continue;
      if (
        source.id === 'dosm-district-population' &&
        (record.age !== selection.age ||
          record.ethnicity !== selection.ethnicity)
      )
        continue;
      const date = z.iso.date().parse(record.date);
      const period =
        source.id === 'malaysia-monthly-pollution'
          ? monthlyPeriod(date)
          : annualPeriod(date);
      if (!overlaps(period, selection.period)) continue;
      if (
        source.id === 'malaysia-monthly-pollution' &&
        !/^PM\s*2\.5$/i.test(String(record.pollutant))
      ) {
        gaps.push(`Rejected non-PM2.5 pollutant at ${locator}.`);
        continue;
      }
      const column =
        source.id === 'dosm-district-population'
          ? 'population'
          : source.id === 'dosm-district-deaths'
            ? 'abs'
            : source.id === 'dosm-selangor-wages'
              ? 'wages_mean'
              : 'concentration';
      const original = finiteNonnegative(record[column]);
      if (original === null) {
        gaps.push(`Missing or invalid ${column} at ${locator}; not zero.`);
        continue;
      }
      const key = `${date}:${String(record.state)}:${String(record.district)}:${String(record.sex)}:${String(record.age)}:${String(record.ethnicity)}`;
      if (seen.has(key))
        throw new Error(
          'Overlapping or duplicate selected population strata/observations.',
        );
      seen.add(key);
      const population = source.id === 'dosm-district-population',
        wages = source.id === 'dosm-selangor-wages',
        pollution = source.id === 'malaysia-monthly-pollution';
      if (population && !Number.isFinite(original * 1000)) {
        gaps.push(`Population normalization overflow at ${locator}; not zero.`);
        continue;
      }
      values.push({
        input: source.supported_inputs[0]!,
        value: original * (population ? 1000 : 1),
        unit: population ? 'persons' : source.units[0]!,
        period,
        geography: {
          level: pollution ? 'country' : wages ? 'state' : 'district',
          name: pollution
            ? 'Malaysia'
            : String(wages ? record.state : record.district),
          boundary_version: null,
        },
        strata: pollution
          ? { pollutant: 'PM2.5' }
          : {
              sex: String(record.sex),
              ...(population
                ? {
                    age: String(record.age),
                    ethnicity: String(record.ethnicity),
                  }
                : {}),
              ...(wages ? { population: 'covered citizen employees' } : {}),
            },
        currency: wages ? 'MYR' : null,
        price_year: wages ? Number(date.slice(0, 4)) : null,
        source_locator: `${locator}/${column}`,
        transformation: {
          operation: population ? 'multiply' : 'identity',
          factor: population ? 1000 : 1,
          original_value: original,
          original_unit: source.units[0]!,
        },
      });
    }
  }
  if (values.length === 0)
    gaps.push(
      'No numerical records match the requested geography, strata and occurrence period.',
    );
  if (values.length > 200)
    throw new Error(
      'Normalized response exceeds 200 values; narrow the selected period.',
    );
  return { values, ...boundEvidenceGaps(gaps), excerpt: null };
}

const providerQueues = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prior = providerQueues.get(key) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(work);
  providerQueues.set(key, next);
  try {
    return await next;
  } finally {
    if (providerQueues.get(key) === next) providerQueues.delete(key);
  }
}

async function download(
  url: string,
  source: EvidenceSourceDefinition,
  options: AcquireDamageEvidenceOptions,
) {
  const redirects: string[] = [];
  const requestOptions = {
    redirect: 'manual' as const,
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(45_000)]),
    headers: {
      Accept:
        source.kind === 'document'
          ? 'text/html,application/pdf,text/plain'
          : 'application/json,text/csv',
    },
  };
  let response = await (options.fetch ?? fetch)(url, requestOptions);
  while ([301, 302, 303, 307, 308].includes(response.status)) {
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location || redirects.length >= 3)
      throw new Error(
        'Missing redirect destination or redirect limit exceeded.',
      );
    const target = new URL(location, redirects.at(-1) ?? url);
    if (
      target.protocol !== 'https:' ||
      target.hostname !== new URL(url).hostname ||
      target.username ||
      target.password ||
      (target.port && target.port !== '443')
    )
      throw new Error('Source redirect leaves the registered HTTPS host.');
    redirects.push(target.toString());
    response = await (options.fetch ?? fetch)(
      target.toString(),
      requestOptions,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error(`Source HTTP ${response.status}`), {
      http_status: response.status,
    });
  }
  if (Number(response.headers.get('content-length')) > source.maximum_bytes) {
    await response.body?.cancel();
    throw new Error('Declared download exceeds source byte bound.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Source returned no response body.');
  const parts: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      options.signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      const chunk = z.instanceof(Uint8Array).parse(result.value);
      count += chunk.byteLength;
      if (count > source.maximum_bytes) {
        await reader.cancel();
        throw new Error('Streaming download exceeds source byte bound.');
      }
      parts.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return { response, bytes: Buffer.concat(parts), redirects };
}

export async function acquireDamageEvidence(
  archive: DamageEvidenceArchive,
  input: AcquisitionRequest,
  options: AcquireDamageEvidenceOptions,
): Promise<DamageEvidenceAcquisition> {
  const request = acquisitionRequestSchema.parse(input),
    source = options.source ?? damageEvidenceSource(request.source_id);
  if (source.id !== request.source_id)
    throw new Error('Source override does not match request.');
  if (source.kind === 'access_gap')
    throw new Error(source.access_requirements.join(' '));
  const url = damageEvidenceRequestUrl(source, request.selection),
    now = options.now ?? (() => new Date());
  const provider = new URL(url).hostname;
  return serialized(`${archive.throttleRoot}:${provider}`, async () => {
    const started = now().toISOString();
    const attempt: AcquisitionAttempt = {
      schema_version: 'haze.damage.evidence.attempt.v1',
      id: randomUUID(),
      source_id: source.id,
      request_key: evidenceRequestKey(request),
      started_at: started,
      finished_at: started,
      source_url: url,
      status: 'failed',
      http_status: null,
      capture_id: null,
      unchanged: false,
      error: null,
    };
    try {
      options.signal.throwIfAborted();
      const wait = Math.max(
        0,
        archive.throttleTime(provider) - now().getTime(),
      );
      if (wait)
        await (
          options.sleep ??
          ((milliseconds, signal) => delay(milliseconds, undefined, { signal }))
        )(wait, options.signal);
      options.signal.throwIfAborted();
      archive.reserveThrottle(
        provider,
        now().getTime() + source.minimum_request_interval_ms,
      );
      const { response, bytes, redirects } = await download(
        url,
        source,
        options,
      );
      attempt.http_status = response.status;
      const raw = archive.writeRaw(bytes);
      let normalized: ReturnType<typeof normalizeDamageEvidence>;
      try {
        normalized = normalizeDamageEvidence(source, bytes, request.selection);
      } catch (error) {
        normalized = {
          values: [],
          excerpt: null,
          gaps: [
            `Normalization rejected: ${(error instanceof Error ? error.message : String(error)).slice(0, 1900)}`,
          ],
        };
      }
      const captureId = evidenceSha256(
        JSON.stringify({
          request_key: attempt.request_key,
          raw_sha256: raw.raw_sha256,
          parser_version: source.parser_version,
        }),
      );
      const previous = archive.latest(request);
      const capture = archive.saveCapture({
        schema_version: 'haze.damage.evidence.capture.v1',
        capture_id: captureId,
        source_id: source.id,
        request_key: attempt.request_key,
        request,
        source_url: url,
        parser_version: source.parser_version,
        source_version: {
          etag: response.headers.get('etag'),
          last_modified: response.headers.get('last-modified'),
        },
        retrieved_at: now().toISOString(),
        ...raw,
        media_type:
          response.headers.get('content-type') ?? 'application/octet-stream',
        redirect_chain: redirects,
        document_published_at: null,
        observation_period: normalized.values.length
          ? {
              start: normalized.values.reduce(
                (min, item) =>
                  item.period.start < min ? item.period.start : min,
                normalized.values[0]!.period.start,
              ),
              end: normalized.values.reduce(
                (max, item) => (item.period.end > max ? item.period.end : max),
                normalized.values[0]!.period.end,
              ),
            }
          : null,
        evidence_origin: options.evidenceOrigin ?? 'external_source',
        stage:
          source.kind === 'numerical' &&
          normalized.values.length > 0 &&
          normalized.gaps.length === 0
            ? 'validated'
            : 'acquired',
        normalized_values: normalized.values,
        excerpt: normalized.excerpt,
        gaps: normalized.gaps,
        omitted_gap_count: normalized.omitted_gap_count ?? 0,
        limitations: source.limitations,
      });
      attempt.status = 'succeeded';
      attempt.capture_id = capture.capture_id;
      attempt.unchanged = previous?.capture_id === capture.capture_id;
      attempt.finished_at = now().toISOString();
      archive.saveAttempt(attempt);
      return { capture, attempt, unchanged: attempt.unchanged };
    } catch (error) {
      attempt.status = options.signal.aborted ? 'cancelled' : 'failed';
      attempt.finished_at = now().toISOString();
      attempt.http_status =
        error && typeof error === 'object' && 'http_status' in error
          ? Number(error.http_status)
          : attempt.http_status;
      attempt.error = error instanceof Error ? error.message : String(error);
      archive.saveAttempt(attempt);
      throw error;
    }
  });
}
