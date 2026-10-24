import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_VERSIONS,
  ContractError,
  validateContract,
} from '../../app/contracts/index.js';
import {
  importSamplePack,
  plannerHandoff,
  verificationHandoff,
  type ImportRequest,
  type ImportResult,
  type SourceDocument,
} from '../../app/import/loader.js';
import { FINDING_CODES } from '../../app/validation/index.js';

const SCENARIOS = [
  { scenario: 'nominal', id: 'nominal' },
  { scenario: 'plus-20', id: 'plus_20_sensitivity' },
] as const;

function document(relative: string): SourceDocument {
  return {
    path: relative,
    bytes: readFileSync(new URL(`../../${relative}`, import.meta.url)),
  };
}

function withBytes(source: SourceDocument, text: string): SourceDocument {
  return { path: source.path, bytes: Buffer.from(text, 'utf8') };
}

function reserialize(source: SourceDocument, mutate: (value: never) => void) {
  const value: unknown = JSON.parse(source.bytes.toString());
  mutate(value as never);
  return withBytes(source, JSON.stringify(value, null, 2));
}

function request(): ImportRequest {
  return {
    planning: document('input_examples/v2/planning.json'),
    verificationSchedules: document(
      'input_examples/v2/verification-schedules.json',
    ),
    environmental: SCENARIOS.map(({ scenario, id }) => ({
      scenario_id: id,
      evidence: document(
        `input_examples/v2/environmental/${scenario}-evidence.json`,
      ),
      series: document(
        `input_examples/v2/environmental/${scenario}-series.json`,
      ),
      raw: document(`input_examples/v2/environmental/${scenario}-pm25.csv`),
    })),
    requiredScenarios: ['nominal', 'plus_20_sensitivity'],
  };
}

function codes(result: ImportResult): string[] {
  return result.findings.map((entry) => entry.code);
}

describe('sample pack import', () => {
  it('imports the shipped pack across the shared boundary', () => {
    const result = importSamplePack(request());
    expect(result.status).toBe('imported');
    expect(result.surface).toBe('historical_harness');
    expect(result.validation.outcome).toBe('admitted_with_supported_coverage');
    expect(result.handoff).not.toBeNull();
    expect(result.handoff?.operating_acceptance).toBe('not_authorized');
    expect(result.handoff?.recommendation_eligible).toBe(false);
    expect(
      result.findings.filter((entry) => entry.severity !== 'advisory'),
    ).toEqual([]);
  });

  it('keeps canonical epoch, head and publication null with reasons', () => {
    const result = importSamplePack(request());
    expect(result.canonical.epoch_ref).toBeNull();
    expect(result.canonical.head_ref).toBeNull();
    expect(result.canonical.publication_ref).toBeNull();
    expect(Object.keys(result.canonical.reasons).sort()).toEqual([
      'epoch_ref',
      'head_ref',
      'publication_ref',
    ]);
    for (const artifact of result.artifacts) {
      expect(artifact.reference_scope).toBe('demo_local');
    }
  });

  it('lists the acceptance capabilities it does not implement', () => {
    const result = importSamplePack(request());
    expect(result.unavailable_capabilities.length).toBeGreaterThan(0);
    for (const entry of result.unavailable_capabilities) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
    expect(
      result.unavailable_capabilities.map((entry) => entry.capability),
    ).toContain('evidence_acceptance_and_review');
  });

  it('is deterministic over repeated imports of the same bytes', () => {
    const first = importSamplePack(request());
    const second = importSamplePack(request());
    expect(JSON.stringify(second.artifacts)).toBe(
      JSON.stringify(first.artifacts),
    );
    expect(JSON.stringify(second.handoff)).toBe(JSON.stringify(first.handoff));
  });

  it('hands Planner and Verification the identical pinned artifacts', () => {
    const result = importSamplePack(request());
    const planner = plannerHandoff(result);
    const verification = verificationHandoff(result);
    expect(planner).not.toBeNull();
    expect(JSON.stringify(verification)).toBe(JSON.stringify(planner));
    expect(planner?.scenarios.map((entry) => entry.scenario_id)).toEqual([
      'nominal',
      'plus_20_sensitivity',
    ]);
    expect(planner?.schedule_refs.length).toBe(2);
    expect(planner?.evidence_refs.length).toBe(4);
  });

  it('preserves units, native resolution and original timezone unconverted', () => {
    const result = importSamplePack(request());
    const series = result.artifacts.filter(
      (artifact) => artifact.kind === 'environmental_series',
    );
    expect(series.length).toBe(4);
    for (const artifact of series) {
      expect(artifact.unit).toBe('ug/m3');
      expect(artifact.native_temporal_resolution).toEqual({
        value: 1,
        unit: 'hour',
      });
      expect(artifact.original_timezone).toBe('Asia/Kuala_Lumpur');
    }
  });

  it('records evidence lineage for the +20 transformation inputs', () => {
    const result = importSamplePack(request());
    const transformed = result.artifacts.find(
      (artifact) => artifact.artifact_id === 'demo:pm25-yard-plus-20',
    );
    const transformation = transformed?.lineage?.transformations[0];
    expect(transformation?.method_id).toBe('fixture:pm25-add-20-ug-m3');
    expect(transformation?.method_version).toBe('1.0.0');
    expect(transformation?.input_refs[0]?.id).toBe('demo:pm25-yard-nominal');
    const nominal = result.artifacts.find(
      (artifact) => artifact.artifact_id === 'demo:pm25-yard-nominal',
    );
    expect(nominal?.lineage?.transformations).toEqual([]);
  });
});

