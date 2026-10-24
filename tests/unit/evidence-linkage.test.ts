import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  validateContract,
  type EnvironmentalSeries,
  type EvidenceRecord,
  type PlanningBundle,
} from '../../app/contracts/index.js';
import {
  linkEvidence,
  parseSourceRows,
  resolveDataLocator,
  selectionHash,
  type ActivityLinkTrace,
  type LinkageResult,
} from '../../app/evidence/linkage.js';
import { FINDING_CODES } from '../../app/validation/index.js';
import type { ScheduleInput } from '../../app/validation/index.js';

const SCENARIOS = {
  nominal: 'nominal',
  'plus-20': 'plus_20_sensitivity',
} as const;

type ScenarioKey = keyof typeof SCENARIOS;

function readJson(relative: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8'),
  );
}

function readText(relative: string): string {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
}

function planning(): PlanningBundle {
  return validateContract(
    'planning',
    readJson('input_examples/v2/planning.json'),
  ) as PlanningBundle;
}

function scenario(key: ScenarioKey) {
  const evidenceEnvelope = readJson(
    `input_examples/v2/environmental/${key}-evidence.json`,
  ) as { records: EvidenceRecord[] };
  const seriesEnvelope = readJson(
    `input_examples/v2/environmental/${key}-series.json`,
  ) as { series: EnvironmentalSeries[] };
  const rawText = readText(`input_examples/v2/environmental/${key}-pm25.csv`);
  const rawByRef: Record<string, string> = {};
  for (const record of evidenceEnvelope.records) {
    rawByRef[record.raw_ref] = rawText;
  }
  return {
    scenario_id: SCENARIOS[key],
    document: `input_examples/v2/environmental/${key}-series.json`,
    evidence: evidenceEnvelope.records,
    series: seriesEnvelope.series,
    rawByRef,
  };
}

function baselineSchedule(bundle: PlanningBundle): ScheduleInput {
  return {
    schedule_id: bundle.baseline.ref.id,
    kind: 'baseline',
    assignments: bundle.baseline.assignments,
  };
}

function illustrative(): ScheduleInput[] {
  const fixture = readJson('input_examples/v2/verification-schedules.json') as {
    schedules: {
      record: {
        id: string;
        assignments: { activity_id: string; start: string }[];
      };
    }[];
  };
  return fixture.schedules.map((entry) => ({
    schedule_id: entry.record.id,
    kind: 'candidate',
    assignments: entry.record.assignments,
  }));
}

function link(key: ScenarioKey, schedules: ScheduleInput[]): LinkageResult {
  return linkEvidence({
    planning: planning(),
    scenario: scenario(key),
    schedules,
  });
}

function trace(
  result: LinkageResult,
  scheduleId: string,
  workerId: string,
  activityId: string,
): ActivityLinkTrace {
  const found = result.traces.find(
    (entry) =>
      entry.schedule_id === scheduleId &&
      entry.worker_id === workerId &&
      entry.activity_id === activityId,
  );
  expect(found).toBeDefined();
  return found!;
}

/** Independent per-worker sum, computed here rather than read from a module. */
function workerTotal(
  result: LinkageResult,
  scheduleId: string,
  workerId: string,
): number {
  return result.traces
    .filter(
      (entry) =>
        entry.schedule_id === scheduleId && entry.worker_id === workerId,
    )
    .reduce(
      (total, entry) => total + (entry.activity_total_ug_m3_hours ?? 0),
      0,
    );
}

function crewTotal(result: LinkageResult, scheduleId: string): number {
  return result.traces
    .filter((entry) => entry.schedule_id === scheduleId)
    .reduce(
      (total, entry) => total + (entry.activity_total_ug_m3_hours ?? 0),
      0,
    );
}

