import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createExecutionRegistry } from '../../app/composition.js';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';
import type { DamageEvidenceMaintenance } from '../../app/capabilities/damage-evidence-maintenance/index.js';
import { damageEvidenceArchiveForIdentity } from '../../app/capabilities/damage-evidence/tools.js';
import { acquireDamageEvidence } from '../../app/capabilities/damage-evidence/acquisition.js';
import { acquisitionRequestSchema } from '../../app/capabilities/damage-evidence/contracts.js';
import type { ToolContext } from '../../app/orchestration/ports.js';
import { createTaskHandler } from '../../app/tasks/http.js';
import { contractHash } from '../../app/contracts/json.js';

const directories: string[] = [],
  runtimes: TaskRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const directory of directories.splice(0)) {
    const rel = relative(tmpdir(), directory);
    if (!rel || rel.startsWith('..')) throw new Error('Unsafe cleanup.');
    rmSync(directory, { recursive: true, force: true });
  }
});
const request = acquisitionRequestSchema.parse({
  source_id: 'dosm-district-deaths',
  selection: {
    state: 'Selangor',
    district: 'Klang',
    period: { start: '2024-01-01', end: '2024-12-31' },
  },
});
function open(directory: string) {
  const runtime = new TaskRuntime({
    stateDirectory: directory,
    mode: 'fixture',
    env: {},
    registry: createExecutionRegistry({ mode: 'fixture', env: {} }),
    dispatchTask: () => undefined,
  });
  runtimes.push(runtime);
  const maintenance = runtime.extension('damage-evidence-maintenance')!
    .service as DamageEvidenceMaintenance;
  return { runtime, maintenance };
}
const resolver =
  (deaths: number): typeof fetch =>
  () =>
    Promise.resolve(
      new Response(
        JSON.stringify([
          {
            state: 'Selangor',
            district: 'Klang',
            sex: 'both',
            date: '2024-01-01',
            abs: deaths,
          },
        ]),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
function context(taskId: string): ToolContext {
  return {
    taskId,
    runId: taskId,
    assignmentId: taskId,
    assignmentRevision: 1,
    objectiveRevision: 1,
    generation: 1,
    identity: localTaskIdentity,
    deadline: '2099-01-01T00:00:00.000Z',
    signal: new AbortController().signal,
    inputs: [],
    outputs: [],
    peers: [],
  };
}
it('durably revises a baseline and both scenario tasks once, preserving occurrence scope and originals', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'haze-evidence-revisions-'));
  directories.push(directory);
  let { runtime, maintenance } = open(directory);
  const scope = {
    capability: 'damage-evidence-research',
    label: 'historical 2024 episode',
    account_scope: {
      occurrence_period: { start: '2024-09-01', end: '2024-10-31' },
    },
  };
  const tasks = ['baseline', 'A and B comparisons'].map((name) =>
    runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: `Research ${name}`,
        scope,
      },
      name,
    ),
  );
  const archive = damageEvidenceArchiveForIdentity(
    maintenance.archive.root,
    localTaskIdentity,
  );
  const initial = await acquireDamageEvidence(archive, request, {
    fetch: resolver(100),
    signal: new AbortController().signal,
    sleep: () => Promise.resolve(),
  });
  for (const task of tasks)
    maintenance.track(initial.capture, request, context(task.task_id));
  await runtime.close();
  runtimes.splice(runtimes.indexOf(runtime), 1);
  ({ runtime, maintenance } = open(directory));
  await maintenance.refresh(
    request,
    localTaskIdentity,
    new AbortController().signal,
    { fetch: resolver(110), sleep: () => Promise.resolve() },
  );
  // A graceful owner close cancels unfinished tasks. A collector must respect that fence.
  expect(maintenance.view(localTaskIdentity).revision_jobs).toHaveLength(0);
  for (const receipt of tasks) {
    const task = runtime.store.read(receipt.task_id, localTaskIdentity);
    runtime.control(
      task.id,
      {
        schema_version: 'haze.task.control.v3',
        action: 'continue',
        expected_objective_revision: task.objective_revision,
        expected_run_id: task.current_run_id,
        expected_generation: task.generation,
        expected_state_revision: task.state_revision,
      },
      `continue-${task.id}`,
    );
  }
  await maintenance.refresh(
    request,
    localTaskIdentity,
    new AbortController().signal,
    { fetch: resolver(110), sleep: () => Promise.resolve() },
  );
  expect(
    maintenance.view(localTaskIdentity).revision_jobs.map((j) => j.error),
  ).toEqual([null, null]);
  for (const task of tasks) {
    const revised = runtime.store.read(task.task_id, localTaskIdentity);
    expect(revised.objective_revision).toBe(2);
    expect(revised.corrections[0]?.scope).toEqual(scope);
    expect(revised.corrections[0]?.passage).toContain(
      '2024-09-01 through 2024-10-31',
    );
    expect(revised.corrections[0]?.passage).toContain(
      'fresh scientific and arithmetic reviews',
    );
  }
  expect(
    archive.capture(initial.capture.capture_id).normalized_values[0]?.value,
  ).toBe(100);
  await maintenance.refresh(
    request,
    localTaskIdentity,
    new AbortController().signal,
    { fetch: resolver(110), sleep: () => Promise.resolve() },
  );
  expect(maintenance.view(localTaskIdentity).revision_jobs).toHaveLength(2);
  expect(
    tasks.map(
      (t) =>
        runtime.store.read(t.task_id, localTaskIdentity).objective_revision,
    ),
  ).toEqual([2, 2]);
});

