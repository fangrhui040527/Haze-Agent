import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentRun, type AgentRun } from '../dashboard/useAgentRun.ts';
import {
  artifactId,
  fixtureAssignment,
  fixtureManager,
  fixtureTask,
  taskId,
} from '../../services/agents/testFixtures.ts';
import { ManagerPage, ManagerTaskView } from './ManagerPage.tsx';

vi.mock('../dashboard/useAgentRun.ts', () => ({ useAgentRun: vi.fn() }));

function taskRun(): AgentRun {
  return {
    events: [],
    status: 'completed',
    statusText: 'Answer ready.',
    startedAt: null,
    serviceLabel: 'Fixture',
    ask: vi.fn(),
    cancel: vi.fn(),
    task: {
      id: taskId,
      taskUrl: `/api/tasks/${taskId}`,
      schemaVersion: 'haze.task.v3',
      status: 'completed',
      record: { ...fixtureTask(), manager: fixtureManager() },
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

const renderView = (run: AgentRun) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(ManagerTaskView, { taskId, run }),
    ),
  );

const renderRoute = (path: string) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: '/manager/:taskId?',
          element: createElement(ManagerPage),
        }),
      ),
    ),
  );

describe('dedicated Manager page', () => {
  beforeEach(() => {
    vi.mocked(useAgentRun).mockReset().mockReturnValue(taskRun());
    vi.stubGlobal('sessionStorage', { getItem: vi.fn(() => null) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('offers a dashboard entry and saved-task access when no task is selected', () => {
    const markup = renderRoute('/manager');
    expect(markup).toContain('<h1>Manager</h1>');
    expect(markup).toContain('No task selected');
    expect(markup).toContain('Start a task on the dashboard');
    expect(markup).toContain('Open a saved task');
    expect(markup).toContain('Task ID');
    expect(useAgentRun).not.toHaveBeenCalled();
  });

  it('restores the dashboard task on direct Manager navigation', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) =>
        key === 'haze.general.task.id' ? taskId : artifactId,
    });
    const markup = renderRoute('/manager');
    expect(markup).toContain('Interpreted objective');
    expect(markup).toContain(`href="/task/${taskId}"`);
    expect(useAgentRun).toHaveBeenCalledWith(taskId, 'haze.manager.task.id');
  });

  it('opens the exact linked task even when the dashboard remembers another task', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => artifactId });
    const markup = renderRoute(`/manager/${taskId}`);
    expect(markup).toContain(`href="/task/${taskId}"`);
    expect(markup).toContain('Explain the supplied evidence.');
    expect(useAgentRun).toHaveBeenCalledWith(taskId, 'haze.manager.task.id');
  });

  it('falls back to the last Manager task when no dashboard task is saved', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) =>
        key === 'haze.manager.task.id' ? taskId : null,
    });
    expect(renderRoute('/manager')).toContain('Interpreted objective');
    expect(useAgentRun).toHaveBeenCalledWith(taskId, 'haze.manager.task.id');
  });

  it('keeps the empty page usable when browser storage is unavailable', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('Storage disabled');
      },
    });
    expect(renderRoute('/manager')).toContain('No task selected');
    expect(renderRoute(`/manager/${taskId}`)).toContain(
      'Interpreted objective',
    );
  });

  it('renders interpretation, replanning, current assignments and complete decision disclosures', () => {
    const run = taskRun();
    const record = run.task!.record!;
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
    const markup = renderView(run);
    expect(markup).toContain(
      'Explain the supplied evidence within its measured coverage.',
    );
    expect(markup).toContain('Plan revision 2');
    expect(markup).toContain('Replanning reason:');
    expect(markup).toContain(
      'Investigate the reviewer objection before synthesis.',
    );
    expect(markup).toContain('evidence-synthesis');
    expect(markup).not.toContain('retired-capability');
    expect(markup).not.toContain('previous-run-capability');
    expect(markup).toContain('Manager decisions and execution details (1)');
    expect(markup).toContain(
      'The review identified a coverage gap requiring investigation.',
    );
    expect(markup).toContain('Artifact inspections (1)');
    expect(markup).toContain('Plan history (2)');
    expect(markup).toContain('Scope, assumptions and stopping conditions');
  });

  it('keeps review objections visible in the new workspace', () => {
    const run = taskRun();
    run.task!.record!.assignments = [
      {
        ...fixtureAssignment(),
        usability: 'rejected',
        gaps: ['The source does not contain direct observations.'],
      },
    ];
    const markup = renderView(run);
    expect(markup).toContain('Review objection: work is rejected.');
    expect(markup).toContain(
      'The source does not contain direct observations.',
    );
  });

  it('does not substitute another task or an earlier run for the selected workspace', () => {
    const run = taskRun();
    run.task!.id = artifactId;
    expect(renderView(run)).not.toContain('Interpreted objective');
    expect(renderView(run)).not.toContain('Explain the supplied evidence.');
    run.task!.id = taskId;
    run.task!.record!.manager!.run_id = artifactId;
    expect(renderView(run)).not.toContain('id="manager-workspace-title"');
    expect(renderView(run)).toContain(
      'No Manager workspace is saved for this run yet.',
    );
    expect(renderView(run)).toContain(`href="/task/${taskId}"`);
  });

  it('retains controls for paused tasks and linked continuation for legacy runs', () => {
    const run = taskRun();
    run.status = 'paused';
    run.task!.record!.status = 'paused';
    expect(renderView(run)).toContain('Resume task');
    run.task!.record!.manager!.upgrade_required =
      'Continue this legacy Manager in a linked run.';
    const markup = renderView(run);
    expect(markup).toContain('Continue this legacy Manager in a linked run.');
    expect(markup).toContain('Continue in a new run');
    expect(markup).not.toContain('Resume task');
  });

  it('reports loading and failed readback without inventing Manager state', () => {
    const run = taskRun();
    run.task = null;
    run.status = 'idle';
    expect(renderView(run)).toContain('Loading the saved task...');
    expect(renderView(run)).toContain('aria-busy="true"');
    run.status = 'failed';
    run.observationError = 'The selected task could not be found.';
    const markup = renderView(run);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('The selected task could not be found.');
    expect(markup).not.toContain('id="manager-workspace-title"');
    expect(markup).toContain('Open another saved task');
  });
});
