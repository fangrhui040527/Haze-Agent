import { describe, expect, it } from 'vitest';
import {
  analyzePm25,
  framePm25Scope,
  independentlyCheckPm25,
  validateCapture,
  type Pm25Analysis,
} from '../../app/capabilities/pm25/methods.js';
import {
  PM25_SOURCE_ID,
  LEGACY_PM25_SOURCE_ID,
  type EvidenceCapture,
  type EvidenceScope,
} from '../../app/capabilities/pm25/evidence.js';

const scope: EvidenceScope = {
  location: 'Fixture Town',
  period: {
    start: '2026-10-24T00:00:00Z',
    end: '2026-10-24T04:00:00Z',
  },
};

/** Explicit fixtures; these tests make no claim of live evidence readiness. */
function capture(
  values: (number | null)[] = [10, 30, 20, 15],
): EvidenceCapture {
  const rows = values.map((value, index) => ({
    start: new Date(
      Date.parse(scope.period.start) + index * 3_600_000,
    ).toISOString(),
    end: new Date(
      Date.parse(scope.period.start) + index * 3_600_000,
    ).toISOString(),
    value,
    issued_at: null,
    location: scope.location,
    ingested_at: '2026-10-24T05:00:00.000Z',
    latitude: null,
    longitude: null,
  }));
  return {
    source: PM25_SOURCE_ID,
    kind: 'modeled',
    units: 'µg/m³',
    location: scope.location,
    retrieved_at: '2026-10-24T06:00:00Z',
    issued_at: null,
    rows,
    raw: JSON.stringify({
      data: rows.map((row) => [
        row.location,
        row.start,
        'model',
        '2026-10-23T01:00:00Z',
        row.value,
        'open-meteo-air-quality',
        row.ingested_at,
        row.latitude,
        row.longitude,
      ]),
    }),
    selection: {
      backend: 'zetaris-rest',
      query: 'Explicit PM2.5 fixture selection; no query was executed.',
      request_id: 'fixture-selection-1',
      row_limit: 1500,
      returned_rows: rows.length,
      truncated: false,
      source_filter: 'open-meteo-air-quality',
      selected_raw_row_indices: rows.map((_, index) => index),
    },
    limitations: ['Synthetic fixture; no live readiness established.'],
    mode: 'live',
    temporal_support: 'instantaneous',
    sample_interval_minutes: 60,
    units_reference: 'https://open-meteo.com/en/docs/air-quality-api',
  };
}

