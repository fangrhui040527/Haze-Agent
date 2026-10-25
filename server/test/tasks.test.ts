import { describe, expect, it } from 'vitest';
import type { TaskEvent } from '../../frontend/src/shared/types/tasks.ts';
import { Manager } from '../src/manager/manager.ts';
import { Runtime } from '../src/runtime/runtime.ts';
import { composeTask } from '../src/tasks/compose.ts';
import { TaskService } from '../src/tasks/tasks.ts';
import { KLANG } from './helpers.ts';

const frame = (question: string) =>
  new Manager().frame({ question, focusItemId: null }, [KLANG]);

describe('task reports', () => {
  it('keeps the request, computes no schedule and lists what is missing', () => {
    const framing = frame('Plan the crew schedule for Klang tomorrow');
    const report = composeTask({
      kind: 'scheduling',
      framing,
      items: [],
      nearby: new Map(),
      refreshNote: null,
    });
    expect(report.title).toBe('Outdoor work schedule: Klang');
    expect(report.blocks).toContainEqual(
      expect.objectContaining({ type: 'quote', text: framing.objective.text }),
    );
    expect(JSON.stringify(report.blocks)).toContain('No schedule was computed');
    expect(report.gaps[0]).toContain('No haze records');
    expect(report.review.status).toBe('not_reviewed');
    expect(report.provenance.model).toBeNull();
  });

  it('does not claim the haze caused a revenue drop', () => {
    const report = composeTask({
      kind: 'revenue_recovery',
      framing: frame('How can my Klang shop recover revenue lost to the haze?'),
      items: [],
      nearby: new Map(),
      refreshNote: null,
    });
    const text = JSON.stringify(report.blocks);
    expect(text).toContain('Haze readings alone do not prove the cause');
    expect(text).toContain('No damage figure or recovery plan was computed');
  });

  it('streams steps and blocks, then the result', async () => {
    const manager = new Manager();
    const tasks = new TaskService({
      manager,
      runtime: new Runtime(),
      freshItems: () => [],
      readingsNear: () => [],
      refresh: async (_places, brief) => {
        expect(brief.objective.text).toBe('Plan the crew schedule for Klang');
        return null;
      },
    });
    const framing = frame('Plan the crew schedule for Klang');
    const link = tasks.start({ ...framing, kind: 'scheduling' });
    const events = await new Promise<TaskEvent[]>((resolve) => {
      const seen: TaskEvent[] = [];
      tasks.subscribe(link.taskId, (event) => {
        seen.push(event);
        if (event.type === 'result' || event.type === 'failed') resolve(seen);
      });
    });
    expect(events.map((e) => e.type)).toContain('block');
    expect(events.at(-1)?.type).toBe('result');
    expect(tasks.result(link.taskId)?.state).toBe('completed');
    expect(manager.assignments()[0]).toMatchObject({
      agent: 'hazeops',
      parentId: link.taskId,
      state: 'completed',
    });
  });
});
