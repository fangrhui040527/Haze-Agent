import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  planningSchema,
  runSchema,
  type PlanningBundle,
} from '../../app/contracts/planning.js';

function fixture(): PlanningBundle {
  const value: unknown = JSON.parse(
    readFileSync(
      new URL('../../input_examples/v2/planning.json', import.meta.url),
      'utf8',
    ),
  );
  return planningSchema.parse(value);
}

const t = (hour: number, minute = 0) =>
  `2026-10-25T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`;

describe('v0.13 closed planning contract', () => {
  it('accepts the two-worker fixed-work specimen without inventing environmental evidence', () => {
    const bundle = fixture();
    expect(bundle.activities.map((activity) => activity.activity_id)).toEqual([
      'inspection',
      'maintenance',
      'administration',
    ]);
    expect(bundle.evidence_refs).toEqual([]);
    expect(planningSchema.parse(bundle)).toEqual(bundle);
  });

  it.each<{
    name: string;
    change: (bundle: PlanningBundle) => void;
    message: RegExp;
  }>([
    {
      name: 'a horizon not divided by the grid',
      change: (b) => {
        b.assessment.end = t(12, 1);
      },
      message: /divisible/,
    },
    {
      name: 'a nonpositive horizon',
      change: (b) => {
        b.assessment.end = b.assessment.start;
      },
      message: /Horizon must be positive/,
    },
    {
      name: 'a foreign timezone offset representing the same instant',
      change: (b) => {
        b.activities[0]!.release = '2026-10-25T00:00:00Z';
      },
      message: /\+08:00/,
    },
    {
      name: 'submillisecond timestamps that Date.parse would truncate',
      change: (b) => {
        b.activities[0]!.allowed_starts[0] = '2026-10-25T08:00:00.0001+08:00';
      },
      message: /whole-minute timestamps/,
    },
    {
      name: 'a horizon anchored to nonzero seconds',
      change: (b) => {
        b.assessment.start = '2026-10-25T08:00:01+08:00';
      },
      message: /whole-minute timestamps/,
    },
    {
      name: 'duplicate worker IDs',
      change: (b) => {
        b.crew.workers[1]!.worker_id = 'worker-a';
      },
      message: /Duplicate/,
    },
    {
      name: 'duplicate activity IDs',
      change: (b) => {
        b.activities[1]!.activity_id = 'inspection';
      },
      message: /Duplicate/,
    },
    {
      name: 'unknown eligible activity IDs',
      change: (b) => {
        b.crew.workers[0]!.eligible_activity_ids.push('unknown');
      },
      message: /Unknown activity/,
    },
    {
      name: 'unknown worker assignments',
      change: (b) => {
        b.activities[0]!.worker_ids = ['unknown'];
      },
      message: /Unknown worker/,
    },
    {
      name: 'ineligible assignments',
      change: (b) => {
        b.crew.workers[0]!.eligible_activity_ids = [
          'maintenance',
          'administration',
        ];
      },
      message: /ineligible/,
    },
    {
      name: 'unknown locations',
      change: (b) => {
        b.activities[0]!.location_id = 'unknown';
      },
      message: /Unknown location/,
    },
    {
      name: 'durations that are not whole planning steps',
      change: (b) => {
        b.activities[0]!.duration_minutes = 59;
      },
      message: /whole planning steps/,
    },
    {
      name: 'duplicate allowed starts',
      change: (b) => {
        b.activities[0]!.allowed_starts.push(t(8));
      },
      message: /Duplicate/,
    },
    {
      name: 'off-grid allowed starts',
      change: (b) => {
        b.activities[0]!.allowed_starts.push(t(8, 1));
      },
      message: /Allowed start must align/,
    },
    {
      name: 'allowed starts finishing past deadline',
      change: (b) => {
        b.activities[0]!.allowed_starts.push(t(11, 15));
      },
      message: /Allowed start must align/,
    },
    {
      name: 'a release later than its baseline start',
      change: (b) => {
        b.activities[0]!.release = t(9);
      },
      message: /Allowed start/,
    },
    {
      name: 'unknown predecessor IDs',
      change: (b) => {
        b.activities[0]!.predecessor_ids = ['unknown'];
      },
      message: /Unknown predecessor/,
    },
    {
      name: 'cycles',
      change: (b) => {
        b.activities[0]!.predecessor_ids = ['maintenance'];
      },
      message: /acyclic/,
    },
    {
      name: 'an infeasible baseline precedence',
      change: (b) => {
        b.activities[0]!.predecessor_ids = ['administration'];
      },
      message: /precedence/,
    },
    {
      name: 'missing baseline activities',
      change: (b) => {
        b.baseline.assignments.pop();
      },
      message: /Missing activity/,
    },
    {
      name: 'duplicate baseline activities',
      change: (b) => {
        b.baseline.assignments.push(b.baseline.assignments[0]!);
      },
      message: /Duplicate/,
    },
    {
      name: 'unknown baseline activities',
      change: (b) => {
        b.baseline.assignments[0]!.activity_id = 'unknown';
      },
      message: /Unknown activity/,
    },
    {
      name: 'an unallowed baseline start',
      change: (b) => {
        b.baseline.assignments[0]!.start = t(7);
      },
      message: /Baseline start is not allowed/,
    },
    {
      name: 'an occupancy gap and overlap',
      change: (b) => {
        b.baseline.assignments[1]!.start = t(9, 15);
      },
      message: /occupancy gap or overlap/,
    },
    {
      name: 'missing worker availability',
      change: (b) => {
        b.crew.workers[0]!.available_intervals[0]!.start = t(8, 15);
      },
      message: /exceeds worker availability/,
    },
    {
      name: 'overlapping availability declarations',
      change: (b) => {
        b.crew.workers[0]!.available_intervals.push({
          start: t(9),
          end: t(10),
        });
      },
      message: /Intervals must not overlap/,
    },
    {
      name: 'unattested absence of controls',
      change: (b) => {
        b.existing_control_basis_ref = null;
      },
      message: /attested absence/,
    },
    {
      name: 'unattested absence of location controls',
      change: (b) => {
        b.locations[0]!.existing_control_basis_ref = null;
      },
      message: /attested absence/,
    },
    {
      name: 'unattested absence of resource bottlenecks',
      change: (b) => {
        b.resource_absence_basis_ref = null;
      },
      message: /attested absence/,
    },
    {
      name: 'undeclared resource demands',
      change: (b) => {
        b.activities[0]!.resource_demands = [
          { resource_id: 'unknown', quantity: 1 },
        ];
      },
      message: /Unknown resource/,
    },
    {
      name: 'movable allowed starts on a fixed activity',
      change: (b) => {
        b.activities[0]!.timing_rule = 'fixed_baseline_start';
      },
      message: /Fixed activities/,
    },
  ])('rejects $name', ({ change, message }) => {
    const bundle = fixture();
    change(bundle);
    const result = planningSchema.safeParse(bundle);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(message);
  });

  it('accepts adjacent availability intervals and a genuinely fixed activity', () => {
    const bundle = fixture();
    bundle.crew.workers[0]!.available_intervals = [
      { start: t(8), end: t(9) },
      { start: t(9), end: t(12) },
    ];
    bundle.activities[0]!.timing_rule = 'fixed_baseline_start';
    bundle.activities[0]!.allowed_starts = [t(8)];
    expect(planningSchema.safeParse(bundle).success).toBe(true);
  });

  it('checks summed resource usage across simultaneous activities and changing capacity intervals', () => {
    const bundle = fixture();
    // Split the shared inspection assignment into two simultaneous worker-specific
    // fixed duties. Their combined equipment demand must be checked, not each alone.
    const second = structuredClone(bundle.activities[0]!);
    second.activity_id = 'inspection-b';
    second.worker_ids = ['worker-b'];
    bundle.activities[0]!.worker_ids = ['worker-a'];
    bundle.activities.push(second);
    bundle.crew.workers[1]!.eligible_activity_ids.push(second.activity_id);
    bundle.baseline.assignments.push({
      activity_id: second.activity_id,
      start: t(8),
    });
    bundle.activities[1]!.predecessor_ids.push(second.activity_id);
    bundle.resources = [
      {
        resource_id: 'inspection-kit',
        unit: 'kit',
        capacity_intervals: [{ start: t(8), end: t(9), capacity: 2 }],
      },
    ];
    bundle.resource_absence_basis_ref = null;
    for (const activity of [bundle.activities[0]!, second]) {
      activity.resource_demands = [
        { resource_id: 'inspection-kit', quantity: 1 },
      ];
    }
    expect(planningSchema.safeParse(bundle).success).toBe(true);
    bundle.activities[0]!.resource_demands[0]!.quantity = 0.1;
    second.resource_demands[0]!.quantity = 0.2;
    bundle.resources[0]!.capacity_intervals[0]!.capacity = 0.3;
    expect(planningSchema.safeParse(bundle).success).toBe(true);
    bundle.resources[0]!.capacity_intervals[0]!.capacity = 0.299;
    expect(planningSchema.safeParse(bundle).error?.message).toMatch(
      /exceeds interval capacity/,
    );
    bundle.activities[0]!.resource_demands[0]!.quantity = 1;
    second.resource_demands[0]!.quantity = 1;
    bundle.resources[0]!.capacity_intervals = [
      { start: t(8), end: t(8, 30), capacity: 2 },
      { start: t(8, 30), end: t(9), capacity: 1 },
    ];
    expect(planningSchema.safeParse(bundle).error?.message).toMatch(
      /exceeds interval capacity/,
    );
    // A missing capacity interval also means no available capacity, not infinity.
    bundle.resources[0]!.capacity_intervals.pop();
    expect(planningSchema.safeParse(bundle).error?.message).toMatch(
      /exceeds interval capacity/,
    );
  });

  it('requires location controls to pin the exact declared bundle revision and hash', () => {
    const bundle = fixture();
    const control = { ...bundle.method_ref, id: 'demo:fictional-control' };
    bundle.existing_control_refs = [control];
    bundle.existing_control_basis_ref = null;
    bundle.locations[0]!.existing_control_refs = [{ ...control, revision: 2 }];
    bundle.locations[0]!.existing_control_basis_ref = null;
    expect(planningSchema.safeParse(bundle).error?.message).toMatch(
      /exactly match/,
    );
    bundle.locations[0]!.existing_control_refs = [control];
    expect(planningSchema.safeParse(bundle).success).toBe(true);
  });

  it('rejects unknown keys at nested levels, coercion, infinity, and oversized arrays', () => {
    const bundle = fixture();
    expect(
      planningSchema.safeParse({ ...bundle, mode: 'offline' }).success,
    ).toBe(false);
    expect(
      planningSchema.safeParse({
        ...bundle,
        assessment: { ...bundle.assessment, unreviewed: true },
      }).success,
    ).toBe(false);
    expect(
      planningSchema.safeParse({
        ...bundle,
        assessment: { ...bundle.assessment, planning_step_minutes: '15' },
      }).success,
    ).toBe(false);
    bundle.activities[0]!.duration_minutes = Infinity;
    expect(planningSchema.safeParse(bundle).success).toBe(false);
    const bounded = fixture();
    bounded.crew.workers = Array.from(
      { length: 65 },
      () => bounded.crew.workers[0]!,
    );
    expect(planningSchema.safeParse(bounded).success).toBe(false);
  });
});

describe('v0.13 run admission shape', () => {
  it('accepts only bounded intent and an immutable bundle reference', () => {
    const run = {
      schema_version: 'haze.run.v2',
      programme_id: 'haze-engineering-demo',
      input: {
        operation: 'plan_outdoor_work',
        problem_id: 'klang-synthetic-crew',
        bundle_ref: fixture().baseline.ref,
      },
    };
    expect(runSchema.safeParse(run).success).toBe(true);
    expect(
      runSchema.safeParse({ ...run, run_id: 'caller-supplied' }).success,
    ).toBe(false);
    expect(
      runSchema.safeParse({ ...run, schema_version: 'haze.run.v1' }).success,
    ).toBe(false);
    expect(
      runSchema.safeParse({ ...run, input: { ...run.input, mode: 'live' } })
        .success,
    ).toBe(false);
    expect(
      runSchema.safeParse({
        ...run,
        input: { ...run.input, query: 'x'.repeat(2_001) },
      }).success,
    ).toBe(false);
    expect(
      runSchema.safeParse({
        ...run,
        input: {
          ...run.input,
          bundle_ref: { ...run.input.bundle_ref, sha256: 'placeholder' },
        },
      }).success,
    ).toBe(false);
  });
});
