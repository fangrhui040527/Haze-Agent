import { z } from 'zod';
import {
  identifierSchema,
  inputOriginSchema,
  referenceSchema,
  timestampSchema,
} from './common.js';

const intervalShape = z.strictObject({
  start: timestampSchema,
  end: timestampSchema,
});
const referenceList = z.array(referenceSchema).max(256);

/** Closed, bounded shape. Referential and scheduling checks live in planningSchema. */
export const planningShape = z.strictObject({
  schema_version: z.literal('haze.planning.v2'),
  programme_id: identifierSchema,
  problem_id: identifierSchema,
  district_id: z.literal('my-selangor-klang'),
  target_ref: referenceSchema,
  policy_ref: referenceSchema,
  method_ref: referenceSchema,
  input_origin: inputOriginSchema,
  timezone: z.literal('Asia/Kuala_Lumpur'),
  assessment: z.strictObject({
    start: timestampSchema,
    end: timestampSchema,
    planning_step_minutes: z.number().int().min(1).max(1_440),
  }),
  attestation_ref: referenceSchema,
  feasibility_gate_ref: referenceSchema,
  crew: z.strictObject({
    crew_id: identifierSchema,
    workers: z
      .array(
        z.strictObject({
          worker_id: identifierSchema,
          available_intervals: z.array(intervalShape).min(1).max(256),
          eligible_activity_ids: z.array(identifierSchema).min(1).max(256),
        }),
      )
      .min(1)
      .max(64),
  }),
  locations: z
    .array(
      z.strictObject({
        location_id: identifierSchema,
        spatial_support_ref: referenceSchema,
        microenvironment: z.enum(['outdoor', 'indoor', 'in_transit']),
        existing_control_refs: referenceList,
        existing_control_basis_ref: referenceSchema.nullable(),
      }),
    )
    .min(1)
    .max(128),
  activities: z
    .array(
      z.strictObject({
        activity_id: identifierSchema,
        kind: z.enum(['work', 'break', 'travel', 'setup', 'waiting']),
        required_service_ref: referenceSchema,
        location_id: identifierSchema,
        duration_minutes: z.number().int().min(1).max(10_080),
        release: timestampSchema,
        deadline: timestampSchema,
        allowed_starts: z.array(timestampSchema).min(1).max(10_080),
        worker_ids: z.array(identifierSchema).min(1).max(64),
        predecessor_ids: z.array(identifierSchema).max(256),
        resource_demands: z
          .array(
            z.strictObject({
              resource_id: identifierSchema,
              quantity: z.number().positive().max(1_000_000_000),
            }),
          )
          .max(64),
        timing_rule: z.enum(['movable_within_window', 'fixed_baseline_start']),
      }),
    )
    .min(1)
    .max(256),
  resources: z
    .array(
      z.strictObject({
        resource_id: identifierSchema,
        capacity_intervals: z
          .array(
            intervalShape.extend({
              capacity: z.number().nonnegative().max(1_000_000_000),
            }),
          )
          .min(1)
          .max(256),
        unit: z.string().min(1).max(64).regex(/\S/),
      }),
    )
    .max(64),
  resource_absence_basis_ref: referenceSchema.nullable(),
  baseline: z.strictObject({
    ref: referenceSchema,
    assignments: z
      .array(
        z.strictObject({
          activity_id: identifierSchema,
          start: timestampSchema,
        }),
      )
      .min(1)
      .max(256),
    ordinary_practice_basis_ref: referenceSchema,
  }),
  evidence_refs: referenceList,
  comparison_use_ref: referenceSchema,
  constraint_review_ref: referenceSchema,
  cost_basis_ref: referenceSchema,
  existing_control_refs: referenceList,
  existing_control_basis_ref: referenceSchema.nullable(),
});

export type PlanningBundle = z.infer<typeof planningShape>;
export type Activity = PlanningBundle['activities'][number];
type Path = (string | number)[];

// Quantities are finite JSON decimal numbers. Compare their decimal values exactly
// so, for example, 0.1 + 0.2 does not falsely overload a 0.3 capacity.
function exceedsCapacity(quantities: number[], capacity: number): boolean {
  const terms = [...quantities, capacity].map((value) => {
    const [mantissa = '0', exponent = '0'] = value.toString().split('e');
    const [whole = '0', fraction = ''] = mantissa.split('.');
    return {
      coefficient: BigInt(whole + fraction),
      exponent: Number(exponent) - fraction.length,
    };
  });
  const scale = Math.min(...terms.map((term) => term.exponent));
  const integers = terms.map(
    (term) => term.coefficient * 10n ** BigInt(term.exponent - scale),
  );
  const limit = integers.pop()!;
  return integers.reduce((total, quantity) => total + quantity, 0n) > limit;
}

