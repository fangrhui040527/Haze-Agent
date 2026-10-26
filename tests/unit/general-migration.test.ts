import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  taskRequestSchema,
  type TaskRecord,
} from '../../app/contracts/tasks.js';
import { TaskStore, STORAGE_MARKER } from '../../app/tasks/store.js';
import { migrateGeneralState } from '../../app/tasks/migrate.js';
import {
  graphThreadId,
  type GraphAuthority,
} from '../../app/tasks/graph-ledger.js';

const identity = { principal: 'migration-test', workspace: 'local' };
const roots: string[] = [],
  stores: TaskStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) if (store.db.isOpen) store.close();
  for (const root of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (!rel || rel.startsWith('..')) throw new Error('Unsafe cleanup path');
    rmSync(root, { recursive: true, force: true });
  }
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'haze-graph-migrate-'));
  roots.push(root);
  const source = join(root, 'source'),
    target = join(root, 'target');
  const store = new TaskStore(source);
  stores.push(store);
  const task = store.admit(
    taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Preserve a research result.',
    }),
    identity,
    randomUUID(),
    { mode: 'fixture' },
  ).task;
  return { root, source, target, store, task };
}
const expected = (task: TaskRecord) => ({
  expected_objective_revision: task.objective_revision,
  expected_run_id: task.current_run_id,
  expected_generation: task.generation,
  expected_state_revision: task.state_revision,
});
function pause(store: TaskStore, id: string) {
  const task = store.read(id, identity);
  store.control(id, identity, randomUUID(), {
    schema_version: 'haze.task.control.v3',
    action: 'pause',
    ...expected(task),
  });
}
function legacy(source: string, store: TaskStore) {
  // Construct a fixture with only the original application's tables and marker.
  store.db.exec(
    'DELETE FROM run_execution; DELETE FROM graph_jobs; DELETE FROM graph_waits;',
  );
  store.close();
  writeFileSync(
    join(source, STORAGE_MARKER),
    JSON.stringify({ format: 'haze.general.sqlite.v1', schema_version: 1 }),
  );
}
const digest = (file: string) =>
  createHash('sha256').update(readFileSync(file)).digest('hex');
const authority = (task: TaskRecord): GraphAuthority => ({
  task_id: task.id,
  run_id: task.current_run_id,
  generation: task.generation,
  objective_revision: task.objective_revision,
});

