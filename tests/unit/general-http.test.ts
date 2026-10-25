import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTaskHandler } from '../../app/tasks/http.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No local server');
  return `http://127.0.0.1:${address.port}`;
}
async function api() {
  const directory = await mkdtemp(join(tmpdir(), 'haze-general-http-'));
  const handler = createTaskHandler({
    stateDirectory: directory,
    mode: 'fixture',
  });
  const server = createServer(handler);
  const origin = await listen(server);
  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await handler.close();
    await rm(directory, { recursive: true, force: true });
  });
  const post = (path: string, value: unknown, key = 'key') =>
    fetch(origin + path, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(value),
    });
  return { origin, post };
}
it('serves one general API and immutable source imports with idempotency', async () => {
  const { origin, post } = await api();
  const capabilities = (await fetch(origin + '/api/capabilities').then(
    (response) => response.json(),
  )) as unknown[];
  expect(capabilities.length).toBeGreaterThan(0);
  const upload = {
    schema_version: 'haze.artifact.import.v3',
    filename: 'note.md',
    media_type: 'text/markdown',
    content_base64: Buffer.from('A graph has nodes and edges.').toString(
      'base64',
    ),
  };
  const source = (await post('/api/artifacts', upload).then((response) =>
    response.json(),
  )) as { id: string; version: number; sha256: string };
  expect(
    (
      (await post('/api/artifacts', upload).then((response) =>
        response.json(),
      )) as { id: string }
    ).id,
  ).toBe(source.id);
  const response = await post('/api/tasks', {
    schema_version: 'haze.task.request.v3',
    objective: 'Explain the note.',
    context_refs: [
      { id: source.id, version: source.version, sha256: source.sha256 },
    ],
  });
  expect(response.status).toBe(202);
  const admission = (await response.json()) as { task_id: string };
  expect(
    (await fetch(`${origin}/api/tasks/${admission.task_id}/events?after=no`))
      .status,
  ).toBe(400);
  expect((await fetch(`${origin}/api/artifacts/${source.id}`)).status).toBe(
    200,
  );
});
it('rejects foreign origins, missing keys and legacy protocol explicitly', async () => {
  const { origin, post } = await api();
  expect(
    (
      await fetch(origin + '/api/tasks', {
        method: 'POST',
        headers: {
          origin: 'https://foreign.example',
          'content-type': 'application/json',
        },
        body: '{}',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(origin + '/api/tasks', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
  ).toBe(400);
  const legacy = await post('/api/tasks', {
    schema_version: 'haze.task.request.v2',
    objective: 'test',
  });
  expect(legacy.status).toBe(400);
  expect(await legacy.text()).toContain('v1/v2 have been retired');
});
it('accepts a full 1 MiB decoded UTF-8 source within the separate transport limit', async () => {
  const { post } = await api();
  const response = await post('/api/artifacts', {
    schema_version: 'haze.artifact.import.v3',
    filename: 'large.txt',
    media_type: 'text/plain',
    content_base64: Buffer.alloc(1024 * 1024, 65).toString('base64'),
  });
  expect(response.status, await response.clone().text()).toBe(201);
});
