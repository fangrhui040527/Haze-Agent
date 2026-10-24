import { createHash } from 'node:crypto';
import type {
  EnvironmentalSeries,
  EvidenceRecord,
  ImmutableReference,
  PlanningBundle,
} from '../contracts/index.js';
import type { CoverageGap, ScheduleInput } from '../validation/index.js';
import type { Finding } from '../validation/findings.js';
import { FINDING_CODES, finding } from '../validation/findings.js';
import type { HalfOpenInterval } from './intervals.js';
import {
  HOUR_MS,
  MINUTE_MS,
  overlapMs,
  parseInstant,
  toUtcInstant,
  uncoveredSegments,
} from './intervals.js';
import { selectSeriesByLocation } from './selection.js';

/** One row of a raw hourly source file, exactly as published. */
export interface SourceRow {
  row_id: string;
  location_id: string;
  start: string;
  end: string;
  value: number;
  unit: string;
}

const SOURCE_COLUMNS = [
  'row_id',
  'location_id',
  'start_utc',
  'end_utc',
  'value',
  'unit',
] as const;

/**
 * Read the raw hourly source. Values are parsed exactly; a malformed cell is
 * reported rather than coerced, and nothing is interpolated or defaulted.
 */
export function parseSourceRows(text: string): {
  rows: SourceRow[];
  lines: string[];
  errors: { line: number; reason: string }[];
} {
  const lines = text.replace(/\r\n/g, '\n').trim().split('\n');
  const errors: { line: number; reason: string }[] = [];
  const header = lines[0]?.split(',') ?? [];
  if (SOURCE_COLUMNS.some((column, index) => header[index] !== column)) {
    errors.push({ line: 1, reason: 'unexpected_source_header' });
    return { rows: [], lines: lines.slice(1), errors };
  }
  const rows: SourceRow[] = [];
  lines.slice(1).forEach((line, index) => {
    const cells = line.split(',');
    if (cells.length !== SOURCE_COLUMNS.length) {
      errors.push({
        line: index + 2,
        reason: 'unexpected_source_column_count',
      });
      return;
    }
    const [rowId, locationId, start, end, rawValue, unit] = cells as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (!/^-?\d+(\.\d+)?$/.test(rawValue)) {
      errors.push({ line: index + 2, reason: 'nonnumeric_source_value' });
      return;
    }
    rows.push({
      row_id: rowId,
      location_id: locationId,
      start,
      end,
      value: Number(rawValue),
      unit,
    });
  });
  return { rows, lines: lines.slice(1), errors };
}

/**
 * `selection_sha256` binds the selected source lines, in file order, joined by
 * a single newline with no header and no trailing newline.
 */