/** Admission shape only: resolving authority, currency and immutable bytes is separate. */
export const runSchema = z.strictObject({
  schema_version: z.literal('haze.run.v2'),
  programme_id: identifierSchema,
  input: z.strictObject({
    operation: z.literal('plan_outdoor_work'),
    problem_id: identifierSchema,
    bundle_ref: referenceSchema,
    query: z.string().min(1).max(2_000).regex(/\S/).optional(),
  }),
});
export type RunRequest = z.infer<typeof runSchema>;

/** Validate the representable domain, including baseline feasibility; never grants acceptance. */
export const planningSchema = planningShape.superRefine((bundle, context) => {
  const issue = (path: Path, message: string) =>
    context.addIssue({ code: 'custom', path, message });
  const start = Date.parse(bundle.assessment.start);
  const end = Date.parse(bundle.assessment.end);
  const step = bundle.assessment.planning_step_minutes * 60_000;
  const horizon = end - start;
  const aligned = (time: number) => (time - start) % step === 0;
  const instant = (value: string, path: Path) => {
    if (!value.endsWith('+08:00')) {
      issue(path, 'Kuala Lumpur instants must retain the +08:00 offset');
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/.test(value)) {
      issue(
        path,
        'Planning instants must use explicit whole-minute timestamps without fractional seconds',
      );
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) issue(path, 'Invalid timestamp');
    return parsed;
  };
  instant(bundle.assessment.start, ['assessment', 'start']);
  instant(bundle.assessment.end, ['assessment', 'end']);
  if (horizon <= 0 || horizon > 7 * 24 * 60 * 60_000 || horizon % step !== 0) {
    issue(
      ['assessment'],
      'Horizon must be positive, at most seven days, and divisible by the planning step',
    );
  }
  const unique = (values: string[], path: Path) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value))
        issue([...path, index], `Duplicate ID or instant: ${value}`);
      seen.add(value);
    });
  };
  const checkIntervals = (
    intervals: { start: string; end: string }[],
    path: Path,
  ) => {
    const parsed = intervals.map((interval, index) => {
      const a = instant(interval.start, [...path, index, 'start']);
      const b = instant(interval.end, [...path, index, 'end']);
      if (a >= b || a < start || b > end || !aligned(a) || !aligned(b)) {
        issue(
          [...path, index],
          'Intervals must be positive, within the horizon and aligned to the planning grid',
        );
      }
      return { start: a, end: b };
    });
    const sorted = [...parsed].sort((a, b) => a.start - b.start);
    for (let index = 1; index < sorted.length; index++) {
      if (sorted[index]!.start < sorted[index - 1]!.end) {
        issue(path, 'Intervals must not overlap');
      }
    }
    return parsed;
  };
  const checkRefs = (refs: z.infer<typeof referenceSchema>[], path: Path) =>
    unique(
      refs.map((ref) => ref.id),
      path,
    );
  const checkControls = (
    controls: z.infer<typeof referenceSchema>[],
    basis: z.infer<typeof referenceSchema> | null,
    path: Path,
  ) => {
    checkRefs(controls, [...path, 'existing_control_refs']);
    if ((controls.length === 0) !== (basis !== null)) {
      issue(
        [...path, 'existing_control_basis_ref'],
        'An empty controls list requires an attested absence basis; use null for a nonempty list',
      );
    }
  };
  const workerIds = bundle.crew.workers.map((worker) => worker.worker_id);
  const activityIds = bundle.activities.map((activity) => activity.activity_id);
  const locationIds = bundle.locations.map((location) => location.location_id);
  const resourceIds = bundle.resources.map((resource) => resource.resource_id);
  unique(workerIds, ['crew', 'workers']);
  unique(activityIds, ['activities']);
  unique(locationIds, ['locations']);
  unique(resourceIds, ['resources']);
  checkRefs(bundle.evidence_refs, ['evidence_refs']);
  checkControls(
    bundle.existing_control_refs,
    bundle.existing_control_basis_ref,
    [],
  );
  if (
    (bundle.resources.length === 0) !==
    (bundle.resource_absence_basis_ref !== null)
  ) {
    issue(
      ['resource_absence_basis_ref'],
      'An empty resources list requires an attested absence basis; use null for a nonempty list',
    );
  }
  const workers = new Map(
    bundle.crew.workers.map((worker) => [worker.worker_id, worker]),
  );
  const activities = new Map(
    bundle.activities.map((activity) => [activity.activity_id, activity]),
  );
  const resources = new Set(resourceIds);
  const locations = new Set(locationIds);
  const controls = new Map(
    bundle.existing_control_refs.map((ref) => [ref.id, ref]),
  );
  const availability = new Map<string, { start: number; end: number }[]>();
  bundle.crew.workers.forEach((worker, index) => {
    const path = ['crew', 'workers', index];
    availability.set(
      worker.worker_id,
      checkIntervals(worker.available_intervals, [
        ...path,
        'available_intervals',
      ]),
    );
    unique(worker.eligible_activity_ids, [...path, 'eligible_activity_ids']);
    worker.eligible_activity_ids.forEach((id) => {
      if (!activities.has(id))
        issue([...path, 'eligible_activity_ids'], `Unknown activity: ${id}`);
    });
  });
  bundle.locations.forEach((location, index) => {
    const path = ['locations', index];
    checkControls(
      location.existing_control_refs,
      location.existing_control_basis_ref,
      path,
    );
    location.existing_control_refs.forEach((ref) => {
      const declared = controls.get(ref.id);
      if (
        !declared ||
        declared.revision !== ref.revision ||
        declared.sha256 !== ref.sha256
      ) {
        issue(
          [...path, 'existing_control_refs'],
          'Location controls must exactly match declared bundle controls',
        );
      }
    });
  });
  bundle.resources.forEach((resource, index) => {
    checkIntervals(resource.capacity_intervals, [
      'resources',
      index,
      'capacity_intervals',
    ]);
  });
  const starts = new Map(
    bundle.baseline.assignments.map((assignment) => [
      assignment.activity_id,
      Date.parse(assignment.start),
    ]),
  );
  unique(
    bundle.baseline.assignments.map((assignment) => assignment.activity_id),
    ['baseline', 'assignments'],
  );
  bundle.baseline.assignments.forEach((assignment, index) => {
    instant(assignment.start, ['baseline', 'assignments', index, 'start']);
    if (!activities.has(assignment.activity_id)) {
      issue(
        ['baseline', 'assignments', index],
        `Unknown activity: ${assignment.activity_id}`,
      );
    }
  });
  const ends = new Map<string, number>();
  bundle.activities.forEach((activity, index) => {
    const path = ['activities', index];
    const duration = activity.duration_minutes * 60_000;
    const release = instant(activity.release, [...path, 'release']);
    const deadline = instant(activity.deadline, [...path, 'deadline']);
    if (duration % step !== 0)
      issue(
        [...path, 'duration_minutes'],
        'Duration must be positive whole planning steps',
      );
    if (
      release < start ||
      deadline > end ||
      deadline - release < duration ||
      !aligned(release) ||
      !aligned(deadline)
    ) {
      issue(
        path,
        'Release/deadline must be aligned within the horizon and fit the duration',
      );
    }
    if (!locations.has(activity.location_id))
      issue([...path, 'location_id'], 'Unknown location');
    unique(activity.worker_ids, [...path, 'worker_ids']);
    unique(activity.predecessor_ids, [...path, 'predecessor_ids']);
    unique(
      activity.resource_demands.map((demand) => demand.resource_id),
      [...path, 'resource_demands'],
    );
    activity.worker_ids.forEach((workerId) => {
      const worker = workers.get(workerId);
      if (!worker)
        issue([...path, 'worker_ids'], `Unknown worker: ${workerId}`);
      else if (!worker.eligible_activity_ids.includes(activity.activity_id))
        issue([...path, 'worker_ids'], `Worker is ineligible: ${workerId}`);
    });
    activity.predecessor_ids.forEach((id) => {
      if (!activities.has(id))
        issue([...path, 'predecessor_ids'], `Unknown predecessor: ${id}`);
    });
    activity.resource_demands.forEach((demand) => {
      if (!resources.has(demand.resource_id))
        issue(
          [...path, 'resource_demands'],
          `Unknown resource: ${demand.resource_id}`,
        );
    });
    const allowed = activity.allowed_starts.map((value, n) =>
      instant(value, [...path, 'allowed_starts', n]),
    );
    unique(allowed.map(String), [...path, 'allowed_starts']);
    allowed.forEach((time, n) => {
      if (
        !aligned(time) ||
        time < release ||
        time + duration > deadline ||
        time < start ||
        time + duration > end
      ) {
        issue(
          [...path, 'allowed_starts', n],
          'Allowed start must align and fit the release/deadline and horizon',
        );
      }
    });
    const baselineStart = starts.get(activity.activity_id);
    if (baselineStart === undefined)
      issue(
        ['baseline', 'assignments'],
        `Missing activity: ${activity.activity_id}`,
      );
    else {
      ends.set(activity.activity_id, baselineStart + duration);
      if (!allowed.includes(baselineStart))
        issue(
          ['baseline', 'assignments'],
          `Baseline start is not allowed: ${activity.activity_id}`,
        );
      if (
        activity.timing_rule === 'fixed_baseline_start' &&
        (allowed.length !== 1 || allowed[0] !== baselineStart)
      ) {
        issue(
          [...path, 'allowed_starts'],
          'Fixed activities must declare only their baseline start',
        );
      }
    }
  });
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) {
      issue(['activities'], 'Predecessor graph must be acyclic');
      return;
    }
    if (visited.has(id)) return;
    active.add(id);
    activities.get(id)?.predecessor_ids.forEach(visit);
    active.delete(id);
    visited.add(id);
  };
  activityIds.forEach(visit);
  bundle.activities.forEach((activity, index) => {
    const current = starts.get(activity.activity_id);
    activity.predecessor_ids.forEach((id) => {
      const previousEnd = ends.get(id);
      if (
        current !== undefined &&
        previousEnd !== undefined &&
        previousEnd > current
      ) {
        issue(
          ['activities', index, 'predecessor_ids'],
          'Baseline violates finish-to-start precedence',
        );
      }
    });
  });
  bundle.crew.workers.forEach((worker, index) => {
    const trajectory = bundle.activities
      .filter(
        (activity) =>
          activity.worker_ids.includes(worker.worker_id) &&
          starts.has(activity.activity_id),
      )
      .map((activity) => ({
        start: starts.get(activity.activity_id)!,
        end: ends.get(activity.activity_id)!,
      }))
      .sort((a, b) => a.start - b.start);
    let cursor = start;
    for (const interval of trajectory) {
      if (interval.start !== cursor)
        issue(
          ['baseline', 'assignments'],
          `Worker ${worker.worker_id} has an occupancy gap or overlap`,
        );
      cursor = interval.end;
      const available = availability.get(worker.worker_id) ?? [];
      let coveredUntil = interval.start;
      for (const slot of [...available].sort((a, b) => a.start - b.start)) {
        if (slot.start <= coveredUntil && slot.end > coveredUntil)
          coveredUntil = slot.end;
      }
      if (coveredUntil < interval.end)
        issue(
          ['crew', 'workers', index, 'available_intervals'],
          'Baseline activity exceeds worker availability',
        );
    }
    if (cursor !== end)
      issue(
        ['baseline', 'assignments'],
        `Worker ${worker.worker_id} must occupy the complete common horizon`,
      );
  });
  bundle.resources.forEach((resource, index) => {
    const capacity = resource.capacity_intervals.map((slot) => ({
      ...slot,
      start: Date.parse(slot.start),
      end: Date.parse(slot.end),
    }));
    const usage = bundle.activities.flatMap((activity) => {
      const demand = activity.resource_demands.find(
        (entry) => entry.resource_id === resource.resource_id,
      );
      const a = starts.get(activity.activity_id);
      const b = ends.get(activity.activity_id);
      return demand && a !== undefined && b !== undefined
        ? [{ start: a, end: b, quantity: demand.quantity }]
        : [];
    });
    const boundaries = [
      ...new Set([
        start,
        end,
        ...capacity.flatMap((slot) => [slot.start, slot.end]),
        ...usage.flatMap((slot) => [slot.start, slot.end]),
      ]),
    ].sort((a, b) => a - b);
    for (let n = 0; n < boundaries.length - 1; n++) {
      const time = boundaries[n]!;
      if (time < start || time >= end) continue;
      const available =
        capacity.find((slot) => slot.start <= time && time < slot.end)
          ?.capacity ?? 0;
      const demand = usage
        .filter((slot) => slot.start <= time && time < slot.end)
        .map((slot) => slot.quantity);
      if (exceedsCapacity(demand, available)) {
        issue(
          ['resources', index, 'capacity_intervals'],
          'Baseline resource demand exceeds interval capacity',
        );
        break;
      }
    }
  });
});
