import { afterEach, describe, expect, it, vi } from 'vitest';
import { openMeteoAdapter } from '../src/hazeops/adapters/openMeteo.ts';
import {
  freshnessCheck,
  normaliseUnit,
  valuesCheck,
} from '../src/hazeops/checks.ts';
import { KLANG } from './helpers.ts';

describe('checks', () => {
  it('normalises the Greek mu Open-Meteo sends', () => {
    expect(normaliseUnit('μg/m³')).toBe('µg/m³');
    expect(normaliseUnit('ppm')).toBeNull();
  });

  it('keeps missing values missing and rejects negative ones', () => {
    expect(valuesCheck([1, null, 3]).result).toBe('warn');
    expect(valuesCheck([1, -2]).result).toBe('fail');
    expect(valuesCheck([1, 2]).result).toBe('pass');
  });

  it('applies the freshness rule', () => {
    const now = new Date('2026-10-24T12:00:00Z');
    expect(freshnessCheck('2026-10-24T11:00:00Z', now, 180).result).toBe(
      'pass',
    );
    expect(freshnessCheck('2026-10-24T06:00:00Z', now, 180).result).toBe(
      'fail',
    );
  });
});

describe('Open-Meteo adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('turns the response into a modeled reading and a forecast, with pinned evidence', async () => {
    const time = Array.from({ length: 72 }, (_, h) =>
      new Date(Date.UTC(2026, 9, 23, h)).toISOString().slice(0, 16),
    );
    const pm25 = time.map((_, h) => (h < 32 ? 40 : 20));
    const body = {
      latitude: 3,
      longitude: 101.4,
      hourly_units: { pm2_5: 'μg/m³' },
      hourly: { time, pm2_5: pm25, pm10: pm25 },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
      ),
    );

    const result = await openMeteoAdapter([KLANG]).run({
      now: new Date('2026-10-24T08:20:00Z'),
      signal: new AbortController().signal,
      runId: 'test',
    });

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.record).toMatchObject({
      sourceKind: 'modeled',
      unit: 'µg/m³',
      acceptedAt: null,
    });
    const reading = result.facts.find((f) => f.predicate === 'pm25_modeled');
    expect(reading).toMatchObject({
      observedAt: '2026-10-24T08:00:00Z',
      value: { value: 20 },
    });
    const forecast = result.facts.find(
      (f) => f.predicate === 'pm25_forecast_24h',
    );
    expect(forecast?.value).toMatchObject({
      direction: 'improving',
      maxPm25: 20,
    });
  });
});
