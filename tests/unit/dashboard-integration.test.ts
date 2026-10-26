import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTaskHandler } from '../../app/tasks/http.js';
import { localTaskIdentity } from '../../app/tasks/runtime.js';
import type { DataSnapshot } from '../../app/contracts/dashboard.js';
import type { TaskRecord } from '../../app/contracts/tasks.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function application(directory?: string) {
  const ownedDirectory = directory === undefined;
  directory ??= await mkdtemp(join(tmpdir(), 'haze-shared-dashboard-'));
  const handler = createTaskHandler({
    stateDirectory: directory,
    mode: 'fixture',
    env: { SAMPLE_MODE: 'true', HAZEOPS_SCHEDULER: 'off' },
  });
  const server = createServer(handler);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No server address.');
  const origin = `http://127.0.0.1:${address.port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await handler.close();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  };
  cleanups.push(async () => {
    await close();
    if (ownedDirectory) {
      const target = resolve(directory);
      const insideTemp = relative(resolve(tmpdir()), target);
      if (
        !insideTemp ||
        insideTemp.startsWith('..') ||
        resolve(tmpdir()) === target
      )
        throw new Error('Unsafe test cleanup target.');
      await rm(target, { recursive: true, force: true });
    }
  });
  const post = (path: string, body: unknown, key = 'integration-key') =>
    fetch(origin + path, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(body),
    });
  return { origin, handler, directory, close, post };
}

it('shows task-collected evidence in dashboard, stream and World Model after restart', async () => {
  const app = await application();
  const response = await app.post('/api/tasks', {
    schema_version: 'haze.task.request.v3',
    objective:
      'Collect current PM2.5 evidence for this explicit synthetic fixture.',
    scope: {
      capability: 'evidence-collection',
      provider: 'open-meteo',
      locations: [
        {
          id: 'shared-fixture-town',
          name: 'Shared Fixture Town',
          region: 'Southeast Asia',
          country: 'Malaysia',
          countryCode: 'MY',
          lat: 3,
          lon: 101,
          timeZone: 'Asia/Kuala_Lumpur',
          aqiStandard: 'Malaysia API',
          populationBand: 'small',
        },
      ],
    },
  });
  expect(response.status).toBe(202);
  const admitted = (await response.json()) as { task_id: string };
  const deadline = Date.now() + 8000;
  let task: TaskRecord;
  do {
    task = app.handler.runtime.store.read(admitted.task_id, localTaskIdentity);
    if (['completed', 'failed', 'waiting', 'paused'].includes(task.status))
      break;
    await new Promise((done) => setTimeout(done, 10));
  } while (Date.now() < deadline);
  expect(task.status, task.error?.message).toBe('completed');
  const snapshot = (await fetch(app.origin + '/api/snapshot').then((r) =>
    r.json(),
  )) as DataSnapshot;
  const item = snapshot.items.find(
    (row) => row.locationId === 'shared-fixture-town',
  );
  expect(item).toMatchObject({
    fictional: true,
    measurements: [{ pollutant: 'pm25', value: 1 }],
  });
  expect(item?.status).not.toBe('verified');
  expect(
    snapshot.sources.some((source) => source.id === 'fixture-open-meteo'),
  ).toBe(true);
  const detail = await fetch(`${app.origin}/api/items/${item!.id}`).then((r) =>
    r.json(),
  );
  expect(detail).toMatchObject({ item: { id: item!.id } });
  const records = (await fetch(
    app.origin + '/api/world/records?kind=haze_fact',
  ).then((r) => r.json())) as {
    records: { ref: { id: string; revision: number; sha256: string } }[];
  };
  expect(records.records.length).toBeGreaterThan(0);
  const retained = records.records.map((record) => record.ref);

  const abort = new AbortController();
  const stream = await fetch(app.origin + '/api/stream', {
    signal: abort.signal,
  });
  expect(stream.headers.get('content-type')).toContain('text/event-stream');
  const reader = stream.body!.getReader();
  let received = '';
  while (
    !received.includes('event: reset') ||
    !received.includes('shared-fixture-town')
  ) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += new TextDecoder().decode(chunk.value);
  }
  expect(received).toContain('shared-fixture-town');
  await reader.cancel();
  abort.abort();
  await app.close();

  const reopened = await application(app.directory);
  const afterRestart = (await fetch(reopened.origin + '/api/snapshot').then(
    (r) => r.json(),
  )) as DataSnapshot;
  expect(afterRestart.items.find((row) => row.id === item!.id)).toEqual(item);
  const reread = (await fetch(
    reopened.origin + '/api/world/records?kind=haze_fact',
  ).then((r) => r.json())) as typeof records;
  expect(reread.records.map((record) => record.ref)).toEqual(retained);
});

it('uses the shared local mutation boundary and gives explicit legacy report guidance', async () => {
  const app = await application();
  expect((await fetch(app.origin + '/api/health')).status).toBe(200);
  const noKey = await fetch(app.origin + '/api/heartbeat/tick', {
    method: 'POST',
    headers: { origin: app.origin, 'content-type': 'application/json' },
    body: '{}',
  });
  expect(noKey.status).toBe(400);
  const foreign = await fetch(app.origin + '/api/heartbeat/tick', {
    method: 'POST',
    headers: {
      origin: 'https://foreign.invalid',
      'content-type': 'application/json',
      'idempotency-key': 'foreign',
    },
    body: '{}',
  });
  expect(foreign.status).toBe(403);
  expect(
    (await app.post('/api/heartbeat/tick', { unexpected: true })).status,
  ).toBe(400);
  const first = await app.post('/api/heartbeat/tick', {}, 'same-heartbeat');
  expect(first.status).toBe(202);
  expect(
    await (await app.post('/api/heartbeat/tick', {}, 'same-heartbeat')).json(),
  ).toEqual(await first.json());
  const retired = await app.post('/api/reports', {
    question: 'Old report request',
  });
  expect(retired.status).toBe(410);
  expect(await retired.json()).toMatchObject({ successor: '/api/tasks' });
  const oldStream = await fetch(app.origin + '/api/reports/task_old/events');
  expect(await oldStream.text()).toContain('event: failed');
});
