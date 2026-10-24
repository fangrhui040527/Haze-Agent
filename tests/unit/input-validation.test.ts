import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MINUTE_MS,
  mergeIntervals,
  overlapMinutes,
  uncoveredSegments,
} from '../../app/evidence/intervals.js';
import {
  FINDING_CODES,
  parseInputDocument,
  pointer,
  validateInputs,
  type EnvironmentalPack,
  type Finding,
  type ScheduleInput,
  type ValidationReport,
} from '../../app/validation/index.js';

const SCENARIOS = [
  { scenario: 'nominal', id: 'nominal' },
  { scenario: 'plus-20', id: 'plus_20_sensitivity' },
] as const;

function readFixture(relative: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8'),
  );
}

function planning(): Record<string, unknown> {
  return readFixture('input_examples/v2/planning.json') as Record<
    string,
    unknown
  >;
}

function packs(): EnvironmentalPack[] {
  return SCENARIOS.map(({ scenario, id }) => ({
    scenario_id: id,
    document: `input_examples/v2/environmental/${scenario}-series.json`,
    evidence: readFixture(
      `input_examples/v2/environmental/${scenario}-evidence.json`,
    ),
    series: readFixture(
      `input_examples/v2/environmental/${scenario}-series.json`,
    ),
  }));
}