describe('raw source resolution', () => {
  it('parses the hourly rows exactly', () => {
    const parsed = parseSourceRows(
      readText('input_examples/v2/environmental/nominal-pm25.csv'),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.length).toBe(8);
    expect(parsed.rows[0]).toEqual({
      row_id: 'yard-0800',
      location_id: 'yard',
      start: '2026-10-25T00:00:00Z',
      end: '2026-10-25T01:00:00Z',
      value: 100,
      unit: 'ug/m3',
    });
  });

  it('resolves a data locator to its exact rows and selection hash', () => {
    const pack = scenario('nominal');
    const record = pack.evidence.find(
      (entry) => entry.evidence_id === 'demo:pm25-yard-nominal',
    );
    expect(record).toBeDefined();
    const outcome = resolveDataLocator({
      evidence: record!,
      rawText: pack.rawByRef[record!.raw_ref]!,
      document: 'nominal-evidence.json',
    });
    expect(outcome.findings).toEqual([]);
    expect(outcome.locator?.resolved).toBe(true);
    expect(outcome.locator?.rows.map((row) => row.row_id)).toEqual([
      'yard-0800',
      'yard-0900',
      'yard-1000',
      'yard-1100',
    ]);
    expect(outcome.locator?.recomputed_selection_sha256).toBe(
      outcome.locator?.declared_selection_sha256,
    );
  });

  it('reports an unresolvable locator row instead of ignoring it', () => {
    const pack = scenario('nominal');
    const record = structuredClone(
      pack.evidence.find(
        (entry) => entry.evidence_id === 'demo:pm25-yard-nominal',
      )!,
    );
    if (record.locator.kind === 'data') {
      record.locator.row_ids = [...record.locator.row_ids, 'yard-1200'];
    }
    const outcome = resolveDataLocator({
      evidence: record,
      rawText: pack.rawByRef[record.raw_ref]!,
      document: 'nominal-evidence.json',
    });
    expect(outcome.findings.map((entry) => entry.code)).toContain(
      FINDING_CODES.locator_row_unresolved,
    );
    expect(outcome.locator?.resolved).toBe(false);
  });

  it('binds the selection hash to the selected lines only', () => {
    const lines = readText('input_examples/v2/environmental/nominal-pm25.csv')
      .trim()
      .split('\n')
      .slice(1, 5);
    expect(selectionHash(lines)).toBe(
      'aa2fa55a06caf52489e0f3c146792f9881c0f02a477f87c7f5f96d55dc318291',
    );
  });

  it('rejects a series value that disagrees with its source row', () => {
    const bundle = planning();
    const pack = scenario('nominal');
    const altered = {
      ...pack,
      series: pack.series.map((series) =>
        series.location_id === 'yard'
          ? {
              ...series,
              intervals: series.intervals.map((interval, index) =>
                index === 0 ? { ...interval, value: 99 } : interval,
              ),
            }
          : series,
      ),
    };
    const result = linkEvidence({
      planning: bundle,
      scenario: altered,
      schedules: [baselineSchedule(bundle)],
    });
    expect(result.findings.map((entry) => entry.code)).toContain(
      FINDING_CODES.series_value_source_mismatch,
    );
  });
});

