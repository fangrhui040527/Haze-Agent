import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../dashboard/useAgentRun.ts';
import {
  at,
  fixtureManager,
  fixtureTask,
  runId,
  taskId,
} from '../../services/agents/testFixtures.ts';
import { ChatPanel } from './ChatPanel.tsx';

function renderChat(run = idleRun()) {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(ChatPanel, { run, prefill: null }),
    ),
  );
}

function idleRun(): AgentRun {
  return {
    events: [],
    status: 'idle',
    statusText: 'Agents are idle. Ask a question to start.',
    startedAt: null,
    serviceLabel: 'Evidence task API',
    ask: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
    task: null,
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

describe('chat after crew demo retirement', () => {
  let saved: unknown[];
  let storageKey: string;
  beforeEach(() => {
    saved = [];
    storageKey = 'haze.chat.v1';
    vi.stubGlobal('localStorage', {
      getItem: (key: string) =>
        key === storageKey ? JSON.stringify(saved) : null,
      setItem: vi.fn(),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('offers the current evidence example without a crew-demo launch action', () => {
    const markup = renderChat();
    expect(markup).toContain(
      'Explain the difference between modeled PM2.5 estimates and sensor observations.',
    );
    expect(markup).not.toContain(
      'Explain the main conclusions from the available evidence',
    );
    expect(markup).not.toContain('Klang crew sample');
    expect(markup).not.toContain('Legacy scheduling demo');
  });
  it('keeps next-task permissions and lifecycle controls out of chat', () => {
    const markup = renderChat();
    expect(markup).not.toContain('Nightshift');
    expect(markup).not.toContain('type="checkbox"');
    expect(markup).not.toContain('Cancel task');
    expect(markup).not.toContain('Pause task');
  });

  it('retains saved legacy text and safely ignores retired structured payloads', () => {
    storageKey = 'hazewatch.chat.v1';
    saved = [
      {
        id: 'old',
        role: 'agents',
        at: '2026-10-24T00:00:00Z',
        state: 'done',
        paragraphs: ['Historical fictional comparison.'],
        source: 'model',
        scheduling: { invalid: 'old contract' },
        agentExecution: 'old receipt shape',
      },
    ];
    const markup = renderChat();
    expect(markup).toContain('Historical fictional comparison.');
    expect(markup).toContain(
      'Archived crew demo. Saved text is retained; structured scheduling',
    );
    expect(markup).not.toContain('AI model answer');
    expect(markup).not.toContain('Loading schedule');
  });

  it('retains a known stale label in browser history after another task is selected', () => {
    saved = [
      {
        id: 'historical',
        role: 'agents',
        at: '2026-10-25T00:00:00Z',
        state: 'done',
        stale: true,
        paragraphs: ['Earlier answer.'],
        evidence: {
          taskUrl: '/api/tasks/earlier',
          result: fixtureTask().result,
        },
      },
    ];
    const markup = renderChat();
    expect(markup).toContain('Stale result');
    expect(markup).toContain('Currency: stale');
  });

  it('keeps a saved dashboard report link and labels its template source', () => {
    saved = [
      {
        id: 'report-answer',
        role: 'agents',
        at: '2026-10-25T00:00:00Z',
        state: 'done',
        source: 'template',
        paragraphs: ['Report opened.'],
        task: {
          taskId: 'report-1',
          title: 'Outdoor work plan',
          kind: 'scheduling',
        },
      },
    ];
    const markup = renderChat();
    expect(markup).toContain('href="/report/report-1"');
    expect(markup).toContain('Template answer from real records');
  });

  it('shows a compact workspace card while a task runs', () => {
    const run = idleRun();
    run.status = 'cancelled';
    run.statusText =
      'Stopped waiting. Check the saved task for its server status.';
    run.task = {
      id: taskId,
      schemaVersion: 'haze.task.v3',
      record: {
        ...fixtureTask(),
        status: 'running',
        manager: fixtureManager(),
      },
      taskUrl: '/api/tasks/current',
      status: 'running',
    };
    const markup = renderChat(run);
    expect(markup).toContain('Open the result');
    expect(markup).toContain(`href="/task/${taskId}"`);
    expect(markup).not.toContain('Cancel task');
    expect(markup).not.toContain('Pause task');
    expect(markup).not.toContain('Stop waiting');
    expect(markup).not.toContain('Open task report');
    expect(markup).not.toContain('Correct or clarify this task');
    expect(markup).not.toContain('Attach source material');
    expect(markup).not.toContain('Paste a source instead');
    expect(markup).not.toContain('Optional task scope');
    expect(markup).not.toContain('id="manager-workspace-title"');
    expect(markup).not.toContain('Interpreted objective');
    expect(markup).not.toContain(
      'Describe what you need to understand or investigate.',
    );
    expect(markup).not.toContain(
      'Explain the difference between modeled PM2.5 estimates',
    );
  });

  it('shows a restored completed task without welcome prompts and lets it be cleared', () => {
    const run = idleRun();
    run.status = 'completed';
    run.statusText = 'Answer ready.';
    run.task = {
      id: 'current',
      schemaVersion: 'haze.task.v3',
      record: fixtureTask(),
      taskUrl: '/api/tasks/current',
      status: 'completed',
    };
    const markup = renderChat(run);
    expect(markup).toContain(
      'Completed. The result is available in the Manager workspace.',
    );
    expect(markup).not.toContain(run.task.record!.result!.answer);
    expect(markup).toContain('Clear chat');
    expect(markup).not.toContain(
      'Describe what you need to understand or investigate.',
    );
    expect(markup).not.toContain(
      'Explain the difference between modeled PM2.5 estimates',
    );
  });
  it('shows the fresh conversation after Clear even if the dashboard retains a restored task', () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) =>
        key === 'haze.chat.detached-task-restore.v1'
          ? 'false'
          : key === 'haze.chat.v1'
            ? '[]'
            : null,
      setItem: vi.fn(),
    });
    const run = idleRun();
    run.status = 'completed';
    run.task = {
      id: taskId,
      schemaVersion: 'haze.task.v3',
      taskUrl: `/api/tasks/${taskId}`,
      status: 'completed',
      record: fixtureTask(),
    };
    const markup = renderChat(run);
    expect(markup).toContain('Latest haze information for Singapore');
    expect(markup).not.toContain('Open the result');
    expect(markup).not.toContain('The task is complete');
    expect(markup).not.toContain('Clear chat');
  });

  it('shows task questions as Manager messages answerable in chat', () => {
    const run = idleRun();
    const record = fixtureTask();
    record.status = 'waiting';
    delete record.result;
    record.questions = [
      {
        id: taskId,
        task_id: taskId,
        run_id: runId,
        objective_revision: 1,
        question: 'Which evidence or source should I analyze?',
        kind: 'human',
        status: 'open',
        created_at: at,
      },
    ];
    run.status = 'waiting';
    run.task = {
      id: taskId,
      schemaVersion: 'haze.task.v3',
      record,
      taskUrl: `/api/tasks/${taskId}`,
      status: 'waiting',
    };
    const markup = renderChat(run);
    expect(markup).toContain('Which evidence or source should I analyze?');
    expect(markup).toContain('Answer this question');
    expect(markup).toContain(`href="/task/${taskId}"`);
    expect(markup).not.toContain('Clarification needed');
    expect(markup).not.toContain('Answer in task report');
    expect(markup).not.toContain('Result: full');
    expect(markup).not.toContain('Correct or clarify this task');
  });
});
