import { describe, expect, it } from 'vitest';
import { createApp, type AppDependencies } from '../src/api/app.ts';

describe.each(['/api/reports', '/api/tasks'])(
  'report routes at %s',
  (prefix) => {
    it('opens a report with an event URL in the same namespace', async () => {
      const link = {
        taskId: 'report-1',
        kind: 'scheduling',
        title: 'Work plan',
      };
      const app = createApp({
        snapshot: () => ({ items: [], locations: [], sources: [] }),
        manager: { frame: () => ({ kind: 'scheduling' }) },
        tasks: { start: () => link },
      } as unknown as AppDependencies);
      const response = await app.request(prefix, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'Plan outdoor work' }),
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        ...link,
        events: `${prefix}/report-1/events`,
      });
    });

    it('reads a saved report', async () => {
      const result = { taskId: 'report-1', state: 'completed' };
      const app = createApp({
        tasks: { exists: () => true, result: () => result },
      } as unknown as AppDependencies);
      const response = await app.request(`${prefix}/report-1`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(result);
    });
  },
);
