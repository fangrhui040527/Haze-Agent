import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentRun, type AgentRun } from './useAgentRun.ts';
import { DashboardPage } from './DashboardPage.tsx';
import { fixtureTask, taskId } from '../../services/agents/testFixtures.ts';

vi.mock('./useAgentRun.ts', () => ({ useAgentRun: vi.fn() }));
vi.mock('../chat/ChatPanel.tsx', () => ({ ChatPanel: () => null }));
vi.mock('../live-table/LiveTable.tsx', () => ({ LiveTable: () => null }));
vi.mock('../agent-office/AgentOffice.tsx', () => ({ AgentOffice: () => null }));

const render = () =>
  renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(DashboardPage)),
  );

describe('dashboard Manager entry', () => {
  beforeEach(() => vi.mocked(useAgentRun).mockReset());

  it('provides a Manager page button before a task exists', () => {
    vi.mocked(useAgentRun).mockReturnValue({ task: null } as AgentRun);
    const markup = render();
    expect(markup).toContain('href="/manager"');
    expect(markup).toContain('Manager workspace');
    expect(markup).toContain('Damage appraisal');
  });

  it('opens the current task directly from the dashboard', () => {
    vi.mocked(useAgentRun).mockReturnValue({
      task: { id: taskId, record: fixtureTask() },
    } as AgentRun);
    expect(render()).toContain(`href="/manager/${taskId}"`);
  });
});
