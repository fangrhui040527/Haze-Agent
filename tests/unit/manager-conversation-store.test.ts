import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { taskRequestSchema } from '../../app/contracts/tasks.js';
import { ConversationTurnStore } from '../../app/tasks/conversation-store.js';
import { TaskStore } from '../../app/tasks/store.js';

const identity = { principal: 'test-user', workspace: 'test-workspace' };
const turn = { conversation_id: 'conversation-1', turn_id: 'turn-1' };
const roots: string[] = [];
const stores: TaskStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) if (store.db.isOpen) store.close();
  for (const root of roots.splice(0)) {
    const path = resolve(root),
      rel = relative(resolve(tmpdir()), path);
    if (!rel || rel.startsWith('..') || path === resolve(tmpdir()))
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function open(root?: string) {
  const directory = root ?? mkdtempSync(join(tmpdir(), 'haze-chat-ledger-'));
  if (!root) roots.push(directory);
  const store = new TaskStore(directory);
  stores.push(store);
  return { store, ledger: new ConversationTurnStore(store), directory };
}
const request = () =>
  taskRequestSchema.parse({
    schema_version: 'haze.task.request.v3',
    objective: 'Investigate haze in Singapore.',
  });

it('binds turn contents and delivery keys independently of transport retries and owner identity', () => {
  const { ledger } = open();
  ledger.begin(turn, { message: 'hello' }, 'delivery-1', identity);
  ledger.begin(turn, { message: 'hello' }, 'delivery-2', identity);
  expect(() =>
    ledger.begin(turn, { message: 'changed' }, 'delivery-1', identity),
  ).toThrow(/different content/);
  expect(() =>
    ledger.begin({ ...turn, turn_id: 'turn-2' }, {}, 'delivery-2', identity),
  ).toThrow(/another conversation turn/);
  expect(
    ledger.read(turn, { ...identity, workspace: 'other' }),
  ).toBeUndefined();
  expect(() =>
    ledger.begin(turn, { message: 'other owner' }, 'delivery-1', {
      ...identity,
      workspace: 'other',
    }),
  ).not.toThrow();
});

it('persists the route decision before mutation and returns the exact admission receipt after restart', () => {
  const { ledger, store, directory } = open();
  ledger.begin(turn, { message: 'investigate' }, 'delivery-1', identity);
  ledger.resolve(turn, identity, { kind: 'start_task', request: request() });
  const response = ledger.finish(turn, identity, () => ({
    task_id: store.admit(request(), identity, 'admit-1', { mode: 'fixture' })
      .task.id,
  }));
  store.close();
  const reopened = open(directory);
  expect(
    JSON.parse(reopened.ledger.read(turn, identity)!.resolution!),
  ).toMatchObject({ kind: 'start_task' });
  expect(
    reopened.ledger.finish(turn, identity, () => {
      throw new Error('must not admit again');
    }),
  ).toEqual(response);
  expect(reopened.store.listTaskSummaries(identity).tasks).toHaveLength(1);
});

it('rolls admission back with response validation failure and runs dispatch only after commit', () => {
  const { ledger, store } = open();
  ledger.begin(turn, {}, 'delivery-1', identity);
  let dispatched = false;
  expect(() =>
    ledger.finish(turn, identity, () => {
      store.admit(request(), identity, 'admit-1', { mode: 'fixture' });
      store.afterCommit(() => {
        dispatched = true;
      });
      throw new Error('invalid response');
    }),
  ).toThrow('invalid response');
  expect(store.listTaskSummaries(identity).tasks).toHaveLength(0);
  expect(dispatched).toBe(false);
  expect(ledger.read(turn, identity)?.response).toBeNull();
  ledger.finish(turn, identity, () => {
    const task = store.admit(request(), identity, 'admit-1', {
      mode: 'fixture',
    }).task;
    store.afterCommit(() => {
      dispatched = true;
    });
    return { task_id: task.id };
  });
  expect(dispatched).toBe(true);
  expect(store.listTaskSummaries(identity).tasks).toHaveLength(1);
});
