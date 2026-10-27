import {
  EvidenceSourceError,
  PM25_SOURCE_ID,
  type EvidenceSource,
} from '../capabilities/pm25/evidence.js';
import { captureSchema } from '../capabilities/pm25/methods.js';

/** Only evidence is substituted. Manager and specialist models still execute. */
export function createSamplePm25Source(
  env: NodeJS.ProcessEnv = {},
): EvidenceSource {
  return {
    id: PM25_SOURCE_ID,
    description:
      'Read local cached synthetic PM2.5 rows for the requested location and UTC interval. No Zetaris, web access or evidence credentials are needed. Missing rows remain gaps; observations and attribution are not supplied.',
    async retrieve(scope, signal) {
      signal.throwIfAborted();
      const filename = env.HAZE_SAMPLE_PM25_FILE
        ? resolve(env.HAZE_SAMPLE_PM25_FILE)
        : new URL(
            '../../data/sample-scenarios/01-evidence/pm25-capture.json',
            import.meta.url,
          );
      const bytes = await readFile(filename);
      if (bytes.length > 524_288)
        throw new EvidenceSourceError(
          'The local sample exceeds its byte limit.',
          'invalid_evidence',
        );
      const capture = captureSchema.parse(JSON.parse(bytes.toString('utf8')));
      if (capture.evidence_origin !== 'synthetic_fixture')
        throw new EvidenceSourceError(
          'Sample input must declare synthetic provenance.',
          'invalid_evidence',
        );
      if (
        scope.location.trim().toLowerCase() !==
        capture.location.trim().toLowerCase()
      )
        throw new EvidenceSourceError(
          `The local synthetic dataset covers ${capture.location}, not ${scope.location}. No live evidence was queried.`,
          'unavailable',
        );
      const from = Date.parse(scope.period.start);
      const until = Date.parse(scope.period.end);
      const within = (value: string) =>
        Date.parse(value) >= from && Date.parse(value) < until;
      const raw = JSON.parse(capture.raw) as {
        data: Record<string, unknown>[];
      };
      if (!Array.isArray(raw.data))
        throw new EvidenceSourceError(
          'The sample has no raw source rows.',
          'invalid_evidence',
        );
      const rawInstant = (value: unknown) => {
        if (typeof value !== 'string') return '';
        const iso = value.replace(' ', 'T');
        return /(?:Z|[+-]\d\d:?\d\d)$/iu.test(iso) ? iso : `${iso}Z`;
      };
      const selected = raw.data.flatMap((row, index) =>
        within(rawInstant(Array.isArray(row) ? row[1] : row.valid_utc))
          ? [{ row, index }]
          : [],
      );
      const indices = new Map(
        selected.map((item, index) => [item.index, index]),
      );
      const rows = capture.rows.flatMap((row, index) =>
        within(row.start)
          ? [
              {
                row,
                rawIndex: capture.selection.selected_raw_row_indices[index]!,
              },
            ]
          : [],
      );
      signal.throwIfAborted();
      return {
        ...capture,
        // This describes the genuine executing agent loop; evidence_origin
        // remains synthetic and is retained in the artifact and final answer.
        mode: 'live',
        retrieved_at: new Date().toISOString(),
        rows: rows.map(({ row }) => row),
        raw: JSON.stringify({ data: selected.map(({ row }) => row) }),
        selection: {
          ...capture.selection,
          backend: 'sample-file',
          query:
            'Local synthetic file selection by requested location and UTC interval; no SQL or external evidence request was executed.',
          request_id: `sample-file:${createHash('sha256').update(bytes).digest('hex')}`,
          returned_rows: selected.length,
          truncated: false,
          selected_raw_row_indices: rows.map(
            ({ rawIndex }) => indices.get(rawIndex) ?? -1,
          ),
        },
        limitations: [
          ...capture.limitations,
          'SAMPLE_MODE=true: synthetic local evidence with configured model inference; no live evidence source was queried.',
        ],
      };
    },
  };
}
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