describe('interval linkage', () => {
  it('splits a two-hour activity into two correctly weighted links', () => {
    const bundle = planning();
    const result = link('nominal', [baselineSchedule(bundle)]);
    const administration = trace(
      result,
      bundle.baseline.ref.id,
      'worker-a',
      'administration',
    );
    expect(administration.links.length).toBe(2);
    expect(
      administration.links.map((entry) => entry.allocation.overlap_minutes),
    ).toEqual([60, 60]);
    expect(
      administration.links.map((entry) => entry.allocation.overlap_hours),
    ).toEqual([1, 1]);
    expect(
      administration.links.map((entry) => entry.source_interval.start),
    ).toEqual(['2026-10-25T02:00:00Z', '2026-10-25T03:00:00Z']);
    expect(administration.activity_total_ug_m3_hours).toBe(40);
    for (const entry of administration.links) {
      expect(entry.allocation.convention).toBe('piecewise_constant_half_open');
      expect(entry.allocation.derived_segment).toBe(true);
      expect(entry.allocation.creates_new_observation).toBe(false);
      expect(entry.native_temporal_resolution).toEqual({
        value: 1,
        unit: 'hour',
      });
    }
  });

  it('neither duplicates nor loses a contribution at an exact hour boundary', () => {
    const bundle = planning();
    const result = link('nominal', [baselineSchedule(bundle)]);
    const inspection = trace(
      result,
      bundle.baseline.ref.id,
      'worker-a',
      'inspection',
    );
    expect(inspection.links.length).toBe(1);
    expect(inspection.links[0]?.allocation.overlap_minutes).toBe(60);
    expect(inspection.links[0]?.source_value).toBe(100);
    expect(inspection.activity_total_ug_m3_hours).toBe(100);
    expect(inspection.coverage).toBe('complete');
  });

  it('keeps one canonical activity identity while tracing each worker', () => {
    const bundle = planning();
    const result = link('nominal', [baselineSchedule(bundle)]);
    const traces = result.traces.filter(
      (entry) => entry.activity_id === 'maintenance',
    );
    expect(traces.map((entry) => entry.worker_id).sort()).toEqual([
      'worker-a',
      'worker-b',
    ]);
    expect(new Set(traces.map((entry) => entry.activity_id)).size).toBe(1);
    expect(traces[0]?.activity_total_ug_m3_hours).toBe(
      traces[1]?.activity_total_ug_m3_hours,
    );
  });

  it('carries the exact evidence revision, hash and locator on every link', () => {
    const bundle = planning();
    const result = link('nominal', [baselineSchedule(bundle)]);
    const inspection = trace(
      result,
      bundle.baseline.ref.id,
      'worker-a',
      'inspection',
    );
    const first = inspection.links[0];
    expect(first?.evidence_ref.id).toBe('demo:pm25-yard-nominal');
    expect(first?.evidence_ref.revision).toBe(1);
    expect(first?.evidence_ref.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first?.locator?.kind).toBe('data');
    expect(first?.source_row_ids).toEqual(['yard-0800']);
    expect(first?.unit).toBe('ug/m3');
  });

  it('links a +20 value to its nominal source record and pinned method', () => {
    const bundle = planning();
    const result = link('plus-20', [baselineSchedule(bundle)]);
    const inspection = trace(
      result,
      bundle.baseline.ref.id,
      'worker-a',
      'inspection',
    );
    expect(inspection.links[0]?.source_value).toBe(120);
    const lineage = inspection.links[0]?.transformation_lineage[0];
    expect(lineage?.method_id).toBe('fixture:pm25-add-20-ug-m3');
    expect(lineage?.method_version).toBe('1.0.0');
    expect(lineage?.input_refs[0]?.id).toBe('demo:pm25-yard-nominal');
  });

  it('leaves a one-hour hole as a gap and refuses to interpolate it', () => {
    const bundle = planning();
    const pack = scenario('nominal');
    const holed = {
      ...pack,
      series: pack.series.map((series) =>
        series.location_id === 'yard'
          ? {
              ...series,
              intervals: series.intervals.map((interval, index) =>
                index === 0
                  ? {
                      ...interval,
                      value: null,
                      null_reason: {
                        code: 'fixture_source_hour_withheld',
                        explanation: 'Removed to prove a gap stays a gap.',
                      },
                    }
                  : interval,
              ),
            }
          : series,
      ),
    };
    const result = linkEvidence({
      planning: bundle,
      scenario: holed,
      schedules: [baselineSchedule(bundle)],
    });
    const inspection = trace(
      result,
      bundle.baseline.ref.id,
      'worker-a',
      'inspection',
    );
    expect(inspection.links).toEqual([]);
    expect(inspection.coverage).toBe('incomplete');
    expect(inspection.activity_total_ug_m3_hours).toBeNull();
    expect(inspection.missing_intervals).toEqual([
      { start: '2026-10-25T00:00:00Z', end: '2026-10-25T01:00:00Z' },
    ]);
    expect(
      result.gaps.some(
        (gap) =>
          gap.activity_id === 'inspection' &&
          gap.reason === 'uncovered_interval',
      ),
    ).toBe(true);
    // Maintenance keeps its own supported hour; the hole is scoped.
    expect(
      trace(result, bundle.baseline.ref.id, 'worker-a', 'maintenance')
        .activity_total_ug_m3_hours,
    ).toBe(80);
  });

  it('links nothing for a location with unresolved conflicting series', () => {
    const bundle = planning();
    const pack = scenario('nominal');
    const yard = pack.series.find((series) => series.location_id === 'yard')!;
    const conflicted = {
      ...pack,
      series: [
        ...pack.series,
        { ...structuredClone(yard), series_id: 'pm25-yard-nominal-alternate' },
      ],
    };
    const result = linkEvidence({
      planning: bundle,
      scenario: conflicted,
      schedules: [baselineSchedule(bundle)],
    });
    expect(result.findings.map((entry) => entry.code)).toContain(
      FINDING_CODES.environmental_duplicate_series,
    );
    expect(
      result.selection.excluded.map((entry) => entry.series_id).sort(),
    ).toEqual(['pm25-yard-nominal', 'pm25-yard-nominal-alternate']);
    expect(
      trace(result, bundle.baseline.ref.id, 'worker-a', 'inspection').links,
    ).toEqual([]);
    expect(
      result.gaps.some((gap) => gap.reason === 'no_series_for_location'),
    ).toBe(true);
  });

  it('reports the pinned selection rule and the chosen series', () => {
    const bundle = planning();
    const result = link('nominal', [baselineSchedule(bundle)]);
    expect(result.selection.rule).toBe(
      'single_declared_series_per_location_v1',
    );
    expect(result.selection.chosen).toEqual([
      { location_id: 'yard', series_id: 'pm25-yard-nominal' },
      { location_id: 'office', series_id: 'pm25-office-nominal' },
    ]);
    expect(result.scope).toBe('evidence_trace_only');
  });
});

