import reviewPackage from '../../../../examples/demo-review/package.json';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ImmutableReference } from '../../../../app/contracts/common.ts';
import { planningSchema } from '../../../../app/contracts/planning.ts';
import type { Result } from '../../../../app/contracts/result.ts';
import {
  demoChatResponseSchema,
  type DemoChatResponse,
} from '../../../../app/demo/chat-contract.ts';
import { ScheduleResult } from './ScheduleResult.tsx';
import {
  checkedQuantification,
  sameReference,
  scheduleDate,
  scheduleOffset,
  scheduleRows,
  scheduleTime,
} from './scheduleDisplay.ts';

const recorded = reviewPackage as unknown as {
  records: { ref: ImmutableReference; record: Record<string, unknown> }[];
  results: Record<string, Result>;
};

function responseFor(name: string): DemoChatResponse {
  const result = recorded.results[name];
  const planning = planningSchema.parse(
    recorded.records.find((entry) =>
      sameReference(entry.ref, result.decision_ref.bundle_ref),
    )?.record,
  );
  const refs = [
    planning.baseline.ref,
    ...result.result.plan_verification.map((check) => check.plan_ref),
  ];
  const plans = recorded.records
    .filter((entry) => refs.some((ref) => sameReference(ref, entry.ref)))
    .map((entry) => ({
      ref: entry.ref,
      plan_id: entry.record.plan_id,
      assignments: entry.record.assignments,
    }));
  return demoChatResponseSchema.parse({
    schema_version: 'haze.demo_chat.v1',
    result,
    planning,
    plans,
  });
}

describe('schedule display', () => {
  it('formats instants in the assessment timezone, including a date rollover', () => {
    expect(scheduleTime('2026-10-25T00:00:00Z', 'Asia/Kuala_Lumpur')).toBe(
      '08:00',
    );
    expect(scheduleTime('2026-10-24T16:30:00Z', 'Asia/Kuala_Lumpur')).toBe(
      '00:30',
    );
    expect(scheduleDate('2026-10-24T16:30:00Z', 'Asia/Kuala_Lumpur')).toBe(
      '25 Oct 2026',
    );
    expect(scheduleOffset('2026-10-25T00:00:00Z', 'Asia/Kuala_Lumpur')).toBe(
      'GMT+08:00',
    );
  });

  it('renders a shared activity once while checking occupancy for both workers', () => {
    const { planning } = responseFor('named_set');
    const display = scheduleRows(planning, planning.baseline.assignments);
    expect(display.rows.map((row) => row.activity.activity_id)).toEqual([
      'inspection',
      'maintenance',
      'administration',
    ]);
    expect(display.rows[0]?.activity.worker_ids).toEqual([
      'worker-a',
      'worker-b',
    ]);
    expect(display.errors).toEqual([]);
    expect(display.occupancy).toEqual([]);
    const repeated = scheduleRows(planning, [
      ...planning.baseline.assignments,
      planning.baseline.assignments[0],
    ]);
    expect(repeated.rows).toHaveLength(3);
    expect(repeated.errors[0]).toContain('Duplicate assignment: inspection');
  });

  it('surfaces missing activities, occupancy gaps and overlapping work', () => {
    const { planning } = responseFor('named_set');
    const incomplete = scheduleRows(
      planning,
      planning.baseline.assignments.slice(1),
    );
    expect(incomplete.errors).toContain('Missing activity: inspection.');
    expect(
      incomplete.occupancy.map((issue) => [issue.workerId, issue.kind]),
    ).toEqual([
      ['worker-a', 'gap'],
      ['worker-b', 'gap'],
    ]);
    const overlap = scheduleRows(
      planning,
      planning.baseline.assignments.map((entry) =>
        entry.activity_id === 'maintenance'
          ? { ...entry, start: planning.assessment.start }
          : entry,
      ),
    );
    expect(overlap.occupancy.map((issue) => issue.kind)).toEqual([
      'overlap',
      'gap',
      'overlap',
      'gap',
    ]);
  });

  it('keeps selection distinct from comparison and shows both section 23 alternatives', () => {
    const markup = renderToStaticMarkup(
      createElement(ScheduleResult, { response: responseFor('named_set') }),
    );
    expect(markup).toContain('Selected engineering candidate');
    expect(markup).toContain('less-disruption');
    expect(markup).toContain('lower-proxy');
    expect(markup).toContain('Illustrated alternative — not selected');
    expect(markup).toContain('Comparison plan:</strong> None');
    expect(markup).toContain('22.73%');
    expect(markup).toContain('Action threshold: met');
    expect(markup).toContain('Action threshold: below');
    expect(markup).toContain('Publication disabled');
    expect(markup).toContain('Draft for review');
    expect(markup).toContain('GMT+08:00');
    expect(markup).toContain('Complete occupancy for every worker');
    expect(markup.match(/<strong>inspection<\/strong>/g)).toHaveLength(3);
  });

  it('retains the baseline and suppresses numbers when coverage is missing', () => {
    const response = responseFor('missing_evidence');
    const markup = renderToStaticMarkup(
      createElement(ScheduleResult, { response }),
    );
    expect(markup).toContain('Baseline retained; no plan selected.');
    expect(markup).toContain('No verified numerical comparison is available.');
    expect(markup).not.toContain('Checked fictional exposure proxy');
    expect(markup).toContain('Input and evidence issues');
    expect(markup).toContain('<strong>inspection</strong>');
    expect(checkedQuantification(response.result)).toBeNull();
  });

  it('keeps a comparison-only result separate when no candidate meets the action threshold', () => {
    // Hypothetical contract state, based on the result-contract predicate tests.
    // It is only used for presentation testing and is never offered as sample data.
    const response = responseFor('named_set');
    const result = response.result.result;
    result.decision_outcome = 'below_action_threshold';
    result.comparison_plan_ref = result.selected_plan_ref;
    result.comparison_plan_reason = null;
    result.selected_plan_ref = null;
    result.selected_plan_reason = {
      code: 'below_threshold',
      explanation:
        'The checked improvement is below the required action threshold.',
    };
    result.action_threshold_status = 'below';
    for (const check of result.plan_verification) {
      check.action_threshold_status = 'below';
    }
    result.search.counts.qualifying = 0;
    const markup = renderToStaticMarkup(
      createElement(ScheduleResult, {
        response: demoChatResponseSchema.parse(response),
      }),
    );
    expect(markup).toContain('No candidate meets the action threshold');
    expect(markup).toContain('Baseline retained; no plan selected.');
    expect(markup).not.toContain('Selected engineering candidate');
    expect(markup).toContain('Comparison only — not selected');
    expect(markup).toContain('Human review:');
  });

  it('fails closed on corrupted saved results and does not show numbers', () => {
    const response = responseFor('named_set');
    response.result.result.quantified!.nominal.candidate = 999999;
    const markup = renderToStaticMarkup(
      createElement(ScheduleResult, { response }),
    );
    expect(markup).toContain('could not be validated');
    expect(markup).not.toContain('999999');
    expect(markup).not.toContain('Checked fictional exposure proxy');
    expect(
      renderToStaticMarkup(
        createElement(ScheduleResult, {
          response: null as unknown as DemoChatResponse,
        }),
      ),
    ).toContain('could not be validated');
  });
});