it('recovers a capture saved before enqueueing, and preserves the last usable evidence after failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'haze-evidence-recovery-'));
  directories.push(directory);
  const { runtime, maintenance } = open(directory);
  const task = runtime.admit(
    {
      schema_version: 'haze.task.request.v3',
      objective: 'Research historical Malaysia evidence',
      scope: { capability: 'damage-evidence-research' },
    },
    'baseline',
  );
  const archive = damageEvidenceArchiveForIdentity(
    maintenance.archive.root,
    localTaskIdentity,
  );
  const old = await acquireDamageEvidence(archive, request, {
    fetch: resolver(100),
    signal: new AbortController().signal,
    sleep: () => Promise.resolve(),
  });
  maintenance.track(old.capture, request, context(task.task_id));
  await acquireDamageEvidence(archive, request, {
    fetch: resolver(125),
    signal: new AbortController().signal,
    sleep: () => Promise.resolve(),
  });
  await maintenance.refresh(
    request,
    localTaskIdentity,
    new AbortController().signal,
    { fetch: resolver(125), sleep: () => Promise.resolve() },
  );
  expect(
    maintenance.view(localTaskIdentity).revision_jobs.map((j) => j.error),
  ).toEqual([null]);
  expect(
    runtime.store.read(task.task_id, localTaskIdentity).objective_revision,
  ).toBe(2);
  await expect(
    maintenance.refresh(
      request,
      localTaskIdentity,
      new AbortController().signal,
      {
        fetch: () =>
          Promise.resolve(new Response('unavailable', { status: 503 })),
        sleep: () => Promise.resolve(),
      },
    ),
  ).rejects.toThrow('HTTP 503');
  const availability =
    maintenance.view(localTaskIdentity).subscriptions[0]!.availability;
  expect(availability.current_availability).toBe('unavailable');
  expect(availability.last_usable_capture?.normalized_values[0]?.value).toBe(
    125,
  );
  expect(
    runtime.store.read(task.task_id, localTaskIdentity).objective_revision,
  ).toBe(2);
});

