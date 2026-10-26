import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskStore } from '../../app/tasks/store.js';
import type {
  PutWorldRecordInput,
  RelateWorldRecordsInput,
} from '../../app/tasks/world-store.js';
import {
  worldRecordSchema,
  type WorldRecord,
} from '../../app/contracts/world.js';
import type { ArtifactRef } from '../../app/contracts/artifacts.js';

const identity = { principal: 'test-user', workspace: 'test-workspace' };
const scope = { ...identity, mode: 'fixture' as const };
const at = '2026-10-26T00:00:00Z';
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
  const directory = mkdtempSync(join(tmpdir(), 'haze-world-store-'));
  directories.push(directory);
  const store = new TaskStore(directory, { recover: false });
  stores.push(store);
  return store;
}

function put(
  operation_key: string,
  kind: string,
  external_id: string,
  payload: WorldRecord['payload'],
): PutWorldRecordInput {
  return {
    scope,
    operation_key,
    kind,
    external_id,
    payload,
    producer: { kind: 'service', id: 'test-ingestor' },
    observed_at: at,
    retrieved_at: at,
    recorded_at: at,
  };
}

function relate(
  operation_key: string,
  kind: string,
  from: WorldRecord['ref'],
  to: WorldRecord['ref'],
): RelateWorldRecordsInput {
  return { scope, operation_key, kind, from, to, recorded_at: at };
}

function artifactRef(value: {
  id: string;
  version: number;
  sha256: string;
}): ArtifactRef {
  return { id: value.id, version: value.version, sha256: value.sha256 };
}

