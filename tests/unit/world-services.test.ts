import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ExecutionRegistry,
  type ToolContext,
} from '../../app/orchestration/ports.js';
import { assembleManagerContext } from '../../app/agents/manager/context.js';
import {
  worldApiPageQuerySchema,
  worldRecordDetailResponseSchema,
  worldRecordNotFoundSchema,
} from '../../app/contracts/world-api.js';
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

function createStore(acceptancePolicy?: 'research-v1') {
  const directory = mkdtempSync(join(tmpdir(), 'haze-world-services-'));
  directories.push(directory);
  const store = new TaskStore(directory, {
    recover: false,
    ...(acceptancePolicy ? { acceptancePolicy } : {}),
  });
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
    assignmentRevision: 1,
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
  it('offers granted read-only World Model tools to the Manager while retaining context writes for specialists', () => {
    const store = createStore();
    const registry = new ExecutionRegistry();
    const [lookup, contextTool, lineage] = createWorldModelTools(
      store,
      'fixture',
    );
    registry
      .registerTool(lookup)
      .registerTool(contextTool)
      .registerTool(lineage);
    const task = store.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Inspect previously retained research evidence.',
        context_refs: [],
        constraints: [],
        desired_deliverables: [],
      },
      identity,
      'manager-world-grants',
      {
        mode: 'fixture',
        tools: ['world.lookup', 'world.lineage', 'world.context'],
      },
    ).task;
    const state = store.managerState(task.id, identity)!;
    const context = assembleManagerContext(task, registry, state, {
      events: [],
      artifacts: [],
    });
    expect(context.lookups.map((tool) => tool.id)).toEqual([
      'world.lookup',
      'world.lineage',
    ]);
    expect(registry.tools.get('world.context')?.manager_read_only).not.toBe(
      true,
    );

    const revoked = structuredClone(task);
    revoked.permissions.tools = ['world.context'];
    expect(
      assembleManagerContext(revoked, registry, state, {
        events: [],
        artifacts: [],
      }).lookups,
    ).toEqual([]);
  });

  it('validates versioned API detail, status, pagination, and not-found contracts', () => {
    expect(
      worldApiPageQuerySchema.parse({ limit: '25', cursor: '10' }),
    ).toEqual({ limit: 25, cursor: '10' });
    expect(() => worldApiPageQuerySchema.parse({ limit: '101' })).toThrow();
    expect(() => worldApiPageQuerySchema.parse({ cursor: '-1' })).toThrow();
    expect(
      worldRecordDetailResponseSchema.shape.schema_version.parse(
        'haze.world.record-detail.v1',
      ),
    ).toBe('haze.world.record-detail.v1');
    expect(
      worldRecordNotFoundSchema.parse({
        error: {
          code: 'world_record_not_found',
          message: 'World Model record not found.',
        },
      }).error.code,
    ).toBe('world_record_not_found');
    expect(() =>
      worldRecordNotFoundSchema.parse({
        error: { code: 'world_record_not_found', message: 'Not found' },
      }),
    ).toThrow();
  });

  it('returns bounded lookup, current lineage, and saves exact retrieved context references', async () => {
    const store = createStore('research-v1');
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
    const accepted = store.world.evaluateAcceptance({
      scope: { ...identity, mode: 'fixture' },
      subject: sourceWorldRecord.ref,
      stated_use: 'Summarize this note for the current investigation.',
      status: 'accepted',
      policy: {
        id: store.worldAcceptancePolicy.id,
        version: store.worldAcceptancePolicy.version,
        sha256: store.worldAcceptancePolicy.sha256,
      },
      support_revisions: [
        {
          schema_version: 'haze.world.support-revision.v1',
          id: 'source-support',
          scope: { ...identity, mode: 'fixture' },
          revision: 1,
          kind: 'artifact',
          sha256: source.sha256,
          artifact: {
            id: source.id,
            version: source.version,
            sha256: source.sha256,
          },
          recorded_at: source.created_at,
        },
      ],
      actor: { kind: 'service', id: 'test-policy' },
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
    const detail = store.worldRecordDetail(
      consumer.id,
      identity,
      sourceWorldRecord.ref.id,
    );
    expect(detail.record.ref).toEqual(sourceWorldRecord.ref);
    expect(detail.status).toMatchObject({
      schema_version: 'haze.world.current-status.v1',
      record_id: sourceWorldRecord.ref.id,
      acceptances: [expect.objectContaining({ status: 'accepted' })],
    });
    expect(() =>
      store.worldRecordDetail(
        consumer.id,
        { principal: 'other-user', workspace: 'shared-space' },
        sourceWorldRecord.ref.id,
      ),
    ).toThrow('Task not found');
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
    const pinnedHold = store.world.holdForSupportArtifact(
      { ...identity, mode: 'fixture' },
      source.id,
      'The pinned World Model record changed.',
      'correction',
      { kind: 'user', id: identity.principal },
    )[0]!;
    expect(pinnedHold.subject).toEqual(sourceWorldRecord.ref);
    expect(
      store.world.currentAcceptance(
        { ...identity, mode: 'fixture' },
        accepted.id,
        { policyHash: accepted.policy.sha256 },
      )?.status,
    ).toBe('held');
    expect(
      store.world.acceptancesForRecord(
        { ...identity, mode: 'fixture' },
        sourceWorldRecord.ref.id,
      )[0]?.status,
    ).toBe('held');
    const lifecycleEvents = store
      .events(consumer.id, identity)
      .events.filter((event) => event.type === 'world_lifecycle_changed');
    const lifecycleKinds = lifecycleEvents.flatMap((event) => {
      const data = event.data;
      return typeof data === 'object' && data !== null && !Array.isArray(data)
        ? [data['event_kind']]
        : [];
    });
    expect(lifecycleKinds).toEqual(
      expect.arrayContaining(['hold_created', 'acceptance_evaluated']),
    );
    const worldEventCount = store.world.events({
      ...identity,
      mode: 'fixture',
    }).length;
    store.db.exec(
      `CREATE TRIGGER reject_world_task_notification
       BEFORE INSERT ON events
       WHEN json_extract(NEW.body,'$.type')='world_lifecycle_changed'
       BEGIN SELECT RAISE(ABORT,'notification failed'); END;`,
    );
    expect(() =>
      store.world.clearHold(
        { ...identity, mode: 'fixture' },
        pinnedHold.id,
        'Attempted clear.',
      ),
    ).toThrow('notification failed');
    expect(
      store.world.activeHolds(
        { ...identity, mode: 'fixture' },
        sourceWorldRecord.ref.id,
      ),
    ).toHaveLength(1);
    expect(store.world.events({ ...identity, mode: 'fixture' })).toHaveLength(
      worldEventCount,
    );
    store.db.exec('DROP TRIGGER reject_world_task_notification;');
    const directory = store.directory;
    store.close();
    const reopened = new TaskStore(directory, { recover: false });
    stores.push(reopened);
    expect(
      reopened
        .events(consumer.id, identity)
        .events.filter((event) => event.type === 'world_lifecycle_changed'),
    ).toHaveLength(2);
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
      store.pinWorldContext(
        task.id,
        identity,
        assignment.id,
        1,
        [],
        '  ',
        record.ref.id,
      ),
    ).toThrow('intended use is required');
  });

  it('blocks context disclosure when the requesting task lacks a required source grant', () => {
    const store = createStore();
    const owner = store.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Produce a restricted source.',
        context_refs: [],
        constraints: [],
        desired_deliverables: [],
      },
      identity,
      'restricted-owner',
      { mode: 'fixture', tools: ['world.context'] },
    ).task;
    const ownerAssignment = store.createAssignments(
      owner.id,
      owner.current_run_id,
      owner.objective_revision,
      [
        {
          role: 'HazeOps',
          definition_id: 'restricted.producer',
          capability: 'evidence-synthesis',
          definition_version: '1',
          brief: 'Produce restricted evidence.',
          tools: ['world.context'],
        },
      ],
    )[0]!;
    store.acquireAssignment(owner.id, ownerAssignment.id);
    const restricted = store.saveArtifact(owner.id, identity, {
      kind: 'restricted-source',
      content: { detail: 'must not be disclosed' },
      producer: { kind: 'assignment', id: ownerAssignment.id },
      generation: 1,
    });
    const artifactRecord = store.world.projectArtifact(
      restricted,
      'fixture',
    ).value;
    const note = store.world.putRecord({
      scope: { ...identity, mode: 'fixture' },
      operation_key: 'restricted-note',
      kind: 'research_note',
      external_id: 'note:restricted',
      payload: { title: 'Restricted note' },
      producer: { kind: 'service', id: 'test' },
    }).value;
    store.world.relate({
      scope: { ...identity, mode: 'fixture' },
      operation_key: 'restricted-note-support',
      kind: 'supported_by',
      from: note.ref,
      to: artifactRecord.ref,
    });
    const consumer = store.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Read the restricted note.',
        context_refs: [],
        constraints: [],
        desired_deliverables: [],
      },
      identity,
      'restricted-consumer',
      { mode: 'fixture', tools: [] },
    ).task;

    expect(() =>
      store.worldContext(consumer.id, identity, 'fixture', note.ref.id),
    ).toThrow('Current source access prevents World Model context disclosure.');
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

  it('reads conversation evidence without admitting a task and keeps identity and mode boundaries', () => {
    const store = createStore();
    const record = store.world.putRecord({
      scope: { ...identity, mode: 'fixture' },
      operation_key: 'conversation-record',
      kind: 'research_note',
      external_id: 'conversation:note',
      payload: { note: 'Stored evidence, not an accepted decision.' },
      producer: { kind: 'service', id: 'test' },
    }).value;
    expect(
      store
        .conversationWorldLookup(identity, 'fixture', {
          external_id: 'conversation:note',
          limit: 10,
        })
        .records.map((entry) => entry.ref.id),
    ).toEqual([record.ref.id]);
    expect(
      store.conversationWorldContext(identity, 'fixture', record.ref.id)
        .acceptances,
    ).toEqual([]);
    expect(
      store.conversationWorldLookup(identity, 'live', { limit: 10 }).records,
    ).toEqual([]);
    expect(() =>
      store.conversationWorldContext(
        { ...identity, principal: 'other-principal' },
        'fixture',
        record.ref.id,
      ),
    ).toThrow('World Model record not found');
    expect(
      store.db.prepare('SELECT COUNT(*) AS count FROM tasks').get(),
    ).toEqual({
      count: 0,
    });
  });

  it('rechecks conversation acceptance against current policy and expiry', () => {
    const store = createStore('research-v1');
    const scope = { ...identity, mode: 'fixture' as const };
    const record = store.world.putRecord({
      scope,
      operation_key: 'conversation-acceptance',
      kind: 'research_note',
      external_id: 'conversation:acceptance',
      payload: { note: 'Needs current acceptance checks.' },
      producer: { kind: 'service', id: 'test' },
    }).value;
    store.world.evaluateAcceptance({
      scope,
      subject: record.ref,
      stated_use: 'Earlier policy use',
      status: 'accepted',
      policy: {
        id: store.worldAcceptancePolicy.id,
        version: store.worldAcceptancePolicy.version,
        sha256: 'a'.repeat(64),
      },
      support_revisions: [],
      actor: { kind: 'service', id: 'test-policy' },
    });
    store.world.evaluateAcceptance({
      scope,
      subject: record.ref,
      stated_use: 'Expired use',
      status: 'accepted',
      policy: {
        id: store.worldAcceptancePolicy.id,
        version: store.worldAcceptancePolicy.version,
        sha256: store.worldAcceptancePolicy.sha256,
      },
      support_revisions: [],
      evaluated_at: '2025-01-01T00:00:00Z',
      expires_at: '2025-01-02T00:00:00Z',
      actor: { kind: 'service', id: 'test-policy' },
    });
    const context = store.conversationWorldContext(
      identity,
      'fixture',
      record.ref.id,
    );
    expect(context.acceptances).toHaveLength(2);
    expect(
      context.acceptances.every((entry) => entry.status === 'not_eligible'),
    ).toBe(true);
    expect(
      store
        .conversationWorldLookup(identity, 'fixture', {
          kind: 'research_note',
          limit: 10,
        })
        .current_acceptances.every(
          ({ acceptance }) => acceptance.status === 'not_eligible',
        ),
    ).toBe(true);
  });

  it('hides conversation records supported by revoked grants, stale artifacts, or another mode', () => {
    const store = createStore();
    const owner = store.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Produce reusable evidence.',
        context_refs: [],
        constraints: [],
        desired_deliverables: [],
      },
      identity,
      'conversation-source-owner',
      { mode: 'fixture', tools: ['world.context'] },
    ).task;
    const assignment = store.createAssignments(
      owner.id,
      owner.current_run_id,
      owner.objective_revision,
      [
        {
          role: 'HazeOps',
          definition_id: 'conversation.producer',
          capability: 'evidence-synthesis',
          definition_version: '1',
          brief: 'Produce evidence.',
          tools: ['world.context'],
        },
      ],
    )[0]!;
    store.acquireAssignment(owner.id, assignment.id);
    const artifact = store.saveArtifact(owner.id, identity, {
      kind: 'conversation.source',
      content: { note: 'Restricted evidence.' },
      producer: { kind: 'assignment', id: assignment.id },
      generation: 1,
    });
    const record = store.world.projectArtifact(artifact, 'fixture').value;
    expect(
      store.conversationWorldContext(identity, 'fixture', record.ref.id).record
        .ref,
    ).toEqual(record.ref);
    const crossover = store.world.projectArtifact(artifact, 'live').value;
    expect(() =>
      store.conversationWorldContext(identity, 'live', crossover.ref.id),
    ).toThrow('Current source access');
    store.recordApplicability(
      owner.id,
      identity,
      artifact,
      false,
      'Withdrawn evidence.',
      'Runtime',
    );
    expect(() =>
      store.conversationWorldContext(identity, 'fixture', record.ref.id),
    ).toThrow('Current source access');
    store.recordApplicability(
      owner.id,
      identity,
      artifact,
      true,
      'Restored before revocation.',
      'Runtime',
    );
    const current = store.read(owner.id, identity);
    store.control(owner.id, identity, 'conversation-revoke', {
      schema_version: 'haze.task.control.v3',
      action: 'revoke',
      revoked_tools: ['world.context'],
      expected_objective_revision: current.objective_revision,
      expected_run_id: current.current_run_id,
      expected_generation: current.generation,
      expected_state_revision: current.state_revision,
    });
    expect(() =>
      store.conversationWorldContext(identity, 'fixture', record.ref.id),
    ).toThrow('Current source access');
    expect(
      store.conversationWorldLookup(identity, 'fixture', {
        kind: 'artifact_reference',
        limit: 50,
      }).records,
    ).toEqual([]);
    expect(
      store.db.prepare('SELECT COUNT(*) AS count FROM tasks').get(),
    ).toEqual({ count: 1 });
  });
});
