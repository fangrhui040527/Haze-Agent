import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { nightshiftJobSchema } from '../../../../app/contracts/nightshift-records.ts';
import { summarizeNightshiftJob } from '../../../../app/contracts/nightshift-list.ts';
import {
  NightshiftClient,
  MutationIntent,
  canReconcileNightshiftJob,
} from './jobsApi.ts';
import { jobsReadinessSchema } from '../../../../app/contracts/nightshift.ts';
import { JobDetails } from './JobDetails.tsx';

const jobId = '11111111-1111-4111-8111-111111111111';
const chainId = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333';
const runId = '44444444-4444-4444-8444-444444444444';
const artifact = {
  id: '55555555-5555-4555-8555-555555555555',
  version: 2,
  sha256: 'a'.repeat(64),
};
function job() {
  return nightshiftJobSchema.parse({
    schema_version: 'haze.nightshift.job.v1',
    id: jobId,
    task_id: taskId,
    chain_id: chainId,
    revision: 3,
    created_at: '2026-10-27T00:00:00Z',
    updated_at: '2026-10-27T00:01:00Z',
    authority: {
      run_id: runId,
      generation: 1,
      objective_revision: 1,
      assignment_id: null,
      assignment_revision: null,
    },
    prompt: 'A draft based on the supplied source.',
    input_refs: [artifact],
    route_id: 'pinned-route',
    options: {
      n: 4,
      judge: 'accuracy',
      budget: 'low',
      window: 'quiet',
      fleet: null,
      privacy: 'local-only',
      max_spend_usd: 0,
    },
    request_fingerprint: 'fingerprint',
    adapter_version: 'test-v1',
    runtime_version: null,
    schema_hash: 'schema-hash',
    execution_state: 'completed',
    remote_id: 'remote-1',
    progress: { generated: 4, requested_attempts: 4 },
    judge_outcome: { status: 'accepted', basis: null, explanation: null },
    receipt: {
      artifact,
      output: '<script>alert("untrusted")</script>',
      attempts: [],
      winner_seq: null,
      captured_at: '2026-10-27T00:01:00Z',
    },
    retrieval_error: null,
    cancellation: {
      requested: true,
      acknowledged: true,
      remote_termination_confirmed: false,
    },
    candidate: true,
    review_status: 'unreviewed',
    selections: [],
    next_poll_at: null,
    read_failures: 0,
  });
}
const submission = {
  schema_version: 'haze.nightshift.job.submit.v1',
  chain_id: chainId,
  expected_run_id: runId,
  expected_generation: 1,
  expected_objective_revision: 1,
  expected_state_revision: 1,
  expected_chain_revision: 1,
  prompt: 'Bounded draft',
  input_refs: [artifact],
};
it('calls the default browser fetch without replacing its native receiver', async () => {
  const nativeFetch = vi.fn(function (this: unknown) {
    if (this instanceof NightshiftClient)
      throw new TypeError('Illegal invocation');
    return Promise.resolve(Response.json(job()));
  });
  vi.stubGlobal('fetch', nativeFetch);
  try {
    expect(
      (await new NightshiftClient().job(jobId, new AbortController().signal))
        .id,
    ).toBe(jobId);
    expect(nativeFetch).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});

it('retains the exact original authority and key across an ambiguous retry', async () => {
  const intent = new MutationIntent();
  const build = vi.fn(() => ({ ...submission }));
  const first = await intent.prepare('same draft', build, () => 'stable-key');
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('network unavailable'))
    .mockResolvedValueOnce(Response.json(job()));
  const client = new NightshiftClient(fetcher);
  await expect(
    client.submitJob(first.body, first.key, new AbortController().signal),
  ).rejects.toThrow();
  const retry = await intent.prepare(
    'same draft',
    () => ({ ...submission, expected_state_revision: 99 }),
    () => 'new-key',
  );
  await client.submitJob(retry.body, retry.key, new AbortController().signal);
  expect(retry).toBe(first);
  expect(build).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    fetcher.mock.calls.map(
      (call) => (call[1]?.headers as Record<string, string>)['Idempotency-Key'],
    ),
  ).toEqual(['stable-key', 'stable-key']);
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
    fetcher.mock.calls[1]?.[1]?.body,
  );
});
it('requires new explicit intent before changed work can get a new key', async () => {
  const intent = new MutationIntent();
  const one = await intent.prepare(
    'draft-one',
    () => submission,
    () => 'one',
  );
  const two = await intent.prepare(
    'draft-two',
    () => ({ ...submission, prompt: 'Changed brief' }),
    () => 'two',
  );
  expect(one.key).toBe('one');
  expect(two.key).toBe('two');
});
it('preserves an uncapped cloud policy when submitting and displaying a candidate job', async () => {
  const cloudJob = nightshiftJobSchema.parse({
    ...job(),
    options: { ...job().options, privacy: 'cloud-ok', max_spend_usd: null },
  });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(cloudJob));
  const client = new NightshiftClient(fetcher);
  const result = await client.submitJob(
    { ...submission, privacy: 'cloud-ok', max_spend_usd: null },
    'cloud-key',
    new AbortController().signal,
  );
  const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
    privacy: string;
    max_spend_usd: number | null;
  };
  expect(request.privacy).toBe('cloud-ok');
  expect(request.max_spend_usd).toBeNull();
  expect(result.options.privacy).toBe('cloud-ok');
  const markup = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      {},
      createElement(JobDetails, {
        job: cloudJob,
        events: [],
        busy: false,
        canReconcile: false,
        onCancel: () => undefined,
        onReconcile: () => undefined,
        onSelect: () => undefined,
      }),
    ),
  );
  expect(markup).toContain('No cloud spend cap');
  expect(markup).not.toContain('$0 cloud spend');
});
it('reads deep-linked jobs and reconnect cursors without submission', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(job()))
    .mockResolvedValueOnce(Response.json({ events: [], next_cursor: 42 }));
  const client = new NightshiftClient(fetcher);
  const signal = new AbortController().signal;
  expect((await client.job(jobId, signal)).id).toBe(jobId);
  expect((await client.events(jobId, 42, signal)).next_cursor).toBe(42);
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
    `/api/nightshift/jobs/${jobId}`,
    `/api/nightshift/jobs/${jobId}/events?after=42`,
  ]);
  expect(fetcher.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(
    true,
  );
});
it('keeps large candidate bodies out of bounded inbox summaries', async () => {
  const detail = job();
  detail.prompt = 'p'.repeat(12000);
  detail.receipt!.output = 'o'.repeat(65536);
  const summary = summarizeNightshiftJob(detail);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      version: 1,
      jobs: Array.from({ length: 100 }, () => summary),
    }),
  );
  const result = await new NightshiftClient(fetcher).jobs(
    new AbortController().signal,
  );
  expect(result.jobs).toHaveLength(100);
  expect(result.jobs[0]?.receipt_available).toBe(true);
  expect(JSON.stringify(result)).not.toContain('p'.repeat(20));
  expect(JSON.stringify(result)).not.toContain('o'.repeat(20));
  expect(JSON.stringify(result).length).toBeLessThan(100000);
});
it('rejects unsupported data and bounds streamed output without displaying raw upstream errors', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const client = new NightshiftClient(fetcher);
  const signal = new AbortController().signal;
  fetcher.mockResolvedValueOnce(
    Response.json({ ...job(), credential_ref: 'private' }),
  );
  await expect(client.job(jobId, signal)).rejects.toThrow(
    'unsupported response',
  );
  fetcher.mockResolvedValueOnce(
    new Response('upstream-secret', { status: 503 }),
  );
  await expect(client.job(jobId, signal)).rejects.toThrow('API is unavailable');
  let cancelled = false;
  fetcher.mockResolvedValueOnce(
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    ),
  );
  await expect(client.job(jobId, signal)).rejects.toThrow('size limit');
  expect(cancelled).toBe(true);
});
it('renders candidate output as escaped text and keeps judge, receipt and cancellation facts distinct', () => {
  const markup = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      {},
      createElement(JobDetails, {
        job: job(),
        events: [],
        busy: false,
        canReconcile: false,
        onCancel() {},
        onReconcile() {},
        onSelect() {},
      }),
    ),
  );
  expect(markup).not.toContain('<script>');
  expect(markup).toContain('&lt;script&gt;');
  expect(markup).toContain('Unreviewed candidate');
  expect(markup).toContain('judge outcome: accepted');
  expect(markup).toContain('receipt: retained');
  expect(markup).toContain('Remote termination confirmed');
  expect(markup).toContain('Request cancellation of this job');
  expect(markup).toContain('Select candidate for current work');
  expect(markup).toContain(runId);
  expect(markup).toContain(artifact.sha256);
  expect(markup).toContain('Every selection still requires independent review');
});
it('keeps cancellation-labelled work visibly unconfirmed until remote termination is proven', () => {
  const candidate = job();
  candidate.execution_state = 'cancelled';
  candidate.receipt = null;
  const markup = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      {},
      createElement(JobDetails, {
        job: candidate,
        events: [],
        busy: false,
        canReconcile: false,
        onCancel() {},
        onReconcile() {},
        onSelect() {},
      }),
    ),
  );
  expect(markup).toContain('runtime reports cancelled');
  expect(markup).toContain('Compute capacity remains reserved and server');
  expect(markup).toContain('observation continues');
  expect(markup).toContain('<dt>Remote termination confirmed</dt><dd>No</dd>');
});
it('retains the remote failure diagnostic separately from a later receipt retrieval failure', () => {
  const candidate = job();
  candidate.execution_state = 'failed';
  candidate.receipt = null;
  candidate.remote_diagnostic = {
    execution_state: 'failed',
    failure_code: 'privacy_floor_refuses_pinned_model',
  };
  candidate.retrieval_error = {
    code: 'result_retrieval_failed',
    message: 'No result text was available.',
  };
  const markup = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      {},
      createElement(JobDetails, {
        job: candidate,
        events: [],
        busy: false,
        canReconcile: false,
        onCancel() {},
        onReconcile() {},
        onSelect() {},
      }),
    ),
  );
  expect(markup).toContain('privacy_floor_refuses_pinned_model');
  expect(markup).toContain('No result text was available.');
  expect(markup).toContain('local-only policy');
  expect(markup).toContain('Receipt retrieval is reported separately.');
});
it.each([false, true])(
  'enables unknown-submission reconciliation only when the reviewed capability is %s',
  (canReconcile) => {
    const candidate = job();
    candidate.execution_state = 'submission_unknown';
    candidate.receipt = null;
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        {},
        createElement(JobDetails, {
          job: candidate,
          events: [],
          busy: false,
          canReconcile,
          onCancel() {},
          onReconcile() {},
          onSelect() {},
        }),
      ),
    );
    const control = markup.match(
      /<button[^>]*>Reconcile verified job<\/button>/u,
    )?.[0];
    expect(control).toBeDefined();
    expect(control?.includes('disabled')).toBe(!canReconcile);
  },
);
it('permits proof-based reconciliation while new generation is blocked, but requires daemon reachability', () => {
  const readiness = jobsReadinessSchema.parse({
    schema_version: 'haze.nightshift.jobs.readiness.v1',
    checked_at: '2026-10-27T00:00:00Z',
    cli_available: true,
    schema_compatible: true,
    runtime_reachable: true,
    local_only_enforced: false,
    cloud_enforced: false,
    ready: false,
    runtime_version: null,
    adapter_version: 'fixture',
    schema_hash: 'proof-capability',
    can_reconcile: true,
    cancellation_idempotent: false,
    reason: 'No compatible local generation lane.',
    options: {
      judges: [],
      budgets: [],
      windows: [],
      max_attempts: 16,
      fleets: [],
    },
  });
  expect(canReconcileNightshiftJob(readiness)).toBe(true);
  expect(
    canReconcileNightshiftJob({ ...readiness, runtime_reachable: false }),
  ).toBe(false);
  expect(
    canReconcileNightshiftJob({ ...readiness, can_reconcile: false }),
  ).toBe(false);
});