describe('explicit v1 migration', () => {
  it('preserves historical bytes, receipts and checkpoints, gates legacy execution, and admits exactly one explicit successor', async () => {
    const { source, target, store, task } = setup();
    const imported = store.importArtifact(
      {
        schema_version: 'haze.artifact.import.v3',
        filename: 'history.txt',
        media_type: 'text/plain',
        content_base64: Buffer.from('immutable historical research').toString(
          'base64',
        ),
      },
      identity,
      'import',
    );
    store.saveCheckpoint(task.id, task.current_run_id, task.generation, {
      old_reference: 'preserved',
    });
    const assignment = store.createAssignments(
      task.id,
      task.current_run_id,
      task.objective_revision,
      [
        {
          role: 'HazeOps',
          definition_id: 'test.preserved',
          capability: 'test',
          definition_version: '3',
          brief: 'Preserved unfinished assignment.',
        },
      ],
    )[0]!;
    const completed = store.admit(
      taskRequestSchema.parse({
        schema_version: 'haze.task.request.v3',
        objective: 'A completed historical answer.',
      }),
      identity,
      'completed',
    ).task;
    const completedResult = store.saveResult(
      completed.id,
      completed.current_run_id,
      completed.generation,
      {
        schema_version: 'haze.task.result.v3',
        answer: 'Preserved completed answer.',
        completion: 'full',
        work_products: [],
        sources: [],
        covered_scope: {},
        uncertainty: [],
        review: {
          status: 'not_required',
          scope: 'No scientific claims.',
          limitations: [],
        },
        currency: 'current',
        next_requirements: [],
        provenance: {
          mode: 'live',
          model_calls: 0,
          tool_calls: 0,
          capabilities: [],
          receipts: [],
        },
      },
    ).result;
    pause(store, task.id);
    const priorArtifacts = store.db.prepare('SELECT body FROM artifacts').all();
    const priorReceipts = store.db.prepare('SELECT * FROM operations').all();
    legacy(source, store);
    const before = digest(join(source, 'tasks.sqlite'));
    const report = await migrateGeneralState({
      sourceDirectory: source,
      targetDirectory: target,
    });
    expect(report.source_unchanged).toBe(true);
    expect(report.automatic_continuations).toBe(0);
    expect(digest(join(source, 'tasks.sqlite'))).toBe(before);
    expect(digest(join(report.rollback_snapshot, 'tasks.sqlite'))).toBe(before);
    const upgraded = new TaskStore(target);
    stores.push(upgraded);
    expect(upgraded.db.prepare('SELECT body FROM artifacts').all()).toEqual(
      priorArtifacts,
    );
    expect(upgraded.db.prepare('SELECT * FROM operations').all()).toEqual(
      priorReceipts,
    );
    expect(upgraded.checkpoint(task.current_run_id)).toBeUndefined();
    expect(
      upgraded.db.prepare('SELECT body FROM legacy_checkpoint_archive').all(),
    ).toHaveLength(1);
    expect(upgraded.artifact(imported.artifact.id, identity).sha256).toBe(
      imported.artifact.sha256,
    );
    const legacyTask = upgraded.read(task.id, identity);
    expect(legacyTask.manager?.upgrade_required).toContain('legacy');
    expect(upgraded.listRecoverableTasks()).toEqual([]);
    expect(upgraded.read(completed.id, identity).result).toEqual(
      completedResult,
    );
    expect(upgraded.executionVersion(completed.current_run_id)?.engine).toBe(
      'legacy',
    );
    expect(() => upgraded.acquireAssignment(task.id, assignment.id)).toThrow(
      /Legacy execution/,
    );
    expect(() =>
      upgraded.control(task.id, identity, 'resume', {
        schema_version: 'haze.task.control.v3',
        action: 'resume',
        ...expected(legacyTask),
      }),
    ).toThrow(/Legacy execution/);
    expect(() =>
      upgraded.update(task.id, identity, 'update', {
        schema_version: 'haze.task.update.v3',
        kind: 'correction',
        passage: 'New scope',
        ...expected(legacyTask),
      }),
    ).toThrow(/Legacy execution/);
    const continuation = {
      schema_version: 'haze.task.control.v3' as const,
      action: 'continue' as const,
      ...expected(legacyTask),
    };
    const first = upgraded.control(
      task.id,
      identity,
      'continue-once',
      continuation,
    );
    expect(
      upgraded.control(task.id, identity, 'continue-once', continuation),
    ).toEqual(first);
    const successor = upgraded.read(task.id, identity);
    expect(successor.runs).toHaveLength(2);
    expect(
      successor.runs.find((run) => run.id === successor.current_run_id)
        ?.predecessor_run_id,
    ).toBe(task.current_run_id);
    expect(upgraded.executionVersion(successor.current_run_id)?.engine).toBe(
      'langgraph',
    );
  });
  it('rejects active sources, incompatible markers and nested targets without altering the source', async () => {
    const { source, target, store } = setup();
    legacy(source, store);
    const before = digest(join(source, 'tasks.sqlite'));
    await expect(
      migrateGeneralState({ sourceDirectory: source, targetDirectory: target }),
    ).rejects.toThrow(/pause or finish/);
    expect(digest(join(source, 'tasks.sqlite'))).toBe(before);
    expect(() => new TaskStore(target)).toThrow(/migration is incomplete/);
    await expect(
      migrateGeneralState({
        sourceDirectory: source,
        targetDirectory: join(source, 'nested'),
      }),
    ).rejects.toThrow(/outside/);
    writeFileSync(
      join(source, STORAGE_MARKER),
      JSON.stringify({ format: 'unrelated' }),
    );
    await expect(
      migrateGeneralState({
        sourceDirectory: source,
        targetDirectory: `${target}-other`,
      }),
    ).rejects.toThrow(/Only haze/);
  });
  it('requires the owner to close and leaves the rollback snapshot readable with the v1 schema', async () => {
    const { root, source, target, store, task } = setup();
    pause(store, task.id);
    legacy(source, store);
    writeFileSync(join(source, 'runtime-owner.lock'), 'test-owner');
    await expect(
      migrateGeneralState({ sourceDirectory: source, targetDirectory: target }),
    ).rejects.toThrow(/Close the runtime owner/);
    rmSync(join(source, 'runtime-owner.lock'));
    const report = await migrateGeneralState({
      sourceDirectory: source,
      targetDirectory: target,
    });
    const rollback = join(root, 'rollback');
    mkdirSync(rollback);
    copyFileSync(
      join(report.rollback_snapshot, 'tasks.sqlite'),
      join(rollback, 'tasks.sqlite'),
    );
    copyFileSync(
      join(report.rollback_snapshot, STORAGE_MARKER),
      join(rollback, STORAGE_MARKER),
    );
    expect(
      JSON.parse(readFileSync(join(rollback, STORAGE_MARKER), 'utf8')),
    ).toEqual({ format: 'haze.general.sqlite.v1', schema_version: 1 });
    const oldReader = new DatabaseSync(join(rollback, 'tasks.sqlite'), {
      readOnly: true,
    });
    try {
      expect(
        (
          oldReader.prepare('PRAGMA integrity_check').get() as {
            integrity_check: string;
          }
        ).integrity_check,
      ).toBe('ok');
      expect(
        oldReader.prepare('SELECT id FROM tasks WHERE id=?').get(task.id),
      ).toBeDefined();
    } finally {
      oldReader.close();
    }
    expect(existsSync(join(target, 'migration-report.json'))).toBe(true);
  });
});

