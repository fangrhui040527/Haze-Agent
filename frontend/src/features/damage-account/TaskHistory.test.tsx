import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { TaskSummary } from '../../services/agents/AgentService.ts';
import { fixtureTask } from '../../services/agents/testFixtures.ts';
import { TaskHistoryView } from './TaskHistory.tsx';

const record = fixtureTask();
const savedTask: TaskSummary = {
  id: record.id,
  objective: 'Build a damage account for Klang in September.',
  status: 'completed',
  current_run_id: record.current_run_id,
  updated_at: record.updated_at,
  usage: record.usage,
};

function render(props: Partial<ComponentProps<typeof TaskHistoryView>> = {}) {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(TaskHistoryView, {
        tasks: [],
        pending: false,
        error: null,
        onRefresh: vi.fn(),
        onLoadMore: vi.fn(),
        ...props,
      }),
    ),
  );
}

describe('saved task history', () => {
  it('shows saved task objectives, statuses and dates with report links', () => {
    const markup = render({
      tasks: [
        savedTask,
        { ...savedTask, id: 'older-task', status: 'timed_out' },
      ],
      currentTaskId: savedTask.id,
      nextCursor: 'older-page',
    });
    expect(markup).toContain('Task history');
    expect(markup).toContain(savedTask.objective);
    expect(markup).toContain(`href="/task/${savedTask.id}"`);
    expect(markup).toContain('href="/task/older-task"');
    expect(markup).toContain('completed');
    expect(markup).toContain('timed out');
    expect(markup).toContain(`dateTime="${savedTask.updated_at}"`);
    expect(markup.match(/Current task/g)).toHaveLength(1);
    expect(markup).toContain('Load more tasks');
    expect(markup).not.toContain('Paste a saved task ID');
  });

  it('escapes task titles and encodes task identities in report URLs', () => {
    const markup = render({
      tasks: [
        { ...savedTask, id: 'task /?#', objective: '<script>unsafe</script>' },
      ],
    });
    expect(markup).toContain('href="/task/task%20%2F%3F%23"');
    expect(markup).toContain('&lt;script&gt;unsafe&lt;/script&gt;');
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('Load more tasks');
  });

  it('distinguishes an empty history from loading and unavailable history', () => {
    expect(render()).toContain('No saved tasks yet.');
    const loading = render({ pending: true });
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('role="status">Loading saved tasks...');
    expect(loading).not.toContain('No saved tasks yet.');
    expect(loading).toMatch(/<button[^>]*disabled=""[^>]*>Refresh/);
    const unavailable = render({
      error: 'The saved tasks could not be read (503).',
    });
    expect(unavailable).toContain(
      'role="alert">The saved tasks could not be read (503).',
    );
    expect(unavailable).toContain('Try again');
    expect(unavailable).not.toContain('No saved tasks yet.');
  });

  it('keeps loaded tasks available during pagination and refresh failures', () => {
    const pending = render({
      tasks: [savedTask],
      pending: true,
      nextCursor: 'older-page',
    });
    expect(pending).toContain(`href="/task/${savedTask.id}"`);
    expect(pending).toMatch(/<button[^>]*disabled=""[^>]*>Load more tasks/);
    const failed = render({
      tasks: [savedTask],
      error: 'Connection interrupted.',
    });
    expect(failed).toContain(`href="/task/${savedTask.id}"`);
    expect(failed).toContain('Try again');
    expect(failed).not.toContain('No saved tasks yet.');
  });
});
