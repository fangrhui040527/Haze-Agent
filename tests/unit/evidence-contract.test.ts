import { describe, expect, it } from 'vitest';
import {
  CONTRACT_VERSIONS,
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
});
