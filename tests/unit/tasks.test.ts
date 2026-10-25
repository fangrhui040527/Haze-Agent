import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentModel } from '../../app/adapters/agent-model.js';
import { contractHash } from '../../app/contracts/json.js';
import {
  taskAdmissionSchema,
  taskEventPageSchema,
  taskRecordSchema,
  taskRequestSchema,
  type TaskIdentity,
  type TaskRequest,
} from '../../app/tasks/contracts.js';
import {
  EvidenceSourceError,
  PM25_SOURCE_ID,
  type EvidenceCapture,
  type EvidenceScope,
  type EvidenceSource,
} from '../../app/tasks/evidence.js';
import { createTaskHandler } from '../../app/tasks/http.js';
import { localTaskIdentity, TaskRuntime } from '../../app/tasks/runtime.js';

// All adapters in this file are deliberately synthetic test doubles. They
// verify wiring and enforcement, and provide no evidence of live readiness.
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function stateDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'haze-task-test-'));
  const parent = resolve(tmpdir());
  cleanups.push(() => {
    const target = resolve(directory);
    if (!target.startsWith(`${parent}\\`) && !target.startsWith(`${parent}/`)) {
      throw new Error('Test cleanup target escaped the temporary directory.');
    }
    rmSync(target, { recursive: true, force: true });
  });
  return directory;
}

function request(overrides: Partial<TaskRequest> = {}): TaskRequest {
  return taskRequestSchema.parse({
    schema_version: 'haze.task.request.v1',
    objective:
      'Summarize the PM2.5 evidence available for Test Town during 2026-10-01T00:00:00Z to 2026-10-01T03:00:00Z, distinguish modeled values from observations, and identify coverage gaps.',
    scope: {
      location: 'Test Town',
      period: {
        start: '2026-10-01T00:00:00Z',
        end: '2026-10-01T03:00:00Z',
      },
    },
    ...overrides,
  });
}

function capture(scope: EvidenceScope, missing = false): EvidenceCapture {
  const from = Date.parse(scope.period.start);
  const rows = [0, 1, 2]
    .filter((hour) => !missing || hour !== 1)
    .map((hour) => ({
      start: new Date(from + hour * 3_600_000).toISOString(),
      end: new Date(from + hour * 3_600_000).toISOString(),
      value: 10 + hour,
      issued_at: null,
      location: scope.location,
      ingested_at: '2026-10-01T04:00:00Z',
      latitude: null,
      longitude: null,
    }));
  return {
    source: PM25_SOURCE_ID,
    kind: 'modeled',
    units: 'µg/m³',
    location: scope.location,
    retrieved_at: '2026-10-01T05:00:00Z',
    issued_at: null,
    rows,
    raw: JSON.stringify({ synthetic_test_rows: rows }),
    selection: {
      backend: 'zetaris-rest',
      query: 'synthetic test selection; no remote SQL executed',
      request_id: 'synthetic-fixture',
      row_limit: 1500,
      returned_rows: rows.length,
      truncated: false,
      source_filter: 'open-meteo-air-quality',
      selected_raw_row_indices: rows.map((_, index) => index),
    },
    limitations: ['Synthetic fixture; spatial representativeness is unknown.'],
    mode: 'live',
    temporal_support: 'instantaneous',
    sample_interval_minutes: 60,
    units_reference: 'https://example.invalid/test-units',
  };
}

function adapters(missing = false) {
  const retrieve = vi.fn<EvidenceSource['retrieve']>((scope) =>
    Promise.resolve(capture(scope, missing)),
  );
  const complete = vi.fn<AgentModel['complete']>().mockResolvedValue(
    JSON.stringify({
      answer:
        'The exact selection contains instantaneous modeled PM2.5 values [E1]. Observations were not queried; provider issuance and spatial representativeness remain unknown. See the reported missing sample intervals.',
    }),
  );
  return {
    source: { id: PM25_SOURCE_ID, retrieve },
    model: {
      selection: { provider: 'synthetic-test', model: 'synthetic-test-model' },
      complete,
    },
  };
}

