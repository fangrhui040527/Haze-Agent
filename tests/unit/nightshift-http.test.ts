import { createServer, IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TaskError } from '../../app/contracts/tasks.js';
import { jobsReadinessSchema } from '../../app/contracts/nightshift.js';
import type { NightshiftJobPort } from '../../app/orchestration/ports.js';
import {
  handleNightshiftHttp,
  type NightshiftHttpService,
} from '../../app/tasks/nightshift-http.js';

const localTaskIdentity = {
  principal: 'local-user',
  workspace: 'local-workspace',
};

function fixture(path: string, method = 'GET', key?: string) {
  const request = new IncomingMessage(new Socket());
  request.method = method;
  if (key) request.headers['idempotency-key'] = key;
  const result = { persisted: true };
  const service: NightshiftHttpService = {
    readiness: vi.fn(() => result),
    automationReadiness: vi.fn(() => result),
    chainAutomation: vi.fn(() => result),
    proposeProgress: vi.fn(() => result),
    admitChain: vi.fn(() => result),
    listChains: vi.fn(() => result),
    chain: vi.fn(() => result),
    controlChain: vi.fn(() => result),
    submitJob: vi.fn(() => result),
    listJobs: vi.fn(() => result),
    job: vi.fn(() => result),
    cancelJob: vi.fn(() => result),
    reconcileJob: vi.fn(() => result),
    selectResult: vi.fn(() => result),
    events: vi.fn(() => result),
  };
  const body = { schema_version: 'test.v1', exact: 'unchanged' };
  const readBody = vi.fn(() => Promise.resolve(body));
  const send = vi.fn();
  const externalWaitView = vi.fn(() => result);
  const idempotencyKey = vi.fn((req: IncomingMessage) => {
    const value = req.headers['idempotency-key'];
    if (typeof value !== 'string')
      throw new TaskError(400, 'idempotency_key_required', 'Provide a key.');
    return value;
  });
  const execute = () =>
    handleNightshiftHttp({
      request,
      url: new URL(path, 'http://127.0.0.1'),
      identity: localTaskIdentity,
      service,
      externalWaitView,
      readBody,
      idempotencyKey,
      send,
    });
  return {
    execute,
    service,
    externalWaitView,
    readBody,
    idempotencyKey,
    send,
    body,
    result,
  };
}

async function removeIsolatedState(directory: string) {
  const path = relative(resolve(tmpdir()), resolve(directory));
  if (!path || path.startsWith('..'))
    throw new Error('Unsafe isolated-state cleanup target.');
  await rm(directory, { recursive: true, force: true });
}

