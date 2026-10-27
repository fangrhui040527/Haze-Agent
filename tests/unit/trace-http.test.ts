import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTaskHandler } from '../../app/tasks/http.js';
import { localTaskIdentity } from '../../app/tasks/runtime.js';
import { taskRequestSchema } from '../../app/contracts/tasks.js';
import {
  tracePageSchema,
  evidenceBundleSchema,
} from '../../app/contracts/trace-export.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function api() {
  const directory = await mkdtemp(join(tmpdir(), 'haze-trace-http-'));
  const handler = createTaskHandler({
    stateDirectory: directory,
    mode: 'fixture',
    env: { HAZE_TRACE_FILES: 'off', HAZE_TRACE_STDOUT: 'off' },
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server');
  const origin = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await handler.close();
    const rel = relative(resolve(tmpdir()), resolve(directory));
    if (!rel || rel.startsWith('..')) throw new Error('Unsafe cleanup');
    await rm(directory, { recursive: true, force: true });
  });
  const admit = () =>
    handler.runtime.store.admit(
      taskRequestSchema.parse({
        schema_version: 'haze.task.request.v3',
        objective: 'Trace a deterministic fixture.',
      }),
      localTaskIdentity,
      randomUUID(),
      { mode: 'fixture', tools: [] },
    ).task;
  return { origin, handler, admit };
}

it('serves validated paginated traces and no-store attachment downloads within local authorization', async () => {
  const { origin, handler, admit } = await api();
  const task = admit();
  for (let index = 0; index < 110; index++)
    handler.runtime.store.appendEvent(
      task.id,
      'test_step',
      'Runtime',
      `Step ${index}`,
    );
  const current = handler.runtime.store.read(task.id, localTaskIdentity);
  handler.runtime.store.control(task.id, localTaskIdentity, randomUUID(), {
    schema_version: 'haze.task.control.v3',
    action: 'pause',
    expected_run_id: current.current_run_id,
    expected_objective_revision: current.objective_revision,
    expected_generation: current.generation,
    expected_state_revision: current.state_revision,
  });
  const base = `${origin}/api/tasks/${task.id}/runs/${task.current_run_id}`;
  const response = await fetch(`${base}/trace?after=0&limit=100`);
  expect(response.status).toBe(200);
  const first = tracePageSchema.parse(await response.json());
  expect(first.records).toHaveLength(100);
  expect(first.has_more).toBe(true);
  expect(first.sink_health).toBeDefined();
  const second = tracePageSchema.parse(
    await fetch(`${base}/trace?after=${first.next_cursor}`).then((item) =>
      item.json(),
    ),
  );
  expect(second.records.every((item) => item.cursor > first.next_cursor)).toBe(
    true,
  );
  const jsonlResponse = await fetch(`${base}/trace?format=jsonl`);
  expect(jsonlResponse.headers.get('content-disposition')).toContain(
    'attachment;',
  );
  expect(jsonlResponse.headers.get('cache-control')).toBe('no-store');
  const jsonl = (await jsonlResponse.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { event_id: string });
  const download = await fetch(`${base}/evidence-bundle`);
  expect(download.headers.get('content-disposition')).toContain(
    'evidence-bundle.json',
  );
  expect(download.headers.get('cache-control')).toBe('no-store');
  const bundle = evidenceBundleSchema.parse(await download.json());
  expect(bundle.manifest.active_snapshot).toBe(true);
  expect(bundle.records.map((item) => item.event_id)).toEqual(
    jsonl.map((item) => item.event_id),
  );
  expect(
    (
      await fetch(`${base}/trace`, {
        headers: { origin: 'https://foreign.example' },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${base}/trace`, {
        headers: { 'sec-fetch-site': 'cross-site' },
      })
    ).status,
  ).toBe(403);
});

it('rejects foreign task/run combinations, malformed queries, duplicate keys and unsupported methods', async () => {
  const { origin, admit } = await api();
  const task = admit(),
    foreign = admit();
  const base = `${origin}/api/tasks/${task.id}/runs/${task.current_run_id}`;
  expect(
    (
      await fetch(
        `${origin}/api/tasks/${task.id}/runs/${foreign.current_run_id}/trace`,
      )
    ).status,
  ).toBe(404);
  for (const query of [
    'after=-1',
    'after=1.5',
    'limit=101',
    'limit=0',
    'after=0&after=1',
    'unexpected=1',
    'format=json',
    'format=jsonl&after=0',
  ])
    expect((await fetch(`${base}/trace?${query}`)).status).toBe(400);
  expect((await fetch(`${base}/evidence-bundle?after=0`)).status).toBe(400);
  expect(
    (await fetch(`${base}/trace`, { method: 'POST', headers: { origin } }))
      .status,
  ).toBe(405);
});
