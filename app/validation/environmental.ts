import type {
  EnvironmentalSeries,
  PlanningBundle,
} from '../contracts/index.js';
import { validateContract } from '../contracts/index.js';
import type { HalfOpenInterval } from '../evidence/intervals.js';
import {
  MINUTE_MS,
  parseInstant,
  toUtcInstant,
  uncoveredSegments,
} from '../evidence/intervals.js';
import { selectSeriesByLocation } from '../evidence/selection.js';
import { contractFindings } from './contract-findings.js';
import type { Finding } from './findings.js';
import { FINDING_CODES, finding } from './findings.js';

/** Canonical screening quantity and unit (Architecture v0.13 §4.3). */
export const CANONICAL_POLLUTANT = 'PM2.5';
export const CANONICAL_UNIT = 'ug/m3';

/** One scenario's environmental pack as stored on disk. */
export interface EnvironmentalPack {
  scenario_id: string;
  /** Document label used in diagnostics, normally the fixture path. */
  document: string;
  /** `{ ..., records: EvidenceRecord[] }` envelope. */
  evidence: unknown;
  /** `{ ..., series: EnvironmentalSeries[] }` envelope. */
  series: unknown;
}

export interface ScheduleInput {
  schedule_id: string;
  kind: 'baseline' | 'candidate';
  assignments: readonly { activity_id: string; start: string }[];
}

export type CoverageGapReason =
  | 'no_series_for_location'
  | 'location_source_unresolved'
  | 'uncovered_interval'
  | 'missing_assignment';

export interface CoverageGap {
  scenario_id: string;
  schedule_id: string;
  schedule_kind: 'baseline' | 'candidate';
  worker_id: string | null;
  activity_id: string;
  location_id: string;
  reason: CoverageGapReason;
  /** Uncovered UTC segments; empty when the whole source is absent. */
  missing_intervals: { start: string; end: string }[];
}

export interface ScenarioCoverage {
  scenario_id: string;
  baseline_covered: boolean;
  covered_schedule_ids: string[];
  excluded_schedule_ids: string[];
  gaps: CoverageGap[];
}

export interface EnvironmentalAssessment {
  status: 'supported' | 'insufficient' | 'not_assessed';
  reason: string | null;
  canonical_unit: typeof CANONICAL_UNIT;
  /** Gaps are reported as gaps; no zero fill, interpolation or indoor ratio. */
  gap_fill_policy: 'never_zero_never_interpolated_never_indoor_ratio';
  scenarios: ScenarioCoverage[];
  required_scenarios_declared: boolean;
  missing_scenarios: string[];
}

export interface ResolvedPack {
  scenario_id: string;
  document: string;
  series: EnvironmentalSeries[];
}

