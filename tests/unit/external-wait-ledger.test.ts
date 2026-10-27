import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GraphLedger,
  graphThreadId,
  type GraphAuthority,
} from '../../app/tasks/graph-ledger.js';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec(
    'CREATE TABLE events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,body TEXT NOT NULL)',
  );
  const ledger = new GraphLedger(
    db,
    (work) => work(),
    () => {},
  );
  const authority: GraphAuthority = {
    task_id: randomUUID(),
    run_id: randomUUID(),
    generation: 2,
    objective_revision: 3,
    assignment_id: randomUUID(),
    assignment_revision: 4,
  };
  ledger.register(authority.run_id);
  const target = graphThreadId('assignment', authority);
  const otherAuthority = { ...authority, assignment_id: randomUUID() };
  const other = graphThreadId('assignment', otherAuthority);
  const manager = graphThreadId('manager', authority);
  const managerAuthority = {
    task_id: authority.task_id,
    run_id: authority.run_id,
    generation: authority.generation,
    objective_revision: authority.objective_revision,
  };
  for (const [kind, thread_id, value] of [
    ['assignment', target, authority],
    ['assignment', other, otherAuthority],
    ['manager', manager, managerAuthority],
  ] as const)
    ledger.park({
      ...value,
      kind,
      thread_id,
      cursor: 0,
      after_cursor: 0,
      event_types: ['external_result', 'external_result_ready'],
    });
  function event(
    type: string,
    overrides: Record<string, unknown> = {},
    data: Record<string, unknown> = {},
  ) {
    const body = {
      ...authority,
      type,
      ...overrides,
      data: {
        recipient: authority.assignment_id,
        recipient_revision: authority.assignment_revision,
        ...data,
      },
    };
    const cursor = Number(
      db
        .prepare('INSERT INTO events(task_id,body) VALUES(?,?)')
        .run(authority.task_id, JSON.stringify(body)).lastInsertRowid,
    );
    ledger.wake(authority.task_id, cursor, type);
    return cursor;
  }
  return { db, ledger, authority, target, other, manager, event };
}

describe('targeted external readiness graph delivery', () => {
  it('retains terminal observations without waking execution, then coalesces ready events into one pending target job', () => {
    const f = fixture();
    f.event('external_result', {}, { retained_only: false });
    expect(f.ledger.pending()).toHaveLength(0);
    expect(f.ledger.wait(f.target)?.status).toBe('parked');
    const first = f.event('external_result_ready');
    const job = f.ledger.pending()[0]!;
    expect(job.thread_id).toBe(f.target);
    expect(f.ledger.wait(f.target)?.wake_cursor).toBe(first);
    const second = f.event('external_result_ready');
    f.ledger.wake(f.authority.task_id, second, 'external_result_ready');
    expect(f.ledger.pending()).toHaveLength(1);
    expect(f.ledger.pending()[0]!.id).toBe(job.id);
    expect(f.ledger.wait(f.target)?.wake_cursor).toBe(second);
    expect(f.ledger.wait(f.other)?.status).toBe('parked');
    expect(f.ledger.wait(f.manager)?.status).toBe('parked');
  });
  it('rejects a ready event addressed to another generation, revision, objective, run or assignment', () => {
    const f = fixture();
    f.event('external_result_ready', { generation: 1 });
    f.event('external_result_ready', { objective_revision: 2 });
    f.event('external_result_ready', { run_id: randomUUID() });
    f.event('external_result_ready', {}, { recipient_revision: 3 });
    f.event('external_result_ready', {}, { recipient_revision: undefined });
    f.event('external_result_ready', {}, { recipient: randomUUID() });
    f.event('external_result_ready', {}, { retained_only: true });
    expect(f.ledger.pending()).toHaveLength(0);
    expect(f.ledger.wait(f.target)?.status).toBe('parked');
    expect(f.ledger.wait(f.other)?.status).toBe('parked');
    expect(f.ledger.wait(f.manager)?.status).toBe('parked');
    f.event('external_result_ready');
    expect(f.ledger.pending().map((job) => job.thread_id)).toEqual([f.target]);
  });
  it('keeps only one pending wake while its target thread is executing and preserves serialized delivery', () => {
    const f = fixture();
    f.event('external_result_ready');
    const running = f.ledger.claim('first-owner')!;
    expect(running.thread_id).toBe(f.target);
    f.event('external_result_ready');
    f.event('external_result_ready');
    expect(
      f.ledger.pending().filter((job) => job.status === 'running'),
    ).toHaveLength(1);
    expect(
      f.ledger.pending().filter((job) => job.status === 'pending'),
    ).toHaveLength(1);
    expect(f.ledger.claim('second-owner')).toBeUndefined();
    f.ledger.finish(running.id);
    expect(f.ledger.claim('second-owner')?.thread_id).toBe(f.target);
    expect(f.ledger.claim('third-owner')).toBeUndefined();
  });
});