export function selectionHash(lines: readonly string[]): string {
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

export interface ResolvedLocator {
  series_id: string;
  run_id: string;
  row_ids: string[];
  rows: SourceRow[];
  declared_selection_sha256: string;
  recomputed_selection_sha256: string;
  resolved: boolean;
}

/**
 * Resolve a `data` locator to the exact source rows it names and check the
 * declared selection hash against those bytes.
 */
export function resolveDataLocator(input: {
  evidence: EvidenceRecord;
  rawText: string;
  document: string;
}): { locator: ResolvedLocator | null; findings: Finding[] } {
  const { evidence } = input;
  if (evidence.locator.kind !== 'data') return { locator: null, findings: [] };
  const findings: Finding[] = [];
  const parsed = parseSourceRows(input.rawText);
  for (const error of parsed.errors) {
    findings.push(
      finding({
        code: FINDING_CODES.source_row_malformed,
        domain: 'environmental',
        severity: 'blocking',
        document: input.document,
        affected_ids: [evidence.evidence_id],
        message: `Raw source line ${error.line} is unusable (${error.reason}). Correct the source bytes; no cell is coerced.`,
      }),
    );
  }
  const byId = new Map(parsed.rows.map((row, index) => [row.row_id, index]));
  const rows: SourceRow[] = [];
  const lines: string[] = [];
  for (const rowId of evidence.locator.row_ids) {
    const index = byId.get(rowId);
    if (index === undefined) {
      findings.push(
        finding({
          code: FINDING_CODES.locator_row_unresolved,
          domain: 'environmental',
          severity: 'blocking',
          document: input.document,
          path: ['locator', 'row_ids'],
          affected_ids: [evidence.evidence_id, rowId],
          message: `Locator row ${rowId} does not exist in the bound source. A citation that cannot be resolved is not evidence for this parameter.`,
        }),
      );
      continue;
    }
    rows.push(parsed.rows[index]!);
    lines.push(parsed.lines[index]!);
  }
  const recomputed = selectionHash(lines);
  const declared = evidence.locator.selection_sha256;
  if (recomputed !== declared) {
    findings.push(
      finding({
        code: FINDING_CODES.locator_selection_mismatch,
        domain: 'environmental',
        severity: 'blocking',
        document: input.document,
        path: ['locator', 'selection_sha256'],
        affected_ids: [evidence.evidence_id],
        message: `Locator selection hash ${declared} does not match the selected rows, which hash to ${recomputed}. Re-bind the selection to the rows it actually names.`,
      }),
    );
  }
  return {
    locator: {
      series_id: evidence.locator.series_id,
      run_id: evidence.locator.run_id,
      row_ids: [...evidence.locator.row_ids],
      rows,
      declared_selection_sha256: declared,
      recomputed_selection_sha256: recomputed,
      resolved: findings.length === 0,
    },
    findings,
  };
}

/**
 * Confirm the resolved series repeats its source exactly: same boundaries, same
 * value, same unit. A series is a resolution of the source, not a new reading.
 */
export function checkSeriesAgainstSource(input: {
  series: EnvironmentalSeries;
  rows: readonly SourceRow[];
  document: string;
}): Finding[] {
  const findings: Finding[] = [];
  const rows = input.rows.filter(
    (row) => row.location_id === input.series.location_id,
  );
  const byStart = new Map(rows.map((row) => [row.start, row]));
  input.series.intervals.forEach((interval, index) => {
    // An explicit null has no source row by construction; it stays missing.
    if (interval.value === null) return;
    const row = byStart.get(interval.start);
    if (!row) {
      findings.push(
        finding({
          code: FINDING_CODES.series_interval_source_mismatch,
          domain: 'environmental',
          severity: 'blocking',
          document: input.document,
          path: ['intervals', index],
          affected_ids: [input.series.series_id],
          message: `Series interval starting ${interval.start} has no matching source row at ${input.series.location_id}. Every resolved interval must name its source row.`,
        }),
      );
      return;
    }
    if (row.end !== interval.end) {
      findings.push(
        finding({
          code: FINDING_CODES.series_interval_source_mismatch,
          domain: 'environmental',
          severity: 'blocking',
          document: input.document,
          path: ['intervals', index, 'end'],
          affected_ids: [input.series.series_id, row.row_id],
          message: `Series interval ends ${interval.end} but source row ${row.row_id} ends ${row.end}. Boundaries are carried through unchanged.`,
        }),
      );
    }
    if (interval.value !== null && interval.value !== row.value) {
      findings.push(
        finding({
          code: FINDING_CODES.series_value_source_mismatch,
          domain: 'environmental',
          severity: 'blocking',
          document: input.document,
          path: ['intervals', index, 'value'],
          affected_ids: [input.series.series_id, row.row_id],
          message: `Series value ${interval.value} disagrees with source row ${row.row_id} value ${row.value}. The resolved series must repeat its source exactly.`,
        }),
      );
    }
    if (input.series.unit !== row.unit) {
      findings.push(
        finding({
          code: FINDING_CODES.environmental_invalid_unit,
          domain: 'environmental',
          severity: 'blocking',
          document: input.document,
          path: ['unit'],
          affected_ids: [input.series.series_id, row.row_id],
          message: `Series unit ${input.series.unit} disagrees with source row unit ${row.unit}. No conversion is applied.`,
        }),
      );
    }
  });
  return findings;
}

export interface EvidenceLink {
  scenario_id: string;
  schedule_id: string;
  schedule_kind: 'baseline' | 'candidate';
  worker_id: string;
  /** One canonical activity identity, shared by every assigned worker. */
  activity_id: string;
  location_id: string;
  activity_interval: { start: string; end: string };
  series_id: string;
  /** Exact revision and hash of the evidence behind this contribution. */
  evidence_ref: ImmutableReference;
  locator: EvidenceRecord['locator'] | null;
  source_row_ids: string[];
  unit: string;
  native_temporal_resolution: EnvironmentalSeries['native_temporal_resolution'];
  source_interval: { start: string; end: string };
  source_value: number;
  quality_flag: string;
  /**
   * Allocation of one native interval across part of an activity. It is a
   * calculation trace over declared source information; it is not a new
   * observation and it grants no sub-hour precision.
   */
  allocation: {
    convention: 'piecewise_constant_half_open';
    overlap_minutes: number;
    overlap_hours: number;
    derived_segment: true;
    creates_new_observation: false;
  };
  /** value * overlap_hours, in ug/m3 * hours, for independent re-derivation. */
  contribution_ug_m3_hours: number;
  transformation_lineage: {
    operation: string;
    method_id: string;
    method_version: string;
    input_refs: ImmutableReference[];
  }[];
}

export interface ActivityLinkTrace {
  scenario_id: string;
  schedule_id: string;
  schedule_kind: 'baseline' | 'candidate';
  worker_id: string;
  activity_id: string;
  location_id: string;
  activity_interval: { start: string; end: string };
  links: EvidenceLink[];
  coverage: 'complete' | 'incomplete';
  missing_intervals: { start: string; end: string }[];
  /** Matched-activity integral for this worker; null while coverage is partial. */
  activity_total_ug_m3_hours: number | null;
}

export interface LinkageResult {
  scenario_id: string;
  selection: {
    rule: string;
    chosen: { location_id: string; series_id: string }[];
    excluded: { location_id: string; series_id: string; reason: string }[];
  };
  traces: ActivityLinkTrace[];
  gaps: CoverageGap[];
  findings: Finding[];
  /** This module traces evidence; it scores, ranks and selects nothing. */
  scope: 'evidence_trace_only';
}

export interface LinkageScenario {
  scenario_id: string;
  document: string;
  series: readonly EnvironmentalSeries[];
  evidence: readonly EvidenceRecord[];
  /** Raw source text keyed by the evidence `raw_ref`, for locator resolution. */
  rawByRef?: Readonly<Record<string, string>>;
}

/**
 * Link every occupied worker/activity interval to the native source intervals
 * that cover it.
 *
 * Boundaries are half-open `[start, end)`, so an activity touching an hour
 * boundary neither duplicates nor loses a contribution. A hole in the source
 * stays a hole: it is reported with its worker, activity, location and
 * scenario, and never interpolated or zero-filled.
 */
export function linkEvidence(input: {
  planning: PlanningBundle;
  scenario: LinkageScenario;
  schedules: readonly ScheduleInput[];
}): LinkageResult {
  const { planning, scenario } = input;
  const findings: Finding[] = [];
  const selection = selectSeriesByLocation(scenario.series);
  for (const conflict of selection.conflicts) {
    findings.push(
      finding({
        code: FINDING_CODES.environmental_duplicate_series,
        domain: 'environmental',
        severity: 'blocking',
        document: scenario.document,
        affected_ids: [conflict.location_id, ...conflict.candidate_series_ids],
        message: `Location ${conflict.location_id} has ${conflict.candidate_series_ids.length} candidate series under rule ${selection.rule}. The alternatives are retained with reasons and none is linked.`,
      }),
    );
  }

  const evidenceById = new Map(
    scenario.evidence.map((record) => [record.evidence_id, record]),
  );
  const resolvedLocators = new Map<string, ResolvedLocator>();
  for (const record of scenario.evidence) {
    const rawText = scenario.rawByRef?.[record.raw_ref];
    if (rawText === undefined) continue;
    const outcome = resolveDataLocator({
      evidence: record,
      rawText,
      document: `${scenario.document}#${record.evidence_id}`,
    });
    findings.push(...outcome.findings);
    if (outcome.locator)
      resolvedLocators.set(record.evidence_id, outcome.locator);
  }
  for (const series of selection.byLocation.values()) {
    const locator = resolvedLocators.get(series.evidence_ref.id);
    if (!locator) continue;
    findings.push(
      ...checkSeriesAgainstSource({
        series,
        rows: locator.rows,
        document: `${scenario.document}#${series.series_id}`,
      }),
    );
  }

  const traces: ActivityLinkTrace[] = [];
  const gaps: CoverageGap[] = [];

  for (const schedule of input.schedules) {
    const starts = new Map(
      schedule.assignments.map((assignment) => [
        assignment.activity_id,
        assignment.start,
      ]),
    );
    for (const activity of planning.activities) {
      const declaredStart = starts.get(activity.activity_id);
      if (declaredStart === undefined) continue;
      const startMs = parseInstant(declaredStart);
      if (startMs === null) continue;
      const target: HalfOpenInterval = {
        start: startMs,
        end: startMs + activity.duration_minutes * MINUTE_MS,
      };
      const series = selection.byLocation.get(activity.location_id);
      for (const workerId of activity.worker_ids) {
        const trace: ActivityLinkTrace = {
          scenario_id: scenario.scenario_id,
          schedule_id: schedule.schedule_id,
          schedule_kind: schedule.kind,
          worker_id: workerId,
          activity_id: activity.activity_id,
          location_id: activity.location_id,
          activity_interval: {
            start: toUtcInstant(target.start),
            end: toUtcInstant(target.end),
          },
          links: [],
          coverage: 'incomplete',
          missing_intervals: [],
          activity_total_ug_m3_hours: null,
        };
        if (!series) {
          trace.missing_intervals = [trace.activity_interval];
          gaps.push(gapOf(trace, 'no_series_for_location'));
          traces.push(trace);
          continue;
        }
        const evidence = evidenceById.get(series.evidence_ref.id) ?? null;
        const locator = resolvedLocators.get(series.evidence_ref.id) ?? null;
        const supported: HalfOpenInterval[] = [];
        for (const interval of series.intervals) {
          const from = parseInstant(interval.start);
          const to = parseInstant(interval.end);
          if (from === null || to === null || to <= from) continue;
          if (interval.value === null) continue;
          const overlap = overlapMs({ start: from, end: to }, target);
          if (overlap === 0) continue;
          supported.push({ start: from, end: to });
          const rowIds = (locator?.rows ?? [])
            .filter(
              (row) =>
                row.location_id === series.location_id &&
                row.start === interval.start,
            )
            .map((row) => row.row_id);
          trace.links.push({
            scenario_id: scenario.scenario_id,
            schedule_id: schedule.schedule_id,
            schedule_kind: schedule.kind,
            worker_id: workerId,
            activity_id: activity.activity_id,
            location_id: activity.location_id,
            activity_interval: trace.activity_interval,
            series_id: series.series_id,
            evidence_ref: { ...series.evidence_ref },
            locator: evidence?.locator ?? null,
            source_row_ids: rowIds,
            unit: series.unit,
            native_temporal_resolution: series.native_temporal_resolution,
            source_interval: { start: interval.start, end: interval.end },
            source_value: interval.value,
            quality_flag: interval.quality_flag,
            allocation: {
              convention: 'piecewise_constant_half_open',
              overlap_minutes: overlap / MINUTE_MS,
              overlap_hours: overlap / HOUR_MS,
              derived_segment: true,
              creates_new_observation: false,
            },
            contribution_ug_m3_hours: interval.value * (overlap / HOUR_MS),
            transformation_lineage: (evidence?.provenance.chain ?? [])
              .filter((step) => step.operation !== 'collection')
              .map((step) => ({
                operation: step.operation,
                method_id: step.method_id,
                method_version: step.method_version,
                input_refs: step.input_refs.map((entry) => ({ ...entry })),
              })),
          });
        }
        const missing = uncoveredSegments(target, supported);
        trace.missing_intervals = missing.map((segment) => ({
          start: toUtcInstant(segment.start),
          end: toUtcInstant(segment.end),
        }));
        if (missing.length === 0) {
          trace.coverage = 'complete';
          trace.activity_total_ug_m3_hours = trace.links.reduce(
            (total, link) => total + link.contribution_ug_m3_hours,
            0,
          );
        } else gaps.push(gapOf(trace, 'uncovered_interval'));
        traces.push(trace);
      }
    }
  }

  return {
    scenario_id: scenario.scenario_id,
    selection: {
      rule: selection.rule,
      chosen: [...selection.byLocation.values()].map((series) => ({
        location_id: series.location_id,
        series_id: series.series_id,
      })),
      excluded: selection.excluded.map((entry) => ({ ...entry })),
    },
    traces,
    gaps,
    findings,
    scope: 'evidence_trace_only',
  };
}

function gapOf(
  trace: ActivityLinkTrace,
  reason: CoverageGap['reason'],
): CoverageGap {
  return {
    scenario_id: trace.scenario_id,
    schedule_id: trace.schedule_id,
    schedule_kind: trace.schedule_kind,
    worker_id: trace.worker_id,
    activity_id: trace.activity_id,
    location_id: trace.location_id,
    reason,
    missing_intervals: trace.missing_intervals,
  };
}
