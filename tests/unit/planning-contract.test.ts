import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  planningSchema,
  runSchema,
  type PlanningBundle,
} from '../../app/contracts/planning.js';
import { resultSchema } from '../../app/contracts/result.js';

const referenceSchema = z.strictObject({
  id: z.string(),
  revision: z.number().int(),
  sha256: z.string(),
});
const demoRecordsSchema = z.array(
  z.strictObject({
    ref: referenceSchema,
    record: z.record(z.string(), z.unknown()),
  }),
);
const verificationSchedulesSchema = z.strictObject({
  fixture_kind: z.literal('verification_schedule_examples'),
  scope: z.literal('illustrative_only'),
  exhaustive: z.literal(false),
  schedules: z.array(
    z.strictObject({
      ref: referenceSchema,
      record: z.strictObject({
        id: z.string(),
        revision: z.number().int(),
        example_kind: z.literal('illustrative_verification_only'),
        assignments: z.array(
          z.strictObject({
            activity_id: z.string(),
            start: z.string(),
          }),
        ),
        notice: z.string(),
      }),
    }),
  ),
});

function fixture(): PlanningBundle {
  const value: unknown = JSON.parse(
    readFileSync(
      new URL('../../input_examples/v2/planning.json', import.meta.url),
      'utf8',
    ),
  );
  return planningSchema.parse(value);
}

function demoRecords(): {
  ref: { id: string; revision: number; sha256: string };
  record: Record<string, unknown>;
}[] {
  const value: unknown = JSON.parse(
    readFileSync(
      new URL('../../input_examples/v2/demo-records.json', import.meta.url),
      'utf8',
    ),
  );
  return demoRecordsSchema.parse(value);
}

