import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancellationSchema,
  orchestrationEventPageSchema,
  orchestrationTaskSchema,
} from '../../app/orchestration/contracts.js';
import { createPm25FixturePorts } from '../../app/orchestration/example.js';
import { createFixtureCapture } from '../../app/orchestration/fixtures.js';
import type { NightShiftPort } from '../../app/orchestration/ports.js';
import {
  taskAdmissionSchema,
  taskRecordSchema,
} from '../../app/tasks/contracts.js';
import { PM25_SOURCE_ID } from '../../app/tasks/evidence.js';
import { createTaskHandler } from '../../app/tasks/http.js';
import { localTaskIdentity } from '../../app/tasks/runtime.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function request(version: 1 | 2 = 2) {
  return {
    schema_version: `haze.task.request.v${version}`,
    objective: 'Summarize PM2.5 for Klang during 2026-10-24 to 2026-10-25.',
    scope: {
      location: 'Klang',
      period: {
        start: '2026-10-24T00:00:00Z',
        end: '2026-10-25T00:00:00Z',
      },
    },
  };
}

async function httpServer(
  options: Partial<Parameters<typeof createTaskHandler>[0]> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'haze-hybrid-http-'));
  const handler = createTaskHandler({
    stateDirectory: directory,
    source: {
      id: PM25_SOURCE_ID,
      retrieve: (scope) => Promise.resolve(createFixtureCapture(scope)),
    },
    model: {
      selection: { provider: 'fixture-v1', model: 'fixture-v1-model' },
      complete: () =>
        Promise.resolve(
          JSON.stringify({ answer: 'Synthetic PM2.5 evidence only [E1].' }),
        ),
    },
    orchestrationPorts: createPm25FixturePorts(),
    ...options,
  });
  const server = createServer(handler);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No HTTP test address.');
  const base = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await handler.close();
    const target = resolve(directory);
    const withinTemporary = relative(resolve(tmpdir()), target);
    if (withinTemporary.startsWith('..') || !withinTemporary)
      throw new Error('Unsafe test cleanup target.');
    rmSync(target, { recursive: true, force: true });
  });
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const submit = (body: unknown, key: string = randomUUID()) =>
    post('/api/tasks', body, { 'Idempotency-Key': key });
  const settled = (id: string, version: 1 | 2 = 2) =>
    vi.waitFor(() => {
      const task =
        version === 2
          ? handler.orchestration.store.read(id, localTaskIdentity)
          : handler.runtime.store.read(id, localTaskIdentity);
      expect(['queued', 'running']).not.toContain(task.status);
      return task;
    });
  return { base, handler, post, submit, settled };
}