describe('Nightshift HTTP dispatch', () => {
  it('accepts an explicit bounded progress proposal with the original request identity', async () => {
    const f = fixture(
      '/api/nightshift/chains/chain-1/progress',
      'POST',
      'progress-key',
    );
    await f.execute();
    expect(f.service.proposeProgress).toHaveBeenCalledExactlyOnceWith(
      'chain-1',
      f.body,
      'progress-key',
      localTaskIdentity,
    );
    expect(f.readBody).toHaveBeenCalledWith(
      expect.any(IncomingMessage),
      65_536,
    );
    expect(f.send).toHaveBeenCalledWith(200, f.result);
    await expect(
      fixture('/api/nightshift/chains/chain-1/progress').execute(),
    ).rejects.toMatchObject({ status: 405 });
    await expect(
      fixture('/api/nightshift/chains/chain-1/progress', 'POST').execute(),
    ).rejects.toMatchObject({ code: 'idempotency_key_required' });
  });
  it.each([
    ['/api/nightshift/automation/readiness', 'automationReadiness'],
    ['/api/nightshift/chains/chain-1/automation', 'chainAutomation'],
  ] as const)(
    'reads automatic chain state at %s without creating authority',
    async (path, name) => {
      const f = fixture(path);
      expect(await f.execute()).toBe(true);
      expect(f.service[name]).toHaveBeenCalledOnce();
      expect(f.send).toHaveBeenCalledWith(200, f.result);
      expect(f.idempotencyKey).not.toHaveBeenCalled();
      expect(f.readBody).not.toHaveBeenCalled();
      await expect(fixture(path, 'POST').execute()).rejects.toMatchObject({
        status: 405,
      });
      await expect(
        fixture(`${path}?enable=true`).execute(),
      ).rejects.toMatchObject({ code: 'invalid_query' });
    },
  );
  it('reads exact task wait and capacity records without accepting a mutation or cursor', async () => {
    const f = fixture('/api/nightshift/tasks/task-1/waits');
    expect(await f.execute()).toBe(true);
    expect(f.externalWaitView).toHaveBeenCalledExactlyOnceWith(
      'task-1',
      localTaskIdentity,
    );
    expect(f.send).toHaveBeenCalledWith(200, f.result);
    expect(f.idempotencyKey).not.toHaveBeenCalled();
    expect(f.readBody).not.toHaveBeenCalled();
    await expect(
      fixture('/api/nightshift/tasks/task-1/waits', 'POST').execute(),
    ).rejects.toMatchObject({ status: 405 });
    await expect(
      fixture('/api/nightshift/tasks/task-1/waits?after=2').execute(),
    ).rejects.toMatchObject({ code: 'invalid_query' });
  });
  it.each([
    ['/api/nightshift/jobs/readiness', 'readiness'],
    ['/api/nightshift/jobs', 'listJobs'],
    ['/api/nightshift/chains', 'listChains'],
    ['/api/nightshift/jobs/job-1', 'job'],
    ['/api/nightshift/chains/chain-1', 'chain'],
  ] as const)(
    'reads persisted state at %s without creating mutation identity',
    async (path, name) => {
      const f = fixture(path);
      expect(await f.execute()).toBe(true);
      expect(f.service[name]).toHaveBeenCalledOnce();
      expect(f.send).toHaveBeenCalledWith(200, f.result);
      expect(f.idempotencyKey).not.toHaveBeenCalled();
      expect(f.readBody).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['/api/nightshift/chains', 'admitChain', 201],
    ['/api/nightshift/jobs', 'submitJob', 202],
    ['/api/nightshift/chains/chain-1/control', 'controlChain', 200],
    ['/api/nightshift/jobs/job-1/cancel', 'cancelJob', 200],
    ['/api/nightshift/jobs/job-1/reconcile', 'reconcileJob', 200],
    ['/api/nightshift/jobs/job-1/select', 'selectResult', 200],
  ] as const)(
    'routes explicit versioned mutation %s with its original body and key',
    async (path, name, status) => {
      const f = fixture(path, 'POST', 'stable-key');
      expect(await f.execute()).toBe(true);
      expect(f.service[name]).toHaveBeenCalledOnce();
      expect(f.readBody).toHaveBeenCalledWith(
        expect.any(IncomingMessage),
        65_536,
      );
      expect(f.idempotencyKey).toHaveBeenCalledOnce();
      expect(f.send).toHaveBeenCalledWith(status, f.result);
      if (name === 'admitChain' || name === 'submitJob')
        expect(f.service[name]).toHaveBeenCalledWith(
          f.body,
          'stable-key',
          localTaskIdentity,
        );
      else
        expect(f.service[name]).toHaveBeenCalledWith(
          name === 'controlChain' ? 'chain-1' : 'job-1',
          f.body,
          'stable-key',
          localTaskIdentity,
        );
    },
  );
  it('rejects missing mutation keys before reading a request body', async () => {
    const f = fixture('/api/nightshift/jobs', 'POST');
    await expect(f.execute()).rejects.toMatchObject({
      status: 400,
      code: 'idempotency_key_required',
    });
    expect(f.readBody).not.toHaveBeenCalled();
    expect(f.service.submitJob).not.toHaveBeenCalled();
  });
  it('passes a bounded reconnect cursor without repeating mutations', async () => {
    const f = fixture('/api/nightshift/jobs/job-1/events?after=42');
    await f.execute();
    expect(f.service.events).toHaveBeenCalledWith(
      'job-1',
      42,
      localTaskIdentity,
    );
    expect(f.service.submitJob).not.toHaveBeenCalled();
  });
  it.each([
    ['/api/nightshift/jobs?token=secret', 'GET', 400],
    ['/api/nightshift/jobs/job-1/events?after=1&after=2', 'GET', 400],
    ['/api/nightshift/jobs/job-1/events?after=-1', 'GET', 400],
    ['/api/nightshift/jobs/job-1/events?after=9007199254740992', 'GET', 400],
    ['/api/nightshift/jobs/job-1/events', 'POST', 405],
    ['/api/nightshift/jobs/job-1/control', 'POST', 404],
    ['/api/nightshift/chains/chain-1/select', 'POST', 404],
    ['/api/nightshift/jobs/job-1', 'DELETE', 405],
  ] as const)(
    'rejects unsupported request %s %s',
    async (path, method, status) => {
      const f = fixture(path, method, 'key');
      await expect(f.execute()).rejects.toMatchObject({ status });
      expect(f.service.submitJob).not.toHaveBeenCalled();
    },
  );
});

