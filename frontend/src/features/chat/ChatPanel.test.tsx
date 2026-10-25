import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../dashboard/useAgentRun.ts';
import { ChatPanel } from './ChatPanel.tsx';

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
    cancellationPending: false,
    cancellationError: null,
    cancelTask: vi.fn(),
  };
}

describe('chat after crew demo retirement', () => {
  let saved: unknown[];
  beforeEach(() => {
    saved = [];
    vi.stubGlobal('localStorage', {
      getItem: (key: string) =>
        key === 'hazewatch.chat.v1' ? JSON.stringify(saved) : null,
      setItem: vi.fn(),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('offers the current evidence example without a crew-demo launch action', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatPanel, { run: idleRun(), prefill: null }),
    );
    expect(markup).toContain('Summarize the PM2.5 evidence available');
    expect(markup).not.toContain('Klang crew sample');
    expect(markup).not.toContain('Legacy scheduling demo');
  });

  it('retains saved legacy text and safely ignores retired structured payloads', () => {
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
    const markup = renderToStaticMarkup(
      createElement(ChatPanel, { run: idleRun(), prefill: null }),
    );
    expect(markup).toContain('Historical fictional comparison.');
    expect(markup).toContain(
      'Archived crew demo. Saved text is retained; structured scheduling',
    );
    expect(markup).not.toContain('AI model answer');
    expect(markup).not.toContain('Loading schedule');
  });

  it('keeps saved task access and explicit server cancellation after polling detaches', () => {
    const run = idleRun();
    run.status = 'cancelled';
    run.statusText =
      'Stopped waiting. Check the saved task for its server status.';
    run.task = {
      id: 'current',
      schemaVersion: 'haze.task.v2',
      taskUrl: '/api/tasks/current',
      status: 'running',
    };
    const markup = renderToStaticMarkup(
      createElement(ChatPanel, { run, prefill: null }),
    );
    expect(markup).toContain('Stopped waiting. Check the saved task');
    expect(markup).toContain('href="/api/tasks/current"');
    expect(markup).toContain('Cancel task');
    expect(markup).toContain('Saved task');
  });
});
