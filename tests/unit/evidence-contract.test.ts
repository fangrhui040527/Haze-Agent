import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CONTRACT_VERSIONS,
  contractHash,
  environmentalSeriesSchema,
  evidenceSchema,
  exportContractSchemas,
  validateContract,
  type EnvironmentalSeries,
  type EvidenceRecord,
} from '../../app/contracts/index.js';

const ref = (id: string) => ({
  id,
  revision: 1,
  sha256: 'a'.repeat(64),
});
const interval = (start: string, end: string) => ({ start, end });
const nullReason = {
  code: 'not_applicable',
  explanation: 'This synthetic fixture field does not apply.',
};

function evidenceRecord(): EvidenceRecord {
  return {
    schema_version: 'haze.evidence.v2',
    evidence_id: 'demo:yard-pm25-nominal',
    revision: 1,
    upstream_id: 'fixture:yard-pm25-nominal',
    upstream_revision: 1,
    raw_sha256: 'b'.repeat(64),
    raw_ref: 'demo:raw-yard-pm25-nominal',
    source_kind: 'synthetic_fixture',
    input_origin: 'synthetic_fixture',
    title: 'Fictional hourly yard PM2.5 series',
    source_owner: 'Haze Agent synthetic fixture',
    provenance: {
      description: 'Values are explicitly fictional test inputs.',
      chain: [
        {
          operation: 'collection',
          method_id: 'fixture:manual-example',
          method_version: '1',
          description: 'Authored as a fictional architecture example.',
          input_refs: [],
        },
      ],
      access_permissions: ['fictional_fixture_only'],
    },
    locator: {
      kind: 'data',
      series_id: 'yard-pm25-nominal',
      run_id: 'fixture-run-1',
      row_ids: ['yard-08', 'yard-09'],
      intervals: [
        {
          ...interval('2026-10-25T00:00:00Z', '2026-10-25T01:00:00Z'),
          location_id: 'yard',
        },
        {
          ...interval('2026-10-25T01:00:00Z', '2026-10-25T02:00:00Z'),
          location_id: 'yard',
        },
      ],
      location_ids: ['yard'],
      selection_sha256: 'c'.repeat(64),
    },
    pollutant: 'PM2.5',
    quantity: null,
    unit: 'ug/m3',
    issued_at: null,
    published_at: null,
    valid_interval: interval('2026-10-25T00:00:00Z', '2026-10-25T04:00:00Z'),
    retrieved_at: '2026-10-24T06:00:00Z',
    accepted_at: null,
    original_timezone: 'Asia/Kuala_Lumpur',
    native_temporal_resolution: { value: 1, unit: 'hour' },
    spatial_support: {
      description: 'Fictional yard location.',
      location_ids: ['yard'],
    },
    quality_ref: null,
    licence_ref: null,
    access_ref: null,
    permitted_uses: ['fictional_fixture_validation'],
    limitations: ['Not accepted for operational or scientific use.'],
    review_refs: [],
    disposition: 'not_assessed',
    expiry: null,
    freshness_rule_ref: null,
    supersession_ref: null,
    withdrawal_ref: null,
    null_reasons: {
      quantity: nullReason,
      issued_at: nullReason,
      published_at: nullReason,
      accepted_at: nullReason,
      quality_ref: nullReason,
      licence_ref: nullReason,
      access_ref: nullReason,
      expiry: nullReason,
      freshness_rule_ref: nullReason,
      supersession_ref: nullReason,
      withdrawal_ref: nullReason,
    },
  };
}