describe('byte integrity', () => {
  it('computes a new bundle hash for an unseen but valid fixture', () => {
    const shipped = importSamplePack(request());
    const unseen = request();
    unseen.planning = reserialize(unseen.planning, (value) => {
      (value as unknown as { programme_id: string }).programme_id =
        'haze-unseen-fixture-case';
    });
    const result = importSamplePack(unseen);
    expect(result.status).toBe('imported');
    expect(result.handoff?.bundle_ref.sha256).not.toBe(
      shipped.handoff?.bundle_ref.sha256,
    );
    expect(result.validation.outcome).toBe('admitted_with_supported_coverage');
  });

  it('rejects a stale evidence reference after the record bytes change', () => {
    const altered = request();
    const first = altered.environmental?.[0];
    expect(first).toBeDefined();
    altered.environmental = [
      {
        ...first!,
        evidence: reserialize(first!.evidence, (value) => {
          const envelope = value as unknown as {
            records: { title: string }[];
          };
          envelope.records[0]!.title = 'Altered fictional title';
        }),
      },
      ...(altered.environmental ?? []).slice(1),
    ];
    const result = importSamplePack(altered);
    expect(result.status).toBe('draft_rejected');
    expect(result.handoff).toBeNull();
    expect(codes(result)).toContain(FINDING_CODES.stale_artifact_reference);
  });

  it('rejects a raw source whose bytes no longer match the evidence binding', () => {
    const altered = request();
    const first = altered.environmental?.[0];
    altered.environmental = [
      {
        ...first!,
        raw: withBytes(
          first!.raw,
          `${first!.raw.bytes.toString()}yard-1200,yard,2026-10-25T04:00:00Z,2026-10-25T05:00:00Z,10,ug/m3\n`,
        ),
      },
      ...(altered.environmental ?? []).slice(1),
    ];
    const result = importSamplePack(altered);
    expect(result.status).toBe('draft_rejected');
    expect(codes(result)).toContain(FINDING_CODES.raw_bytes_mismatch);
  });

  it('rejects a stale bundle reference supplied by the caller', () => {
    const result = importSamplePack({
      ...request(),
      expectedBundleRef: {
        id: 'demo:klang-fixture-input-v2',
        revision: 1,
        sha256: 'f'.repeat(64),
      },
    });
    expect(result.status).toBe('draft_rejected');
    expect(codes(result)).toContain(FINDING_CODES.stale_artifact_reference);
  });

  it('rejects a duplicate JSON key in an imported document', () => {
    const broken = request();
    broken.planning = withBytes(
      broken.planning,
      '{"schema_version":"haze.planning.v2","schema_version":"haze.planning.v2"}',
    );
    const result = importSamplePack(broken);
    expect(result.status).toBe('draft_rejected');
    expect(codes(result)).toContain(FINDING_CODES.malformed_json);
  });

  it('refuses a series pack whose timezone disagrees with the bundle', () => {
    const altered = request();
    const first = altered.environmental?.[0];
    altered.environmental = [
      {
        ...first!,
        series: reserialize(first!.series, (value) => {
          (value as unknown as { timezone: string }).timezone =
            'Asia/Singapore';
        }),
      },
      ...(altered.environmental ?? []).slice(1),
    ];
    const result = importSamplePack(altered);
    expect(codes(result)).toContain(FINDING_CODES.timezone_envelope_mismatch);
    expect(result.status).toBe('draft_rejected');
  });
});

describe('missing-coverage pack end to end', () => {
  it('imports but reports a precise baseline insufficiency', () => {
    const altered = request();
    const first = altered.environmental?.[0];
    altered.environmental = [
      {
        ...first!,
        series: reserialize(first!.series, (value) => {
          const envelope = value as unknown as {
            series: {
              location_id: string;
              intervals: {
                start: string;
                value: number | null;
                null_reason: unknown;
              }[];
            }[];
          };
          for (const series of envelope.series) {
            if (series.location_id !== 'yard') continue;
            const interval = series.intervals[0]!;
            interval.value = null;
            interval.null_reason = {
              code: 'fixture_source_hour_withheld',
              explanation: 'Removed to demonstrate a missing-coverage result.',
            };
          }
        }),
      },
      ...(altered.environmental ?? []).slice(1),
    ];
    const result = importSamplePack(altered);
    expect(result.status).toBe('imported');
    expect(result.validation.outcome).toBe(
      'admitted_with_environmental_insufficiency',
    );
    expect(result.validation.quantified_comparison_available).toBe(false);
    expect(result.validation.transport_status_hint).toBe(200);
    expect(codes(result)).toContain(
      FINDING_CODES.environmental_baseline_coverage_missing,
    );
  });
});

describe('canonical surface boundary', () => {
  it('rejects the demo-local bundle reference on the canonical surface', () => {
    const run: unknown = JSON.parse(
      readFileSync(
        new URL('../../input_examples/v2/run.json', import.meta.url),
        'utf8',
      ),
    );
    expect(() => validateContract('run', run, 'canonical')).toThrow(
      ContractError,
    );
    expect(validateContract('run', run, 'historical_harness')).toMatchObject({
      schema_version: CONTRACT_VERSIONS.run,
    });
  });
});