describe('orchestration task HTTP boundary', () => {
  it('serves v1 and v2 on the same API with contract-scoped idempotency and receipt schemas', async () => {
    const api = await httpServer();
    const v1Response = await api.submit(request(1), 'shared-version-key');
    const v2Response = await api.submit(request(2), 'shared-version-key');
    expect(v1Response.status).toBe(202);
    expect(v2Response.status).toBe(202);
    const v1Admission = taskAdmissionSchema.parse(await v1Response.json());
    const v2Admission = taskAdmissionSchema.parse(await v2Response.json());
    expect(v1Admission.task_id).not.toBe(v2Admission.task_id);
    expect(v2Response.headers.get('Location')).toBe(v2Admission.status_url);
    await api.settled(v1Admission.task_id, 1);
    await api.settled(v2Admission.task_id);
    const v1 = taskRecordSchema.parse(
      await (await fetch(`${api.base}${v1Admission.status_url}`)).json(),
    );
    const v2 = orchestrationTaskSchema.parse(
      await (await fetch(`${api.base}${v2Admission.status_url}`)).json(),
    );
    expect(v1.status).toBe('completed');
    expect(v1.result?.provenance.model.calls).toBe(1);
    expect(v2.status).toBe('completed');
    expect(v2.mode).toBe('fixture');
    expect(v2.assignments).toHaveLength(5);
    expect(v2.result?.provenance).toMatchObject({
      mode: 'fixture',
      model: { calls: 5, provider: 'fixture', model: 'fixture-nightshift' },
    });
    const events = orchestrationEventPageSchema.parse(
      await (await fetch(`${api.base}${v2Admission.events_url}`)).json(),
    );
    expect(events.events[0]?.type).toBe('task_admitted');
    expect(events.events.some((event) => event.actor === 'WorkerShield')).toBe(
      true,
    );
    const tail = orchestrationEventPageSchema.parse(
      await (
        await fetch(
          `${api.base}${v2Admission.events_url}?after=${events.next_cursor}`,
        )
      ).json(),
    );
    expect(tail.events).toEqual([]);
    expect(tail.next_cursor).toBe(events.next_cursor);
    const repeat = taskAdmissionSchema.parse(
      await (await api.submit(request(2), 'shared-version-key')).json(),
    );
    expect(repeat).toMatchObject({ task_id: v2.id, reused: true });
    expect(
      api.handler.orchestration.store.read(v2.id, localTaskIdentity).usage,
    ).toEqual(v2.usage);
  });

  it('cancels durably once, fences late model completion and preserves the cancellation generation', async () => {
    const ports = createPm25FixturePorts();
    let finish:
      | ((completion: Awaited<ReturnType<NightShiftPort['execute']>>) => void)
      | undefined;
    const execute = vi.fn<NightShiftPort['execute']>(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    ports.nightshift = { ...ports.nightshift, execute };
    const api = await httpServer({ orchestrationPorts: ports });
    const admission = taskAdmissionSchema.parse(
      await (await api.submit(request(), 'pending')).json(),
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const cancelPath = `${admission.status_url}/cancel`;
    const cancelled = cancellationSchema.parse(
      await (
        await api.post(cancelPath, {}, { 'Idempotency-Key': 'cancel-once' })
      ).json(),
    );
    expect(cancelled).toMatchObject({
      task_id: admission.task_id,
      status: 'cancelled',
      generation: 2,
    });
    const repeat = cancellationSchema.parse(
      await (
        await api.post(cancelPath, {}, { 'Idempotency-Key': 'cancel-once' })
      ).json(),
    );
    const another = cancellationSchema.parse(
      await (
        await api.post(cancelPath, {}, { 'Idempotency-Key': 'cancel-again' })
      ).json(),
    );
    expect(repeat).toEqual(cancelled);
    expect(another).toEqual(cancelled);
    const before = api.handler.orchestration.store.read(
      admission.task_id,
      localTaskIdentity,
    );
    const events = api.handler.orchestration.store.events(
      admission.task_id,
      localTaskIdentity,
      0,
    );
    expect(
      events.events.filter((event) => event.type === 'task_cancelled'),
    ).toHaveLength(1);
    expect(before.usage.model_calls).toBe(1);
    finish!({
      text: JSON.stringify({
        capability: 'pm25-evidence-summary',
        roles: ['HazeOps', 'WorkerShield', 'EvidenceCritic'],
      }),
      receipt: {
        response_model: 'late-fixture',
        response_id: null,
        input_tokens: null,
        output_tokens: null,
      },
    });
    await new Promise<void>((done) => setImmediate(done));
    expect(
      api.handler.orchestration.store.read(
        admission.task_id,
        localTaskIdentity,
      ),
    ).toEqual(before);
    expect(
      api.handler.orchestration.store.events(
        admission.task_id,
        localTaskIdentity,
        0,
      ),
    ).toEqual(events);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(before.result).toBeUndefined();
  });

  it('denies malformed cancellation identity/grants and requires same-origin JSON and an operation key', async () => {
    const ports = createPm25FixturePorts();
    const execute = vi.fn<NightShiftPort['execute']>(
      () => new Promise(() => undefined),
    );
    ports.nightshift = { ...ports.nightshift, execute };
    const api = await httpServer({ orchestrationPorts: ports });
    const admission = taskAdmissionSchema.parse(
      await (await api.submit(request())).json(),
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const path = `${admission.status_url}/cancel`;
    for (const body of [
      { identity: { principal: 'admin' } },
      { generation: 99 },
      { permissions: { tools: ['arbitrary'] } },
      [],
    ]) {
      expect((await api.post(path, body)).status).toBe(400);
    }
    expect(
      (await api.post(path, {}, { Origin: 'https://attacker.invalid' })).status,
    ).toBe(403);
    expect(
      (await api.post(path, {}, { 'Sec-Fetch-Site': 'cross-site' })).status,
    ).toBe(403);
    expect((await api.post(path, {}, { 'Idempotency-Key': '' })).status).toBe(
      400,
    );
    expect(
      (await api.post(path, {}, { 'Content-Type': 'text/plain' })).status,
    ).toBe(415);
    expect(
      (
        await fetch(`${api.base}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': 'no-origin',
          },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect(
      api.handler.orchestration.store.read(
        admission.task_id,
        localTaskIdentity,
      ),
    ).toMatchObject({ status: 'running', generation: 1 });
    expect((await api.post(path, {})).status).toBe(200);
  });

  it('serves exact artifacts and denies cross-task paths and inaccessible principal/workspace records', async () => {
    const api = await httpServer();
    const firstAdmission = taskAdmissionSchema.parse(
      await (await api.submit(request())).json(),
    );
    await api.settled(firstAdmission.task_id);
    const first = api.handler.orchestration.store.read(
      firstAdmission.task_id,
      localTaskIdentity,
    );
    const citation = first.result!.citations[0]!;
    const artifactResponse = await fetch(`${api.base}${citation.url}`);
    expect(artifactResponse.status).toBe(200);
    expect(await artifactResponse.json()).toMatchObject({
      task_id: first.id,
      id: citation.artifact_id,
      sha256: citation.sha256,
      schema_version: 'haze.artifact.v2',
    });
    const secondAdmission = taskAdmissionSchema.parse(
      await (await api.submit(request())).json(),
    );
    await api.settled(secondAdmission.task_id);
    expect(
      (
        await fetch(
          `${api.base}${secondAdmission.status_url}/artifacts/${citation.artifact_id}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(
          `${api.base}${firstAdmission.status_url}/artifacts/${randomUUID()}`,
        )
      ).status,
    ).toBe(404);
    const otherIdentity = {
      principal: 'other-user',
      workspace: 'other-workspace',
    };
    const foreignAdmission = api.handler.orchestration.admit(
      request(),
      'foreign-record',
      otherIdentity,
    );
    const foreign = await vi.waitFor(() => {
      const task = api.handler.orchestration.store.read(
        foreignAdmission.task_id,
        otherIdentity,
      );
      expect(['queued', 'running']).not.toContain(task.status);
      return task;
    });
    expect(foreign.status).toBe('completed');
    expect(
      (await fetch(`${api.base}${foreignAdmission.status_url}`)).status,
    ).toBe(404);
    expect(
      (await fetch(`${api.base}${foreignAdmission.events_url}`)).status,
    ).toBe(404);
    expect(
      (await fetch(`${api.base}${foreign.result!.citations[0]!.url}`)).status,
    ).toBe(404);
  });

  it('rejects client-owned authority and mismatched exact context hashes before starting a new task', async () => {
    const api = await httpServer();
    expect(
      (
        await api.submit({
          ...request(),
          identity: { principal: 'admin', workspace: 'admin' },
        })
      ).status,
    ).toBe(400);
    expect((await api.submit({ ...request(), generation: 9 })).status).toBe(
      400,
    );
    const admission = taskAdmissionSchema.parse(
      await (await api.submit(request())).json(),
    );
    await api.settled(admission.task_id);
    const source = api.handler.orchestration.store.read(
      admission.task_id,
      localTaskIdentity,
    );
    const citation = source.result!.citations[0]!;
    const invalid = await api.submit({
      ...request(),
      context_refs: [
        { id: citation.artifact_id, version: 1, sha256: '0'.repeat(64) },
      ],
    });
    expect(invalid.status).toBe(409);
    expect(
      api.handler.orchestration.store.db
        .prepare('SELECT COUNT(*) AS count FROM hybrid_tasks')
        .get(),
    ).toMatchObject({ count: 1 });
  });
});
