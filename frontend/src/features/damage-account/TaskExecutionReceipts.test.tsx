import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskEvent } from '../../../../app/contracts/tasks.ts';
import { fixtureTask, receipt } from '../../services/agents/testFixtures.ts';
import { TaskExecutionReceipts } from './TaskExecutionReceipts.tsx';

function render(receipts: TaskEvent[]) {
  const record = fixtureTask();
  record.updated_at = '2026-10-25T00:01:05.250Z';
  record.usage = {
    model_calls: 3,
    tool_calls: 2,
    assignments: 1,
    artifacts: 2,
  };
  return renderToStaticMarkup(
    createElement(TaskExecutionReceipts, { record, receipts }),
  );
}

describe('task execution receipts', () => {
  it('shows saved wall-clock time, precise UTC timestamps and measured operation time', () => {
    const started = {
      ...receipt(12, 'model.attempt_charged', 'Manager'),
      at: '2026-10-25T00:00:01.000Z',
    };
    const completed = {
      ...receipt(15, 'model.attempt_completed', 'Manager'),
      at: '2026-10-25T00:00:03.345Z',
      data: { attempt_id: 'attempt-1', duration_ms: 2345, accepted: true },
    };
    const markup = render([completed, started]);
    expect(markup).toContain('1m 5s');
    expect(markup).toContain('Model calls</dt><dd>3</dd>');
    expect(markup).toContain('Tool calls</dt><dd>2</dd>');
    expect(markup).toContain('Assignments</dt><dd>1</dd>');
    expect(markup).toContain('dateTime="2026-10-25T00:00:03.345Z"');
    expect(markup).toContain('00:00:03.345 UTC');
    expect(markup).toContain('3.35 s');
    expect(markup).toContain('2.35 s');
    expect(markup).toContain('+2.35 s since previous');
    expect(markup.indexOf('model.attempt_charged')).toBeLessThan(
      markup.indexOf('model.attempt_completed'),
    );
    expect(markup).toContain('details for receipt 15');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('including queue and waiting time');
  });

  it('does not invent execution durations for historical receipts or intervals across runs', () => {
    const earlier = {
      ...receipt(1, 'task.created'),
      at: '2026-10-25T00:00:01Z',
    };
    const resumed = {
      ...receipt(2, 'task.continued'),
      run_id: 'another-run',
      at: '2026-10-25T00:00:04Z',
      data: { duration_ms: '3000' },
    };
    const markup = render([earlier, resumed]);
    expect(markup.match(/Not recorded/g)).toHaveLength(2);
    expect(markup).not.toContain('since previous');
    expect(markup).not.toContain('NaN');
  });

  it('keeps durable cursor order when the clock moves back and accepts a measured zero', () => {
    const earlier = {
      ...receipt(1, 'runtime.graph'),
      at: '2026-10-25T00:00:03Z',
      data: { duration_ms: 0 },
    };
    const later = {
      ...receipt(2, 'runtime.graph'),
      at: '2026-10-25T00:00:02Z',
      data: { duration_ms: -1 },
    };
    const markup = render([later, earlier]);
    expect(markup.indexOf('receipt 1')).toBeLessThan(
      markup.indexOf('receipt 2'),
    );
    expect(markup).toContain('0 ms');
    expect(markup).toContain('Not recorded');
    expect(markup).not.toContain('since previous');
  });

  it('shows an explicit empty state while keeping the saved task summary', () => {
    const markup = render([]);
    expect(markup).toContain('No execution receipts have been recorded yet.');
    expect(markup).toContain('1m 5s');
    expect(markup).not.toContain('<table');
  });
});
