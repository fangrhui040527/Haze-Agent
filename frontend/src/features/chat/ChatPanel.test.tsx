import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../dashboard/useAgentRun.ts';
import { fixtureTask } from '../../services/agents/testFixtures.ts';
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
      'Explain the main conclusions in my attached sources',
    );
    expect(markup).toContain('Attach source material');
    expect(markup).toContain('Optional task scope');
    expect(markup).not.toContain('Klang crew sample');
    expect(markup).not.toContain('Legacy scheduling demo');
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

  it('keeps saved task access and explicit server cancellation after polling detaches', () => {
    const run = idleRun();
    run.status = 'cancelled';
    run.statusText =
      'Stopped waiting. Check the saved task for its server status.';
    run.task = {
      id: 'current',
      schemaVersion: 'haze.task.v3',
      record: { ...fixtureTask(), status: 'running' },
      taskUrl: '/api/tasks/current',
      status: 'running',
    };
    const markup = renderChat(run);
    expect(markup).toContain('Stopped waiting. Check the saved task');
    expect(markup).toContain('href="/api/tasks/current"');
    expect(markup).toContain('Cancel task');
    expect(markup).toContain('Pause task');
    expect(markup).toContain('Saved task');
    expect(markup).toContain('href="/task/current"');
    expect(markup).toContain('Open task report');
  });
});