function environmentalSeries(): EnvironmentalSeries {
  return {
    schema_version: 'haze.environmental_series.v2',
    series_id: 'yard-pm25-nominal',
    evidence_ref: ref('demo:yard-pm25-nominal'),
    source_kind: 'synthetic_fixture',
    source_ref: ref('demo:raw-yard-pm25-nominal'),
    run_id: null,
    pollutant: 'PM2.5',
    unit: 'ug/m3',
    location_id: 'yard',
    native_temporal_resolution: { value: 1, unit: 'hour' },
    spatial_support_ref: ref('demo:yard-spatial-support'),
    issued_at: null,
    retrieved_at: '2026-10-24T06:00:00Z',
    accepted_at: null,
    valid_interval: interval('2026-10-25T00:00:00Z', '2026-10-25T02:00:00Z'),
    intervals: [
      {
        ...interval('2026-10-25T00:00:00Z', '2026-10-25T01:00:00Z'),
        value: 100,
        quality_flag: 'fictional',
        null_reason: null,
      },
      {
        ...interval('2026-10-25T01:00:00Z', '2026-10-25T02:00:00Z'),
        value: 80,
        quality_flag: 'fictional',
        null_reason: null,
      },
    ],
    quality_ref: null,
    licence_ref: null,
    applicability_ref: null,
    freshness_rule_ref: null,
    uncertainty_ref: null,
    null_reasons: {
      run_id: nullReason,
      issued_at: nullReason,
      accepted_at: nullReason,
      quality_ref: nullReason,
      licence_ref: nullReason,
      applicability_ref: nullReason,
      freshness_rule_ref: nullReason,
      uncertainty_ref: nullReason,
    },
  };
}

