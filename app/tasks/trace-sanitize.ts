import type { JsonValue } from '../contracts/artifacts.js';
import { traceRecordSchema } from '../contracts/trace.js';

const withheld = '[withheld source body]';
const redacted = '[redacted]';
const secretKey =
  /(?:authorization|cookie|password|passwd|secret|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|lease[_-]?token|(?:^|[_-])token$)/i;
const secretEnvironmentKey =
  /(?:password|passwd|secret|credential|authorization|cookie|username|(?:^|[_-])(?:key|token)$)/i;
const bodyKey =
  /^(?:prompt|prompts|messages|input|output|request|response|body|content|request_body|response_body|raw_body|raw_output|excerpt|source_body|source_text|content_base64|copied_source|original_content)$/i;

/** One delivery policy for traces, stdout, HTTP and exported bytes. */
export function createTraceSanitizer(
  env: NodeJS.ProcessEnv = {},
  withheldSources: string[] = [],
) {
  const secrets = [
    ...new Set(
      Object.entries(env)
        .filter(
          ([key, value]) =>
            (secretKey.test(key) || secretEnvironmentKey.test(key)) &&
            value &&
            value.length >= 1,
        )
        .map(([, value]) => value!),
    ),
  ].sort((a, b) => b.length - a.length);
  const sources = [
    ...new Set(withheldSources.filter((value) => value.length > 0)),
  ].sort((a, b) => b.length - a.length);
  const sanitizeText = (input: string): string => {
    let result = input;
    const mask = (
      text: string,
      needle: string,
      replacement: string,
      minimum: number,
    ) =>
      needle.length >= minimum
        ? text.replaceAll(needle, replacement)
        : text.replace(
            new RegExp(
              `(?<![A-Za-z0-9_])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`,
              'g',
            ),
            replacement,
          );
    for (const secret of secrets) result = mask(result, secret, redacted, 4);
    for (const source of sources) result = mask(result, source, withheld, 8);
    result = result.replace(
      /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=:-]+/gi,
      redacted,
    );
    result = result.replace(
      /\b(?:authorization|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\s*[:=]\s*["']?[^\s,;"'}]+/gi,
      redacted,
    );
    return result.replace(/https?:\/\/[^\s<>"')]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        if (url.username || url.password) {
          url.username = '';
          url.password = '';
        }
        for (const key of [...url.searchParams.keys()])
          if (secretKey.test(key) || /^(?:key|token|sig|signature)$/i.test(key))
            url.searchParams.set(key, redacted);
        return url.toString();
      } catch {
        return redacted;
      }
    });
  };
  const structural = (key: string, value: string) =>
    (key === 'schema_version' && /^haze\.[A-Za-z0-9.:-]+$/.test(value)) ||
    (['event_id', 'event_ids'].includes(key) && /^trace:\d+$/.test(value)) ||
    ((key === 'id' || /_id$/.test(key)) &&
      /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value)) ||
    (/sha256$/.test(key) && /^[a-f\d]{64}$/.test(value)) ||
    ((key === 'at' || /_at$/.test(key)) &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value));
  const traceEnum = (path: string[], value: string): boolean => {
    const field = path.join('.');
    if (field === 'provenance.mode')
      return ['live', 'fixture', 'replay'].includes(value);
    if (field === 'provenance.capture')
      return ['native', 'reconstructed'].includes(value);
    if (field === 'reviews.verdict' || field === 'evidence_verdict')
      return ['supported', 'needs_review', 'rejected', 'not_required'].includes(
        value,
      );
    if (['status', 'execution_status', 'task_status'].includes(field))
      return [
        'queued',
        'running',
        'waiting',
        'paused',
        'completed',
        'failed',
        'timed_out',
        'cancelled',
        'started',
        'unknown',
        'stale',
      ].includes(value);
    return false;
  };
  const visit = (
    value: unknown,
    depth: number,
    path: string[] = [],
    trustedTrace = false,
  ): JsonValue => {
    const key = path.at(-1) ?? '';
    if (depth > 32) return '[withheld: depth limit]';
    if (typeof value === 'string')
      return structural(key, value) || (trustedTrace && traceEnum(path, value))
        ? value
        : sanitizeText(value);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (Array.isArray(value))
      return value.map((item) => visit(item, depth + 1, path, trustedTrace));
    if (typeof value === 'object') {
      const result: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        Object.defineProperty(result, key, {
          enumerable: true,
          value: secretKey.test(key)
            ? redacted
            : bodyKey.test(key)
              ? withheld
              : visit(item, depth + 1, [...path, key], trustedTrace),
        });
      }
      return result;
    }
    return null;
  };
  return {
    sanitizeText,
    sanitize: (value: unknown): JsonValue =>
      visit(value, 0, [], traceRecordSchema.safeParse(value).success),
  };
}

export type TraceSanitizer = ReturnType<typeof createTraceSanitizer>;
