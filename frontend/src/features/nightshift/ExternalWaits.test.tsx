import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import {
  externalWaitViewSchema,
  type ExternalWaitView,
} from '../../../../app/contracts/external-waits.ts';
import { ExternalWaitDetails, ExternalWaitObserver } from './ExternalWaits.tsx';
import { NightshiftClient } from './jobsApi.ts';

const taskId = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';
const secondJob = '33333333-3333-4333-8333-333333333333';
const runId = '44444444-4444-4444-8444-444444444444';
const assignmentId = '55555555-5555-4555-8555-555555555555';
const waitId = '66666666-6666-4666-8666-666666666666';
const deliveryId = '77777777-7777-4777-8777-777777777777';
const artifact = {
  id: '88888888-8888-4888-8888-888888888888',
  version: 1,
  sha256: 'a'.repeat(64),
};
function view(): ExternalWaitView {
  return externalWaitViewSchema.parse({
    schema_version: 'haze.external.wait.view.v1',
    task_id: taskId,
    capacity: {
      permit: 'released',
      wait_reason: 'capacity',
      queue: {
        sequence: 12,
        thread_id: 'target-thread',
        status: 'eligible',
        reason: null,
      },
    },
    waits: [
      {
        id: waitId,
        thread_id: 'target-thread',
        authority: {
          task_id: taskId,
          run_id: runId,
          generation: 3,
          objective_revision: 2,
          assignment_id: assignmentId,
          assignment_revision: 4,
        },
        after_cursor: 42,
        dependencies: [{ job_id: jobId, required: true }],
        state: 'ready',
        reason: null,
        created_at: '2026-10-27T00:00:00Z',
      },
    ],
    deliveries: [
      {
        id: deliveryId,
        wait_id: waitId,
        job_id: jobId,
        execution_state: 'completed',
        artifact,
        event_cursor: 43,
        state: 'retained',
        reason: null,
      },
    ],
  });
}
function render(data: ExternalWaitView, job?: string) {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      {},
      createElement(ExternalWaitDetails, { data, jobId: job }),
    ),
  );
}

it('reads deep-linked capacity and delivery state through GET only on reconnect', async () => {
  const data = view();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(Response.json(data)));
  const client = new NightshiftClient(fetcher);
  const signal = new AbortController().signal;
  expect(await client.externalWaits(taskId, signal)).toEqual(data);
  expect(await client.externalWaits(taskId, signal)).toEqual(data);
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const [path, options] of fetcher.mock.calls) {
    expect(path).toBe(`/api/nightshift/tasks/${taskId}/waits`);
    expect(options?.method).toBe('GET');
    expect(options?.body).toBeUndefined();
    expect(options?.headers).toBeUndefined();
  }
});

it.each([
  ['compute', 'Waiting for external compute'],
  ['capacity', 'Waiting for Haze capacity'],
  ['human', 'Waiting for a user'],
  ['stopped', 'Stopped work'],
] as const)(
  'distinguishes %s waits from public task status',
  (reason, label) => {
    const data = view();
    data.capacity.wait_reason = reason;
    const markup = render(data);
    expect(markup).toContain(label);
    expect(markup).toContain('Task permit: released');
    expect(markup).toContain('Remote job reservations are counted separately');
    if (reason === 'stopped')
      expect(markup).toContain(
        'explicit Continue within the same remaining grant',
      );
  },
);

it('shows exact delivery targets and retained references while capacity remains occupied', () => {
  const markup = render(view());
  expect(markup).toContain('first eligible sequence 12');
  expect(markup).toContain('Capacity queue: eligible');
  expect(markup).toContain(
    'Required result; blocks finalization while pending',
  );
  expect(markup).toContain(runId);
  expect(markup).toContain('generation 3; objective revision 2; assignment');
  expect(markup).toContain(assignmentId);
  expect(markup).toContain('revision 4');
  expect(markup).toContain('Event cursor 42');
  expect(markup).toContain('Delivery: retained; event cursor 43');
  expect(markup).toContain(artifact.sha256);
  expect(markup).toContain(`/nightshift/${jobId}`);
  expect(markup).toContain('independent review still apply');
});

it('filters a job deep link to its exact dependencies and escapes recorded stop reasons', () => {
  const data = view();
  data.waits.push({
    ...data.waits[0]!,
    id: '99999999-9999-4999-8999-999999999999',
    dependencies: [{ job_id: secondJob, required: true }],
  });
  data.deliveries[0]!.execution_state = 'failed';
  data.deliveries[0]!.reason = '<script>untrusted()</script>';
  const markup = render(data, jobId);
  expect(markup).not.toContain(secondJob);
  expect(markup).not.toContain('<script>');
  expect(markup).toContain('&lt;script&gt;');
  expect(markup).toContain(
    'explicit failure, partial-result or replanning decision',
  );
});

it('stopping browser observation has no remote control implication', () => {
  const markup = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      {},
      createElement(ExternalWaitObserver, { taskId, observing: false }),
    ),
  );
  expect(markup).toContain('Browser observation stopped');
  expect(markup).toContain(
    'Observation does not cancel a job, close a chain or start a run',
  );
  expect(markup).toContain('Refresh wait state');
  expect(markup).toContain('disabled');
});
