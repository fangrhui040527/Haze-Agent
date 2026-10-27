import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../dashboard/useAgentRun.ts';
import {
  artifactId,
  artifactRef,
  fixtureAssignment,
  fixtureManager,
  fixtureTask,
  receipt,
  taskId,
} from '../../services/agents/testFixtures.ts';
import { GeneralTaskReport } from './GeneralTaskPage.tsx';

function taskRun(): AgentRun {
  return {
    events: [],
    status: 'completed',
    statusText: 'Answer ready.',
    startedAt: null,
    serviceLabel: 'Fixture',
    ask: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
    task: {
      id: taskId,
      taskUrl: `/api/tasks/${taskId}`,
      schemaVersion: 'haze.task.v3',
      status: 'completed',
      record: fixtureTask(),
    },
    operationPending: false,
    operationError: null,
    receipt: null,
    control: vi.fn(),
    update: vi.fn(),
    importSource: vi.fn(),
    capabilities: [],
    capabilitiesError: null,
    latestAnswer: null,
  };
}

const render = (run: AgentRun) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(GeneralTaskReport, { taskId, run }),
    ),
  );

describe('general task reports', () => {
  it('renders the original objective, saved evidence answer, review and currency', () => {
    const run = taskRun();
    const record = run.task!.record!;
    record.result!.currency = 'stale';
    const markup = render(run);
    expect(markup).toContain('Explain the supplied evidence.');
    expect(markup).toContain('>Completed</span>');
    expect(markup).toContain('The source supports a limited explanation. [E1]');
    expect(markup).toContain('needs review');
    expect(markup).toContain('Stale result');
    expect(markup).toContain('Exact source');
    expect(markup).toContain('Open Manager workspace');
    expect(markup).not.toContain('Continue in a new run');
    expect(markup).not.toContain('Filled in from a template');
    expect(markup).not.toContain('href="/task/');
    expect(markup).not.toContain('Actual execution receipts');
    expect(markup).not.toContain('Next step');
  });

  it('leaves raw receipts to the trace timeline and hides an empty World Model panel', () => {
    const run = taskRun();
    const own = receipt(1, 'assignment.started', 'Manager');
    const unrelated = {
      ...receipt(2, 'another-task-event', 'HazeOps'),
      task_id: artifactId,
    };
    run.events = [own, unrelated].map((item) => ({
      type: 'task_event',
      runId: item.run_id,
      at: item.at,
      message: item.message,
      receipt: item,
    }));
    const markup = render(run);
    expect(markup).not.toContain('Actual assignment.started');
    expect(markup).not.toContain('another-task-event');
    expect(markup).not.toContain('World Model');
  });

  it('keeps saved server failure and partial results visible after observation ends', () => {
    const run = taskRun();
    run.status = 'failed';
    run.statusText = 'Source retrieval failed.';
    run.task!.record!.status = 'failed';
    run.task!.record!.error = {
      code: 'SOURCE_UNAVAILABLE',
      message: 'Source retrieval failed.',
    };
    const markup = render(run);
    expect(markup).toContain('>Failed</span>');
    expect(markup).toContain('role="alert">Source retrieval failed.');
    expect(markup.split('Source retrieval failed.').length).toBe(2);
    expect(markup).toContain('Next step');
    expect(markup).toContain('Continue in a new run');
    expect(markup).toContain('Saved result');
    expect(markup).toContain('aria-busy="false"');
    expect(markup).not.toContain('Stop waiting');
  });

  it('renders waiting questions and links paused controls to the workspace', () => {
    const run = taskRun();
    run.status = 'waiting';
    run.statusText = 'Waiting for clarification or source material.';
    run.task!.record!.status = 'waiting';
    run.task!.record!.questions = [
      {
        id: taskId,
        task_id: taskId,
        run_id: run.task!.record!.current_run_id,
        objective_revision: 1,
        question: 'Which supplied document should be analyzed?',
        kind: 'human',
        status: 'open',
        created_at: run.task!.record!.created_at,
      },
    ];
    const waiting = render(run);
    expect(waiting).toContain('Which supplied document should be analyzed?');
    expect(waiting).toContain('Next step');
    expect(waiting).toContain('Send answer');
    expect(waiting).not.toContain('Continue in a new run');
    expect(render(run)).toContain('aria-busy="false"');
    run.status = 'paused';
    run.statusText = 'Task paused. Saved work is retained.';
    run.task!.record!.status = 'paused';
    const paused = render(run);
    expect(paused).toContain('>Paused</span>');
    expect(paused).toContain('Open Manager workspace');
    expect(paused).not.toContain('Resume task');
    expect(paused).toContain('aria-busy="false"');
    expect(paused).not.toContain('Continue in a new run');
  });

  it('distinguishes stopping observation from server cancellation', () => {
    const run = taskRun();
    run.task!.record!.status = 'running';
    run.status = 'cancelled';
    run.statusText =
      'Stopped waiting. Check the saved task for its server status.';
    const stopped = render(run);
    expect(stopped).toContain('>Running</span>');
    expect(stopped).toContain('Stopped waiting.');
    expect(stopped).not.toContain('Stop waiting</button>');
    run.status = 'task_cancelled';
    run.statusText =
      'The server cancelled this task. Saved artifacts remain available.';
    run.task!.record!.status = 'cancelled';
    expect(render(run)).toContain('>Cancelled</span>');
  });

  it('shows transport/readback errors while retaining the last saved server status', () => {
    const run = taskRun();
    run.status = 'failed';
    run.task!.record!.status = 'running';
    run.observationError = 'Task request failed (503).';
    const markup = render(run);
    expect(markup).toContain('>Running</span>');
    expect(markup).toContain('role="alert">Task request failed (503).');
    run.task = null;
    expect(render(run)).toContain('Task request failed (503).');
  });

  it('does not display another task as the requested report', () => {
    const run = taskRun();
    run.task!.id = artifactId;
    const markup = render(run);
    expect(markup).not.toContain('Explain the supplied evidence.');
    expect(markup).not.toContain('Saved result');
    expect(markup).not.toContain('Continue in a new run');
  });

  it('links to the saved task Manager page instead of embedding coordination details', () => {
    const run = taskRun();
    const record = run.task!.record!;
    record.manager = fixtureManager();
    record.assignments = [
      fixtureAssignment(),
      {
        ...fixtureAssignment(),
        id: taskId,
        capability: 'retired-capability',
        status: 'stale',
      },
      {
        ...fixtureAssignment(),
        id: record.current_run_id,
        run_id: artifactId,
        capability: 'previous-run-capability',
      },
    ];
    const markup = render(run);
    expect(markup).toContain(`href="/manager/${taskId}"`);
    expect(markup).toContain('Open Manager workspace');
    expect(markup).not.toContain('id="manager-workspace-title"');
    expect(markup).not.toContain('Interpreted objective');
    expect(markup).not.toContain(
      'Explain the supplied evidence within its measured coverage.',
    );
    expect(markup).not.toContain('Plan revision 2');
    expect(markup).not.toContain('Replanning reason:');
    expect(markup).not.toContain(
      'Investigate the reviewer objection before synthesis.',
    );
    expect(markup).not.toContain('retired-capability');
    expect(markup).not.toContain('previous-run-capability');
    expect(markup).not.toContain(
      '<details><summary>Manager decisions and execution details (1)</summary>',
    );
    expect(markup).not.toContain(
      'The review identified a coverage gap requiring investigation.',
    );
    expect(markup).not.toContain('Artifact inspections (1)');
    expect(markup).not.toContain('Plan history (2)');
  });

  it('exposes rejected claims and next requirements in a partial saved result', () => {
    const run = taskRun();
    const record = run.task!.record!;
    record.manager = fixtureManager();
    record.assignments = [
      {
        ...fixtureAssignment(),
        usability: 'rejected',
        gaps: ['The source does not contain direct observations.'],
      },
    ];
    record.result!.review.checks = [
      {
        artifact: artifactRef,
        producer_assignment_id: artifactId,
        producer_revision: 2,
        reviewer_assignment_id: taskId,
        reviewer_revision: 1,
        verdict: 'rejected',
        limitations: ['A numerical claim lacks supporting observations.'],
      },
    ];
    const markup = render(run);
    expect(markup).toContain('Result: partial');
    expect(markup).not.toContain('Review objection: work is rejected.');
    expect(markup).not.toContain(
      'The source does not contain direct observations.',
    );
    expect(markup).toContain(`href="/manager/${taskId}"`);
    expect(markup).toContain('Artifact review checks');
    expect(markup).toContain('Review objections');
    expect(markup).toContain(
      'A numerical claim lacks supporting observations.',
    );
    expect(markup).toContain('What is needed next');
    expect(markup).toContain('Provide direct observations.');
  });

  it('preserves historical tasks without Manager state and excludes a predecessor Manager', () => {
    const run = taskRun();
    expect(render(run)).not.toContain('id="manager-workspace-title"');
    expect(render(run)).toContain(`href="/manager/${taskId}"`);
    run.task!.record!.manager = { ...fixtureManager(), run_id: artifactId };
    const markup = render(run);
    expect(markup).not.toContain('id="manager-workspace-title"');
    expect(markup).toContain('Saved result');
  });

  it('links unfinished legacy Manager tasks to their workspace for continuation', () => {
    const run = taskRun();
    run.status = 'paused';
    const record = run.task!.record!;
    record.status = 'paused';
    record.manager = {
      ...fixtureManager(),
      upgrade_required:
        'This run used the previous Manager. Continue in a linked run to use the current version.',
    };
    const markup = render(run);
    expect(markup).toContain('Open Manager workspace');
    expect(markup).toContain(`href="/manager/${taskId}"`);
    expect(markup).not.toContain('Continue in a new run');
    expect(markup).not.toContain('Resume task');
  });

  it('leaves task permission revocation in the Manager workspace', () => {
    const run = taskRun();
    run.task!.record!.permissions.tools = ['nightshift.submit'];
    const markup = render(run);
    expect(markup).toContain('Open Manager workspace');
    expect(markup).not.toContain('Tool permissions');
    expect(markup).not.toContain('Revoke selected permissions');
    expect(markup).not.toContain('Next task permissions');
  });
});