function nominalFixture() {
  const evidence = JSON.parse(
    readFileSync(
      new URL(
        '../../input_examples/v2/environmental/nominal-evidence.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { records: EvidenceRecord[] };
  const series = JSON.parse(
    readFileSync(
      new URL(
        '../../input_examples/v2/environmental/nominal-series.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { timezone: string; series: EnvironmentalSeries[] };
  const source = readFileSync(
    new URL(
      '../../input_examples/v2/environmental/nominal-pm25.csv',
      import.meta.url,
    ),
  );
  return { evidence, series, source };
}

function plus20Fixture() {
  const evidence = JSON.parse(
    readFileSync(
      new URL(
        '../../input_examples/v2/environmental/plus-20-evidence.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as {
    scenario_id: string;
    scenario_kind: string;
    transformation: {
      method_id: string;
      method_version: string;
      operation: string;
      amount: number;
      unit: string;
      source_scenario: string;
      preserves_native_intervals: boolean;
      notice: string;
    };
    records: EvidenceRecord[];
  };
  const series = JSON.parse(
    readFileSync(
      new URL(
        '../../input_examples/v2/environmental/plus-20-series.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as {
    scenario_id: string;
    scenario_kind: string;
    timezone: string;
    source_ref: { id: string; revision: number; sha256: string };
    transformation: typeof evidence.transformation;
    series: EnvironmentalSeries[];
  };
  const source = readFileSync(
    new URL(
      '../../input_examples/v2/environmental/plus-20-pm25.csv',
      import.meta.url,
    ),
  );
  return { evidence, series, source };
}

function planningGridSamples(
  series: EnvironmentalSeries,
  start: number,
  durationMinutes: number,
  stepMinutes: number,
) {
  const stepMilliseconds = stepMinutes * 60_000;
  return Array.from({ length: durationMinutes / stepMinutes }, (_, index) => {
    const sampleStart = start + index * stepMilliseconds;
    const sampleEnd = sampleStart + stepMilliseconds;
    const interval = series.intervals.find(
      ({ start: intervalStart, end: intervalEnd }) =>
        Date.parse(intervalStart) <= sampleStart &&
        Date.parse(intervalEnd) >= sampleEnd,
    );
    if (interval?.value === null || interval?.value === undefined)
      throw new Error('test_fixture_missing_piecewise_constant_value');
    return {
      start: new Date(sampleStart).toISOString(),
      end: new Date(sampleEnd).toISOString(),
      value: interval.value,
    };
  });
}

describe('environmental evidence contracts', () => {
  it('registers the architecture evidence and resolved-series versions', () => {
    expect(CONTRACT_VERSIONS.evidence).toBe('haze.evidence.v2');
    expect(CONTRACT_VERSIONS.environmental_series).toBe(
      'haze.environmental_series.v2',
    );
    const schemas = exportContractSchemas();
    expect(schemas['haze.evidence.v2']).toBeDefined();
    expect(schemas['haze.environmental_series.v2']).toBeDefined();
  });

  it('accepts a synthetic evidence record with exact provenance and null reasons', () => {
    const record = evidenceRecord();
    validateContract('evidence', record);
    expect(evidenceSchema.parse(record).evidence_id).toBe(
      'demo:yard-pm25-nominal',
    );
  });

  it('requires a reason for each null and rejects unrelated null reasons', () => {
    const missingReason = evidenceRecord();
    delete missingReason.null_reasons.quantity;
    expect(evidenceSchema.safeParse(missingReason).success).toBe(false);

    const unrelatedReason = evidenceRecord();
    unrelatedReason.null_reasons.unused_field = nullReason;
    expect(evidenceSchema.safeParse(unrelatedReason).success).toBe(false);
  });

  it('requires UTC evidence timestamps and synthetic origin for synthetic sources', () => {
    const offsetTime = evidenceRecord();
    offsetTime.valid_interval.start = '2026-10-25T08:00:00+08:00';
    expect(evidenceSchema.safeParse(offsetTime).success).toBe(false);

    const mismatchedOrigin = evidenceRecord();
    mismatchedOrigin.input_origin = 'captured_operating_case';
    expect(evidenceSchema.safeParse(mismatchedOrigin).success).toBe(false);
  });

  it('validates resolved series with ordered, nonoverlapping source intervals', () => {
    const series = environmentalSeries();
    validateContract('environmental_series', series);
    expect(environmentalSeriesSchema.parse(series).series_id).toBe(
      'yard-pm25-nominal',
    );

    const overlap = environmentalSeries();
    const secondInterval = overlap.intervals[1];
    if (!secondInterval)
      throw new Error('test_fixture_missing_second_interval');
    secondInterval.start = '2026-10-25T00:30:00Z';
    expect(environmentalSeriesSchema.safeParse(overlap).success).toBe(false);
  });

  it('requires explicit reasons for missing environmental measurements', () => {
    const missing = environmentalSeries();
    const firstInterval = missing.intervals[0];
    if (!firstInterval) throw new Error('test_fixture_missing_first_interval');
    firstInterval.value = null;
    expect(environmentalSeriesSchema.safeParse(missing).success).toBe(false);

    firstInterval.null_reason = nullReason;
    expect(environmentalSeriesSchema.safeParse(missing).success).toBe(true);
  });

  it('loads the nominal fictional yard and office source and series', () => {
    const { evidence, series, source } = nominalFixture();
    expect(series.timezone).toBe('Asia/Kuala_Lumpur');
    expect(createHash('sha256').update(source).digest('hex')).toBe(
      '6013a15d781efff196c643af3a39f869b2767185202cfa9a0a9e89d541335b8e',
    );
    expect(evidence.records).toHaveLength(2);
    expect(series.series).toHaveLength(2);
    const csvValues = new Map<string, number[]>();
    for (const line of source
      .toString('utf8')
      .trimEnd()
      .split(/\r?\n/)
      .slice(1)) {
      const [, location, , , rawValue] = line.split(',');
      if (!location || !rawValue)
        throw new Error('test_fixture_invalid_nominal_csv_row');
      csvValues.set(location, [
        ...(csvValues.get(location) ?? []),
        Number(rawValue),
      ]);
    }
    expect(csvValues.get('yard')).toEqual([100, 80, 50, 30]);
    expect(csvValues.get('office')).toEqual([20, 20, 20, 20]);

    for (const record of evidence.records) {
      expect(evidenceSchema.parse(record).input_origin).toBe(
        'synthetic_fixture',
      );
      expect(record.original_timezone).toBe('Asia/Kuala_Lumpur');
      expect(record.raw_sha256).toBe(
        createHash('sha256').update(source).digest('hex'),
      );
      const locator = record.locator;
      if (locator.kind !== 'data')
        throw new Error('test_fixture_expected_data_locator');
      const rows = source
        .toString('utf8')
        .trimEnd()
        .split(/\r?\n/)
        .filter((line) => locator.row_ids.includes(line.split(',')[0] ?? ''));
      expect(
        createHash('sha256').update(rows.join('\n'), 'utf8').digest('hex'),
      ).toBe(locator.selection_sha256);
    }

    const byLocation = new Map(
      series.series.map((entry) => [
        environmentalSeriesSchema.parse(entry).location_id,
        entry,
      ]),
    );
    expect(byLocation.get('yard')?.intervals.map(({ value }) => value)).toEqual(
      [100, 80, 50, 30],
    );
    expect(
      byLocation.get('office')?.intervals.map(({ value }) => value),
    ).toEqual([20, 20, 20, 20]);
    for (const [location, entry] of byLocation) {
      const parsed = environmentalSeriesSchema.parse(entry);
      expect(parsed.unit).toBe('ug/m3');
      expect(parsed.source_kind).toBe('synthetic_fixture');
      expect(parsed.source_ref.sha256).toBe(
        createHash('sha256').update(source).digest('hex'),
      );
      expect(parsed.native_temporal_resolution).toEqual({
        value: 1,
        unit: 'hour',
      });
      expect(parsed.intervals).toHaveLength(4);
      expect(
        parsed.intervals.map(({ start, end }) => [
          start,
          end,
          Date.parse(end) - Date.parse(start),
        ]),
      ).toEqual([
        ['2026-10-25T00:00:00Z', '2026-10-25T01:00:00Z', 3_600_000],
        ['2026-10-25T01:00:00Z', '2026-10-25T02:00:00Z', 3_600_000],
        ['2026-10-25T02:00:00Z', '2026-10-25T03:00:00Z', 3_600_000],
        ['2026-10-25T03:00:00Z', '2026-10-25T04:00:00Z', 3_600_000],
      ]);
      const evidenceRecord = evidence.records.find(
        ({ evidence_id }) => evidence_id === parsed.evidence_ref.id,
      );
      if (!evidenceRecord || evidenceRecord.locator.kind !== 'data')
        throw new Error('test_fixture_expected_matching_data_locator');
      expect(evidenceRecord.locator.series_id).toBe(parsed.series_id);
      expect(evidenceRecord.locator.location_ids).toEqual([location]);
      expect(
        evidenceRecord.locator.intervals.map(({ start, end, location_id }) => [
          start,
          end,
          location_id,
        ]),
      ).toEqual(
        parsed.intervals.map(({ start, end }) => [start, end, location]),
      );
      expect(evidenceRecord && contractHash(evidenceRecord)).toBe(
        parsed.evidence_ref.sha256,
      );
      expect(parsed.location_id).toBe(location);
    }
    expect(
      evidence.records.find(({ evidence_id }) =>
        evidence_id.endsWith('office-nominal'),
      )?.limitations,
    ).toContain(
      'Office values are independently fictional, not derived from yard values or a filtration assumption.',
    );
  });

  it('binds complete nonnegative hourly coverage and immutable fictional records in both scenarios', () => {
    const nominal = nominalFixture();
    const plus20 = plus20Fixture();
    const expectedIntervals = [
      ['2026-10-25T00:00:00Z', '2026-10-25T01:00:00Z'],
      ['2026-10-25T01:00:00Z', '2026-10-25T02:00:00Z'],
      ['2026-10-25T02:00:00Z', '2026-10-25T03:00:00Z'],
      ['2026-10-25T03:00:00Z', '2026-10-25T04:00:00Z'],
    ];
    const scenarios = [
      {
        timezone: nominal.series.timezone,
        records: nominal.evidence.records,
        source: nominal.source,
        series: nominal.series.series,
        values: new Map([
          ['yard', [100, 80, 50, 30]],
          ['office', [20, 20, 20, 20]],
        ]),
      },
      {
        timezone: plus20.series.timezone,
        records: plus20.evidence.records,
        source: plus20.source,
        series: plus20.series.series,
        values: new Map([
          ['yard', [120, 100, 70, 50]],
          ['office', [40, 40, 40, 40]],
        ]),
      },
    ];

    for (const scenario of scenarios) {
      expect(scenario.timezone).toBe('Asia/Kuala_Lumpur');
      expect(scenario.records).toHaveLength(2);
      expect(scenario.series).toHaveLength(2);
      const sourceHash = createHash('sha256')
        .update(scenario.source)
        .digest('hex');
      const expectedLocations = [...scenario.values.keys()].sort();
      expect(
        scenario.series.map(({ location_id }) => location_id).sort(),
      ).toEqual(expectedLocations);

      for (const entry of scenario.series) {
        const parsed = environmentalSeriesSchema.parse(entry);
        const expectedValues = scenario.values.get(parsed.location_id);
        expect(expectedValues).toBeDefined();
        expect(parsed.native_temporal_resolution).toEqual({
          value: 1,
          unit: 'hour',
        });
        expect(parsed.valid_interval).toEqual({
          start: expectedIntervals[0]?.[0],
          end: expectedIntervals.at(-1)?.[1],
        });
        expect(parsed.intervals).toHaveLength(4);
        expect(parsed.intervals.map(({ start, end }) => [start, end])).toEqual(
          expectedIntervals,
        );
        expect(parsed.intervals.map(({ value }) => value)).toEqual(
          expectedValues,
        );
        for (const interval of parsed.intervals) {
          expect(interval.value).not.toBeNull();
          if (interval.value === null)
            throw new Error('test_fixture_missing_hourly_value');
          expect(Number.isFinite(interval.value)).toBe(true);
          expect(interval.value).toBeGreaterThanOrEqual(0);
          expect(Date.parse(interval.end) - Date.parse(interval.start)).toBe(
            3_600_000,
          );
        }
        expect(parsed.source_ref.sha256).toBe(sourceHash);

        const record = scenario.records.find(
          ({ evidence_id }) => evidence_id === parsed.evidence_ref.id,
        );
        if (!record) throw new Error('test_fixture_missing_evidence_record');
        expect(record.revision).toBe(parsed.evidence_ref.revision);
        expect(record.raw_sha256).toBe(sourceHash);
        expect(record.source_kind).toBe('synthetic_fixture');
        expect(record.input_origin).toBe('synthetic_fixture');
        expect(record.original_timezone).toBe('Asia/Kuala_Lumpur');
        expect(record.disposition).toBe('not_assessed');
        expect(record.accepted_at).toBeNull();
        expect(record.permitted_uses).toEqual(['fictional_fixture_validation']);
        expect(contractHash(record)).toBe(parsed.evidence_ref.sha256);
        expect(parsed.source_kind).toBe('synthetic_fixture');
        expect(parsed.accepted_at).toBeNull();
      }

      expect(
        scenario.records.map(({ evidence_id }) => evidence_id).sort(),
      ).toEqual(
        scenario.series.map(({ evidence_ref }) => evidence_ref.id).sort(),
      );
    }
  });

  it('applies hourly values as piecewise constant without creating quarter-hour readings', () => {
    const nominalYard = environmentalSeriesSchema.parse(
      nominalFixture().series.series.find(
        ({ location_id }) => location_id === 'yard',
      ),
    );
    const samples = planningGridSamples(
      nominalYard,
      Date.parse('2026-10-25T08:45:00+08:00'),
      30,
      15,
    );

    expect(samples).toEqual([
      {
        start: '2026-10-25T00:45:00.000Z',
        end: '2026-10-25T01:00:00.000Z',
        value: 100,
      },
      {
        start: '2026-10-25T01:00:00.000Z',
        end: '2026-10-25T01:15:00.000Z',
        value: 80,
      },
    ]);
    expect(samples.reduce((sum, sample) => sum + sample.value * 15, 0)).toBe(
      2700,
    );
    expect(nominalYard.native_temporal_resolution).toEqual({
      value: 1,
      unit: 'hour',
    });
    expect(nominalYard.intervals).toHaveLength(4);
    expect(
      nominalYard.intervals.every(
        ({ start, end }) => Date.parse(end) - Date.parse(start) === 3_600_000,
      ),
    ).toBe(true);
  });

  it('preserves nominal hourly intervals through the pinned fictional +20 transformation', () => {
    const nominal = nominalFixture();
    const transformed = plus20Fixture();
    const rawHash = createHash('sha256')
      .update(transformed.source)
      .digest('hex');
    const csvRows = transformed.source
      .toString('utf8')
      .trimEnd()
      .split(/\r?\n/)
      .slice(1);
    const expected = new Map([
      ['yard', [120, 100, 70, 50]],
      ['office', [40, 40, 40, 40]],
    ]);

    expect(transformed.evidence.scenario_id).toBe('plus_20_sensitivity');
    expect(transformed.series.scenario_id).toBe('plus_20_sensitivity');
    expect(transformed.evidence.scenario_kind).toBe(
      'fictional_engineering_sensitivity',
    );
    expect(transformed.series.scenario_kind).toBe(
      'fictional_engineering_sensitivity',
    );
    expect(transformed.evidence.transformation).toEqual(
      transformed.series.transformation,
    );
    expect(transformed.evidence.transformation).toMatchObject({
      method_id: 'fixture:pm25-add-20-ug-m3',
      method_version: '1.0.0',
      operation: 'add_constant',
      amount: 20,
      unit: 'ug/m3',
      source_scenario: 'nominal',
      preserves_native_intervals: true,
    });
    expect(transformed.evidence.transformation.notice).toContain(
      'not a forecast-error distribution, supported scientific uncertainty, or operational uncertainty treatment',
    );
    expect(transformed.evidence.records).toHaveLength(2);
    expect(transformed.series.series).toHaveLength(2);
    expect(transformed.series.source_ref.sha256).toBe(rawHash);

    for (const outputRecord of transformed.evidence.records) {
      const output = evidenceSchema.parse(outputRecord);
      expect(output.input_origin).toBe('synthetic_fixture');
      expect(output.source_kind).toBe('synthetic_fixture');
      expect(output.original_timezone).toBe('Asia/Kuala_Lumpur');
      expect(output.raw_ref).toBe('demo:raw-pm25-plus-20-csv');
      expect(output.raw_sha256).toBe(rawHash);
      if (output.locator.kind !== 'data')
        throw new Error('test_fixture_expected_sensitivity_data_locator');
      const location = output.locator.location_ids[0];
      if (!location)
        throw new Error('test_fixture_expected_sensitivity_location');
      const nominalRecord = nominal.evidence.records.find(
        (record) =>
          record.locator.kind === 'data' &&
          record.locator.location_ids.includes(location),
      );
      if (!nominalRecord)
        throw new Error('test_fixture_missing_nominal_evidence_lineage');
      const transformationStep = output.provenance.chain.at(-1);
      expect(transformationStep).toMatchObject({
        operation: 'transformation',
        method_id: 'fixture:pm25-add-20-ug-m3',
        method_version: '1.0.0',
        input_refs: [
          {
            id: nominalRecord.evidence_id,
            revision: nominalRecord.revision,
            sha256: contractHash(nominalRecord),
          },
        ],
      });
      const selectedRows = csvRows.filter(
        (row) =>
          output.locator.kind === 'data' &&
          output.locator.row_ids.includes(row.split(',')[0] ?? ''),
      );
      expect(
        createHash('sha256')
          .update(selectedRows.join('\n'), 'utf8')
          .digest('hex'),
      ).toBe(output.locator.selection_sha256);
    }

    const nominalByLocation = new Map(
      nominal.series.series.map((entry) => [entry.location_id, entry]),
    );
    const outputByLocation = new Map(
      transformed.series.series.map((entry) => [entry.location_id, entry]),
    );
    expect(outputByLocation.size).toBe(2);
    for (const [location, outputValue] of expected) {
      const output = environmentalSeriesSchema.parse(
        outputByLocation.get(location),
      );
      const source = environmentalSeriesSchema.parse(
        nominalByLocation.get(location),
      );
      expect(output.location_id).toBe(location);
      expect(output.pollutant).toBe(source.pollutant);
      expect(output.unit).toBe(source.unit);
      expect(output.source_kind).toBe('synthetic_fixture');
      expect(output.native_temporal_resolution).toEqual({
        value: 1,
        unit: 'hour',
      });
      expect(output.source_ref.sha256).toBe(rawHash);
      expect(output.intervals.map(({ value }) => value)).toEqual(outputValue);
      expect(output.intervals.map(({ start, end }) => [start, end])).toEqual(
        source.intervals.map(({ start, end }) => [start, end]),
      );
      expect(
        output.intervals.map(({ value }, index) => {
          const nominalValue = source.intervals[index]?.value;
          if (
            value === null ||
            nominalValue === null ||
            nominalValue === undefined
          )
            throw new Error('test_fixture_missing_scenario_measurement');
          return value - nominalValue;
        }),
      ).toEqual([20, 20, 20, 20]);
      const outputRecord = transformed.evidence.records.find(
        ({ evidence_id }) => evidence_id === output.evidence_ref.id,
      );
      if (!outputRecord)
        throw new Error('test_fixture_missing_sensitivity_evidence_record');
      expect(contractHash(outputRecord)).toBe(output.evidence_ref.sha256);
    }
  });
});