/** The two illustrative verification schedules, as coverage candidates. */
function illustrativeCandidates(): ScheduleInput[] {
  const fixture = readFixture(
    'input_examples/v2/verification-schedules.json',
  ) as {
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

type SeriesEnvelope = {
  series: {
    series_id: string;
    location_id: string;
    unit: string;
    pollutant: string;
    intervals: {
      start: string;
      end: string;
      value: number | null;
      quality_flag: string;
      null_reason: { code: string; explanation: string } | null;
    }[];
  }[];
};

function seriesOf(pack: EnvironmentalPack): SeriesEnvelope {
  return pack.series as SeriesEnvelope;
}

/** Replace one hour with an explicit null, as a removed-source fixture would. */
function blankHour(
  pack: EnvironmentalPack,
  locationId: string,
  startsWith: string,
) {
  for (const series of seriesOf(pack).series) {
    if (series.location_id !== locationId) continue;
    for (const interval of series.intervals) {
      if (!interval.start.startsWith(startsWith)) continue;
      interval.value = null;
      interval.null_reason = {
        code: 'fixture_interval_removed_for_test',
        explanation: 'Deliberately removed source hour for a negative case.',
      };
    }
  }
}

function codes(report: ValidationReport): string[] {
  return report.findings.map((entry) => entry.code);
}

function withCode(report: ValidationReport, code: string): Finding[] {
  return report.findings.filter((entry) => entry.code === code);
}

describe('half-open interval helpers', () => {
  it('allocates an activity across two hourly source intervals', () => {
    const hour = 60 * MINUTE_MS;
    const activity = { start: 45 * MINUTE_MS, end: 75 * MINUTE_MS };
    expect(overlapMinutes(activity, { start: 0, end: hour })).toBe(15);
    expect(overlapMinutes(activity, { start: hour, end: 2 * hour })).toBe(15);
  });

  it('treats an exact boundary as neither duplicated nor lost', () => {
    const hour = 60 * MINUTE_MS;
    const activity = { start: 0, end: hour };
    expect(overlapMinutes(activity, { start: 0, end: hour })).toBe(60);
    expect(overlapMinutes(activity, { start: hour, end: 2 * hour })).toBe(0);
    expect(uncoveredSegments(activity, [{ start: 0, end: hour }])).toEqual([]);
  });

  it('reports a one-hour hole instead of bridging it', () => {
    const hour = 60 * MINUTE_MS;
    const gaps = uncoveredSegments({ start: 0, end: 3 * hour }, [
      { start: 0, end: hour },
      { start: 2 * hour, end: 3 * hour },
    ]);
    expect(gaps).toEqual([{ start: hour, end: 2 * hour }]);
  });

  it('merges touching intervals without inventing coverage', () => {
    expect(
      mergeIntervals([
        { start: 10, end: 20 },
        { start: 20, end: 30 },
        { start: 50, end: 60 },
      ]),
    ).toEqual([
      { start: 10, end: 30 },
      { start: 50, end: 60 },
    ]);
  });
});

describe('JSON pointers and document parsing', () => {
  it('escapes pointer segments per RFC 6901', () => {
    expect(pointer([])).toBe('');
    expect(pointer(['activities', 2, 'allowed_starts', 0])).toBe(
      '/activities/2/allowed_starts/0',
    );
    expect(pointer(['a/b', 'c~d'])).toBe('/a~1b/c~0d');
  });

  it('rejects a duplicate JSON key rather than keeping the last value', () => {
    const parsed = parseInputDocument(
      '{"programme_id":"a","programme_id":"b"}',
      'duplicate.json',
    );
    expect(parsed.value).toBeUndefined();
    expect(parsed.findings.map((entry) => entry.code)).toEqual([
      FINDING_CODES.malformed_json,
    ]);
    expect(parsed.findings[0]?.message).toMatch(/duplicate_json_key/);
  });

  it('accepts the shipped planning bytes', () => {
    const source = readFileSync(
      new URL('../../input_examples/v2/planning.json', import.meta.url),
      'utf8',
    );
    const parsed = parseInputDocument(source, 'planning.json');
    expect(parsed.findings).toEqual([]);
    expect(parsed.value).toBeTypeOf('object');
  });
});

describe('valid fixture pack', () => {
  it('admits the bundle with supported nominal and +20 coverage', () => {
    const report = validateInputs({
      planning: planning(),
      environmental: packs(),
      candidates: illustrativeCandidates(),
      requiredScenarios: ['nominal', 'plus_20_sensitivity'],
    });
    expect(report.outcome).toBe('admitted_with_supported_coverage');
    expect(report.admitted).toBe(true);
    expect(report.environmental.status).toBe('supported');
    expect(report.environmental.missing_scenarios).toEqual([]);
    expect(report.quantified_comparison_available).toBe(true);
    expect(report.transport_status_hint).toBe(200);
    expect(
      report.findings.filter((entry) => entry.severity !== 'advisory'),
    ).toEqual([]);
    expect(
      report.environmental.scenarios.map((entry) => entry.scenario_id),
    ).toEqual(['nominal', 'plus_20_sensitivity']);
    for (const scenario of report.environmental.scenarios) {
      expect(scenario.baseline_covered).toBe(true);
      expect(scenario.excluded_schedule_ids).toEqual([]);
      expect(scenario.gaps).toEqual([]);
    }
  });

  it('never grants acceptance, applicability or eligibility', () => {
    const report = validateInputs({
      planning: planning(),
      environmental: packs(),
    });
    expect(report.acceptance_status).toBe('not_accepted');
    expect(report.applicability_status).toBe('not_assessed');
    expect(report.recommendation_eligible).toBe(false);
    expect(report.input_origin).toBe('synthetic_fixture');
    expect(report.fictional_use).toBe(true);
  });

  it('reports not_assessed when no environmental pack is supplied', () => {
    const report = validateInputs({ planning: planning() });
    expect(report.admitted).toBe(true);
    expect(report.environmental.status).toBe('not_assessed');
    expect(report.environmental.reason).toBe('no_environmental_pack_supplied');
    expect(report.quantified_comparison_available).toBe(false);
  });
});

describe('malformed and unsupported contracts', () => {
  it('rejects an unsupported contract version without reinterpreting it', () => {
    const bundle = planning();
    bundle.schema_version = 'haze.planning.v1';
    const report = validateInputs({ planning: bundle });
    expect(codes(report)).toEqual([FINDING_CODES.unsupported_contract_version]);
    expect(report.transport_status_hint).toBe(400);
    expect(report.quantified_comparison_available).toBe(false);
    expect(report.recommendation_eligible).toBe(false);
  });

  it('rejects an unknown property', () => {
    const bundle = planning();
    bundle.unexpected_field = true;
    const report = validateInputs({ planning: bundle });
    expect(codes(report)).toContain(FINDING_CODES.unknown_property);
    expect(report.transport_status_hint).toBe(400);
  });

  it('reports a missing required field with its pointer', () => {
    const bundle = planning();
    delete bundle.policy_ref;
    const report = validateInputs({ planning: bundle });
    const found = withCode(report, FINDING_CODES.missing_required_field);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.pointer).toBe('/policy_ref');
  });

  it('yields no numerical comparison for malformed input', () => {
    const report = validateInputs({
      planning: { schema_version: 'haze.planning.v2' },
      environmental: packs(),
    });
    expect(report.admitted).toBe(false);
    expect(report.quantified_comparison_available).toBe(false);
    expect(report.environmental.status).toBe('not_assessed');
    expect(report.environmental.reason).toBe('operating_input_invalid');
  });
});

describe('invalid operating semantics', () => {
  it('reports duplicate worker IDs', () => {
    const bundle = planning();
    const crew = bundle.crew as { workers: unknown[] };
    crew.workers = [crew.workers[0], crew.workers[0]];
    const report = validateInputs({ planning: bundle });
    expect(codes(report)).toContain(FINDING_CODES.duplicate_identifier);
    expect(report.transport_status_hint).toBe(422);
  });

  it('reports an unknown predecessor reference with the affected ID', () => {
    const bundle = planning();
    const activities = bundle.activities as { predecessor_ids: string[] }[];
    activities[1]!.predecessor_ids = ['no-such-activity'];
    const report = validateInputs({ planning: bundle });
    const found = withCode(report, FINDING_CODES.unknown_reference);
    expect(found.length).toBeGreaterThan(0);
    expect(
      found.some((entry) => entry.affected_ids.includes('no-such-activity')),
    ).toBe(true);
    expect(found[0]?.domain).toBe('operating_input');
  });

  it('reports an offset that is not Kuala Lumpur local time', () => {
    const bundle = planning();
    const assessment = bundle.assessment as { start: string };
    assessment.start = '2026-10-25T00:00:00Z';
    const report = validateInputs({ planning: bundle });
    expect(codes(report)).toContain(FINDING_CODES.timezone_offset_mismatch);
  });

  it('reports an unaligned allowed start', () => {
    const bundle = planning();
    const activities = bundle.activities as { allowed_starts: string[] }[];
    activities[0]!.allowed_starts = ['2026-10-25T08:05:00+08:00'];
    const report = validateInputs({ planning: bundle });
    expect(codes(report)).toContain(FINDING_CODES.unaligned_start);
  });

  it('reports a duration that is not whole planning steps', () => {
    const bundle = planning();
    const activities = bundle.activities as { duration_minutes: number }[];
    activities[0]!.duration_minutes = 50;
    const report = validateInputs({ planning: bundle });
    expect(codes(report)).toContain(FINDING_CODES.duration_not_whole_steps);
  });

  it('reports a baseline that breaks finish-to-start precedence', () => {
    const bundle = planning();
    const baseline = bundle.baseline as {
      assignments: { activity_id: string; start: string }[];
    };
    for (const assignment of baseline.assignments) {
      if (assignment.activity_id === 'maintenance') {
        assignment.start = '2026-10-25T08:00:00+08:00';
      }
    }
    const report = validateInputs({ planning: bundle });
    expect(codes(report)).toContain(FINDING_CODES.precedence_violation);
    expect(report.admitted).toBe(false);
    expect(report.transport_status_hint).toBe(422);
  });

  it('reports an occupancy gap rather than assuming idle time', () => {
    const bundle = planning();
    const baseline = bundle.baseline as {
      assignments: { activity_id: string; start: string }[];
    };
    for (const assignment of baseline.assignments) {
      if (assignment.activity_id === 'administration') {
        assignment.start = '2026-10-25T10:15:00+08:00';
      }
    }
    const report = validateInputs({ planning: bundle });
    expect(codes(report)).toContain(FINDING_CODES.occupancy_gap_or_overlap);
  });
});

describe('environmental record checks', () => {
  it('reports a negative concentration without clamping it', () => {
    const supplied = packs();
    seriesOf(supplied[0]!).series[0]!.intervals[0]!.value = -1;
    const report = validateInputs({
      planning: planning(),
      environmental: supplied,
    });
    expect(codes(report)).toContain(FINDING_CODES.environmental_negative_value);
    expect(report.environmental.status).toBe('insufficient');
  });

  it('refuses an unapproved unit conversion', () => {
    const supplied = packs();
    seriesOf(supplied[0]!).series[0]!.unit = 'mg/m3';
    const report = validateInputs({
      planning: planning(),
      environmental: supplied,
    });
    expect(codes(report)).toContain(
      FINDING_CODES.environmental_unsupported_conversion,
    );
    expect(report.environmental.status).toBe('insufficient');
  });

  it('refuses to choose between two series for one location', () => {
    const supplied = packs();
    const envelope = seriesOf(supplied[0]!);
    const duplicate = structuredClone(envelope.series[0]!);
    duplicate.series_id = `${duplicate.series_id}-alternate`;
    envelope.series.push(duplicate);
    const report = validateInputs({
      planning: planning(),
      environmental: supplied,
    });
    expect(codes(report)).toContain(
      FINDING_CODES.environmental_duplicate_series,
    );
  });

  it('reports a required scenario that no pack supplies', () => {
    const report = validateInputs({
      planning: planning(),
      environmental: [packs()[0]!],
      requiredScenarios: ['nominal', 'plus_20_sensitivity'],
    });
    const found = withCode(
      report,
      FINDING_CODES.environmental_scenario_missing,
    );
    expect(found[0]?.affected_ids).toEqual(['plus_20_sensitivity']);
    expect(report.environmental.missing_scenarios).toEqual([
      'plus_20_sensitivity',
    ]);
    expect(report.environmental.status).toBe('insufficient');
  });

  it('keeps an environmental insufficiency out of the server-fault path', () => {
    const supplied = packs();
    blankHour(supplied[0]!, 'yard', '2026-10-25T00:00');
    const report = validateInputs({
      planning: planning(),
      environmental: supplied,
    });
    expect(report.outcome).toBe('admitted_with_environmental_insufficiency');
    expect(report.transport_status_hint).toBe(200);
    expect(report.admitted).toBe(true);
  });
});

describe('coverage by occupied location and time', () => {
  it('blocks a quantified comparison when baseline coverage is missing', () => {
    const supplied = packs();
    blankHour(supplied[0]!, 'yard', '2026-10-25T00:00');
    const report = validateInputs({
      planning: planning(),
      environmental: supplied,
      candidates: illustrativeCandidates(),
    });
    const nominal = report.environmental.scenarios.find(
      (entry) => entry.scenario_id === 'nominal',
    );
    expect(nominal?.baseline_covered).toBe(false);
    expect(report.quantified_comparison_available).toBe(false);
    expect(codes(report)).toContain(
      FINDING_CODES.environmental_baseline_coverage_missing,
    );
    const gap = nominal?.gaps.find(
      (entry) => entry.schedule_kind === 'baseline',
    );
    expect(gap?.activity_id).toBe('inspection');
    expect(gap?.location_id).toBe('yard');
    expect(gap?.reason).toBe('uncovered_interval');
    expect(gap?.missing_intervals).toEqual([
      { start: '2026-10-25T00:00:00Z', end: '2026-10-25T01:00:00Z' },
    ]);
    expect(gap?.worker_id).toBeTypeOf('string');
  });

  it('ignores a gap at a location and hour nobody occupies', () => {
    const supplied = packs();
    // Baseline office occupancy is 10:00-12:00 local, so the 08:00 office hour
    // is unused and its absence must not invalidate the comparison.
    blankHour(supplied[0]!, 'office', '2026-10-25T00:00');
    const report = validateInputs({
      planning: planning(),
      environmental: supplied,
    });
    expect(report.environmental.status).toBe('supported');
    expect(report.quantified_comparison_available).toBe(true);
    expect(codes(report)).toContain(FINDING_CODES.environmental_null_interval);
    expect(
      withCode(report, FINDING_CODES.environmental_null_interval)[0]?.severity,
    ).toBe('advisory');
  });

  it('excludes only the affected candidate when the baseline stays covered', () => {
    const supplied = packs();
    // Yard 11:00-12:00 local is unused by the baseline but used by both
    // illustrative candidates, which place maintenance at 11:00.
    blankHour(supplied[0]!, 'yard', '2026-10-25T03:00');
    const report = validateInputs({
      planning: planning(),
      environmental: supplied,
      candidates: illustrativeCandidates(),
    });
    const nominal = report.environmental.scenarios.find(
      (entry) => entry.scenario_id === 'nominal',
    );
    expect(nominal?.baseline_covered).toBe(true);
    expect(nominal?.excluded_schedule_ids.length).toBe(2);
    expect(nominal?.covered_schedule_ids).toContain(
      'demo:fictional-ordinary-baseline',
    );
    expect(report.environmental.status).toBe('supported');
    const exclusions = withCode(
      report,
      FINDING_CODES.environmental_coverage_gap,
    );
    expect(exclusions.length).toBeGreaterThan(0);
    for (const exclusion of exclusions) {
      expect(exclusion.severity).toBe('scoped_exclusion');
    }
  });

  it('reports a missing series for an occupied location', () => {
    const supplied = packs();
    const envelope = seriesOf(supplied[0]!);
    envelope.series = envelope.series.filter(
      (series) => series.location_id !== 'office',
    );
    const report = validateInputs({
      planning: planning(),
      environmental: supplied,
    });
    const nominal = report.environmental.scenarios.find(
      (entry) => entry.scenario_id === 'nominal',
    );
    const gap = nominal?.gaps.find((entry) => entry.location_id === 'office');
    expect(gap?.reason).toBe('no_series_for_location');
    expect(nominal?.baseline_covered).toBe(false);
  });
});
