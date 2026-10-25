import { describe, expect, it } from 'vitest';
import type { AgentTaskHandle } from '../../shared/types/agents.ts';
import {
  artifactId,
  fixtureTask,
  taskId,
} from '../../services/agents/testFixtures.ts';
import { acceptTaskReadback } from './taskReadback.ts';
function handle(): AgentTaskHandle {
  return {
    id: taskId,
    schemaVersion: 'haze.task.v3',
    taskUrl: `/api/tasks/${taskId}`,
    status: 'completed',
    record: fixtureTask(),
  };
}
describe('task readback races', () => {
  it('rejects delayed prior revisions after a correction', () => {
    const previous = handle();
    previous.record!.objective_revision = 2;
    expect(acceptTaskReadback(previous, handle())).toBe(false);
    const incoming = handle();
    incoming.record!.state_revision = 1;
    expect(acceptTaskReadback(handle(), incoming)).toBe(false);
  });
  it('accepts a linked run whose state revision restarts at one and excludes a late predecessor', () => {
    const previous = handle();
    previous.record!.state_revision = 50;
    const incoming = handle();
    incoming.record!.current_run_id = artifactId;
    incoming.record!.state_revision = 1;
    incoming.record!.runs.push({
      ...incoming.record!.runs[0],
      id: artifactId,
      predecessor_run_id: previous.record!.current_run_id,
    });
    expect(acceptTaskReadback(previous, incoming)).toBe(true);
    expect(acceptTaskReadback(incoming, previous)).toBe(false);
  });
});