describe('architecture section 23 reference arithmetic', () => {
  const bundle = planning();
  const baseline = bundle.baseline.ref.id;
  const lessDisruption = 'demo:verification-less-disruption';
  const lowerProxy = 'demo:verification-lower-proxy';

  it('reproduces the nominal matched-activity integrals', () => {
    const result = link('nominal', [
      baselineSchedule(bundle),
      ...illustrative(),
    ]);
    const matched = (scheduleId: string, activityId: string) =>
      trace(result, scheduleId, 'worker-a', activityId)
        .activity_total_ug_m3_hours;
    expect(matched(baseline, 'inspection')).toBe(100);
    expect(matched(baseline, 'maintenance')).toBe(80);
    expect(matched(baseline, 'administration')).toBe(40);
    expect(matched(lessDisruption, 'inspection')).toBe(100);
    expect(matched(lessDisruption, 'maintenance')).toBe(30);
    expect(matched(lessDisruption, 'administration')).toBe(40);
    expect(matched(lowerProxy, 'inspection')).toBe(50);
    expect(matched(lowerProxy, 'maintenance')).toBe(30);
    expect(matched(lowerProxy, 'administration')).toBe(40);
  });

  it('reproduces the nominal per-worker and crew sums', () => {
    const result = link('nominal', [
      baselineSchedule(bundle),
      ...illustrative(),
    ]);
    for (const worker of ['worker-a', 'worker-b']) {
      expect(workerTotal(result, baseline, worker)).toBe(220);
      expect(workerTotal(result, lessDisruption, worker)).toBe(170);
      expect(workerTotal(result, lowerProxy, worker)).toBe(120);
    }
    expect(crewTotal(result, baseline)).toBe(440);
    expect(crewTotal(result, lessDisruption)).toBe(340);
    expect(crewTotal(result, lowerProxy)).toBe(240);
  });

  it('reproduces the +20 sensitivity matched-activity and crew values', () => {
    const result = link('plus-20', [
      baselineSchedule(bundle),
      ...illustrative(),
    ]);
    const matched = (scheduleId: string, activityId: string) =>
      trace(result, scheduleId, 'worker-a', activityId)
        .activity_total_ug_m3_hours;
    expect(matched(baseline, 'inspection')).toBe(120);
    expect(matched(baseline, 'maintenance')).toBe(100);
    expect(matched(baseline, 'administration')).toBe(80);
    expect(matched(lessDisruption, 'maintenance')).toBe(50);
    expect(matched(lowerProxy, 'inspection')).toBe(70);
    expect(workerTotal(result, baseline, 'worker-a')).toBe(300);
    expect(workerTotal(result, lessDisruption, 'worker-a')).toBe(250);
    expect(workerTotal(result, lowerProxy, 'worker-a')).toBe(200);
    expect(crewTotal(result, baseline)).toBe(600);
    expect(crewTotal(result, lessDisruption)).toBe(500);
    expect(crewTotal(result, lowerProxy)).toBe(400);
  });
});
