import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../../app/orchestration/ports.js';
import { TaskStore } from '../../app/tasks/store.js';
import { createWorldModelTools } from '../../app/tasks/world-tools.js';

const identity = { principal: 'world-service-user', workspace: 'shared-space' };
const directories: string[] = [];
const stores: TaskStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0).reverse())
    if (store.db.isOpen) store.close();
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    const rel = relative(resolve(tmpdir()), target);
    if (!rel || rel.startsWith('..') || resolve(tmpdir()) === target)
      throw new Error('Unsafe test cleanup target.');
    rmSync(target, { recursive: true, force: true });
  }
});

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), 'haze-world-services-'));
  directories.push(directory);
  const store = new TaskStore(directory, { recover: false });
  stores.push(store);
  return store;
}

function createToolContext(
  taskId: string,
  runId: string,
  assignmentId: string,
): ToolContext {
  return {
    taskId,
    runId,
    assignmentId,
    objectiveRevision: 1,
    generation: 1,
    identity,
    deadline: '2099-01-01T00:00:00Z',
    signal: new AbortController().signal,
    inputs: [],
    peers: [],
    outputs: [],
  };
}

describe('authorized World Model reuse services', () => {
  it('returns bounded lookup, current lineage, and saves exact retrieved context references', async () => {
    const store = createStore();
    const source = store.importArtifact(
      {
        schema_version: 'haze.artifact.import.v3',
        filename: 'support.txt',
        media_type: 'text/plain',
        content_base64: Buffer.from('Source evidence.').toString('base64'),
      },
      identity,
      'service-source',
    ).artifact;
    store.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Make the source available.',
        context_refs: [{ id: source.id, version: 1, sha256: source.sha256 }],
        constraints: [],
        desired_deliverables: [],
      },
      identity,
      'source-adoption',
      { mode: 'fixture' },
    );
    const artifactReference = store.world.projectArtifact(
      source,
      'fixture',
    ).value;
    const sourceWorldRecord = store.world.putRecord({
      scope: { ...identity, mode: 'fixture' },
      operation_key: 'source-world-record',
      kind: 'research_note',
      external_id: 'note:reuse',
      payload: { title: 'Reusable note' },
      producer: { kind: 'service', id: 'test' },
    }).value;
    store.world.relate({
      scope: { ...identity, mode: 'fixture' },
      operation_key: 'note-supported-by-source',
      kind: 'supported_by',
      from: sourceWorldRecord.ref,
      to: artifactReference.ref,
    });
    const consumer = store.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Use this previously accepted research note.',
        context_refs: [],
        constraints: [],
        desired_deliverables: [],
      },
      identity,
      'context-consumer',
      {
        mode: 'fixture',
        tools: ['world.lookup', 'world.context', 'world.lineage'],
      },
    ).task;
    const assignment = store.createAssignments(
      consumer.id,
      consumer.current_run_id,
      consumer.objective_revision,
      [
        {
          role: 'HazeOps',
          definition_id: 'world.reader',
          capability: 'evidence-synthesis',
          definition_version: '1',
          brief: 'Inspect authorized research context.',
          tools: ['world.lookup', 'world.context', 'world.lineage'],
        },
      ],
    )[0]!;
    store.acquireAssignment(consumer.id, assignment.id);

    const [lookup, contextTool, lineage] = createWorldModelTools(
      store,
      'fixture',
    );
    const toolContext = createToolContext(
      consumer.id,
      consumer.current_run_id,
      assignment.id,
    );
    const found = await lookup.execute(
      lookup.inputSchema.parse({ kind: 'research_note', limit: 5 }),
      toolContext,
    );
    expect(found.records.map((record) => record.ref.id)).toContain(
      sourceWorldRecord.ref.id,
    );
    const retrieved = await contextTool.execute(
      contextTool.inputSchema.parse({
        record_id: sourceWorldRecord.ref.id,
        stated_use: 'Summarize this note for the current investigation.',
      }),
      toolContext,
    );
    expect(retrieved.support_artifacts).toContainEqual({
      id: source.id,
      version: 1,
      sha256: source.sha256,
    });
    const snapshot = store.artifact(
      retrieved.snapshot.id,
      identity,
      retrieved.snapshot,
    );
    expect(snapshot.kind).toBe('world.context.snapshot');
    expect(snapshot.dependencies).toContainEqual({
      id: source.id,
      version: 1,
      sha256: source.sha256,
    });
    const history = await lineage.execute(
      lineage.inputSchema.parse({
        record_id: sourceWorldRecord.ref.id,
        limit: 10,
      }),
      toolContext,
    );
    expect(history.entries.map((entry) => entry.event_kind)).toContain(
      'record_created',
    );
  });

  it('rejects mode crossover and requires an explicit intended use', () => {
    const store = createStore();
    const record = store.world.putRecord({
      scope: { ...identity, mode: 'fixture' },
      operation_key: 'mode-record',
      kind: 'note',
      external_id: 'note:mode',
      payload: { content: 'bounded' },
      producer: { kind: 'service', id: 'test' },
    }).value;
    const task = store.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Read a prior research note.',
        context_refs: [],
        constraints: [],
        desired_deliverables: [],
      },
      identity,
      'mode-consumer',
      { mode: 'fixture', tools: ['world.context'] },
    ).task;
    const assignment = store.createAssignments(
      task.id,
      task.current_run_id,
      task.objective_revision,
      [
        {
          role: 'HazeOps',
          definition_id: 'world.reader',
          capability: 'evidence-synthesis',
          definition_version: '1',
          brief: 'Read context.',
          tools: ['world.context'],
        },
      ],
    )[0]!;
    store.acquireAssignment(task.id, assignment.id);
    expect(() =>
      store.worldContext(task.id, identity, 'live', record.ref.id),
    ).toThrow('execution mode mismatch');
    expect(() =>
      store.pinWorldContext(task.id, identity, assignment.id, 1, [], '  '),
    ).toThrow('intended use is required');
  });

  it('keeps record lookups scoped to the requesting identity', () => {
    const store = createStore();
    store.world.putRecord({
      scope: { ...identity, mode: 'fixture' },
      operation_key: 'private-record',
      kind: 'private_note',
      external_id: 'private:one',
      payload: { note: 'not cross-tenant' },
      producer: { kind: 'service', id: 'test' },
    });
    const other = { principal: 'other-user', workspace: 'shared-space' };
    expect(
      store.world.lookup({ ...other, mode: 'fixture' }, { limit: 20 }),
    ).toEqual([]);
  });
});