it('serves blocked job readiness and persisted lists through the local same-origin boundary without submission', async () => {
  const { createTaskHandler } = await import('../../app/tasks/http.js');
  const directory = await mkdtemp(join(tmpdir(), 'haze-nightshift-http-'));
  const unavailable = () =>
    Promise.reject(new Error('Unexpected external operation.'));
  const submit = vi.fn(unavailable);
  const port: NightshiftJobPort = {
    readiness: () =>
      Promise.resolve(
        jobsReadinessSchema.parse({
          schema_version: 'haze.nightshift.jobs.readiness.v1',
          checked_at: new Date().toISOString(),
          cli_available: false,
          schema_compatible: false,
          runtime_reachable: false,
          local_only_enforced: false,
          cloud_enforced: false,
          ready: false,
          runtime_version: null,
          adapter_version: 'isolated-fixture',
          schema_hash: null,
          can_reconcile: false,
          cancellation_idempotent: false,
          reason: 'The local runtime is unavailable.',
          options: {
            judges: [],
            budgets: [],
            windows: [],
            max_attempts: 16,
            fleets: [],
          },
        }),
      ),
    submit,
    inspect: unavailable,
    outcome: unavailable,
    result: unavailable,
    cancel: unavailable,
    verifyReconciliation: unavailable,
  };
  const handler = createTaskHandler({
    stateDirectory: directory,
    mode: 'fixture',
    env: {},
    nightshiftJobs: port,
  });
  const server = createServer(handler);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No isolated server address.');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const readiness = await fetch(origin + '/api/nightshift/jobs/readiness');
    expect(readiness.status).toBe(200);
    expect(readiness.headers.get('cache-control')).toBe('no-store');
    expect(await readiness.json()).toMatchObject({
      ready: false,
      reason: 'The local runtime is unavailable.',
    });
    const automaticReadiness = await fetch(
      origin + '/api/nightshift/automation/readiness',
    );
    expect(automaticReadiness.status).toBe(200);
    expect(await automaticReadiness.json()).toMatchObject({
      schema_version: 'haze.nightshift.automatic.readiness.v1',
      released: false,
      ready: false,
      evidence_id: null,
      evidence_kind: null,
    });
    expect(
      (await fetch(origin + '/api/nightshift/chains/not-admitted/automation'))
        .status,
    ).toBe(404);
    expect(
      await fetch(origin + '/api/nightshift/chains').then((response) =>
        response.json(),
      ),
    ).toEqual({ version: 1, chains: [] });
    expect(
      await fetch(origin + '/api/nightshift/jobs').then((response) =>
        response.json(),
      ),
    ).toEqual({ version: 1, jobs: [] });
    expect(
      (
        await fetch(origin + '/api/nightshift/jobs', {
          headers: { origin: 'https://foreign.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(origin + '/api/nightshift/jobs', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'no-origin',
          },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(origin + '/api/nightshift/jobs', {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(origin + '/api/nightshift/jobs', {
          method: 'POST',
          headers: {
            origin,
            'content-type': 'application/json',
            'idempotency-key': 'invalid-body',
          },
          body: '{"schema_version":"haze.nightshift.job.submit.v1","privacy":"cloud-ok"}',
        })
      ).status,
    ).toBe(400);
    expect(
      (await fetch(origin + '/api/nightshift/jobs/readiness?after=0')).status,
    ).toBe(400);
    expect(
      (
        await fetch(
          origin + '/api/nightshift/jobs/unknown/events?after=1&after=2',
        )
      ).status,
    ).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await handler.close();
    await removeIsolatedState(directory);
  }
});
