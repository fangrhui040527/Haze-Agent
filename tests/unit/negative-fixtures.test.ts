import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  validateContract,
  type EnvironmentalSeries,
  type EvidenceRecord,
  type PlanningBundle,
} from '../../app/contracts/index.js';
import { linkEvidence } from '../../app/evidence/linkage.js';
import {
  importSamplePack,
  type ImportResult,
  type SourceDocument,
} from '../../app/import/loader.js';
import { FINDING_CODES } from '../../app/validation/index.js';
import type { ScheduleInput } from '../../app/validation/index.js';

const VALID_PACK = 'input_examples/v2';
const NEGATIVE_ROOT = 'input_examples/v2/negative';
const SCENARIOS = [
  { key: 'nominal', id: 'nominal' },
  { key: 'plus-20', id: 'plus_20_sensitivity' },
] as const;

interface CaseDescriptor {
  fixture_kind: string;
  case_id: string;
  scope: string;
  input_origin: string;
  operational_eligibility: boolean;
  recommendation_eligible: boolean;
  intent: string;
  derivation: { source_pack: string; method_id: string; steps: string[] };
  paths: {
    planning: string;
    environmental_source?: string;
    environmental?: Record<
      string,
      { raw: string; evidence: string; series: string }
    >;
  };
  expected: {
    import_status: ImportResult['status'];
    validation_outcome: string;
    environmental_status: string;
    quantified_comparison_available: boolean;
    transport_status_hint: number;
    admitted: boolean;
    required_finding_codes: string[];
    forbidden_finding_codes: string[];
    selected_plan: null;
    excluded_schedule_ids?: string[];
    checked_search_scope?: {
      schedules_checked: string[];
      exhaustive: boolean;
      note: string;
    };
    arithmetic?: Record<
      string,
      { per_worker_total: number; crew_total: number }
    >;
    affected?: {
      scenario_ids: string[];
      schedule_kind: string;
      activity_id: string;
      location_id: string;
      worker_ids: string[];
      missing_intervals: { start: string; end: string }[];
    }[];
  };
}

function readText(relative: string): string {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
}

function readJson(relative: string): unknown {
  return JSON.parse(readText(relative));
}

function document(relative: string): SourceDocument {
  return {
    path: relative,
    bytes: readFileSync(new URL(`../../${relative}`, import.meta.url)),
  };
}

function matrix() {
  return readJson(`${NEGATIVE_ROOT}/scenario-matrix.json`) as {
    cases: { case_id: string; case_path: string }[];
    valid_pack: string;
    operational_eligibility: boolean;
  };
}

function descriptorOf(caseId: string): CaseDescriptor {
  return readJson(`${NEGATIVE_ROOT}/${caseId}/case.json`) as CaseDescriptor;
}

function scenarioPaths(descriptor: CaseDescriptor) {
  const base = descriptor.paths.environmental_source;
  return SCENARIOS.map(({ key, id }) => ({
    scenario_id: id,
    raw: base
      ? `${base}/${key}-pm25.csv`
      : descriptor.paths.environmental![key]!.raw,
    evidence: base
      ? `${base}/${key}-evidence.json`
      : descriptor.paths.environmental![key]!.evidence,
    series: base
      ? `${base}/${key}-series.json`
      : descriptor.paths.environmental![key]!.series,
  }));
}

function importCase(descriptor: CaseDescriptor): ImportResult {
  return importSamplePack({
    planning: document(descriptor.paths.planning),
    verificationSchedules: document(
      `${VALID_PACK}/verification-schedules.json`,
    ),
    environmental: scenarioPaths(descriptor).map((entry) => ({
      scenario_id: entry.scenario_id,
      raw: document(entry.raw),
      evidence: document(entry.evidence),
      series: document(entry.series),
    })),
    requiredScenarios: SCENARIOS.map((entry) => entry.id),
  });
}