function records(envelope: unknown, key: string): unknown[] | null {
  if (envelope === null || typeof envelope !== 'object') return null;
  const value = (envelope as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : null;
}

/**
 * Validate one scenario pack's evidence and series records.
 *
 * Shape validity is not acceptance: `disposition` and applicability stay with
 * the record and are never inferred from a passing schema.
 */
export function validateEnvironmentalPack(pack: EnvironmentalPack): {
  findings: Finding[];
  resolved: ResolvedPack | null;
} {
  const findings: Finding[] = [];
  const evidenceRecords = records(pack.evidence, 'records');
  const seriesRecords = records(pack.series, 'series');
  if (evidenceRecords === null || seriesRecords === null) {
    findings.push(
      finding({
        code: FINDING_CODES.environmental_envelope_invalid,
        domain: 'environmental',
        severity: 'blocking',
        document: pack.document,
        affected_ids: [pack.scenario_id],
        message:
          'Environmental pack must supply a `records` array of evidence and a `series` array of resolved series.',
      }),
    );
    return { findings, resolved: null };
  }
  evidenceRecords.forEach((record, index) => {
    try {
      validateContract('evidence', record);
    } catch (error) {
      findings.push(
        ...contractFindings({
          error,
          document: `${pack.document}#/records/${index}`,
          value: record,
          domain: 'environmental',
        }).map((entry) => ({
          ...entry,
          code: FINDING_CODES.environmental_record_invalid,
        })),
      );
    }
  });
  const resolved: EnvironmentalSeries[] = [];
  seriesRecords.forEach((record, index) => {
    let parsed: EnvironmentalSeries;
    try {
      parsed = validateContract(
        'environmental_series',
        record,
      ) as EnvironmentalSeries;
    } catch (error) {
      findings.push(
        ...contractFindings({
          error,
          document: `${pack.document}#/series/${index}`,
          value: record,
          domain: 'environmental',
        }),
      );
      return;
    }
    findings.push(...seriesDomainFindings(parsed, pack, index));
    resolved.push(parsed);
  });
  return {
    findings,
    resolved: {
      scenario_id: pack.scenario_id,
      document: pack.document,
      series: resolved,
    },
  };
}

/** Quantity, unit and explicit-null checks beyond the structural contract. */
function seriesDomainFindings(
  series: EnvironmentalSeries,
  pack: EnvironmentalPack,
  index: number,
): Finding[] {
  const found: Finding[] = [];
  const document = `${pack.document}#/series/${index}`;
  const ids = [series.series_id, series.location_id, pack.scenario_id];
  if (series.pollutant !== CANONICAL_POLLUTANT) {
    found.push(
      finding({
        code: FINDING_CODES.environmental_unexpected_pollutant,
        domain: 'environmental',
        severity: 'blocking',
        document,
        path: ['pollutant'],
        affected_ids: ids,
        message: `This screening proxy reads ${CANONICAL_POLLUTANT} only; received ${JSON.stringify(series.pollutant)}. Supply the declared pollutant rather than relabelling the series.`,
      }),
    );
  }
  if (series.unit !== CANONICAL_UNIT) {
    found.push(
      finding({
        code: FINDING_CODES.environmental_unsupported_conversion,
        domain: 'environmental',
        severity: 'blocking',
        document,
        path: ['unit'],
        affected_ids: ids,
        message: `No unit conversion is approved for this slice. Express values in the canonical ${CANONICAL_UNIT} at source; received ${JSON.stringify(series.unit)}.`,
      }),
    );
  }
  series.intervals.forEach((interval, position) => {
    if (interval.value === null) {
      found.push(
        finding({
          code: FINDING_CODES.environmental_null_interval,
          domain: 'environmental',
          severity: 'advisory',
          document,
          path: ['intervals', position, 'value'],
          affected_ids: ids,
          message: `Interval ${interval.start}/${interval.end} carries an explicit null (${interval.null_reason?.code ?? 'no_reason'}). It stays missing; it becomes a blocking gap only where a worker occupies this location and time.`,
        }),
      );
      return;
    }
    if (!Number.isFinite(interval.value)) {
      found.push(
        finding({
          code: FINDING_CODES.environmental_nonfinite_value,
          domain: 'environmental',
          severity: 'blocking',
          document,
          path: ['intervals', position, 'value'],
          affected_ids: ids,
          message:
            'Concentrations must be finite. Correct the source row; a nonfinite value is never treated as zero or missing.',
        }),
      );
    } else if (interval.value < 0) {
      found.push(
        finding({
          code: FINDING_CODES.environmental_negative_value,
          domain: 'environmental',
          severity: 'blocking',
          document,
          path: ['intervals', position, 'value'],
          affected_ids: ids,
          message:
            'Concentrations must be nonnegative. Correct the source row rather than clamping it.',
        }),
      );
    }
  });
  return found;
}

/**
 * Apply the pinned source-selection rule and report unresolved conflicts
 * (Architecture v0.13 §4.3). Nothing is chosen implicitly.
 */
function selectByLocation(pack: ResolvedPack): {
  byLocation: Map<string, EnvironmentalSeries>;
  unresolved: Set<string>;
  findings: Finding[];
} {
  const selection = selectSeriesByLocation(pack.series);
  const findings = selection.conflicts.map((conflict) =>
    finding({
      code: FINDING_CODES.environmental_duplicate_series,
      domain: 'environmental',
      severity: 'blocking',
      document: pack.document,
      affected_ids: [
        conflict.location_id,
        pack.scenario_id,
        ...conflict.candidate_series_ids,
      ],
      message: `Location ${conflict.location_id} resolves to ${conflict.candidate_series_ids.length} series in scenario ${pack.scenario_id} under rule ${selection.rule}. Pin a versioned source-selection rule and record the excluded alternatives; no series is chosen implicitly.`,
    }),
  );
  return {
    byLocation: selection.byLocation,
    unresolved: new Set(
      selection.conflicts.map((conflict) => conflict.location_id),
    ),
    findings,
  };
}

function supportedIntervals(series: EnvironmentalSeries): HalfOpenInterval[] {
  const intervals: HalfOpenInterval[] = [];
  for (const interval of series.intervals) {
    if (interval.value === null) continue;
    const start = parseInstant(interval.start);
    const end = parseInstant(interval.end);
    if (start === null || end === null || end <= start) continue;
    intervals.push({ start, end });
  }
  return intervals;
}

/**
 * Coverage of every occupied worker/activity interval for one scenario.
 *
 * Only occupied locations and times are required: a gap at an unused location
 * does not invalidate a covered schedule, but any resulting exclusion from the
 * action space is reported.
 */
export function assessScenarioCoverage(input: {
  planning: PlanningBundle;
  pack: ResolvedPack;
  schedules: readonly ScheduleInput[];
}): { coverage: ScenarioCoverage; findings: Finding[] } {
  const { planning, pack } = input;
  const selection = selectByLocation(pack);
  const findings = [...selection.findings];
  const gaps: CoverageGap[] = [];
  const covered: string[] = [];
  const excluded: string[] = [];

  for (const schedule of input.schedules) {
    const starts = new Map(
      schedule.assignments.map((assignment) => [
        assignment.activity_id,
        assignment.start,
      ]),
    );
    const scheduleGaps: CoverageGap[] = [];
    for (const activity of planning.activities) {
      const start = starts.get(activity.activity_id);
      const workers: (string | null)[] =
        activity.worker_ids.length > 0 ? [...activity.worker_ids] : [null];
      if (start === undefined) {
        for (const worker of workers) {
          scheduleGaps.push({
            scenario_id: pack.scenario_id,
            schedule_id: schedule.schedule_id,
            schedule_kind: schedule.kind,
            worker_id: worker,
            activity_id: activity.activity_id,
            location_id: activity.location_id,
            reason: 'missing_assignment',
            missing_intervals: [],
          });
        }
        continue;
      }
      const startMs = parseInstant(start);
      if (startMs === null) continue;
      const target: HalfOpenInterval = {
        start: startMs,
        end: startMs + activity.duration_minutes * MINUTE_MS,
      };
      const series = selection.byLocation.get(activity.location_id);
      const reason: CoverageGapReason | null = series
        ? null
        : selection.unresolved.has(activity.location_id)
          ? 'location_source_unresolved'
          : 'no_series_for_location';
      if (!series || reason !== null) {
        for (const worker of workers) {
          scheduleGaps.push({
            scenario_id: pack.scenario_id,
            schedule_id: schedule.schedule_id,
            schedule_kind: schedule.kind,
            worker_id: worker,
            activity_id: activity.activity_id,
            location_id: activity.location_id,
            reason: reason ?? 'no_series_for_location',
            missing_intervals: [
              {
                start: toUtcInstant(target.start),
                end: toUtcInstant(target.end),
              },
            ],
          });
        }
        continue;
      }
      const missing = uncoveredSegments(target, supportedIntervals(series));
      if (missing.length === 0) continue;
      for (const worker of workers) {
        scheduleGaps.push({
          scenario_id: pack.scenario_id,
          schedule_id: schedule.schedule_id,
          schedule_kind: schedule.kind,
          worker_id: worker,
          activity_id: activity.activity_id,
          location_id: activity.location_id,
          reason: 'uncovered_interval',
          missing_intervals: missing.map((segment) => ({
            start: toUtcInstant(segment.start),
            end: toUtcInstant(segment.end),
          })),
        });
      }
    }
    gaps.push(...scheduleGaps);
    if (scheduleGaps.length === 0) covered.push(schedule.schedule_id);
    else excluded.push(schedule.schedule_id);
  }

  const baselineGaps = gaps.filter((gap) => gap.schedule_kind === 'baseline');
  const baselineCovered = baselineGaps.length === 0;
  if (!baselineCovered) {
    findings.push(
      finding({
        code: FINDING_CODES.environmental_baseline_coverage_missing,
        domain: 'environmental',
        severity: 'blocking',
        document: pack.document,
        affected_ids: [
          ...new Set(
            baselineGaps.flatMap((gap) => [
              gap.activity_id,
              gap.location_id,
              ...(gap.worker_id === null ? [] : [gap.worker_id]),
            ]),
          ),
        ],
        message: `Scenario ${pack.scenario_id} lacks baseline coverage for ${baselineGaps.length} occupied worker/activity interval(s). There is no quantified comparison for this scenario; the precise gaps are listed and are not zero-filled.`,
      }),
    );
  }
  for (const gap of gaps) {
    if (gap.schedule_kind === 'baseline') continue;
    findings.push(
      finding({
        code: FINDING_CODES.environmental_coverage_gap,
        domain: 'environmental',
        severity: 'scoped_exclusion',
        document: pack.document,
        affected_ids: [
          gap.schedule_id,
          gap.activity_id,
          gap.location_id,
          ...(gap.worker_id === null ? [] : [gap.worker_id]),
        ],
        message: `Candidate ${gap.schedule_id} is excluded from scenario ${gap.scenario_id}: ${gap.reason} for activity ${gap.activity_id} at ${gap.location_id}. Other covered alternatives remain scoreable; this exclusion proves nothing about the uncovered option.`,
      }),
    );
  }
  return {
    coverage: {
      scenario_id: pack.scenario_id,
      baseline_covered: baselineCovered,
      covered_schedule_ids: covered,
      excluded_schedule_ids: excluded,
      gaps,
    },
    findings,
  };
}
