import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskStore } from '../../app/tasks/store.js';
import type {
  PutWorldRecordInput,
  RelateWorldRecordsInput,
} from '../../app/tasks/world-store.js';
import type { WorldRecord } from '../../app/contracts/world.js';

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
});