function schedulesFor(bundle: PlanningBundle): ScheduleInput[] {
  const fixture = readJson(`${VALID_PACK}/verification-schedules.json`) as {
    schedules: {
      record: {
        id: string;
        assignments: { activity_id: string; start: string }[];
      };
    }[];
  };
  return [
    {
      schedule_id: bundle.baseline.ref.id,
      kind: 'baseline',
      assignments: bundle.baseline.assignments,
    },
    ...fixture.schedules.map((entry) => ({
      schedule_id: entry.record.id,
      kind: 'candidate' as const,
      assignments: entry.record.assignments,
    })),
  ];
}

describe('negative fixture scenario matrix', () => {
  it('declares a fictional, operationally ineligible pack', () => {
    const declared = matrix();
    expect(declared.valid_pack).toBe(VALID_PACK);
    expect(declared.operational_eligibility).toBe(false);
    expect(declared.cases.map((entry) => entry.case_id)).toEqual([
      'missing-baseline-coverage',
      'missing-candidate-coverage',
      'flat-pollution',
      'invalid-baseline-precedence',
    ]);
  });

  it.each(matrix().cases.map((entry) => entry.case_id))(
    'matches the declared expectation for %s',
    (caseId) => {
      const descriptor = descriptorOf(caseId);
      expect(descriptor.scope).toBe('fictional_fixture_only');
      expect(descriptor.input_origin).toBe('synthetic_fixture');
      expect(descriptor.operational_eligibility).toBe(false);
      expect(descriptor.recommendation_eligible).toBe(false);
      expect(descriptor.derivation.source_pack).toBe(VALID_PACK);
      expect(descriptor.derivation.steps.length).toBeGreaterThan(0);
      expect(descriptor.intent.length).toBeGreaterThan(0);

      const result = importCase(descriptor);
      const expected = descriptor.expected;
      expect(result.status).toBe(expected.import_status);
      expect(result.validation.outcome).toBe(expected.validation_outcome);
      expect(result.validation.environmental.status).toBe(
        expected.environmental_status,
      );
      expect(result.validation.quantified_comparison_available).toBe(
        expected.quantified_comparison_available,
      );
      expect(result.validation.transport_status_hint).toBe(
        expected.transport_status_hint,
      );
      expect(result.validation.admitted).toBe(expected.admitted);
      expect(result.validation.recommendation_eligible).toBe(false);

      const codes = new Set(result.findings.map((entry) => entry.code));
      for (const code of expected.required_finding_codes) {
        expect([...codes]).toContain(code);
      }
      for (const code of expected.forbidden_finding_codes) {
        expect([...codes]).not.toContain(code);
      }
      for (const scheduleId of expected.excluded_schedule_ids ?? []) {
        for (const scenario of result.validation.environmental.scenarios) {
          expect(scenario.excluded_schedule_ids).toContain(scheduleId);
        }
      }
      for (const affected of expected.affected ?? []) {
        for (const scenarioId of affected.scenario_ids) {
          const scenario = result.validation.environmental.scenarios.find(
            (entry) => entry.scenario_id === scenarioId,
          );
          const gaps = (scenario?.gaps ?? []).filter(
            (gap) =>
              gap.activity_id === affected.activity_id &&
              gap.schedule_kind === affected.schedule_kind,
          );
          expect(gaps.length).toBeGreaterThan(0);
          expect([...new Set(gaps.map((gap) => gap.worker_id))].sort()).toEqual(
            affected.worker_ids,
          );
          for (const gap of gaps) {
            expect(gap.location_id).toBe(affected.location_id);
            expect(gap.missing_intervals).toEqual(affected.missing_intervals);
          }
        }
      }
    },
  );
});

