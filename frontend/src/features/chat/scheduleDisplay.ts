import type { ImmutableReference } from '../../../../app/contracts/common.ts';
import type {
  Activity,
  PlanningBundle,
} from '../../../../app/contracts/planning.ts';
import type { Result } from '../../../../app/contracts/result.ts';

type Assignment = PlanningBundle['baseline']['assignments'][number];

export const sameReference = (
  a: ImmutableReference | null,
  b: ImmutableReference | null,
) =>
  !!a &&
  !!b &&
  a.id === b.id &&
  a.revision === b.revision &&
  a.sha256 === b.sha256;

/** Always use the assessment timezone, including when the browser is elsewhere. */
export function scheduleTime(instant: string | number, timezone: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(instant));
}

export function scheduleDate(instant: string, timezone: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(instant));
}

export function scheduleOffset(instant: string, timezone: string) {
  return (
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    })
      .formatToParts(new Date(instant))
      .find((part) => part.type === 'timeZoneName')?.value ?? timezone
  );
}

export interface ScheduleRow {
  activity: Activity;
  start: number;
  end: number;
}

export interface OccupancyIssue {
  kind: 'gap' | 'overlap';
  workerId: string;
  start: number;
  end: number;
}

/** Shared activities remain one row; occupancy is checked for each assigned worker. */
export function scheduleRows(
  bundle: PlanningBundle,
  assignments: Assignment[],
) {
  const activities = new Map(
    bundle.activities.map((activity) => [activity.activity_id, activity]),
  );
  const seen = new Set<string>();
  const errors: string[] = [];
  const rows: ScheduleRow[] = [];
  const horizonStart = Date.parse(bundle.assessment.start);
  const horizonEnd = Date.parse(bundle.assessment.end);
  for (const assignment of assignments) {
    if (seen.has(assignment.activity_id)) {
      errors.push(
        `Duplicate assignment: ${assignment.activity_id}. Displayed once; the schedule needs correction.`,
      );
      continue;
    }
    seen.add(assignment.activity_id);
    const activity = activities.get(assignment.activity_id);
    if (!activity) {
      errors.push(`Unknown activity: ${assignment.activity_id}.`);
      continue;
    }
    const start = Date.parse(assignment.start);
    const end = start + activity.duration_minutes * 60_000;
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      errors.push(`Invalid timing: ${assignment.activity_id}.`);
      continue;
    }
    if (start < horizonStart || end > horizonEnd) {
      errors.push(`Outside assessment horizon: ${assignment.activity_id}.`);
    }
    rows.push({ activity, start, end });
  }
  for (const activity of bundle.activities) {
    if (!seen.has(activity.activity_id))
      errors.push(`Missing activity: ${activity.activity_id}.`);
  }
  rows.sort(
    (a, b) =>
      a.start - b.start ||
      a.activity.activity_id.localeCompare(b.activity.activity_id),
  );
  const occupancy: OccupancyIssue[] = [];
  for (const worker of bundle.crew.workers) {
    const intervals = rows.filter((row) =>
      row.activity.worker_ids.includes(worker.worker_id),
    );
    let cursor = horizonStart;
    for (const interval of intervals) {
      const start = Math.max(interval.start, horizonStart);
      const end = Math.min(interval.end, horizonEnd);
      if (end <= start) continue;
      if (start > cursor)
        occupancy.push({
          kind: 'gap',
          workerId: worker.worker_id,
          start: cursor,
          end: start,
        });
      if (start < cursor)
        occupancy.push({
          kind: 'overlap',
          workerId: worker.worker_id,
          start,
          end: Math.min(cursor, end),
        });
      cursor = Math.max(cursor, end);
    }
    if (cursor < horizonEnd)
      occupancy.push({
        kind: 'gap',
        workerId: worker.worker_id,
        start: cursor,
        end: horizonEnd,
      });
  }
  return { rows, errors, occupancy };
}

/** Numbers are evidence from the checked contract, never a browser calculation. */
export function checkedQuantification(envelope: Result) {
  const { result } = envelope;
  const values = result.quantified;
  if (
    !values ||
    envelope.input_assessment.status !== 'valid' ||
    result.evidence_status !== 'sufficient_for_declared_use' ||
    envelope.evidence.gaps.length > 0 ||
    envelope.errors.length > 0 ||
    !result.plan_verification.some(
      (check) =>
        sameReference(check.plan_ref, values.plan_ref) &&
        check.checker_status === 'passed',
    )
  )
    return null;
  return values;
}
