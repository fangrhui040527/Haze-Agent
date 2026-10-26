import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTaskHandler } from '../../app/tasks/http.js';
import { localTaskIdentity } from '../../app/tasks/runtime.js';
import {
  WORLD_BROWSE_RESPONSE_BYTES,
  worldBrowseResponseSchema,
  worldProjectionRebuildResponseSchema,
} from '../../app/contracts/world-api.js';
import type { WorldRecord } from '../../app/contracts/world.js';
import { TaskStore } from '../../app/tasks/store.js';

const scope = { ...localTaskIdentity, mode: 'fixture' as const };
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function api() {
  const directory = await mkdtemp(join(tmpdir(), 'haze-world-control-'));
  const handler = createTaskHandler({
    stateDirectory: directory,
    mode: 'fixture',
  });
  const server = createServer(handler);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server');
  const origin = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await handler.close();
    const target = resolve(directory);
    const rel = relative(resolve(tmpdir()), target);
    if (!rel || rel.startsWith('..') || resolve(tmpdir()) === target)
      throw new Error('Unsafe test cleanup target.');
    await rm(target, { recursive: true, force: true });
  });
  const browse = async (query = '') => {
    const response = await fetch(`${origin}/api/world/records${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return worldBrowseResponseSchema.parse(await response.json());
  };
  const rebuild = (key = 'rebuild-1', value: unknown = {}) =>
    fetch(`${origin}/api/world/projections/rebuild`, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(value),
    });
  return {
    origin,
    handler,
    store: handler.runtime.store,
    browse,
    rebuild,
    directory,
  };
}

function put(
  store: TaskStore,
  id: string,
  value: string,
  kind = 'note',
  recordScope: WorldRecord['scope'] = scope,
) {
  return store.world.putRecord({
    scope: recordScope,
    operation_key: `put:${id}:${value.length}`,
    kind,
    external_id: id,
    payload: { value },
    producer: { kind: 'service', id: 'control-plane-test' },
  }).value;
}

it('browses current revisions with scoped counts, kind filters and cursor pages', async () => {
  const { store, browse } = await api();
  expect(await browse()).toMatchObject({
    scope,
    records: [],
    kinds: [],
    kinds_truncated: false,
    counts: { records: 0, relationships: 0, events: 0 },
    projection_cursor: 0,
    has_more: false,
  });
  put(store, 'alpha_', 'old');
  const second = put(store, 'beta', 'second', 'location');
  const current = put(store, 'alpha_', 'current revision');
  store.world.relate({
    scope,
    operation_key: 'relation',
    kind: 'located_at',
    from: current.ref,
    to: second.ref,
  });
  put(store, 'hidden-principal', 'secret', 'hidden_kind', {
    ...scope,
    principal: 'another-user',
  });
  put(store, 'hidden-workspace', 'secret', 'hidden_kind', {
    ...scope,
    workspace: 'another-workspace',
  });
  put(store, 'hidden-mode', 'secret', 'hidden_kind', {
    ...scope,
    mode: 'live',
  });
  const firstPage = await browse('?limit=1');
  expect(firstPage).toMatchObject({
    records: [current],
    counts: { records: 2, relationships: 1, events: 4 },
    projection_cursor: 4,
    kinds: [
      { kind: 'location', count: 1 },
      { kind: 'note', count: 1 },
    ],
    has_more: true,
    next_cursor: '3',
  });
  const secondPage = await browse(`?limit=1&cursor=${firstPage.next_cursor!}`);
  expect(secondPage.records).toEqual([second]);
  expect(secondPage.has_more).toBe(false);
  expect(secondPage.next_cursor).toBeUndefined();
  expect((await browse('?kind=location')).records).toEqual([second]);
  expect((await browse('?query=%25')).records).toEqual([]);
  expect((await browse('?query=_')).records).toEqual([current]);
  expect((await browse('?query=ALPHA')).records).toEqual([current]);
  expect((await browse('?query=hidden')).records).toEqual([]);
});

it('bounds records by response bytes and keeps remaining records pageable', async () => {
  const { store, browse } = await api();
  for (let index = 0; index < 3; index++)
    put(store, `large:${index}`, 'x'.repeat(800_000));
  const page = await browse('?limit=100');
  expect(page.records).toHaveLength(2);
  expect(page.has_more).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
    WORLD_BROWSE_RESPONSE_BYTES,
  );
  const next = await browse(`?cursor=${page.next_cursor!}`);
  expect(next.records).toHaveLength(1);
  expect(next.records[0]!.ref.id).not.toBe(page.records[0]!.ref.id);
  expect(next.records[0]!.ref.id).not.toBe(page.records[1]!.ref.id);
  expect(next.has_more).toBe(false);
});

it('reports an oversized stored projection and lets a rebuild repair it', async () => {
  const { origin, store, rebuild, browse } = await api();
  const record = put(store, 'large-projection', 'canonical value');
  // Simulate a corrupt restored projection while retaining its canonical event.
  const oversized = {
    ...record,
    payload: { value: 'x'.repeat(WORLD_BROWSE_RESPONSE_BYTES) },
  };
  store.db
    .prepare('UPDATE world_projection_entities SET body=? WHERE record_id=?')
    .run(JSON.stringify(oversized), record.ref.id);
  const response = await fetch(`${origin}/api/world/records`);
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({
    error: {
      code: 'world_record_too_large',
      message: 'A World Model record exceeds the browse response limit.',
    },
  });
  expect((await rebuild('repair-large-projection')).status).toBe(200);
  expect((await browse()).records).toEqual([record]);
});

it('rejects invalid or duplicate browse parameters and client-selected scopes', async () => {
  const { origin } = await api();
  for (const query of [
    '?limit=101',
    '?limit=0',
    '?limit=1&limit=2',
    '?cursor=-1',
    '?cursor=9007199254740992',
    '?kind=',
    '?query=',
    '?workspace=other',
    '?mode=live',
    '?__proto__=other',
  ])
    expect((await fetch(`${origin}/api/world/records${query}`)).status).toBe(
      400,
    );
});

it('rebuilds only local projections and persists idempotent receipts without new facts', async () => {
  const { store, browse, rebuild, directory } = await api();
  const record = put(store, 'alpha', 'retained');
  const foreignScope = { ...scope, principal: 'another-user' };
  const foreign = put(store, 'foreign', 'secret', 'note', foreignScope);
  const before = store.world.events(scope);
  store.db
    .prepare(
      'DELETE FROM world_projection_entities WHERE principal=? AND workspace=? AND mode=?',
    )
    .run(scope.principal, scope.workspace, scope.mode);
  expect((await browse()).records).toEqual([]);
  const response = await rebuild();
  expect(response.status, await response.clone().text()).toBe(200);
  const result = worldProjectionRebuildResponseSchema.parse(
    await response.json(),
  );
  expect(result).toEqual({
    schema_version: 'haze.world.projection-rebuild.v1',
    mode: 'fixture',
    projection_cursor: 1,
    reused: false,
  });
  expect((await browse()).records).toEqual([record]);
  expect(store.world.record(foreignScope, foreign.ref.id)).toEqual(foreign);
  expect(store.world.events(scope)).toEqual(before);
  put(store, 'newer', 'after rebuild');
  const retry = await rebuild();
  expect(await retry.json()).toEqual({ ...result, reused: true });
  const reopened = new TaskStore(directory, { recover: false });
  try {
    expect(
      reopened.worldRebuildProjections(
        localTaskIdentity,
        'fixture',
        'rebuild-1',
        {},
      ),
    ).toEqual({ ...result, reused: true });
  } finally {
    reopened.close();
  }
  expect(() =>
    store.worldRebuildProjections(localTaskIdentity, 'live', 'rebuild-1', {}),
  ).toThrow('This key was used with different content.');
});

it('rolls back projection changes and leaves no receipt when replay fails', async () => {
  const { store, rebuild } = await api();
  const record = put(store, 'alpha', 'retained');
  store.db
    .prepare('UPDATE world_events SET sequence=2 WHERE principal=?')
    .run(scope.principal);
  const response = await rebuild('failed-rebuild');
  expect(response.status).toBe(500);
  expect(store.world.record(scope, record.ref.id)).toEqual(record);
  expect(store.world.projectionCursor(scope)).toBe(1);
  expect(
    store.db
      .prepare('SELECT receipt FROM operations WHERE key=?')
      .get('failed-rebuild'),
  ).toBeUndefined();
});

it('requires local same-origin JSON mutations, bounded keys and empty rebuild bodies', async () => {
  const { origin, rebuild } = await api();
  const path = `${origin}/api/world/projections/rebuild`;
  for (const headers of [
    { origin: 'https://foreign.example', 'idempotency-key': 'foreign' },
    { 'idempotency-key': 'missing-origin' },
    { origin, 'sec-fetch-site': 'cross-site', 'idempotency-key': 'cross-site' },
  ]) {
    expect(
      (
        await fetch(path, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
  }
  expect(
    (
      await fetch(path, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
  ).toBe(400);
  expect((await rebuild('x'.repeat(201))).status).toBe(400);
  expect((await rebuild('other-body', { scope: 'foreign' })).status).toBe(400);
  expect((await fetch(path)).status).toBe(405);
});