async function subscribed() {
  const directory = mkdtempSync(join(tmpdir(), 'haze-evidence-audit-'));
  directories.push(directory);
  const value = open(directory);
  const task = value.runtime.admit(
    {
      schema_version: 'haze.task.request.v3',
      objective: 'Research historical Malaysia evidence',
      scope: { capability: 'damage-evidence-research' },
    },
    'baseline',
  );
  const archive = damageEvidenceArchiveForIdentity(
    value.maintenance.archive.root,
    localTaskIdentity,
  );
  const initial = await acquireDamageEvidence(archive, request, {
    fetch: resolver(100),
    signal: new AbortController().signal,
    sleep: () => Promise.resolve(),
  });
  value.maintenance.track(initial.capture, request, context(task.task_id));
  return { ...value, taskId: task.task_id, archive, initial };
}
function control(
  value: Awaited<ReturnType<typeof subscribed>>,
  action: 'cancel' | 'revoke',
  revoked_tools?: string[],
) {
  const task = value.runtime.store.read(value.taskId, localTaskIdentity);
  return value.runtime.control(
    task.id,
    {
      schema_version: 'haze.task.control.v3',
      action,
      expected_objective_revision: task.objective_revision,
      expected_run_id: task.current_run_id,
      expected_generation: task.generation,
      expected_state_revision: task.state_revision,
      ...(revoked_tools ? { revoked_tools } : {}),
    },
    `audit-${action}-${task.state_revision}`,
  );
}
function queueRevision(
  value: Awaited<ReturnType<typeof subscribed>>,
  captureId: string,
) {
  const subscription =
    value.maintenance.view(localTaskIdentity).subscriptions[0]!;
  const id = contractHash({
    subscription: subscription.id,
    capture: captureId,
  });
  value.runtime.store.db
    .prepare('INSERT INTO damage_evidence_revision_jobs VALUES(?,?,?)')
    .run(
      id,
      'fixture',
      JSON.stringify({
        id,
        subscription: {
          id: subscription.id,
          task_id: subscription.task_id,
          identity: subscription.identity,
          request: subscription.request,
          capture_id: subscription.capture_id,
        },
        capture_id: captureId,
        state: 'pending',
        attempts: 0,
        error: null,
      }),
    );
}
it('retains changed originals without recalculating when only unselected rows, row order or metadata changed', async () => {
  const value = await subscribed();
  await value.maintenance.refresh(
    request,
    localTaskIdentity,
    new AbortController().signal,
    {
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify([
              {
                state: 'Selangor',
                district: 'Petaling',
                sex: 'both',
                date: '2024-01-01',
                abs: 999,
              },
              {
                state: 'Selangor',
                district: 'Klang',
                sex: 'both',
                date: '2024-01-01',
                abs: 100,
                provider_updated: 'new metadata',
              },
            ]),
            {
              headers: {
                'content-type': 'application/json',
                etag: 'revised-file',
              },
            },
          ),
        ),
      sleep: () => Promise.resolve(),
    },
  );
  expect(value.archive.listCaptures()).toHaveLength(2);
  expect(value.maintenance.view(localTaskIdentity).revision_jobs).toHaveLength(
    0,
  );
  expect(
    value.runtime.store.read(value.taskId, localTaskIdentity)
      .objective_revision,
  ).toBe(1);
});
it('cancels active acquisition when the task revokes permission and prevents later network reads or revisions', async () => {
  const value = await subscribed();
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const fetcher = vi.fn(
    (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        notifyStarted();
        init!.signal!.addEventListener(
          'abort',
          () => {
            const reason: unknown = init!.signal!.reason;
            reject(
              reason instanceof Error ? reason : new Error(String(reason)),
            );
          },
          { once: true },
        );
      }),
  );
  const running = value.maintenance.refresh(
    request,
    localTaskIdentity,
    new AbortController().signal,
    { fetch: fetcher, sleep: () => Promise.resolve() },
  );
  await started;
  control(value, 'revoke', ['haze-damage-data-acquire']);
  await expect(running).rejects.toThrow(/subscribing tasks/);
  const subsequent = vi.fn(resolver(110));
  await value.maintenance.refresh(
    request,
    localTaskIdentity,
    new AbortController().signal,
    { fetch: subsequent, sleep: () => Promise.resolve() },
  );
  expect(subsequent).not.toHaveBeenCalled();
  expect(value.archive.attempts(request).at(-1)?.status).toBe('cancelled');
  expect(value.maintenance.view(localTaskIdentity).revision_jobs).toHaveLength(
    0,
  );
});
it('does not apply queued revisions to cancelled tasks or to a corrected disjoint occurrence period', async () => {
  const value = await subscribed();
  const revised = await acquireDamageEvidence(value.archive, request, {
    fetch: resolver(110),
    signal: new AbortController().signal,
    sleep: () => Promise.resolve(),
  });
  queueRevision(value, revised.capture.capture_id);
  control(value, 'cancel');
  expect(value.maintenance.drain()).toBe(0);
  expect(
    value.maintenance.view(localTaskIdentity).revision_jobs[0]?.state,
  ).toBe('waiting');
  expect(
    value.runtime.store.read(value.taskId, localTaskIdentity)
      .objective_revision,
  ).toBe(1);
  const other = await subscribed();
  const task = other.runtime.store.read(other.taskId, localTaskIdentity);
  other.runtime.update(
    task.id,
    {
      schema_version: 'haze.task.update.v3',
      kind: 'correction',
      passage: 'Use the 2015 episode.',
      scope: {
        capability: 'damage-evidence-research',
        account_scope: {
          occurrence_period: { start: '2015-09-01', end: '2015-10-31' },
        },
      },
      expected_objective_revision: task.objective_revision,
      expected_run_id: task.current_run_id,
      expected_generation: task.generation,
      expected_state_revision: task.state_revision,
    },
    'change-occurrence',
  );
  const fetcher = vi.fn(resolver(125));
  await other.maintenance.refresh(
    request,
    localTaskIdentity,
    new AbortController().signal,
    { fetch: fetcher, sleep: () => Promise.resolve() },
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    other.runtime.store.read(other.taskId, localTaskIdentity)
      .objective_revision,
  ).toBe(2);
});
it('supersedes a queued numerical revision when the provider reverts before the worker applies it', async () => {
  const value = await subscribed();
  const revised = await acquireDamageEvidence(value.archive, request, {
    fetch: resolver(110),
    signal: new AbortController().signal,
    sleep: () => Promise.resolve(),
  });
  queueRevision(value, revised.capture.capture_id);
  await acquireDamageEvidence(value.archive, request, {
    fetch: resolver(100),
    signal: new AbortController().signal,
    sleep: () => Promise.resolve(),
  });
  expect(value.maintenance.drain()).toBe(0);
  expect(
    value.maintenance.view(localTaskIdentity).revision_jobs[0]?.state,
  ).toBe('superseded');
  expect(
    value.runtime.store.read(value.taskId, localTaskIdentity)
      .objective_revision,
  ).toBe(1);
});

