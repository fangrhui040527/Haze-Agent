import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  SmokeLedgerReport,
  localDays,
  readSmokeTrace,
} from './SmokeLedgerReport.tsx';

const claim = (text: string) => ({ text });
const content = {
  operation: 'trace_sources',
  scope: {
    town: 'Batu Pahat',
    window: {
      start: '2026-10-24T00:00:00+08:00',
      end: '2026-10-26T00:00:00+08:00',
    },
  },
  response: {
    mode: 'live',
    output: {
      claims: [
        claim(
          'Air quality: model PM2.5 at Batu Pahat averaged 12.8 ug/m3 with a peak of 34.3 ug/m3 [E-ccca380c40].',
        ),
        claim(
          'Where the smoke-relevant fires were (approximate area boxes, not province boundaries): Sumatra and nearby islands 92.7% of the smoke signal (range 92.7-96.2%), 6107 detections; Borneo (Kalimantan, Sarawak, Sabah, Brunei) 3.1% of the smoke signal (range 0.9-3.1%), 4281 detections [E-40023a3949].',
        ),
        claim(
          'Fire hotspot centred at -1.375, 104.125 (0.25 degree cell): 24.7% of the smoke signal, 745 detections, peak FRP 289.6 MW, seen 2026-10-22 06:50 UTC to 2026-10-23 19:13 UTC [E-6795fa05d3].',
        ),
        claim(
          'Fires inside mapped concessions: 7.5% (range 6.5%-8.3%) of the smoke signal, from 2446 detections [E-990b40e6fd].',
        ),
        claim(
          'Fires on peat: 29.0% (range 29.0%-30.3%) of the smoke signal, from 1238 detections [E-990b40e6fd]. Peat map used: Indonesia forest moratorium (PIPPIB 2020) peatland areas via GFW; it covers only peat inside the moratorium, so peat shares are minimums [E-1234567890].',
        ),
        claim(
          "Confidence: high by SmokeLedger's rule (high when the concession share varies by 10 percentage points or less across wind speeds) [E-990b40e6fd].",
        ),
        claim(
          'Asia Pulp And Paper Supplier: 2.0% (range 1.9%-2.0%), 299 detections [E-a161507084].',
        ),
      ],
      limitations: [
        'Fire detections inside a concession show where land burned, not who lit it; names are leads for verification.',
      ],
    },
    map: {
      fire_count: 10601,
      shares: {
        concession: { central: 7.5, low: 6.5, high: 8.3 },
        peat: { central: 29, low: 29, high: 30.3 },
      },
      method: {
        hours_back: 72,
        paths_per_wind_speed: 170,
        assumptions: ['Peat fires count 3x; an uncalibrated placeholder.'],
      },
    },
  },
};

describe('SmokeLedger report', () => {
  it('reads the reviewed findings into plain figures', () => {
    const trace = readSmokeTrace(content)!;
    expect(trace.areas.map((a) => [a.name, a.share])).toEqual([
      ['Sumatra and nearby islands', 92.7],
      ['Borneo (Kalimantan, Sarawak, Sabah, Brunei)', 3.1],
    ]);
    expect(trace.hotspots[0]).toMatchObject({
      lat: -1.375,
      share: 24.7,
      detections: 745,
      seen: '22 Oct 06:50 – 23 Oct 19:13 UTC',
    });
    expect(trace.holders).toEqual([
      {
        name: 'Asia Pulp And Paper Supplier',
        share: 2,
        low: 1.9,
        high: 2,
        detections: 299,
      },
    ]);
    expect(trace.air).toEqual({ mean: 12.8, peak: 34.3 });
    expect(trace.confidence).toBe('high');
    expect(trace.peatIsMinimum).toBe(true);
    expect(readSmokeTrace(null)).toBeNull();
  });

  it('shows the window as local calendar days', () => {
    expect(localDays(content.scope.window)).toBe('24–25 Oct 2026');
    expect(
      localDays({
        start: '2026-10-31T00:00:00+08:00',
        end: '2026-11-02T00:00:00+08:00',
      }),
    ).toBe('31 Oct – 1 Nov 2026');
  });

  it('leads with a plain answer and hides evidence ids', () => {
    const markup = renderToStaticMarkup(
      createElement(SmokeLedgerReport, {
        trace: readSmokeTrace(content)!,
        content,
        result: { review: { status: 'supported' } } as never,
      }),
    );
    expect(markup).toContain('Where did the smoke over Batu Pahat come from?');
    expect(markup).toContain('Checked by an independent reviewer');
    expect(markup).toContain('Sumatra and nearby islands');
    expect(markup).toContain('at least <b>29.0%</b>');
    expect(markup).toContain('not who started');
    expect(markup).not.toContain('[E-');
    expect(markup).not.toContain('World Model');
  });
});