describe('PM2.5 capability boundary and independent analysis', () => {
  it('can still reconstruct retained SmokeLedger captures after the source migration', () => {
    const evidence = capture();
    evidence.source = LEGACY_PM25_SOURCE_ID;
    const raw = evidence.raw;
    const analysis = analyzePm25(evidence, scope);
    expect(independentlyCheckPm25(evidence, analysis, scope).valid).toBe(true);
    expect(evidence.source).toBe(LEGACY_PM25_SOURCE_ID);
    expect(evidence.raw).toBe(raw);
    evidence.source = 'unrelated-source';
    expect(() => validateCapture(evidence, scope)).toThrow(
      'authorized selection',
    );
  });

  it('frames explicit requests without defaulting ambiguous places or times', () => {
    expect(
      framePm25Scope({
        objective:
          'Summarize PM2.5 for Fixture Town during 2026-10-24 to 2026-10-25',
      }),
    ).toEqual({
      location: scope.location,
      period: { start: '2026-10-24T00:00:00Z', end: '2026-10-25T00:00:00Z' },
    });
    expect(
      framePm25Scope({ objective: 'Summarize PM2.5 evidence.', scope }),
    ).toEqual(scope);
    expect(() =>
      framePm25Scope({ objective: 'Summarize PM2.5 evidence.' }),
    ).toThrow('explicit UTC');
    expect(
      framePm25Scope({
        objective: 'Change the selected town; keep the interval.',
        scope,
      }),
    ).toEqual(scope);
    expect(() => framePm25Scope({ objective: 'Summarize rainfall.' })).toThrow(
      'PM2.5',
    );
    expect(() =>
      framePm25Scope({
        objective:
          'Summarize PM2.5 for Other Town during 2026-10-24 to 2026-10-25',
        scope,
      }),
    ).toThrow('conflicts');
  });

  it('computes a fully retained modeled range and distinguishes instantaneous semantics', () => {
    const evidence = capture();
    const analysis = analyzePm25(evidence, scope);
    expect(analysis.range).toEqual({ min: 10, max: 30 });
    expect(analysis.coverage).toEqual({
      requested: scope,
      row_count: 4,
      usable_row_count: 4,
      modeled_count: 4,
      observation_count: 0,
      unknown_kind_count: 0,
      missing_intervals: [],
      status: 'available',
    });
    expect(analysis.findings[0]?.text).toContain(
      'not observations or hourly averages',
    );
    expect(analysis.unresolved_gaps.join(' ')).toContain(
      'Provider issuance time is unknown',
    );
    expect(independentlyCheckPm25(evidence, analysis, scope)).toMatchObject({
      valid: true,
      findings: [],
    });
  });

  it('counts nulls as missing and merges adjacent absent timestamps without implying continuous support', () => {
    const evidence = capture([10, null, null, 15]);
    const analysis = analyzePm25(evidence, scope);
    expect(analysis.coverage).toMatchObject({
      row_count: 4,
      usable_row_count: 2,
      modeled_count: 2,
      missing_intervals: [
        { start: '2026-10-24T01:00:00.000Z', end: '2026-10-24T03:00:00.000Z' },
      ],
      status: 'partial',
    });
    expect(analysis.range).toEqual({ min: 10, max: 15 });
    expect(independentlyCheckPm25(evidence, analysis, scope).valid).toBe(true);
  });

  it.each([{ values: [] }, { values: [null, null, null, null] }])(
    'reports insufficient evidence for $values',
    ({ values }) => {
      const evidence = capture(values);
      const analysis = analyzePm25(evidence, scope);
      expect(analysis.range).toEqual({ min: null, max: null });
      expect(analysis.coverage).toMatchObject({
        usable_row_count: 0,
        status: 'insufficient_evidence',
        missing_intervals: [
          {
            start: '2026-10-24T00:00:00.000Z',
            end: '2026-10-24T04:00:00.000Z',
          },
        ],
      });
      expect(independentlyCheckPm25(evidence, analysis, scope).valid).toBe(
        true,
      );
    },
  );

  it('treats a truncated raw selection as partial even when every expected timestamp is retained', () => {
    const evidence = capture();
    const payload = JSON.parse(evidence.raw) as { data: unknown[] };
    payload.data.push(payload.data[0]);
    evidence.raw = JSON.stringify(payload);
    evidence.selection = {
      ...evidence.selection,
      row_limit: 4,
      returned_rows: 5,
      truncated: true,
    };
    const analysis = analyzePm25(evidence, scope);
    expect(analysis.coverage.missing_intervals).toEqual([]);
    expect(analysis.coverage.status).toBe('partial');
    expect(analysis.unresolved_gaps.join(' ')).toContain('truncated');
    expect(independentlyCheckPm25(evidence, analysis, scope).valid).toBe(true);
  });

  it('checks partial-hour boundaries with the same explicit expected-hour interpretation', () => {
    const evidence = capture([10, 30]);
    const shiftedScope = {
      ...scope,
      period: { start: '2026-10-24T00:00:00Z', end: '2026-10-24T02:30:00Z' },
    };
    const analysis = analyzePm25(evidence, shiftedScope);
    expect(analysis.coverage.missing_intervals).toEqual([
      { start: '2026-10-24T02:00:00.000Z', end: '2026-10-24T02:30:00.000Z' },
    ]);
    expect(independentlyCheckPm25(evidence, analysis, shiftedScope).valid).toBe(
      true,
    );
  });

  it.each([
    [
      'range',
      (analysis: Pm25Analysis) => {
        analysis.range.max = 999;
      },
    ],
    [
      'counts',
      (analysis: Pm25Analysis) => {
        analysis.coverage.modeled_count = 1;
      },
    ],
    [
      'missingness',
      (analysis: Pm25Analysis) => {
        analysis.coverage.missing_intervals = [];
      },
    ],
    [
      'availability',
      (analysis: Pm25Analysis) => {
        analysis.coverage.status = 'available';
      },
    ],
    [
      'scope',
      (analysis: Pm25Analysis) => {
        analysis.scope = { ...scope, location: 'Other Town' };
      },
    ],
  ])('independently rejects tampered %s', (_label, tamper) => {
    const evidence = capture([10, null, 20, 15]);
    const analysis = structuredClone(analyzePm25(evidence, scope));
    tamper(analysis);
    const checked = independentlyCheckPm25(evidence, analysis, scope);
    expect(checked.valid).toBe(false);
    expect(checked.findings.length).toBeGreaterThan(0);
  });

  it('rejects fabricated citation targets and duplicate finding identities', () => {
    const evidence = capture();
    const analysis = analyzePm25(evidence, scope);
    expect(
      independentlyCheckPm25(
        evidence,
        {
          ...analysis,
          findings: [{ ...analysis.findings[0], citation_ids: ['E2'] }],
        },
        scope,
      ).valid,
    ).toBe(false);
    analysis.findings[1]!.id = analysis.findings[0]!.id;
    expect(
      independentlyCheckPm25(evidence, analysis, scope).findings.join(' '),
    ).toContain('duplicated');
  });

  it.each([
    [
      'missing runtime rows',
      (evidence: EvidenceCapture) => ({ ...evidence, rows: undefined }),
    ],
    [
      'string concentration',
      (evidence: EvidenceCapture) => ({
        ...evidence,
        rows: [{ ...evidence.rows[0], value: '10' }],
      }),
    ],
    [
      'negative concentration',
      (evidence: EvidenceCapture) => ({
        ...evidence,
        rows: [{ ...evidence.rows[0], value: -1 }],
      }),
    ],
    [
      'incorrect units',
      (evidence: EvidenceCapture) => ({ ...evidence, units: 'mg/m³' }),
    ],
    [
      'asserted provider issuance',
      (evidence: EvidenceCapture) => ({
        ...evidence,
        issued_at: '2026-10-23T00:00:00Z',
      }),
    ],
    [
      'hourly-average semantics',
      (evidence: EvidenceCapture) => ({
        ...evidence,
        temporal_support: 'hourly_average',
      }),
    ],
    [
      'different location',
      (evidence: EvidenceCapture) => ({ ...evidence, location: 'Other Town' }),
    ],
    [
      'different source',
      (evidence: EvidenceCapture) => ({
        ...evidence,
        source: 'unadmitted-source',
      }),
    ],
    [
      'incorrect raw index',
      (evidence: EvidenceCapture) => ({
        ...evidence,
        selection: {
          ...evidence.selection,
          selected_raw_row_indices: [3, 2, 1, 0],
        },
      }),
    ],
    [
      'unreported truncation',
      (evidence: EvidenceCapture) => ({
        ...evidence,
        selection: { ...evidence.selection, truncated: true },
      }),
    ],
    [
      'malformed raw payload',
      (evidence: EvidenceCapture) => ({ ...evidence, raw: '{}' }),
    ],
    [
      'unlinked numeric values',
      (evidence: EvidenceCapture) => ({
        ...evidence,
        rows: evidence.rows.map((row) => ({ ...row, value: 99 })),
      }),
    ],
    [
      'non-instantaneous rows',
      (evidence: EvidenceCapture) => ({
        ...evidence,
        rows: [
          { ...evidence.rows[0], end: '2026-10-24T01:00:00Z' },
          ...evidence.rows.slice(1),
        ],
      }),
    ],
  ])('rejects %s at the untrusted adapter boundary', (_label, mutate) => {
    const source = capture();
    const malformed: unknown = mutate(source);
    expect(() => validateCapture(malformed, scope)).toThrow();
    expect(
      independentlyCheckPm25(malformed, analyzePm25(source, scope), scope)
        .valid,
    ).toBe(false);
  });

  it('rejects out-of-scope raw timestamps and a non-latest duplicate selection', () => {
    const evidence = capture();
    const payload = JSON.parse(evidence.raw) as { data: unknown[][] };
    payload.data[0]![1] = scope.period.end;
    evidence.raw = JSON.stringify(payload);
    expect(() => validateCapture(evidence, scope)).toThrow('out-of-scope');
    const duplicated = capture();
    const duplicatePayload = JSON.parse(duplicated.raw) as {
      data: unknown[][];
    };
    const newest = [...duplicatePayload.data[0]!];
    newest[6] = '2026-10-24T05:30:00Z';
    newest[4] = 99;
    duplicatePayload.data.push(newest);
    duplicated.raw = JSON.stringify(duplicatePayload);
    duplicated.selection.returned_rows++;
    expect(() => validateCapture(duplicated, scope)).toThrow(
      'exact raw source row',
    );
  });
});