it('suspends acquisition and queued revisions after a prose-only scope correction until explicit scope is restored', async () => {
  const value = await subscribed();
  const update = (passage: string, scope?: object) => {
    const task = value.runtime.store.read(value.taskId, localTaskIdentity);
    return value.runtime.update(
      task.id,
      {
        schema_version: 'haze.task.update.v3',
        kind: 'correction',
        passage,
        ...(scope === undefined ? {} : { scope }),
        expected_objective_revision: task.objective_revision,
        expected_run_id: task.current_run_id,
        expected_generation: task.generation,
        expected_state_revision: task.state_revision,
      },
      `scope-update-${task.objective_revision}`,
    );
  };
  const scope = {
    capability: 'damage-evidence-research',
    account_scope: {
      occurrence_period: { start: '2024-09-01', end: '2024-10-31' },
    },
  };
  update('Use this historical episode.', scope);
  const revised = await acquireDamageEvidence(value.archive, request, {
    fetch: resolver(110),
    signal: new AbortController().signal,
    sleep: () => Promise.resolve(),
  });
  queueRevision(value, revised.capture.capture_id);
  update('Change the account to the 2015 episode instead.');
  const fetcher = vi.fn(resolver(125));
  await value.maintenance.refresh(
    request,
    localTaskIdentity,
    new AbortController().signal,
    { fetch: fetcher, sleep: () => Promise.resolve() },
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(value.maintenance.drain()).toBe(0);
  expect(
    value.maintenance.view(localTaskIdentity).revision_jobs[0]?.state,
  ).toBe('waiting');
  expect(
    value.maintenance.view(localTaskIdentity).revision_jobs[0]?.error,
  ).toContain('explicit structured scope');
  expect(
    value.runtime.store.read(value.taskId, localTaskIdentity)
      .objective_revision,
  ).toBe(3);
  expect(value.archive.listCaptures()).toHaveLength(2);
  update('Retain the explicitly scoped 2024 episode.', scope);
  expect(value.maintenance.drain()).toBe(1);
  expect(
    value.maintenance.view(localTaskIdentity).revision_jobs[0]?.state,
  ).toBe('completed');
});
it('retains edited content and publication dates at one news URL as separate investigations only', async () => {
  const value = await subscribed();
  const retain = (content: string, date: string) =>
    value.maintenance.retainNewsResponse(
      Buffer.from(
        JSON.stringify({
          results: [
            {
              url: 'https://example.org/article?utm_source=test',
              title: 'Haze report',
              content,
              published_date: date,
            },
          ],
        }),
      ),
      '2026-10-27T01:00:00Z',
    );
  expect(retain('Original report', '2026-10-26').changed).toBe(true);
  expect(retain('Original report', '2026-10-26').changed).toBe(false);
  expect(retain('Revised report', '2026-10-26').changed).toBe(true);
  expect(retain('Revised report', '2026-10-27').changed).toBe(true);
  expect(value.maintenance.view(localTaskIdentity).investigations).toHaveLength(
    3,
  );
  expect(value.maintenance.view(localTaskIdentity).revision_jobs).toHaveLength(
    0,
  );
  expect(
    value.runtime.store.read(value.taskId, localTaskIdentity)
      .objective_revision,
  ).toBe(1);
});
it('starts the revision collector before any dashboard request while SAMPLE_MODE disables news network activity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'haze-evidence-startup-'));
  directories.push(directory);
  const handler = createTaskHandler({
    stateDirectory: directory,
    mode: 'live',
    env: { SAMPLE_MODE: 'true' },
    dispatchTask: () => undefined,
  });
  try {
    await vi.waitFor(
      () => {
        const rows = handler.runtime.store.db
          .prepare('SELECT body FROM hazeops_watchers')
          .all() as { body: string }[];
        const states = rows.map(
          (row) =>
            JSON.parse(row.body) as {
              id: string;
              attempts: number;
              enabled: boolean;
            },
        );
        expect(
          states.find((state) => state.id === 'damage-evidence-revisions')
            ?.attempts,
        ).toBeGreaterThan(0);
        expect(
          states.find((state) => state.id === 'damage-evidence-news')?.enabled,
        ).toBe(false);
      },
      { timeout: 10000, interval: 20 },
    );
  } finally {
    await handler.close();
  }
});
