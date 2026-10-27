import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../dashboard/useAgentRun.ts';
import {
  fixtureAssignment,
  fixtureTask,
  receipt,
  taskId,
} from '../../services/agents/testFixtures.ts';
import { AgentOffice } from './AgentOffice.tsx';

function taskRun(): AgentRun {
  const record = fixtureTask();
  record.status = 'running';
  record.assignments = [
    {
      ...fixtureAssignment(),
      brief: 'Internal specialist implementation brief.',
      gaps: ['Internal applicability diagnostic.'],
    },
  ];
  const event = {
    ...receipt(1, 'checkpoint_written'),
    actor: 'Runtime' as const,
    message: 'Internal runtime receipt payload.',
  };
  return {
    events: [
      {
        type: 'task_event',
        runId: event.run_id,
        at: event.at,
        message: event.message,
        receipt: event,
      },
    ],
    status: 'running',
    statusText: 'Working.',
    startedAt: null,
    serviceLabel: 'Actual task receipts',
    ask: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
    task: {
      id: taskId,
      schemaVersion: 'haze.task.v3',
      taskUrl: `/api/tasks/${taskId}`,
      status: 'running',
      record,
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
const renderOffice = (run: AgentRun) =>
  renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(AgentOffice, { run })),
  );

describe('dashboard office task presentation', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('preserves the office canvas and agent statuses while routing technical details to the workspace', () => {
    const markup = renderOffice(taskRun());
    expect(markup).toContain('<canvas');
    expect(markup).toContain('What each agent is doing');
    expect(markup).toContain('Manager');
    expect(markup).toContain(`href="/manager/${taskId}"`);
    expect(markup).toContain('Open Manager workspace');
    expect(markup).not.toContain('Actual task execution receipts');
    expect(markup).not.toContain('Actual assignments');
    expect(markup).not.toContain('Internal runtime receipt payload.');
    expect(markup).not.toContain('Internal specialist implementation brief.');
    expect(markup).not.toContain('Internal applicability diagnostic.');
    expect(markup).not.toContain('brief acknowledged at');
  });
  it('keeps workspace access when only persisted execution receipts identify the task', () => {
    const run = taskRun();
    run.task = null;
    expect(renderOffice(run)).toContain(`href="/manager/${taskId}"`);
  });
  it('does not invent a workspace link while the office is idle', () => {
    const run = taskRun();
    run.task = null;
    run.events = [];
    run.status = 'idle';
    const markup = renderOffice(run);
    expect(markup).toContain('<canvas');
    expect(markup).not.toContain('Open Manager workspace');
  });
});