describe('derived identities', () => {
  it('keeps the valid pack at revision 1 and bumps every changed record', () => {
    const valid = readJson(
      `${VALID_PACK}/environmental/nominal-evidence.json`,
    ) as { records: EvidenceRecord[] };
    for (const record of valid.records) expect(record.revision).toBe(1);

    const descriptor = descriptorOf('flat-pollution');
    const derived = readJson(
      descriptor.paths.environmental!['nominal']!.evidence,
    ) as { records: EvidenceRecord[] };
    for (const record of derived.records) {
      expect(record.revision).toBe(2);
      expect(record.raw_sha256).not.toBe(
        valid.records.find((entry) => entry.evidence_id === record.evidence_id)
          ?.raw_sha256,
      );
    }
  });

  it('rebinds the +20 transformation input to the derived nominal revision', () => {
    const descriptor = descriptorOf('flat-pollution');
    const derived = readJson(
      descriptor.paths.environmental!['plus-20']!.evidence,
    ) as { records: EvidenceRecord[] };
    const yard = derived.records.find(
      (record) => record.evidence_id === 'demo:pm25-yard-plus-20',
    );
    const transformation = yard?.provenance.chain.find(
      (step) => step.operation === 'transformation',
    );
    expect(transformation?.input_refs[0]?.id).toBe('demo:pm25-yard-nominal');
    expect(transformation?.input_refs[0]?.revision).toBe(2);
  });
});

describe('missing pollution is never zero-filled', () => {
  it('leaves the withheld hour explicitly null with a reason', () => {
    const descriptor = descriptorOf('missing-baseline-coverage');
    for (const scenario of SCENARIOS) {
      const envelope = readJson(
        descriptor.paths.environmental![scenario.key]!.series,
      ) as { series: EnvironmentalSeries[] };
      const yard = envelope.series.find(
        (series) => series.location_id === 'yard',
      );
      const withheld = yard?.intervals.find(
        (interval) => interval.start === '2026-10-25T00:00:00Z',
      );
      expect(withheld?.value).toBeNull();
      expect(withheld?.value).not.toBe(0);
      expect(withheld?.null_reason?.code).toBe('fixture_source_row_withheld');
      const source = readText(
        descriptor.paths.environmental![scenario.key]!.raw,
      );
      const yardRows = source
        .trim()
        .split(/\r?\n/)
        .slice(1)
        .filter((line) => line.split(',')[1] === 'yard');
      expect(yardRows.length).toBe(3);
      expect(
        yardRows.some((line) => line.includes('2026-10-25T00:00:00Z')),
      ).toBe(false);
      // The unaffected office hour keeps the same interval, so the removal is
      // scoped to one location rather than one timestamp.
      expect(source).toContain('office');
    }
  });

  it('produces no quantified comparison and no trace total for the gap', () => {
    const descriptor = descriptorOf('missing-baseline-coverage');
    const result = importCase(descriptor);
    expect(result.validation.quantified_comparison_available).toBe(false);
    const bundle = validateContract(
      'planning',
      readJson(descriptor.paths.planning),
    ) as PlanningBundle;
    const paths = scenarioPaths(descriptor)[0]!;
    const evidenceEnvelope = readJson(paths.evidence) as {
      records: EvidenceRecord[];
    };
    const seriesEnvelope = readJson(paths.series) as {
      series: EnvironmentalSeries[];
    };
    const rawText = readText(paths.raw);
    const rawByRef: Record<string, string> = {};
    for (const record of evidenceEnvelope.records) {
      rawByRef[record.raw_ref] = rawText;
    }
    const linked = linkEvidence({
      planning: bundle,
      scenario: {
        scenario_id: 'nominal',
        document: paths.series,
        evidence: evidenceEnvelope.records,
        series: seriesEnvelope.series,
        rawByRef,
      },
      schedules: schedulesFor(bundle),
    });
    const inspection = linked.traces.find(
      (trace) =>
        trace.schedule_kind === 'baseline' &&
        trace.activity_id === 'inspection',
    );
    expect(inspection?.coverage).toBe('incomplete');
    expect(inspection?.activity_total_ug_m3_hours).toBeNull();
    expect(inspection?.links).toEqual([]);
  });
});

