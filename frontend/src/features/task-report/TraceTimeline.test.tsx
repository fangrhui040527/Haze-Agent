import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TracePage } from '../../../../app/contracts/trace-export.ts';
import type { AgentService } from '../../services/agents/AgentService.ts';
import {
  fixtureTask,
  taskId,
  runId,
} from '../../services/agents/testFixtures.ts';
import { HttpAgentService } from '../../services/agents/HttpAgentService.ts';
import { readTracePage, TraceTimeline } from './TraceTimeline.tsx';

function page(): TracePage {
  return {
    schema_version: 'haze.trace.page.v1',
    task_id: taskId,
    run_id: runId,
    records: [],
    next_cursor: 0,
    has_more: false,
    snapshot_cursor: 0,
    active_snapshot: false,
    completeness: { native: 0, reconstructed: 0, omissions: [] },
  };
}
const service = (readTrace: AgentService['readTrace']) => ({
  label: 'fixture',
  ask: vi.fn(),
  readTrace,
});
describe('execution trace report', () => {
  it('renders run selection and downloads without changing the current result', () => {
    const record = fixtureTask();
    record.runs.push({ ...record.runs[0], id: taskId });
    const markup = renderToStaticMarkup(
      createElement(TraceTimeline, {
        record,
        service: new HttpAgentService('/haze/'),
      }),
    );
    expect(markup).toContain('Trace run');
    expect(markup).toContain(`${runId} (current)`);
    expect(markup).toContain(`${taskId} (historical)`);
    expect(markup).toContain(
      `/haze/api/tasks/${taskId}/runs/${runId}/trace?format=jsonl`,
    );
    expect(markup).toContain(
      `/haze/api/tasks/${taskId}/runs/${runId}/evidence-bundle`,
    );
  });
  it('shows an unavailable state for services without trace support', () => {
    const markup = renderToStaticMarkup(
      createElement(TraceTimeline, {
        record: fixtureTask(),
        service: service(undefined),
      }),
    );
    expect(markup).toContain(
      'Execution trace is unavailable in this task service.',
    );
    expect(markup).not.toContain('Download JSONL');
  });
  it('discards a stale selection response even if its transport ignores abort', async () => {
    let finish!: (value: TracePage) => void;
    const controller = new AbortController();
    const pending = readTracePage(
      service(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
      taskId,
      runId,
      0,
      controller.signal,
    );
    controller.abort();
    finish(page());
    await expect(pending).resolves.toBeNull();
  });
  it('rejects mismatched run identities and stalled cursors', async () => {
    await expect(
      readTracePage(
        service(async () => ({ ...page(), run_id: taskId })),
        taskId,
        runId,
        0,
        new AbortController().signal,
      ),
    ).rejects.toThrow('selected task and run');
    await expect(
      readTracePage(
        service(async () => ({ ...page(), has_more: true })),
        taskId,
        runId,
        0,
        new AbortController().signal,
      ),
    ).rejects.toThrow('advance its cursor');
  });
  it('loads and validates trace pages through the selected HTTP run URL', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(page()), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(
      new HttpAgentService('', fetcher).readTrace(taskId, runId),
    ).resolves.toEqual(page());
    expect(fetcher.mock.calls[0][0]).toBe(
      `/api/tasks/${taskId}/runs/${runId}/trace?after=0&limit=100`,
    );
    fetcher.mockResolvedValue(
      new Response(JSON.stringify({ ...page(), task_id: runId }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(
      new HttpAgentService('', fetcher).readTrace(taskId, runId),
    ).rejects.toThrow('selected task and run');
  });
});
