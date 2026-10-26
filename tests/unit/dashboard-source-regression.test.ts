import { afterEach, describe, expect, it, vi } from 'vitest';
import { zetarisAdapter } from '../../app/capabilities/evidence-collection/sources/zetaris.js';
import { openMeteoAdapter } from '../../app/capabilities/evidence-collection/sources/openMeteo.js';
import { locationsFor } from '../../app/dashboard/locations.js';

const klang = locationsFor('malaysia').find(
  (location) => location.id === 'klang',
)!;
afterEach(() => vi.unstubAllGlobals());

describe('migrated dashboard source semantics', () => {
  it('keeps missing and nonnumeric Zetaris values missing while preserving real zero', async () => {
    const values: unknown[] = [
      null,
      '',
      '   ',
      false,
      true,
      [],
      {},
      undefined,
      'bad',
      '18.2',
      0,
      '0',
    ];
    const observedAt = '2026-10-25T12:00:00.000Z';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ idToken: 'test-token', orgId: 1 }),
        )
        .mockResolvedValueOnce(
          Response.json({
            rows: values.map((pm25) => ({
              locationId: klang.id,
              observedAt,
              pm25,
            })),
          }),
        ),
    );
    const source = zetarisAdapter([klang], {
      baseUrl: 'https://zetaris.test',
      username: 'test',
      password: 'test',
      queries: [
        {
          id: 'test',
          version: 1,
          description: 'Pinned synthetic query',
          sql: 'select test',
          sourceKind: 'modeled',
          unit: 'µg/m³',
          columns: {
            locationId: 'locationId',
            observedAt: 'observedAt',
            pm25: 'pm25',
          },
        },
      ],
    });
    const capture = await source.run({
      now: new Date(observedAt),
      signal: new AbortController().signal,
      runId: 'test',
    });
    expect(capture.facts.map((fact) => fact.value.value)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      18.2,
      0,
      0,
    ]);
    const check = capture.evidence[0]!.record.checks.find(
      (item) => item.id === 'coverage.values',
    );
    expect(check?.result).toBe('warn');
    expect(check?.detail).toContain('9 missing');
  });

  it('retains the exact source forecast interval instead of extending it at read time', async () => {
    const at = new Date('2026-10-25T12:00:00.000Z');
    const times = Array.from({ length: 30 }, (_, index) =>
      new Date(at.getTime() + (index - 3) * 3_600_000)
        .toISOString()
        .slice(0, 16),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          latitude: klang.lat,
          longitude: klang.lon,
          hourly_units: { pm2_5: 'µg/m³', pm10: 'µg/m³' },
          hourly: {
            time: times,
            pm2_5: times.map((_, index) => index),
            pm10: times.map(() => 0),
          },
        }),
      ),
    );
    const capture = await openMeteoAdapter([klang]).run({
      now: at,
      signal: new AbortController().signal,
      runId: 'forecast-test',
    });
    const forecast = capture.facts.find(
      (fact) => fact.predicate === 'pm25_forecast_24h',
    )!;
    expect(forecast.value.validFrom).toBe('2026-10-25T13:00:00Z');
    expect(forecast.value.validTo).toBe('2026-10-26T12:00:00Z');
    expect(forecast.observedAt).toBe('2026-10-25T12:00:00Z');
    expect(capture.evidence[0]!.record.acceptedAt).toBeNull();
    expect(capture.evidence[0]!.record.sourceKind).toBe('modeled');
  });
});