describe('flat pollution', () => {
  it('names the checked search scope and declines to claim more', () => {
    const descriptor = descriptorOf('flat-pollution');
    const scope = descriptor.expected.checked_search_scope;
    expect(scope?.exhaustive).toBe(false);
    expect(scope?.schedules_checked).toEqual([
      'demo:fictional-ordinary-baseline',
      'demo:verification-less-disruption',
      'demo:verification-lower-proxy',
    ]);
    expect(scope?.note).toMatch(/No claim/i);
  });

  it('gives every checked schedule the same declared total, so timing cannot help', () => {
    const descriptor = descriptorOf('flat-pollution');
    const bundle = validateContract(
      'planning',
      readJson(descriptor.paths.planning),
    ) as PlanningBundle;
    const schedules = schedulesFor(bundle);
    for (const [key, scenarioId] of [
      ['nominal', 'nominal'],
      ['plus-20', 'plus_20_sensitivity'],
    ] as const) {
      const paths = descriptor.paths.environmental![key]!;
      const evidenceEnvelope = readJson(paths.evidence) as {
        records: EvidenceRecord[];
      };
      const seriesEnvelope = readJson(paths.series) as {
        series: EnvironmentalSeries[];
      };
      const rawText = readText(paths.raw);
      const rawByRef: Record<string, string> = {};
      for (const record of evidenceEnvelope.records) {
        rawByRef[record.raw_ref] = rawText;
      }
      const linked = linkEvidence({
        planning: bundle,
        scenario: {
          scenario_id: scenarioId,
          document: paths.series,
          evidence: evidenceEnvelope.records,
          series: seriesEnvelope.series,
          rawByRef,
        },
        schedules,
      });
      expect(linked.findings).toEqual([]);
      const declared =
        descriptor.expected.arithmetic![
          key === 'nominal' ? 'nominal' : 'plus_20_sensitivity'
        ]!;
      const totals = schedules.map((schedule) =>
        linked.traces
          .filter(
            (trace) =>
              trace.schedule_id === schedule.schedule_id &&
              trace.worker_id === 'worker-a',
          )
          .reduce(
            (sum, trace) => sum + (trace.activity_total_ug_m3_hours ?? 0),
            0,
          ),
      );
      for (const total of totals) {
        expect(total).toBe(declared.per_worker_total);
      }
      const crew = linked.traces
        .filter((trace) => trace.schedule_kind === 'baseline')
        .reduce(
          (sum, trace) => sum + (trace.activity_total_ug_m3_hours ?? 0),
          0,
        );
      expect(crew).toBe(declared.crew_total);
    }
  });
});

describe('invalid baseline', () => {
  it('returns precedence diagnostics and selects nothing', () => {
    const descriptor = descriptorOf('invalid-baseline-precedence');
    const result = importCase(descriptor);
    expect(result.status).toBe('draft_rejected');
    expect(result.handoff).toBeNull();
    expect(result.validation.transport_status_hint).toBe(422);
    const precedence = result.findings.filter(
      (entry) => entry.code === FINDING_CODES.precedence_violation,
    );
    expect(precedence.length).toBeGreaterThan(0);
    expect(precedence[0]?.domain).toBe('scheduling');
    expect(precedence[0]?.pointer).toMatch(/^\/activities\//);
    expect(precedence[0]?.message.length).toBeGreaterThan(0);
    expect(descriptor.expected.selected_plan).toBeNull();
  });

  it('leaves the environmental pack byte-identical to the valid pack', () => {
    const descriptor = descriptorOf('invalid-baseline-precedence');
    expect(descriptor.paths.environmental_source).toBe(
      `${VALID_PACK}/environmental`,
    );
    expect(descriptor.paths.environmental).toBeUndefined();
  });
});