function verificationSchedules() {
  const value: unknown = JSON.parse(
    readFileSync(
      new URL(
        '../../input_examples/v2/verification-schedules.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  return verificationSchedulesSchema.parse(value);
}

function exampleResult() {
  const value: unknown = JSON.parse(
    readFileSync(
      new URL('../../output_examples/v2/result.json', import.meta.url),
      'utf8',
    ),
  );
  return resultSchema.parse(value);
}

const t = (hour: number, minute = 0) =>
  `2026-10-25T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`;

describe('v0.13 closed planning contract', () => {
  it('binds the two-worker fixture to local nominal and sensitivity evidence records', () => {
    const bundle = fixture();
    expect(bundle.activities.map((activity) => activity.activity_id)).toEqual([
      'inspection',
      'maintenance',
      'administration',
    ]);
    expect(bundle.evidence_refs.map(({ id }) => id)).toEqual([
      'demo:pm25-yard-nominal',
      'demo:pm25-office-nominal',
      'demo:pm25-yard-plus-20',
      'demo:pm25-office-plus-20',
    ]);
    expect(
      bundle.evidence_refs.every((reference) =>
        demoRecords().some(
          (entry) =>
            entry.ref.id === reference.id &&
            entry.ref.revision === reference.revision &&
            entry.ref.sha256 === reference.sha256,
        ),
      ),
    ).toBe(true);
    expect(planningSchema.parse(bundle)).toEqual(bundle);
  });

  it('pins the fictional work, both workers, and complete horizon occupancy', () => {
    const bundle = fixture();
    expect(bundle.crew.workers.map((worker) => worker.worker_id)).toEqual([
      'worker-a',
      'worker-b',
    ]);
    for (const worker of bundle.crew.workers) {
      expect(worker.available_intervals).toEqual([{ start: t(8), end: t(12) }]);
      expect(worker.eligible_activity_ids).toEqual([
        'inspection',
        'maintenance',
        'administration',
      ]);

      const assignments = bundle.activities
        .filter((activity) => activity.worker_ids.includes(worker.worker_id))
        .map((activity) => ({
          activity,
          start: Date.parse(
            bundle.baseline.assignments.find(
              (assignment) => assignment.activity_id === activity.activity_id,
            )!.start,
          ),
        }))
        .sort((a, b) => a.start - b.start);
      expect(assignments.map(({ activity }) => activity.activity_id)).toEqual([
        'inspection',
        'maintenance',
        'administration',
      ]);
      expect(assignments[0]!.start).toBe(Date.parse(t(8)));
      assignments.slice(1).forEach((current, index) => {
        const previous = assignments[index]!;
        expect(current.start).toBe(
          previous.start + previous.activity.duration_minutes * 60_000,
        );
      });
      const last = assignments.at(-1)!;
      expect(last.start + last.activity.duration_minutes * 60_000).toBe(
        Date.parse(t(12)),
      );
    }

    expect(
      bundle.activities.map((activity) => ({
        id: activity.activity_id,
        kind: activity.kind,
        location: activity.location_id,
        duration: activity.duration_minutes,
        service: activity.required_service_ref.id,
        workers: activity.worker_ids,
        predecessors: activity.predecessor_ids,
        resources: activity.resource_demands,
        timing: activity.timing_rule,
      })),
    ).toEqual([
      {
        id: 'inspection',
        kind: 'work',
        location: 'yard',
        duration: 60,
        service: 'demo:fictional-inspection-service',
        workers: ['worker-a', 'worker-b'],
        predecessors: [],
        resources: [],
        timing: 'movable_within_window',
      },
      {
        id: 'maintenance',
        kind: 'work',
        location: 'yard',
        duration: 60,
        service: 'demo:fictional-maintenance-service',
        workers: ['worker-a', 'worker-b'],
        predecessors: ['inspection'],
        resources: [],
        timing: 'movable_within_window',
      },
      {
        id: 'administration',
        kind: 'work',
        location: 'office',
        duration: 120,
        service: 'demo:fictional-administration-service',
        workers: ['worker-a', 'worker-b'],
        predecessors: [],
        resources: [],
        timing: 'movable_within_window',
      },
    ]);
    expect(
      bundle.locations.map((location) => ({
        id: location.location_id,
        microenvironment: location.microenvironment,
        controls: location.existing_control_refs,
        controlBasis: location.existing_control_basis_ref?.id,
      })),
    ).toEqual([
      {
        id: 'yard',
        microenvironment: 'outdoor',
        controls: [],
        controlBasis: 'demo:fictional-yard-no-controls',
      },
      {
        id: 'office',
        microenvironment: 'indoor',
        controls: [],
        controlBasis: 'demo:fictional-office-no-controls',
      },
    ]);
  });

  it('marks the no-travel/setup assumption as fictional, not an operating attestation', () => {
    const assumption = demoRecords().find(
      ({ ref }) => ref.id === 'demo:fictional-no-travel-setup',
    )?.record;
    expect(assumption).toMatchObject({
      scope: 'fictional_fixture_only',
      no_travel_required: true,
      no_setup_required: true,
      operational_attestation: false,
    });
  });

  it('declares bounded aligned starts and keeps baseline timing inside those bounds', () => {
    const bundle = fixture();
    const starts = (firstHour: number, lastHour: number) =>
      Array.from({ length: (lastHour - firstHour) * 4 + 1 }, (_, index) =>
        t(firstHour + Math.floor(index / 4), (index % 4) * 15),
      );
    const expected = new Map([
      ['inspection', starts(8, 11)],
      ['maintenance', starts(8, 11)],
      ['administration', starts(8, 10)],
    ]);

    for (const activity of bundle.activities) {
      expect(activity.timing_rule).toBe('movable_within_window');
      expect(activity.allowed_starts).toEqual(
        expected.get(activity.activity_id),
      );
      const baseline = bundle.baseline.assignments.find(
        (assignment) => assignment.activity_id === activity.activity_id,
      );
      expect(baseline).toBeDefined();
      expect(activity.allowed_starts).toContain(baseline!.start);
      expect(Date.parse(baseline!.start)).toBeGreaterThanOrEqual(
        Date.parse(activity.release),
      );
      expect(
        Date.parse(baseline!.start) + activity.duration_minutes * 60_000,
      ).toBeLessThanOrEqual(Date.parse(activity.deadline));
    }

    expect(
      bundle.baseline.assignments.map(({ activity_id, start }) => [
        activity_id,
        start,
      ]),
    ).toEqual([
      ['inspection', t(8)],
      ['maintenance', t(9)],
      ['administration', t(10)],
    ]);
    const inspectionEnd =
      Date.parse(t(8)) +
      bundle.activities.find(
        (activity) => activity.activity_id === 'inspection',
      )!.duration_minutes *
        60_000;
    expect(Date.parse(t(9))).toBeGreaterThanOrEqual(inspectionEnd);
  });

  it('records the empty resource set with a fictional absence basis', () => {
    const bundle = fixture();
    expect(bundle.resources).toEqual([]);
    expect(bundle.resource_absence_basis_ref?.id).toBe(
      'demo:fictional-no-bottlenecks',
    );
    const absence = demoRecords().find(
      ({ ref }) => ref.id === 'demo:fictional-no-bottlenecks',
    )?.record;
    expect(absence).toMatchObject({
      scope: 'fictional_fixture_only',
      no_relevant_resource_bottlenecks_assumed: true,
      operational_attestation: false,
    });
  });

  it('pins the fictional policy thresholds without granting operational approval', () => {
    const bundle = fixture();
    const policy = demoRecords().find(
      ({ ref }) => ref.id === bundle.policy_ref.id,
    );
    expect(policy?.record).toMatchObject({
      id: 'demo:fictional-policy',
      revision: bundle.policy_ref.revision,
      policy_version: 'haze.decision_policy.v2',
      scope: 'fictional_two_worker_engineering_example',
      approval_status: 'not_approved',
      operational_use_allowed: false,
      allow_overtime: false,
      allow_reassignment: false,
      allow_new_controls: false,
      worker_and_activity_nonincrease: true,
      minimum_benefit: {
        metric: 'crew_concentration_time_proxy_reduction_fraction',
        threshold: 0.1,
        comparison: 'greater_than_or_equal',
        required_scenarios: ['nominal', 'plus_20_sensitivity'],
        aggregation: 'each_required_scenario',
      },
      disruption_limits: {
        maximum_total_absolute_timing_movement_minutes: 360,
        maximum_changed_activities: 3,
        maximum_per_activity_absolute_timing_movement_minutes: 120,
        shared_activity_counting: 'once_per_activity_id',
      },
      uncertainty_note:
        'The +20 sensitivity is a fictional engineering perturbation, not supported operational uncertainty.',
    });
    expect(bundle.evidence_refs).toHaveLength(4);
  });

  it('validates the illustrative schedules without claiming an exhaustive set', () => {
    const bundle = fixture();
    const examples = verificationSchedules();
    expect(examples).toMatchObject({
      fixture_kind: 'verification_schedule_examples',
      scope: 'illustrative_only',
      exhaustive: false,
    });
    expect(
      examples.schedules.map(({ record }) => ({
        id: record.id,
        example_kind: record.example_kind,
        assignments: record.assignments,
      })),
    ).toEqual([
      {
        id: 'demo:verification-less-disruption',
        example_kind: 'illustrative_verification_only',
        assignments: [
          { activity_id: 'inspection', start: t(8) },
          { activity_id: 'administration', start: t(9) },
          { activity_id: 'maintenance', start: t(11) },
        ],
      },
      {
        id: 'demo:verification-lower-proxy',
        example_kind: 'illustrative_verification_only',
        assignments: [
          { activity_id: 'administration', start: t(8) },
          { activity_id: 'inspection', start: t(10) },
          { activity_id: 'maintenance', start: t(11) },
        ],
      },
    ]);

    const knownRecords = new Map(
      demoRecords().map(({ ref, record }) => [ref.id, record]),
    );
    const expectedActivityIds = bundle.activities
      .map((activity) => activity.activity_id)
      .sort();
    for (const { ref, record } of examples.schedules) {
      expect(ref.id).toBe(record.id);
      expect(ref.revision).toBe(record.revision);
      expect(knownRecords.get(ref.id)).toEqual(record);
      expect(record.example_kind).toBe('illustrative_verification_only');
      expect(
        record.assignments.map(({ activity_id }) => activity_id).sort(),
      ).toEqual(expectedActivityIds);

      const starts = new Map(
        record.assignments.map(({ activity_id, start }) => [
          activity_id,
          Date.parse(start),
        ]),
      );
      for (const activity of bundle.activities) {
        const scheduledStart = starts.get(activity.activity_id)!;
        const assignment = record.assignments.find(
          ({ activity_id }) => activity_id === activity.activity_id,
        )!;
        expect(activity.allowed_starts).toContain(assignment.start);
        expect(
          (scheduledStart - Date.parse(bundle.assessment.start)) %
            (bundle.assessment.planning_step_minutes * 60_000),
        ).toBe(0);
        expect(scheduledStart).toBeGreaterThanOrEqual(
          Date.parse(activity.release),
        );
        const scheduledEnd =
          scheduledStart + activity.duration_minutes * 60_000;
        expect(scheduledEnd).toBeLessThanOrEqual(Date.parse(activity.deadline));
        expect(activity.resource_demands).toEqual([]);
        for (const predecessorId of activity.predecessor_ids) {
          const predecessor = bundle.activities.find(
            ({ activity_id }) => activity_id === predecessorId,
          )!;
          expect(scheduledStart).toBeGreaterThanOrEqual(
            starts.get(predecessorId)! + predecessor.duration_minutes * 60_000,
          );
        }
      }

      for (const worker of bundle.crew.workers) {
        const workerActivities = bundle.activities
          .filter((activity) => activity.worker_ids.includes(worker.worker_id))
          .map((activity) => ({
            activity,
            start: starts.get(activity.activity_id)!,
          }))
          .sort((a, b) => a.start - b.start);
        let cursor = Date.parse(bundle.assessment.start);
        for (const { activity, start } of workerActivities) {
          expect(start).toBe(cursor);
          const end = start + activity.duration_minutes * 60_000;
          expect(
            worker.available_intervals.some(
              (interval) =>
                Date.parse(interval.start) <= start &&
                Date.parse(interval.end) >= end,
            ),
          ).toBe(true);
          cursor = end;
        }
        expect(cursor).toBe(Date.parse(bundle.assessment.end));
      }
    }
  });

  it('keeps the synthetic example publication-disabled and ineligible', () => {
    const result = exampleResult();
    expect(result.input_origin).toBe('synthetic_fixture');
    expect(result.execution_surface).toBe('historical_harness');
    expect(result.result.recommendation_eligible).toBe(false);
    expect(result.result.publication_status).toBe('publication_disabled');
    expect(result.decision_ref.publication_ref).toBeNull();
    expect(result.decision_ref.candidate_ref).toBeNull();
    expect(result.result.evidence_status).toBe('insufficient');
    expect(result.result.decision_outcome).toBe('insufficient_evidence');
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