function runtime(
  options: Partial<ConstructorParameters<typeof TaskRuntime>[0]> = {},
) {
  const instance = new TaskRuntime({
    stateDirectory: stateDirectory(),
    ...adapters(),
    ...options,
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await instance.close();
  };
  cleanups.push(close);
  return { instance, close };
}

async function settled(
  instance: TaskRuntime,
  id: string,
  identity: TaskIdentity = localTaskIdentity,
) {
  return vi.waitFor(() => {
    const task = instance.store.read(id, identity);
    expect(['queued', 'running']).not.toContain(task.status);
    return task;
  });
}

async function httpServer(
  options: Partial<ConstructorParameters<typeof TaskRuntime>[0]> = {},
) {
  const handler = createTaskHandler({
    stateDirectory: stateDirectory(),
    ...adapters(),
    ...options,
  });
  const server = createServer(handler);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No test address.');
  const base = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await handler.close();
  });
  const submit = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        'Idempotency-Key': randomUUID(),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { base, handler, submit };
}

describe('read-only evidence task runtime', () => {
  it('durably admits a request and produces prose citing the immutable exact capture', async () => {
    const doubles = adapters();
    const { instance } = runtime(doubles);
    const original = request({ constraints: ['Explain unknown issuance.'] });
    const admitted = instance.admit(original, 'supported');
    const initial = instance.store.read(admitted.task_id, localTaskIdentity);
    expect(initial.status).toBe('queued');
    expect(initial.usage).toEqual({
      tool_calls: 0,
      model_calls: 0,
      artifacts: 0,
    });
    expect(doubles.source.retrieve).not.toHaveBeenCalled();
    expect(initial.original_request).toEqual(original);
    expect(initial.objective_revision).toBe(1);
    expect(initial.permissions.effects).toEqual([]);

    const task = await settled(instance, admitted.task_id);
    expect(task.status).toBe('completed');
    expect(task.result?.answer).toContain('[E1]');
    expect(task.result?.coverage).toMatchObject({
      status: 'available',
      modeled_count: 3,
      observation_count: 0,
      missing_intervals: [],
    });
    expect(task.usage).toEqual({ tool_calls: 1, model_calls: 1, artifacts: 4 });
    const citation = task.result?.citations[0];
    expect(citation).toBeDefined();
    const artifact = instance.store.artifact(
      citation!.artifact_id,
      localTaskIdentity,
    );
    expect(artifact.kind).toBe('evidence-capture');
    expect(citation?.sha256).toBe(contractHash(artifact.content));
    expect(artifact.content).toEqual(capture(original.scope!));
    expect(task.result?.provenance).toMatchObject({
      source: PM25_SOURCE_ID,
      tool_calls: 1,
      model: {
        provider: 'synthetic-test',
        calls: 1,
        usage: 'not_reported_by_adapter',
      },
    });
    const events = instance.store.events(task.id, localTaskIdentity, 0).events;
    expect(events.map((event) => event.type)).toEqual([
      'task_admitted',
      'task_started',
      'path_selected',
      'tool_started',
      'artifact_saved',
      'tool_completed',
      'artifact_saved',
      'model_started',
      'artifact_saved',
      'model_completed',
      'artifact_saved',
      'review_completed',
      'task_completed',
    ]);
    expect(doubles.source.retrieve).toHaveBeenCalledExactlyOnceWith(
      original.scope,
      expect.any(AbortSignal),
    );
    expect(doubles.model.complete).toHaveBeenCalledTimes(1);
  });

  it('reports exact missing output slots and permits insufficient evidence as a result', async () => {
    const doubles = adapters(true);
    const { instance } = runtime(doubles);
    const partial = await settled(
      instance,
      instance.admit(request(), 'partial').task_id,
    );
    expect(partial.result?.coverage).toMatchObject({
      status: 'partial',
      usable_row_count: 2,
      missing_intervals: [
        { start: '2026-10-01T01:00:00.000Z', end: '2026-10-01T02:00:00.000Z' },
      ],
    });
    doubles.source.retrieve.mockImplementationOnce((scope) =>
      Promise.resolve({ ...capture(scope), rows: [], raw: '{"data":[]}' }),
    );
    const empty = await settled(
      instance,
      instance.admit(request(), 'empty').task_id,
    );
    expect(empty.status).toBe('completed');
    expect(empty.result?.coverage.status).toBe('insufficient_evidence');
    expect(empty.result?.coverage.missing_intervals).toEqual([
      { start: '2026-10-01T00:00:00.000Z', end: '2026-10-01T03:00:00.000Z' },
    ]);
    expect(empty.result?.findings[0]?.text).toContain('No usable PM2.5 values');
    expect(empty.result?.unresolved_gaps).toContain(
      'Provider issuance time is unknown; collection/retrieval timestamps are not provider issuance.',
    );
  });

  it('pins the actual model response receipt and charges one synthesis call', async () => {
    const doubles = adapters();
    const receipt = {
      response_model: 'synthetic-provider-returned-model',
      response_id: 'synthetic-response-id',
      input_tokens: 123,
      output_tokens: 45,
    };
    const text = JSON.stringify({
      answer:
        'Modeled instantaneous PM2.5 only [E1]; observation coverage and provider issuance remain unknown.',
    });
    const completeWithReceipt = vi
      .fn<NonNullable<AgentModel['completeWithReceipt']>>()
      .mockResolvedValue({ text, receipt });
    const { instance } = runtime({
      ...doubles,
      model: { ...doubles.model, completeWithReceipt },
    });
    const task = await settled(
      instance,
      instance.admit(request(), 'receipt').task_id,
    );
    expect(task.status).toBe('completed');
    expect(task.result?.provenance.model).toMatchObject({
      model: 'synthetic-test-model',
      calls: 1,
      usage: 'reported_by_provider',
      receipt,
    });
    expect(completeWithReceipt).toHaveBeenCalledTimes(1);
    expect(doubles.model.complete).not.toHaveBeenCalled();
    const event = instance.store
      .events(task.id, localTaskIdentity, 0)
      .events.find((entry) => entry.type === 'model_completed');
    expect(event?.data).toMatchObject({ receipt });
    const artifactId = (event?.data as { artifact_id: string }).artifact_id;
    expect(
      instance.store.artifact(artifactId, localTaskIdentity).content,
    ).toMatchObject({ text, receipt });
  });

  it('parses a request-specific prose scope and rejects ambiguous, malformed or self-authorized requests before execution', () => {
    const doubles = adapters();
    const { instance } = runtime(doubles);
    const prose = request({
      objective:
        'Summarize PM2.5 for Other Town during 2026-09-10 to 2026-09-11.',
    });
    delete prose.scope;
    const task = instance.store.read(
      instance.admit(prose, 'prose').task_id,
      localTaskIdentity,
    );
    expect(task.scope).toEqual({
      location: 'Other Town',
      period: { start: '2026-09-10T00:00:00Z', end: '2026-09-11T00:00:00Z' },
    });
    expect(() =>
      instance.admit(
        { ...request(), permissions: { tools: ['arbitrary'] } },
        'grants',
      ),
    ).toThrow('haze.task.request.v1');
    expect(() =>
      instance.admit({ ...request(), schema_version: 'haze.run.v2' }, 'legacy'),
    ).toThrow('Legacy scheduling payloads are no longer supported.');
    expect(() =>
      instance.admit(
        request({ objective: 'PM2.5 evidence please', scope: undefined }),
        'ambiguous',
      ),
    ).toThrow('location and explicit UTC');
    expect(() =>
      instance.admit(
        request({ objective: 'Publish an operational notice' }),
        'unsupported',
      ),
    ).toThrow('PM2.5 evidence summaries only');
    expect(doubles.source.retrieve).not.toHaveBeenCalled();
  });

  it('enforces artifact ownership and exact versions for context references', async () => {
    const doubles = adapters();
    const { instance } = runtime(doubles);
    const completed = await settled(
      instance,
      instance.admit(request(), 'context-source').task_id,
    );
    const citation = completed.result!.citations[0]!;
    const ref = {
      id: citation.artifact_id,
      version: 1 as const,
      sha256: citation.sha256,
    };
    const contextRequest = request({ context_refs: [ref] });
    expect(() =>
      instance.admit(contextRequest, 'other-user', {
        ...localTaskIdentity,
        principal: 'someone-else',
      }),
    ).toThrow('principal/workspace');
    expect(() =>
      instance.admit(contextRequest, 'other-workspace', {
        ...localTaskIdentity,
        workspace: 'elsewhere',
      }),
    ).toThrow('principal/workspace');
    expect(() =>
      instance.admit(
        request({ context_refs: [{ ...ref, sha256: '0'.repeat(64) }] }),
        'wrong-hash',
      ),
    ).toThrow('exact accessible artifact version');
    expect(() =>
      instance.admit(
        request({ context_refs: [{ ...ref, id: randomUUID() }] }),
        'unknown-artifact',
      ),
    ).toThrow('Artifact not found');
    expect(() =>
      instance.admit(
        { ...contextRequest, context_refs: [{ ...ref, version: 2 }] },
        'wrong-version',
      ),
    ).toThrow('haze.task.request.v1');
    expect(doubles.source.retrieve).toHaveBeenCalledTimes(1);
    expect(
      (
        await settled(
          instance,
          instance.admit(contextRequest, 'allowed-context').task_id,
        )
      ).status,
    ).toBe('completed');
    expect(doubles.source.retrieve).toHaveBeenCalledTimes(2);
  });

  it.each(['Test\u0000Town', 'Test\u007fTown', 'Test\\Town'])(
    'rejects malformed location %j before admission or execution',
    (location) => {
      const doubles = adapters();
      const { instance } = runtime(doubles);
      const body = request();
      expect(() =>
        instance.admit(
          {
            ...body,
            scope: { ...body.scope, location },
          },
          'malformed-location',
        ),
      ).toThrow('haze.task.request.v1');
      expect(
        instance.store.db.prepare('SELECT COUNT(*) AS count FROM tasks').get(),
      ).toMatchObject({ count: 0 });
      expect(
        instance.store.db.prepare('SELECT COUNT(*) AS count FROM events').get(),
      ).toMatchObject({ count: 0 });
      expect(doubles.source.retrieve).not.toHaveBeenCalled();
      expect(doubles.model.complete).not.toHaveBeenCalled();
    },
  );

  it('scopes durable idempotency by principal/workspace and refuses changed content', async () => {
    const doubles = adapters();
    const { instance } = runtime(doubles);
    const body = request();
    const first = instance.admit(body, 'same-key');
    expect(instance.admit(body, 'same-key')).toMatchObject({
      task_id: first.task_id,
      reused: true,
    });
    expect(() =>
      instance.admit(request({ constraints: ['different'] }), 'same-key'),
    ).toThrow('different content');
    await settled(instance, first.task_id);
    expect(instance.admit(body, 'same-key').task_id).toBe(first.task_id);
    const identity = { ...localTaskIdentity, workspace: 'other-workspace' };
    const other = instance.admit(body, 'same-key', identity);
    expect(other.task_id).not.toBe(first.task_id);
    await settled(instance, other.task_id, identity);
    expect(doubles.source.retrieve).toHaveBeenCalledTimes(2);
    expect(doubles.model.complete).toHaveBeenCalledTimes(2);
  });

  it('treats omitted defaults and explicit empty arrays as different idempotent submission content', () => {
    const { instance } = runtime();
    const body = request();
    const omitted = {
      schema_version: body.schema_version,
      objective: body.objective,
      scope: body.scope,
    };
    instance.admit(omitted, 'presence-matters');
    expect(() => instance.admit(body, 'presence-matters')).toThrow(
      'different content',
    );
  });

  it.each(['source', 'model'] as const)(
    'keeps %s failure explicit without a mock result or retry',
    async (failed) => {
      const doubles = adapters();
      if (failed === 'source')
        doubles.source.retrieve.mockRejectedValue(
          new EvidenceSourceError('synthetic source down', 'provider_failure'),
        );
      else
        doubles.model.complete.mockRejectedValue(
          new Error('synthetic model down'),
        );
      const { instance } = runtime(doubles);
      const task = await settled(
        instance,
        instance.admit(request(), 'failure').task_id,
      );
      expect(task.status).toBe('failed');
      expect(task.result).toBeUndefined();
      expect(task.error?.code).toBe(
        failed === 'source' ? 'provider_failure' : 'execution_failed',
      );
      expect(doubles.source.retrieve).toHaveBeenCalledTimes(1);
      expect(doubles.model.complete).toHaveBeenCalledTimes(
        failed === 'source' ? 0 : 1,
      );
      expect(
        instance.store.events(task.id, localTaskIdentity, 0).events.at(-1)
          ?.type,
      ).toBe('task_failed');
    },
  );

  it('rejects uncited or invented citation targets from model synthesis', async () => {
    const doubles = adapters();
    doubles.model.complete.mockResolvedValue(
      JSON.stringify({ answer: 'An uncited claim with invented source [E2].' }),
    );
    const { instance } = runtime(doubles);
    const task = await settled(
      instance,
      instance.admit(request(), 'invalid-synthesis').task_id,
    );
    expect(task.status).toBe('failed');
    expect(task.error?.code).toBe('invalid_synthesis');
    expect(task.result).toBeUndefined();
  });

  it('enforces deadlines even for an adapter that ignores cancellation', async () => {
    const doubles = adapters();
    doubles.source.retrieve.mockImplementation(
      () => new Promise(() => undefined),
    );
    const { instance } = runtime({ ...doubles, deadlineMs: 20 });
    const task = await settled(
      instance,
      instance.admit(request(), 'deadline').task_id,
    );
    expect(task.status).toBe('timed_out');
    expect(task.usage).toEqual({ tool_calls: 1, model_calls: 0, artifacts: 0 });
    expect(doubles.source.retrieve.mock.calls[0]?.[1].aborted).toBe(true);
    expect(doubles.model.complete).not.toHaveBeenCalled();
  });

  it('bounds aggregate model input before calling the provider', async () => {
    const doubles = adapters();
    const { instance } = runtime(doubles);
    const task = await settled(
      instance,
      instance.admit(
        request({
          constraints: Array.from({ length: 16 }, () => 'x'.repeat(2000)),
        }),
        'input-budget',
      ).task_id,
    );
    expect(task.error?.code).toBe('model_budget');
    expect(task.usage).toEqual({ tool_calls: 1, model_calls: 0, artifacts: 2 });
    expect(doubles.model.complete).not.toHaveBeenCalled();
  });

  it('records shutdown cancellation and ignores a late source completion', async () => {
    const directory = stateDirectory();
    const doubles = adapters();
    let finish: ((value: EvidenceCapture) => void) | undefined;
    doubles.source.retrieve.mockImplementation(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    const first = runtime({ ...doubles, stateDirectory: directory });
    const admitted = first.instance.admit(request(), 'shutdown');
    await vi.waitFor(() =>
      expect(doubles.source.retrieve).toHaveBeenCalledTimes(1),
    );
    await first.close();
    const second = runtime({ ...doubles, stateDirectory: directory });
    const cancelled = second.instance.store.read(
      admitted.task_id,
      localTaskIdentity,
    );
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.usage).toEqual({
      tool_calls: 1,
      model_calls: 0,
      artifacts: 0,
    });
    finish!(capture(request().scope!));
    await Promise.resolve();
    expect(
      second.instance.store.read(admitted.task_id, localTaskIdentity),
    ).toEqual(cancelled);
    expect(doubles.model.complete).not.toHaveBeenCalled();
  });

  it('retains completed status, citations, idempotency and cursor events across runtime restart', async () => {
    const directory = stateDirectory();
    const doubles = adapters();
    const first = runtime({ ...doubles, stateDirectory: directory });
    const admitted = first.instance.admit(request(), 'restart');
    const completed = await settled(first.instance, admitted.task_id);
    const page = first.instance.store.events(
      admitted.task_id,
      localTaskIdentity,
      0,
    );
    await first.close();
    const second = runtime({ ...doubles, stateDirectory: directory });
    expect(
      second.instance.store.read(admitted.task_id, localTaskIdentity),
    ).toEqual(completed);
    expect(
      second.instance.store.events(admitted.task_id, localTaskIdentity, 0),
    ).toEqual(page);
    expect(
      second.instance.store.events(
        admitted.task_id,
        localTaskIdentity,
        page.next_cursor,
      ).events,
    ).toEqual([]);
    expect(second.instance.admit(request(), 'restart')).toMatchObject({
      task_id: admitted.task_id,
      reused: true,
    });
    expect(
      second.instance.store.artifact(
        completed.result!.citations[0]!.artifact_id,
        localTaskIdentity,
      ).sha256,
    ).toBe(completed.result!.citations[0]!.sha256);
    expect(doubles.source.retrieve).toHaveBeenCalledTimes(1);
  });

  it('marks a durable nonterminal checkpoint interrupted on restart without retrying charged work', async () => {
    const directory = stateDirectory();
    const doubles = adapters();
    const first = runtime({ ...doubles, stateDirectory: directory });
    const completed = await settled(
      first.instance,
      first.instance.admit(request(), 'interrupted').task_id,
    );
    // Simulate the exact durable state left by a crash after charging an attempt.
    const checkpoint = { ...completed };
    delete checkpoint.result;
    checkpoint.status = 'running';
    first.instance.store.transition(
      checkpoint,
      'test_checkpoint',
      'Manager',
      'Synthetic crash checkpoint.',
    );
    await first.close();
    const second = runtime({ ...doubles, stateDirectory: directory });
    const recovered = second.instance.store.read(
      checkpoint.id,
      localTaskIdentity,
    );
    expect(recovered.status).toBe('failed');
    expect(recovered.error?.code).toBe('restart_interrupted');
    expect(recovered.usage).toEqual(completed.usage);
    const events = second.instance.store.events(
      checkpoint.id,
      localTaskIdentity,
      0,
    ).events;
    expect(events.at(-1)?.type).toBe('task_failed');
    expect(events.map((event) => event.cursor)).toEqual(
      [...events.map((event) => event.cursor)].sort((a, b) => a - b),
    );
    expect(doubles.source.retrieve).toHaveBeenCalledTimes(1);
  });
});