describe('transactional World Model writes', () => {
  it('uses deterministic scoped identities and returns the original receipt on exact retries', () => {
    const firstStore = createStore();
    const input = put('ingest-klang', 'location', 'geo:klang', {
      country: 'MY',
    });
    const first = firstStore.world.putRecord(input);
    const retry = firstStore.world.putRecord(input);
    const secondStore = createStore();
    const independentlyWritten = secondStore.world.putRecord(input);

    expect(first.changed).toBe(true);
    expect(retry.changed).toBe(false);
    expect(retry.value).toEqual(first.value);
    expect(retry.receipt).toEqual(first.receipt);
    expect(independentlyWritten.value.ref.id).toBe(first.value.ref.id);
    expect(
      firstStore.db
        .prepare('SELECT COUNT(*) AS count FROM world_entities')
        .get(),
    ).toEqual({ count: 1 });
    expect(
      firstStore.db.prepare('SELECT COUNT(*) AS count FROM world_events').get(),
    ).toEqual({ count: 1 });
    expect(firstStore.world.events(scope)).toHaveLength(1);
    expect(firstStore.world.projectionCursor(scope)).toBe(1);
  });

  it('rejects conflicting operation-key reuse without persisting a second revision', () => {
    const store = createStore();
    const initial = store.world.putRecord(
      put('shared-key', 'source', 'source:one', { title: 'Initial' }),
    );

    expect(() =>
      store.world.putRecord(
        put('shared-key', 'source', 'source:one', { title: 'Changed' }),
      ),
    ).toThrow('reused with different content');
    expect(store.world.record(scope, initial.value.ref.id, 2)).toBeUndefined();
    expect(
      store.db.prepare('SELECT COUNT(*) AS count FROM world_events').get(),
    ).toEqual({ count: 1 });
  });

  it('stores changed observations as explicit immutable revisions and links supersession', () => {
    const store = createStore();
    const first = store.world.putRecord(
      put('observation-1', 'assessment', 'assessment:account-a', {
        total: 100,
        currency: 'USD',
      }),
    );
    const second = store.world.putRecord(
      put('observation-2', 'assessment', 'assessment:account-a', {
        total: 125,
        currency: 'USD',
      }),
    );

    expect(second.value.ref.id).toBe(first.value.ref.id);
    expect(second.value.ref.revision).toBe(2);
    expect(store.world.record(scope, first.value.ref.id, 1)).toEqual(
      first.value,
    );
    expect(store.world.record(scope, first.value.ref.id)).toEqual(second.value);

    const supersession = store.world.relate(
      relate(
        'supersede-account-a',
        'supersedes',
        second.value.ref,
        first.value.ref,
      ),
    );
    expect(supersession.value.kind).toBe('supersedes');
    expect(store.world.relationships(scope, first.value.ref.id)).toContainEqual(
      supersession.value,
    );
  });

  it('retains multiple supporting sources and deduplicates exact relationships', () => {
    const store = createStore();
    const analysis = store.world.putRecord(
      put('analysis', 'analysis', 'analysis:episode-1', { value: 18 }),
    ).value;
    const sourceOne = store.world.putRecord(
      put('source-1', 'evidence', 'evidence:source-1', { hash: 'one' }),
    ).value;
    const sourceTwo = store.world.putRecord(
      put('source-2', 'evidence', 'evidence:source-2', { hash: 'two' }),
    ).value;

    const firstLink = store.world.relate(
      relate('link-source-1', 'supported_by', analysis.ref, sourceOne.ref),
    );
    const secondLinkInput = relate(
      'link-source-2',
      'supported_by',
      analysis.ref,
      sourceTwo.ref,
    );
    const secondLink = store.world.relate(secondLinkInput);
    const retry = store.world.relate(secondLinkInput);

    expect(retry.value).toEqual(secondLink.value);
    expect(retry.receipt).toEqual(secondLink.receipt);
    expect(
      store.world
        .relationships(scope, analysis.ref.id)
        .filter((relationship) => relationship.kind === 'supported_by'),
    ).toEqual([firstLink.value, secondLink.value]);
  });

  it('bounds current context while keeping all support refs and paginated lineage', () => {
    const store = createStore();
    const hub = store.world.putRecord(
      put('hub', 'location', 'geo:hub', { name: 'Hub' }),
    ).value;
    for (let index = 0; index < 110; index++) {
      const support = store.world.putRecord(
        put(`support-${index}`, 'artifact_reference', `support:${index}`, {
          artifact: {
            id: randomUUID(),
            version: 1,
            sha256: 'a'.repeat(64),
          },
        }),
      ).value;
      store.world.relate(
        relate(`link-${index}`, 'supported_by', hub.ref, support.ref),
      );
    }
    const context = store.world.context(scope, hub.ref.id)!;
    expect(context.relationships).toHaveLength(100);
    expect(context.support_artifacts).toHaveLength(64);
    const detail = store.worldRecordDetailForIdentity(
      identity,
      'fixture',
      hub.ref.id,
    );
    expect(detail.relationships).toHaveLength(100);
    expect(detail.support_artifacts).toHaveLength(64);
    expect(store.world.supportArtifacts(scope, hub.ref.id)).toHaveLength(110);
    const first = store.world.lineage(scope, {
      record_id: hub.ref.id,
      limit: 100,
    })!;
    expect(first.entries).toHaveLength(100);
    expect(first.page.has_more).toBe(true);
    const second = store.world.lineage(scope, {
      record_id: hub.ref.id,
      limit: 100,
      cursor: first.page.next_cursor,
    })!;
    expect(second.entries).toHaveLength(11);
    expect(second.page.has_more).toBe(false);
  });

  it('isolates live, fixture, and replay state and requires exact relationship endpoints', () => {
    const store = createStore();
    const fixtureRecord = store.world.putRecord(
      put('fixture-location', 'location', 'geo:klang', { country: 'MY' }),
    ).value;

    expect(
      store.world.record({ ...scope, mode: 'live' }, fixtureRecord.ref.id),
    ).toBeUndefined();
    expect(() =>
      store.world.relate({
        scope: { ...scope, mode: 'replay' },
        operation_key: 'cross-mode-link',
        kind: 'supported_by',
        from: fixtureRecord.ref,
        to: fixtureRecord.ref,
        recorded_at: at,
      }),
    ).toThrow('endpoint is not available in this scope');
  });

  it('rebuilds projections from verified events and restores them on restart', () => {
    const store = createStore();
    const location = store.world.putRecord(
      put('location', 'location', 'geo:klang', { name: 'Klang' }),
    ).value;
    const source = store.world.putRecord(
      put('source', 'source', 'source:openaq', { name: 'OpenAQ' }),
    ).value;
    store.world.relate(
      relate('published-by', 'supported_by', location.ref, source.ref),
    );
    const before = store.world.events(scope);
    expect(before.map((event) => event.sequence)).toEqual([1, 2, 3]);

    store.db
      .prepare(
        `DELETE FROM world_projection_entities
         WHERE principal=? AND workspace=? AND mode=? AND record_id=?`,
      )
      .run(scope.principal, scope.workspace, scope.mode, location.ref.id);
    expect(store.world.record(scope, location.ref.id)).toBeUndefined();
    expect(store.world.rebuildProjections(scope)).toBe(3);
    expect(store.world.record(scope, location.ref.id)).toEqual(location);
    expect(store.world.relationships(scope, location.ref.id)).toHaveLength(1);
    expect(store.world.events(scope)).toEqual(before);
    expect(store.world.events(scope, 1).map((event) => event.sequence)).toEqual(
      [2, 3],
    );

    const directory = directories.at(-1)!;
    store.db
      .prepare(
        `DELETE FROM world_projection_entities
         WHERE principal=? AND workspace=? AND mode=?`,
      )
      .run(scope.principal, scope.workspace, scope.mode);
    store.db
      .prepare(
        `DELETE FROM world_projection_relationships
         WHERE principal=? AND workspace=? AND mode=?`,
      )
      .run(scope.principal, scope.workspace, scope.mode);
    store.db
      .prepare(
        `DELETE FROM world_projection_cursors
         WHERE principal=? AND workspace=? AND mode=?`,
      )
      .run(scope.principal, scope.workspace, scope.mode);
    store.close();
    const index = stores.indexOf(store);
    if (index >= 0) stores.splice(index, 1);
    const restarted = new TaskStore(directory, { recover: false });
    stores.push(restarted);
    expect(restarted.world.record(scope, location.ref.id)).toEqual(location);
    expect(restarted.world.projectionCursor(scope)).toBe(3);
    expect(restarted.world.relationships(scope, location.ref.id)).toHaveLength(
      1,
    );
  });

  it('rejects tampered event payloads and rolls back a projection rebuild', () => {
    const store = createStore();
    const location = store.world.putRecord(
      put('location', 'location', 'geo:klang', { name: 'Klang' }),
    ).value;
    store.db
      .prepare('UPDATE world_events SET body=? WHERE sequence=?')
      .run('{"invalid":true}', 1);

    expect(() => store.world.rebuildProjections(scope)).toThrow();
    expect(store.world.record(scope, location.ref.id)).toEqual(location);
    expect(store.world.projectionCursor(scope)).toBe(1);
  });

  it('projects imported context only when a task adopts it in that execution mode', () => {
    const store = createStore();
    const source = store.importArtifact(
      {
        schema_version: 'haze.artifact.import.v3',
        filename: 'source.txt',
        media_type: 'text/plain',
        content_base64: Buffer.from('Private source content.').toString(
          'base64',
        ),
      },
      identity,
      'import-source',
    ).artifact;
    const ref = artifactRef(source);

    expect(
      store.db.prepare('SELECT COUNT(*) AS count FROM world_entities').get(),
    ).toEqual({ count: 0 });

    const task = store.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Review the imported source.',
        context_refs: [ref],
        constraints: [],
        desired_deliverables: [],
      },
      identity,
      'adopt-source',
      { mode: 'fixture' },
    ).task;

    const records = store.db
      .prepare(
        `SELECT body FROM world_entities
         WHERE principal=? AND workspace=? AND mode=? AND kind=?`,
      )
      .all(
        identity.principal,
        identity.workspace,
        task.mode,
        'artifact_reference',
      ) as {
      body: string;
    }[];
    expect(records).toHaveLength(1);
    expect(
      worldRecordSchema.parse(JSON.parse(records[0]!.body)).payload,
    ).toEqual({
      artifact: ref,
      kind: 'source.import',
      producer: source.producer,
      created_at: source.created_at,
      dependencies: [],
      evidence_origin: 'user_supplied',
    });
    expect(JSON.stringify(records[0]!.body)).not.toContain(
      'Private source content.',
    );
    const projectedRef = worldRecordSchema.parse(
      JSON.parse(records[0]!.body),
    ).ref;
    expect(
      store.world.record({ ...scope, mode: 'live' }, projectedRef.id),
    ).toBeUndefined();
  });

  it('projects produced artifact references and dependency links in the artifact transaction', () => {
    const store = createStore();
    const source = store.importArtifact(
      {
        schema_version: 'haze.artifact.import.v3',
        filename: 'source.txt',
        media_type: 'text/plain',
        content_base64: Buffer.from('Evidence source.').toString('base64'),
      },
      identity,
      'artifact-source',
    ).artifact;
    const task = store.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Analyze the evidence source.',
        context_refs: [artifactRef(source)],
        constraints: [],
        desired_deliverables: [],
      },
      identity,
      'artifact-task',
      { mode: 'fixture' },
    ).task;
    const assignment = store.createAssignments(
      task.id,
      task.current_run_id,
      task.objective_revision,
      [
        {
          role: 'HazeOps',
          definition_id: 'test.analysis',
          capability: 'test',
          definition_version: '1',
          brief: 'Create a derived analysis.',
          inputs: [artifactRef(source)],
        },
      ],
    )[0]!;
    store.acquireAssignment(task.id, assignment.id);

    const output = store.saveArtifact(task.id, identity, {
      kind: 'test.analysis',
      producer: { kind: 'assignment', id: assignment.id },
      dependencies: [artifactRef(source)],
      content: { finding: 'bounded' },
    });
    const artifactRecords = store.db
      .prepare(
        `SELECT body FROM world_entities
         WHERE principal=? AND workspace=? AND mode=? AND kind=?`,
      )
      .all(
        identity.principal,
        identity.workspace,
        'fixture',
        'artifact_reference',
      ) as {
      body: string;
    }[];
    expect(artifactRecords).toHaveLength(2);
    const outputRecord = artifactRecords
      .map((row) => worldRecordSchema.parse(JSON.parse(row.body)))
      .find(
        (record) =>
          record.external_id === `artifact:${output.id}:${output.version}`,
      );
    const sourceRecord = artifactRecords
      .map((row) => worldRecordSchema.parse(JSON.parse(row.body)))
      .find(
        (record) =>
          record.external_id === `artifact:${source.id}:${source.version}`,
      );
    expect(outputRecord).toBeDefined();
    expect(sourceRecord).toBeDefined();
    expect(
      store.world.relationships(
        { ...scope, mode: 'fixture' },
        outputRecord!.ref.id,
      ),
    ).toContainEqual(
      expect.objectContaining({
        kind: 'depends_on',
        from: outputRecord!.ref,
        to: sourceRecord!.ref,
      }),
    );
  });

  it('rolls back task creation and World Model projection when artifact projection fails', () => {
    const store = createStore();
    const source = store.importArtifact(
      {
        schema_version: 'haze.artifact.import.v3',
        filename: 'source.txt',
        media_type: 'text/plain',
        content_base64: Buffer.from('Evidence source.').toString('base64'),
      },
      identity,
      'rollback-source',
    ).artifact;
    store.db.exec(`CREATE TRIGGER reject_world_events
      BEFORE INSERT ON world_events
      BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END;`);

    expect(() =>
      store.admit(
        {
          schema_version: 'haze.task.request.v3',
          objective: 'This admission must roll back.',
          context_refs: [artifactRef(source)],
          constraints: [],
          desired_deliverables: [],
        },
        identity,
        'rollback-task',
        { mode: 'fixture' },
      ),
    ).toThrow('injected projection failure');
    expect(
      store.db.prepare('SELECT COUNT(*) AS count FROM tasks').get(),
    ).toEqual({ count: 0 });
    expect(
      store.db.prepare('SELECT COUNT(*) AS count FROM world_entities').get(),
    ).toEqual({ count: 0 });
    expect(
      store.db.prepare('SELECT COUNT(*) AS count FROM world_events').get(),
    ).toEqual({ count: 0 });
    expect(
      store.db
        .prepare(
          'SELECT COUNT(*) AS count FROM world_operation_receipts WHERE operation_key=?',
        )
        .get(`project-artifact:${source.id}:${source.version}`),
    ).toEqual({ count: 0 });
  });

  it('persists accepted status with policy history, expires it, and holds it when support changes', () => {
    const store = createStore();
    const record = store.world.putRecord(
      put('accepted-record', 'evidence_synthesis_bundle', 'bundle:one', {
        summary: 'Reviewed evidence bundle.',
      }),
    ).value;
    const unrelated = store.world.putRecord(
      put('unrelated-accepted-record', 'research_note', 'note:unrelated', {
        summary: 'Independent support branch.',
      }),
    ).value;
    const policy = {
      id: 'research-v1',
      version: '1',
      sha256: 'a'.repeat(64),
    };
    const accepted = store.world.evaluateAcceptance({
      scope,
      subject: record.ref,
      stated_use: 'evidence-synthesis',
      status: 'accepted',
      policy,
      support_revisions: [],
      actor: { kind: 'service', id: 'test-policy' },
      evaluated_at: at,
      expires_at: '2026-10-27T00:00:00Z',
    });
    const unrelatedAcceptance = store.world.evaluateAcceptance({
      scope,
      subject: unrelated.ref,
      stated_use: 'evidence-synthesis',
      status: 'accepted',
      policy,
      support_revisions: [],
      actor: { kind: 'service', id: 'test-policy' },
      evaluated_at: at,
      expires_at: '2026-10-27T00:00:00Z',
    });
    expect(accepted.status).toBe('accepted');
    expect(
      store.world.currentAcceptance(scope, accepted.id, {
        now: '2026-10-26T12:00:00Z',
        policyHash: policy.sha256,
      })?.status,
    ).toBe('accepted');
    expect(
      store.world.currentAcceptance(scope, accepted.id, {
        now: '2026-10-28T00:00:00Z',
        policyHash: policy.sha256,
      }),
    ).toMatchObject({
      status: 'not_eligible',
      reasons: ['Acceptance has expired and requires reevaluation.'],
    });

    const hold = store.world.hold(
      scope,
      record.ref,
      'Source support changed.',
      'correction',
    );
    expect(
      store.world.currentAcceptance(scope, accepted.id, {
        now: '2026-10-26T12:00:00Z',
        policyHash: policy.sha256,
      }),
    ).toMatchObject({ status: 'held', hold_ids: [hold.id] });
    expect(
      store.world.currentAcceptance(scope, unrelatedAcceptance.id, {
        now: '2026-10-26T12:00:00Z',
        policyHash: policy.sha256,
      })?.status,
    ).toBe('accepted');
    store.world.clearHold(
      scope,
      hold.id,
      'An explicit applicability review passed.',
    );
    const rechecked = store.world.evaluateAcceptance({
      scope,
      subject: record.ref,
      stated_use: 'evidence-synthesis',
      status: 'accepted',
      policy,
      support_revisions: [],
      actor: { kind: 'service', id: 'test-policy' },
      evaluated_at: '2026-10-26T13:00:00Z',
      expires_at: '2026-11-26T13:00:00Z',
    });
    expect(rechecked.status).toBe('accepted');
    expect(store.world.events(scope).map((event) => event.event_kind)).toEqual(
      expect.arrayContaining([
        'acceptance_evaluated',
        'hold_created',
        'hold_cleared',
      ]),
    );
  });

  it('deduplicates identical acceptance and rolls back a failed acceptance event', () => {
    const store = createStore();
    const policy = {
      id: 'research-v1',
      version: '1',
      sha256: 'b'.repeat(64),
    };
    const acceptedRecord = store.world.putRecord(
      put('accepted-once', 'evidence_synthesis_bundle', 'bundle:once', {
        summary: 'Reviewed bundle.',
      }),
    ).value;
    const acceptanceInput = {
      scope,
      subject: acceptedRecord.ref,
      stated_use: 'evidence-synthesis',
      status: 'accepted' as const,
      policy,
      support_revisions: [],
      actor: { kind: 'service' as const, id: 'test-policy' },
      evaluated_at: at,
      expires_at: '2026-11-25T00:00:00Z',
    };
    const first = store.world.evaluateAcceptance(acceptanceInput);
    const retry = store.world.evaluateAcceptance({
      ...acceptanceInput,
      evaluated_at: '2026-10-26T01:00:00Z',
    });

    expect(retry).toEqual(first);
    expect(
      store.world.acceptancesForRecord(scope, acceptedRecord.ref.id),
    ).toEqual([first]);
    expect(
      store.world
        .events(scope)
        .filter((event) => event.event_kind === 'acceptance_evaluated'),
    ).toHaveLength(1);
    expect(
      store.db
        .prepare(
          `SELECT COUNT(*) AS count FROM world_operation_receipts
           WHERE operation_key LIKE 'acceptance:%'`,
        )
        .get(),
    ).toEqual({ count: 1 });

    const rollbackRecord = store.world.putRecord(
      put(
        'acceptance-rollback',
        'evidence_synthesis_bundle',
        'bundle:rollback',
        {
          summary: 'Must not be accepted.',
        },
      ),
    ).value;
    store.db.exec(`CREATE TRIGGER reject_acceptance_events
      BEFORE INSERT ON world_events
      WHEN NEW.event_kind='acceptance_evaluated'
      BEGIN SELECT RAISE(ABORT, 'injected acceptance event failure'); END;`);
    expect(() =>
      store.world.evaluateAcceptance({
        ...acceptanceInput,
        subject: rollbackRecord.ref,
      }),
    ).toThrow('injected acceptance event failure');
    expect(
      store.world.acceptancesForRecord(scope, rollbackRecord.ref.id),
    ).toEqual([]);
    expect(
      store.db
        .prepare(
          `SELECT COUNT(*) AS count FROM world_operation_receipts
           WHERE operation_key LIKE 'acceptance:%'`,
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      store.world
        .events(scope)
        .filter((event) => event.event_kind === 'acceptance_evaluated'),
    ).toHaveLength(1);
  });

  it('holds transitive artifact support while leaving unrelated accepted records usable', () => {
    const store = createStore();
    const source = store.importArtifact(
      {
        schema_version: 'haze.artifact.import.v3',
        filename: 'source.txt',
        media_type: 'text/plain',
        content_base64: Buffer.from('Original support.').toString('base64'),
      },
      identity,
      'support-source',
    ).artifact;
    const task = store.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Create work derived from the source.',
        context_refs: [artifactRef(source)],
        constraints: [],
        desired_deliverables: [],
      },
      identity,
      'support-task',
      { mode: 'fixture' },
    ).task;
    const assignment = store.createAssignments(
      task.id,
      task.current_run_id,
      task.objective_revision,
      [
        {
          role: 'HazeOps',
          definition_id: 'test.derived-work',
          capability: 'test',
          definition_version: '1',
          brief: 'Create a derived artifact.',
          inputs: [artifactRef(source)],
        },
      ],
    )[0]!;
    store.acquireAssignment(task.id, assignment.id);
    const derived = store.saveArtifact(task.id, identity, {
      kind: 'test.derived-work',
      content: { summary: 'Derived from the source.' },
      producer: { kind: 'assignment', id: assignment.id },
      dependencies: [artifactRef(source)],
      generation: task.generation,
    });

    const acceptedRecord = store.world.putRecord(
      put(
        'transitive-accepted',
        'evidence_synthesis_bundle',
        'bundle:derived',
        {
          summary: 'Uses derived support.',
        },
      ),
    ).value;
    const unrelatedRecord = store.world.putRecord(
      put('unrelated-accepted', 'research_note', 'note:independent', {
        summary: 'Independent evidence.',
      }),
    ).value;
    const policy = {
      id: 'research-v1',
      version: '1',
      sha256: 'd'.repeat(64),
    };
    const support = {
      schema_version: 'haze.world.support-revision.v1' as const,
      id: 'derived-support',
      scope,
      revision: 1,
      kind: 'artifact' as const,
      sha256: derived.sha256,
      artifact: artifactRef(derived),
      recorded_at: at,
    };
    const accepted = store.world.evaluateAcceptance({
      scope,
      subject: acceptedRecord.ref,
      stated_use: 'evidence-synthesis',
      status: 'accepted',
      policy,
      support_revisions: [support],
      actor: { kind: 'service', id: 'test-policy' },
      evaluated_at: at,
    });
    const unrelated = store.world.evaluateAcceptance({
      scope,
      subject: unrelatedRecord.ref,
      stated_use: 'evidence-synthesis',
      status: 'accepted',
      policy,
      support_revisions: [],
      actor: { kind: 'service', id: 'test-policy' },
      evaluated_at: at,
    });

    const holds = store.world.holdForSupportArtifact(
      scope,
      source.id,
      'The original source changed.',
      'correction',
    );

    expect(holds).toEqual([
      expect.objectContaining({ subject: acceptedRecord.ref }),
    ]);
    expect(
      store.world.currentAcceptance(scope, accepted.id, {
        policyHash: policy.sha256,
      })?.status,
    ).toBe('held');
    expect(
      store.world.currentAcceptance(scope, unrelated.id, {
        policyHash: policy.sha256,
      })?.status,
    ).toBe('accepted');
  });
});
