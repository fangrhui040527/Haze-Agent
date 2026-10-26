import { describe, expect, it, vi } from 'vitest';
import {
  PM25_SOURCE_ID,
  resolveEvidenceSource,
} from '../../app/capabilities/pm25/evidence.js';
import {
  analyzePm25,
  independentlyCheckPm25,
} from '../../app/capabilities/pm25/methods.js';

const env = {
  ZETARIS_API_KEY: 'test-secret-not-in-artifacts',
  ZETARIS_REST_URL: 'https://zetaris.example/api/v1.0',
  ZETARIS_ORG_ID: '1',
};
const scope = {
  location: 'Selected Town',
  period: { start: '2026-10-24T00:00:00Z', end: '2026-10-24T03:00:00Z' },
};
const row: unknown[] = [
  'Selected Town',
  '2026-10-24 00:00:00',
  'model',
  '2026-10-23 12:00:00',
  18,
  'open-meteo-air-quality',
  '2026-10-24 00:05:00',
  3.04,
  101.44,
];
const signal = () => new AbortController().signal;

describe('Zetaris Open-Meteo snapshot PM2.5 evidence boundary', () => {
  it('reconstructs decimal-string REST cells without changing the retained evidence', async () => {
    const encoded = [...row];
    encoded[4] = '1.8E1';
    encoded[7] = '3.04';
    encoded[8] = '101.44';
    const raw = JSON.stringify({ data: [encoded] });
    const evidence = await resolveEvidenceSource(
      env,
      vi.fn<typeof fetch>().mockResolvedValue(new Response(raw)),
    ).retrieve(scope, signal());
    expect(evidence.raw).toBe(raw);
    expect(evidence.rows[0]).toMatchObject({
      value: 18,
      latitude: 3.04,
      longitude: 101.44,
    });
    expect(
      independentlyCheckPm25(evidence, analyzePm25(evidence, scope), scope)
        .valid,
    ).toBe(true);
  });

  it.each(['', ' ', 'Infinity', '0x10', true, false])(
    'rejects a nonnumeric REST concentration %j',
    async (value) => {
      const invalid = [...row];
      invalid[4] = value;
      await expect(
        resolveEvidenceSource(
          env,
          vi
            .fn<typeof fetch>()
            .mockResolvedValue(Response.json({ data: [invalid] })),
        ).retrieve(scope, signal()),
      ).rejects.toMatchObject({ code: 'invalid_evidence' });
    },
  );

  it('preserves an unknown remote outcome after network interruption without substituting evidence', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('private transport failure'));
    await expect(
      resolveEvidenceSource(env, fetcher).retrieve(scope, signal()),
    ).rejects.toMatchObject({ code: 'provider_failure', outcome: 'unknown' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('captures the exact response, selection and model semantics without claiming issuance', async () => {
    const raw = `{ "data": ${JSON.stringify([row])} }`;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(raw));
    const capture = await resolveEvidenceSource(env, fetcher).retrieve(
      scope,
      signal(),
    );
    expect(capture.source).toBe(PM25_SOURCE_ID);
    expect(capture.raw).toBe(raw);
    expect(capture.kind).toBe('modeled');
    expect(capture.temporal_support).toBe('instantaneous');
    expect(capture.issued_at).toBeNull();
    expect(capture.rows).toEqual([
      {
        start: '2026-10-24T00:00:00.000Z',
        end: '2026-10-24T00:00:00.000Z',
        issued_at: null,
        ingested_at: '2026-10-24T00:05:00.000Z',
        value: 18,
        location: 'Selected Town',
        latitude: 3.04,
        longitude: 101.44,
      },
    ]);
    expect(capture.selection.selected_raw_row_indices).toEqual([0]);
    expect(JSON.stringify(capture)).not.toContain(env.ZETARIS_API_KEY);
    const body = JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string) as {
      sql: string;
    };
    expect(body.sql).toContain('FROM air_quality.hourly_observations q');
    expect(body.sql).not.toContain('sl_pg');
    expect(body.sql).toContain("'Selected Town'");
    expect(body.sql).toContain(
      "q.observation_time < '2026-10-24T03:00:00.000Z'",
    );
    expect(body.sql).not.toContain('TIMESTAMP');
    expect(body.sql).toContain("'open-meteo-air-quality' AS source");
    expect(body.sql).toContain('q.ingested_utc');
    expect(body.sql).toContain('q.requested_latitude AS lat');
  });

  it('normalizes numeric strings returned by the Zetaris SQL API', async () => {
    const stringNumbers = [...row];
    stringNumbers[4] = '18.5';
    stringNumbers[7] = '3.04';
    stringNumbers[8] = '101.44';
    const capture = await resolveEvidenceSource(
      env,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ data: [stringNumbers] })),
    ).retrieve(scope, signal());
    expect(capture.rows[0]).toMatchObject({
      value: 18.5,
      latitude: 3.04,
      longitude: 101.44,
    });
    expect(analyzePm25(capture, scope).coverage.usable_row_count).toBe(1);
  });

  it.each(['', '18.5µg/m3', 'NaN', 'Infinity'])(
    'rejects malformed string concentrations: %s',
    async (value) => {
      const malformed = [...row];
      malformed[4] = value;
      await expect(
        resolveEvidenceSource(
          env,
          vi
            .fn<typeof fetch>()
            .mockResolvedValue(Response.json({ data: [malformed] })),
        ).retrieve(scope, signal()),
      ).rejects.toMatchObject({ code: 'invalid_evidence' });
    },
  );

  it('selects latest ingestion per sample and preserves null values as unknown', async () => {
    const newest = [...row];
    newest[4] = null;
    newest[6] = '2026-10-24 01:00:00';
    const capture = await resolveEvidenceSource(
      env,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ data: [row, newest] })),
    ).retrieve(scope, signal());
    expect(capture.rows).toHaveLength(1);
    expect(capture.rows[0]?.value).toBeNull();
    expect(capture.selection.selected_raw_row_indices).toEqual([1]);
    expect(capture.selection.returned_rows).toBe(2);
  });

  it.each([
    {},
    { ...env, SAMPLE_MODE: 'true' },
    { ...env, SAMPLE_MODE: ' enabled ' },
    { ...env, SAMPLE_MODE: ' 1 ' },
  ])('reports unavailable access without fallback for %j', async (settings) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      resolveEvidenceSource(settings, fetcher).retrieve(scope, signal()),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['false', ' FALSE ', '0', ' 0 ', ''])(
    'honors explicit live SAMPLE_MODE=%s',
    async (sampleMode) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ data: [] }));
      await expect(
        resolveEvidenceSource(
          { ...env, SAMPLE_MODE: sampleMode },
          fetcher,
        ).retrieve(scope, signal()),
      ).resolves.toMatchObject({ mode: 'live' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('does not turn an HTTP failure or malformed response into empty evidence', async () => {
    const failed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('provider detail', { status: 401 }));
    await expect(
      resolveEvidenceSource(env, failed).retrieve(scope, signal()),
    ).rejects.toMatchObject({ code: 'provider_failure', outcome: 'failed' });
    expect(failed).toHaveBeenCalledTimes(1);
    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: 'query failed' }));
    await expect(
      resolveEvidenceSource(env, malformed).retrieve(scope, signal()),
    ).rejects.toMatchObject({ code: 'invalid_evidence' });
  });

  it('rejects an upstream credential echo before capturing the response', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ data: [row], debug: env.ZETARIS_API_KEY }),
      );
    const error: unknown = await resolveEvidenceSource(env, fetcher)
      .retrieve(scope, signal())
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'invalid_evidence' });
    expect(String(error)).not.toContain(env.ZETARIS_API_KEY);
  });

  it('rejects returned rows outside the authorized selection', async () => {
    const otherTown = ['Other Town', ...row.slice(1)];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [otherTown] }));
    await expect(
      resolveEvidenceSource(env, fetcher).retrieve(scope, signal()),
    ).rejects.toMatchObject({ code: 'invalid_evidence' });
  });

  it('keeps zero-row search scope and truncation explicit', async () => {
    const empty = await resolveEvidenceSource(
      env,
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [] })),
    ).retrieve(scope, signal());
    expect(empty.rows).toEqual([]);
    expect(empty.location).toBe(scope.location);
    const capture = await resolveEvidenceSource(
      env,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ data: Array.from({ length: 1_501 }, () => row) }),
        ),
    ).retrieve(scope, signal());
    expect(capture.selection.truncated).toBe(true);
    expect(
      capture.limitations.some((limitation) =>
        limitation.includes('truncated'),
      ),
    ).toBe(true);
  });

  it('bounds the response and prevents requests after cancellation', async () => {
    const oversized = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('x'.repeat(524_289)));
    await expect(
      resolveEvidenceSource(env, oversized).retrieve(scope, signal()),
    ).rejects.toMatchObject({ code: 'invalid_evidence' });
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      resolveEvidenceSource(env, fetcher).retrieve(scope, controller.signal),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('escapes a quoted location as a single SQL literal and rejects overlarge scope', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [] }));
    await resolveEvidenceSource(env, fetcher).retrieve(
      { ...scope, location: "O'Brien" },
      signal(),
    );
    const body = JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string) as {
      sql: string;
    };
    expect(body.sql).toContain("LOWER('O''Brien')");
    fetcher.mockClear();
    await expect(
      resolveEvidenceSource(env, fetcher).retrieve(
        { ...scope, period: { ...scope.period, end: '2026-12-24T00:00:00Z' } },
        signal(),
      ),
    ).rejects.toThrow('at most 31 days');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
