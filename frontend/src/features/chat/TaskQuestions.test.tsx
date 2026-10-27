import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../dashboard/useAgentRun.ts';
import {
  at,
  fixtureTask,
  runId,
  taskId,
} from '../../services/agents/testFixtures.ts';
import { TaskQuestions } from './TaskQuestions.tsx';
import { TaskControls } from './TaskControls.tsx';
function taskRun(): AgentRun {
  return {
    events: [],
    status: 'waiting',
    statusText: 'Waiting',
    startedAt: null,
    serviceLabel: 'Fixture',
    ask: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
    task: {
      id: taskId,
      taskUrl: `/api/tasks/${taskId}`,
      schemaVersion: 'haze.task.v3',
      status: 'waiting',
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
describe('persisted task interactions', () => {
  it('shows open questions and exact correction history', () => {
    const run = taskRun();
    const record = run.task!.record!;
    record.questions.push({
      id: taskId,
      task_id: taskId,
      run_id: runId,
      objective_revision: 1,
      question: 'Which source should be included?',
      kind: 'human',
      status: 'open',
      created_at: at,
    });
    record.corrections.push({
      id: runId,
      objective_revision: 2,
      kind: 'correction',
      passage: `Keep the original passage.
  Include the new scope.`,
      affected_assignment_ids: [],
      created_at: at,
    });
    const markup = renderToStaticMarkup(createElement(TaskQuestions, { run }));
    expect(markup).toContain('Which source should be included?');
    expect(markup).toContain('Your answer');
    expect(markup).toContain('Send answer');
    expect(markup).not.toContain('human wait');
    expect(markup).toContain('Correction history (1)');
    expect(markup).toContain(`Keep the original passage.
  Include the new scope.`);
  });
  it('shows resume and explicit continuation with persisted control receipt distinctions', () => {
    const run = taskRun();
    run.task!.record!.status = 'paused';
    expect(
      renderToStaticMarkup(createElement(TaskControls, { run })),
    ).toContain('Resume task');
    run.task!.record!.status = 'completed';
    const markup = renderToStaticMarkup(createElement(TaskControls, { run }));
    expect(markup).toContain('Continue in a new run');
    expect(markup).toContain('fresh bounded resources');
    expect(markup).not.toContain('Pause task');
  });
});
