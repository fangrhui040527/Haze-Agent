import { afterEach, describe, expect, it, vi } from 'vitest';
import { zetarisAdapter } from '../../dist/capabilities/evidence-collection/sources/zetaris.js';
import { KLANG } from './helpers.ts';

afterEach(() => vi.unstubAllGlobals());

describe('Zetaris pinned query values', () => {
  it('keeps missing and nonnumeric values missing while preserving real zero', async () => {
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
              locationId: KLANG.id,
              observedAt,
              pm25,
            })),
          }),
        ),
    );
    const adapter = zetarisAdapter([KLANG], {
      baseUrl: 'https://zetaris.test',
      username: 'test',
      password: 'test',
      queries: [
        {
          id: 'test',
          version: 1,
          description: 'Test query',
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
    const result = await adapter.run({
      now: new Date(observedAt),
      signal: new AbortController().signal,
      runId: 'test',
    });
    expect(result.facts.map((f) => f.value.value)).toEqual([
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
    const check = result.evidence[0]?.record.checks.find(
      (c) => c.id === 'coverage.values',
    );
    expect(check?.result).toBe('warn');
    expect(check?.detail).toContain('9 missing');
  });
});