describe('graph delivery and operation ledger', () => {
  it('commits local effects and receipts atomically and reuses accepted results after recovery', () => {
    const { store, task, source } = setup();
    const scope = authority(task);
    const effect = () =>
      store.appendEvent(task.id, 'test_effect', 'Runtime', 'exactly once')
        .cursor;
    const result = store.graph.localEffect('stable-step', {}, scope, effect);
    expect(store.graph.localEffect('stable-step', {}, scope, effect)).toBe(
      result,
    );
    expect(() =>
      store.graph.localEffect('rolled-back', {}, scope, () => {
        effect();
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(
      store
        .events(task.id, identity)
        .events.filter((event) => event.type === 'test_effect'),
    ).toHaveLength(1);
    store.close();
    const reopened = new TaskStore(source);
    stores.push(reopened);
    const current = reopened.read(task.id, identity);
    expect(
      reopened.graph.localEffect('stable-step', {}, authority(current), () => {
        throw new Error('must not execute');
      }),
    ).toBe(result);
  });
  it('deduplicates reordered wakeups and rechecks events committed before parking', () => {
    const { store, task } = setup();
    const scope = authority(task),
      thread_id = graphThreadId('manager', scope);
    const first = store.appendEvent(
      task.id,
      'peer_message',
      'Runtime',
      'before parking',
    );
    store.graph.park({
      ...scope,
      thread_id,
      kind: 'manager',
      cursor: 0,
      after_cursor: first.cursor - 1,
      event_types: ['peer_message'],
    });
    store.graph.wake(task.id, first.cursor, 'peer_message');
    store.graph.wake(task.id, first.cursor - 1, 'peer_message');
    expect(store.graph.wait(thread_id)?.status).toBe('ready');
    expect(
      store.graph.pending().filter((job) => job.cursor === first.cursor),
    ).toHaveLength(1);
    const claimed = store.graph.claim('owner');
    expect(claimed).toBeDefined();
    expect(store.graph.claim('owner')).toBeUndefined();
    store.graph.finish(claimed!.id);
    expect(store.graph.claim('owner')).toBeDefined();
  });
  it('refuses unknown remote replay until explicit Resume and validates topology and thread identity', () => {
    const { store, task } = setup();
    const scope = authority(task);
    const operation = store.graph.prepare('remote-call', {}, scope, 'model');
    store.graph.dispatch(operation.id, scope.generation, 'first-attempt');
    pause(store, task.id);
    expect(store.graph.operation(operation.id).status).toBe('unknown');
    const paused = store.read(task.id, identity);
    store.control(task.id, identity, 'resume-explicit', {
      schema_version: 'haze.task.control.v3',
      action: 'resume',
      ...expected(paused),
    });
    const current = authority(store.read(task.id, identity));
    const replacement = store.graph.prepare(
      'remote-call',
      {},
      current,
      'model',
    );
    expect(replacement.id).toBe(operation.id);
    store.graph.dispatch(
      replacement.id,
      current.generation,
      'replacement-attempt',
    );
    store.graph.complete(replacement.id, current.generation, {
      response: 'accepted',
    });
    expect(
      store.db
        .prepare('SELECT * FROM graph_operation_attempts WHERE operation_id=?')
        .all(operation.id),
    ).toHaveLength(2);
    expect(() =>
      store.graph.enqueue({
        ...current,
        thread_id: 'caller-chosen-namespace',
        kind: 'manager',
        cursor: 50,
      }),
    ).toThrow(/thread identity/);
    const version = store.executionVersion(current.run_id)!;
    store.db
      .prepare('UPDATE run_execution SET body=? WHERE run_id=?')
      .run(
        JSON.stringify({ ...version, manager_topology: 'manager.v999' }),
        current.run_id,
      );
    expect(() => store.assertGraphExecution(current.run_id)).toThrow(
      /topology/,
    );
  });
  it('retains deferred deliveries and wakes only the intended peer revision', () => {
    const { store, task } = setup();
    const managerJob = store.graph.claim('owner')!;
    store.graph.retry(managerJob.id);
    expect(store.graph.claim('owner')?.id).toBe(managerJob.id);
    store.graph.finish(managerJob.id);
    const scope = {
      ...authority(task),
      assignment_id: randomUUID(),
      assignment_revision: 2,
    };
    const thread_id = graphThreadId('assignment', scope);
    const cursor = store.events(task.id, identity).next_cursor;
    store.graph.park({
      ...scope,
      thread_id,
      kind: 'assignment',
      cursor,
      after_cursor: cursor,
      event_types: ['peer_message_sent'],
    });
    store.appendEvent(
      task.id,
      'peer_message_sent',
      'Runtime',
      'Other recipient',
      { recipient: randomUUID(), recipient_revision: 2 },
    );
    store.appendEvent(task.id, 'peer_message_sent', 'Runtime', 'Old revision', {
      recipient: scope.assignment_id,
      recipient_revision: 1,
    });
    expect(store.graph.wait(thread_id)?.status).toBe('parked');
    store.appendEvent(
      task.id,
      'peer_message_sent',
      'Runtime',
      'Matching peer',
      { recipient: scope.assignment_id, recipient_revision: 2 },
    );
    expect(store.graph.wait(thread_id)?.status).toBe('ready');
    expect(
      store.graph.latestAssignmentWait(
        task.current_run_id,
        scope.assignment_id,
        2,
      )?.thread_id,
    ).toBe(thread_id);
    expect(store.graph.pending()).toHaveLength(1);
  });
  it('rebinds parked waits after restart without activating them and fences human and paused Manager waits', () => {
    const { store, task, source } = setup();
    const manager = store.ensureManager(task.id, task.current_run_id, {
      role: 'Manager',
      definition_id: 'core.manager.coordinator',
      capability: 'core.manager',
      definition_version: '4',
      brief: 'Coordinate the work.',
    });
    store.acquireAssignment(task.id, manager.id);
    const specialist = store.createAssignments(
      task.id,
      task.current_run_id,
      task.objective_revision,
      [
        {
          role: 'HazeOps',
          definition_id: 'test.peer',
          capability: 'test',
          definition_version: '3',
          brief: 'Wait for a peer.',
        },
      ],
    )[0]!;
    store.acquireAssignment(task.id, specialist.id);
    store.completeAssignment(task.id, specialist.id, task.generation, {
      status: 'waiting',
    });
    store.waitForManagerEvent(
      task.id,
      {
        run_id: task.current_run_id,
        generation: task.generation,
        objective_revision: task.objective_revision,
        plan_revision: 0,
      },
      'All work is waiting.',
    );
    const scope = authority(task),
      peerScope = {
        ...scope,
        assignment_id: specialist.id,
        assignment_revision: specialist.revision,
      };
    const originalManagerThread = graphThreadId('manager', scope),
      originalPeerThread = graphThreadId('assignment', peerScope);
    const cursor = store.events(task.id, identity).next_cursor;
    store.graph.park({
      ...scope,
      thread_id: originalManagerThread,
      kind: 'manager',
      cursor,
      after_cursor: cursor,
      event_types: ['peer_message_sent'],
    });
    store.graph.park({
      ...peerScope,
      thread_id: originalPeerThread,
      kind: 'assignment',
      cursor,
      after_cursor: cursor,
      event_types: ['peer_message_sent'],
    });
    store.close();
    const reopened = new TaskStore(source);
    stores.push(reopened);
    const recovered = reopened.read(task.id, identity),
      currentScope = authority(recovered);
    expect(recovered.status).toBe('waiting');
    expect(reopened.graph.pending()).toHaveLength(0);
    const managerThread = graphThreadId('manager', currentScope),
      peerThread = graphThreadId('assignment', {
        ...currentScope,
        assignment_id: specialist.id,
        assignment_revision: specialist.revision,
      });
    expect(reopened.graph.wait(managerThread)?.payload).toEqual({
      source_thread_id: originalManagerThread,
    });
    expect(
      reopened.graph.latestAssignmentWait(
        task.current_run_id,
        specialist.id,
        specialist.revision,
      )?.payload,
    ).toEqual({ source_thread_id: originalPeerThread });
    expect(reopened.graph.wait(originalPeerThread)?.status).toBe('retired');
    const event = reopened.appendEvent(
      task.id,
      'peer_message_sent',
      'Runtime',
      'Peer response after restart.',
      { recipient: specialist.id, recipient_revision: specialist.revision },
    );
    expect(
      new Set(reopened.graph.pending().map((job) => job.thread_id)),
    ).toEqual(new Set([managerThread, peerThread]));
    expect(reopened.wakeManager(task.id, event.cursor).status).toBe('queued');
    expect(
      reopened
        .read(task.id, identity)
        .assignments.find((item) => item.id === manager.id)?.status,
    ).toBe('queued');
    reopened.askQuestion(task.id, undefined, 'A human answer is required.');
    const questionCursor = reopened.events(task.id, identity).next_cursor;
    reopened.graph.park({
      ...currentScope,
      thread_id: managerThread,
      kind: 'manager',
      cursor: questionCursor,
      after_cursor: questionCursor,
      event_types: ['peer_message_sent'],
    });
    const later = reopened.appendEvent(
      task.id,
      'peer_message_sent',
      'Runtime',
      'Cannot bypass the human wait.',
      { recipient: specialist.id, recipient_revision: specialist.revision },
    );
    expect(reopened.wakeManager(task.id, later.cursor).status).toBe('waiting');
    pause(reopened, task.id);
    expect(reopened.wakeManager(task.id, later.cursor).status).toBe('paused');
  });
});