describe('local task HTTP boundary', () => {
  it('serves a persisted cited answer, exact artifacts and durable event cursors', async () => {
    const api = await httpServer();
    const response = await api.submit(request(), {
      'Idempotency-Key': 'http-supported',
    });
    expect(response.status).toBe(202);
    const admitted = taskAdmissionSchema.parse(await response.json());
    expect(response.headers.get('Location')).toBe(admitted.status_url);
    await settled(api.handler.runtime, admitted.task_id);
    const status = await fetch(`${api.base}${admitted.status_url}`);
    const task = taskRecordSchema.parse(await status.json());
    expect(task.status).toBe('completed');
    const events = taskEventPageSchema.parse(
      await (await fetch(`${api.base}${admitted.events_url}`)).json(),
    );
    expect(events.events[0]?.type).toBe('task_admitted');
    const tail = taskEventPageSchema.parse(
      await (
        await fetch(
          `${api.base}${admitted.events_url}?after=${events.next_cursor}`,
        )
      ).json(),
    );
    expect(tail.events).toEqual([]);
    expect(tail.next_cursor).toBe(events.next_cursor);
    const exact = await fetch(`${api.base}${task.result!.citations[0]!.url}`);
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({
      id: task.result!.citations[0]!.artifact_id,
      sha256: task.result!.citations[0]!.sha256,
    });
    const repeat = taskAdmissionSchema.parse(
      await (
        await api.submit(request(), { 'Idempotency-Key': 'http-supported' })
      ).json(),
    );
    expect(repeat).toMatchObject({ task_id: task.id, reused: true });
  });

  it('denies foreign origins, cross-site requests, client grants and invalid JSON without starting execution', async () => {
    const doubles = adapters();
    const api = await httpServer(doubles);
    expect(
      (await api.submit(request(), { Origin: 'https://attacker.invalid' }))
        .status,
    ).toBe(403);
    expect(
      (await api.submit(request(), { 'Sec-Fetch-Site': 'cross-site' })).status,
    ).toBe(403);
    const foreignHostStatus = await new Promise<number>((done, reject) => {
      const outgoing = httpRequest(
        `${api.base}/api/tasks`,
        {
          method: 'POST',
          headers: {
            Host: 'attacker.invalid',
            Origin: api.base,
            'Content-Type': 'application/json',
            'Idempotency-Key': 'foreign-host',
          },
        },
        (response) => {
          response.resume();
          response.on('end', () => done(response.statusCode ?? 0));
        },
      );
      outgoing.on('error', reject);
      outgoing.end(JSON.stringify(request()));
    });
    expect(foreignHostStatus).toBe(403);
    expect(
      (
        await fetch(`${api.base}/api/tasks`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': 'missing-origin',
          },
          body: JSON.stringify(request()),
        })
      ).status,
    ).toBe(403);
    expect(
      (await api.submit({ ...request(), identity: { principal: 'admin' } }))
        .status,
    ).toBe(400);
    expect(
      (await api.submit({ ...request(), limits: { max_model_calls: 100 } }))
        .status,
    ).toBe(400);
    expect(
      (await api.submit(request(), { 'Idempotency-Key': '' })).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${api.base}/api/tasks`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: api.base,
            'Idempotency-Key': 'duplicate-json',
          },
          body: '{"objective":"one","objective":"two"}',
        })
      ).status,
    ).toBe(400);
    expect(doubles.source.retrieve).not.toHaveBeenCalled();
    expect(doubles.model.complete).not.toHaveBeenCalled();
  });
});
