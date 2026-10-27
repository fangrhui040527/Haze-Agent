import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import {
  automaticReadinessSchema,
  automaticReleaseBlocked,
} from '../../../../app/contracts/nightshift-automatic.ts';
import {
  chainAutomationViewSchema,
  nightshiftProgressRecordSchema,
} from '../../../../app/contracts/nightshift-chains.ts';
import {
  automaticChainAdmissionSchema,
  chainControlSchema,
} from '../../../../app/contracts/nightshift.ts';
import {
  AutomaticReleaseDetails,
  ChainAutomationDetails,
  ChainAutomationObserver,
} from './AutomaticChains.tsx';
import { ChainAdmissionForm } from './JobForms.tsx';
import { MutationIntent, NightshiftClient } from './jobsApi.ts';

const chainId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const initialRun = '33333333-3333-4333-8333-333333333333';
const successor = '44444444-4444-4444-8444-444444444444';
const jobId = '55555555-5555-4555-8555-555555555555';
const artifact = {
  id: '66666666-6666-4666-8666-666666666666',
  version: 1,
  sha256: 'a'.repeat(64),
};
const progress = {
  schema_version: 'haze.nightshift.progress.v1',
  purpose: 'evidence_linked_draft',
  instruction: 'Inspect the newly retained source.',
  unresolved_deliverables: ['objective'],
  input_refs: [artifact],
  output_refs: [],
  review_objections: [],
  failure_causes: [],
  last_consumed_result_cursor: 9,
};
function view() {
  return chainAutomationViewSchema.parse({
    schema_version: 'haze.nightshift.chain.automation.v1',
    chain_id: chainId,
    task_id: taskId,
    current_run_id: successor,
    automatic_enabled: true,
    authorized_followups: 2,
    used_followups: 1,
    remaining_followups: 1,
    admitted_runs: 2,
    maximum_runs: 3,
    original_expires_at: '2026-10-27T23:00:00Z',
    next_purpose: 'evidence_linked_draft',
    run_profile: {
      max_model_input_bytes: 24576,
      max_model_output_tokens: 1200,
      reserved_model_calls: 2,
    },
    progress: {
      schema_version: 'haze.nightshift.progress.record.v1',
      chain_id: chainId,
      run_id: successor,
      revision: 2,
      actor: 'service',
      accepted_at: '2026-10-27T01:00:00Z',
      fingerprint: 'stable',
      progress,
    },
    lineage: [
      {
        chain_id: chainId,
        predecessor_run_id: initialRun,
        objective_revision: 1,
        run_id: successor,
        actor: 'service',
        mode: 'automatic',
        reason: 'Inspect a matching result.',
        cursor: 9,
        delivery_ids: [],
        created_at: '2026-10-27T01:00:00Z',
      },
    ],
    stops: [
      {
        code: 'no_progress',
        message: '<script>untrusted stop</script>',
        cursor: 12,
        refs: [artifact],
        remaining: { model_calls: 2, jobs: 0 },
        at: '2026-10-27T01:01:00Z',
      },
    ],
    inbox: [
      {
        job_id: jobId,
        remote_id: 'remote-1',
        original_run_id: initialRun,
        execution_state: 'completed',
        candidate: artifact,
        required: true,
        delivered_to_run_id: successor,
      },
    ],
  });
}

it('keeps explicit automatic admission unchecked and unavailable without server release evidence', () => {
  const markup = renderToStaticMarkup(
    createElement(ChainAdmissionForm, {
      busy: false,
      available: true,
      onSubmit: () => undefined,
    }),
  );
  expect(markup).toContain('Explicitly authorize bounded automatic follow-ups');
  const checkbox = markup.match(
    /<input[^>]*name="automatic_opt_in"[^>]*>/u,
  )?.[0];
  expect(checkbox).toContain('disabled');
  expect(checkbox).not.toContain('checked');
  expect(markup).toContain('zero automatic follow-ups');
  expect(markup).toContain('Automatic mode is blocked');
});

it('shows unmet live gates separately from generation reachability and rejects forged release claims', () => {
  const blocked = automaticReleaseBlocked('No eligible local lane.');
  const markup = renderToStaticMarkup(
    createElement(AutomaticReleaseDetails, { data: blocked }),
  );
  expect(markup).toContain('blocked');
  expect(markup).toContain('No eligible local lane.');
  expect(markup).toContain('Plan 3 live wait trace and interactive latency');
  expect(markup).toContain('Resume cannot enable a manual-only chain');
  expect(
    automaticReadinessSchema.safeParse({
      ...blocked,
      released: true,
      ready: true,
    }).success,
  ).toBe(false);
});

it('renders exact lineage, cumulative quotas, inbox ownership and escaped stop decisions', () => {
  const previousTask = '88888888-8888-4888-8888-888888888888';
  const data = chainAutomationViewSchema.parse({
    ...view(),
    previous_chain_id: '77777777-7777-4777-8777-777777777777',
    previous_task_id: previousTask,
  });
  const markup = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      {},
      createElement(ChainAutomationDetails, {
        data,
        originalRunId: initialRun,
      }),
    ),
  );
  expect(markup).toContain(`href="#chain-${chainId}-run-${initialRun}"`);
  expect(markup).toContain('service / automatic');
  expect(markup).toContain(`/task/${previousTask}`);
  expect(markup).toContain('Previous granted task report');
  expect(markup).toContain('2 / 3');
  expect(markup).toContain('1 / 2');
  expect(markup).toContain('last consumed result cursor 9');
  expect(markup).toContain('Haze output tokens per model call');
  expect(markup).toContain('1200');
  expect(markup).toContain('Reserved synthesis and review model calls');
  expect(markup).toContain('Required');
  expect(markup).toContain(`/nightshift/${jobId}`);
  expect(markup).toContain(artifact.sha256);
  expect(markup).toContain('no_progress');
  expect(markup).toContain('&lt;script&gt;untrusted stop&lt;/script&gt;');
  expect(markup).not.toContain('<script>');
});

it('keeps chain observation read-only and separate from stopped browser observation', () => {
  const markup = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      {},
      createElement(ChainAutomationObserver, {
        chainId,
        originalRunId: initialRun,
        observing: false,
        busy: false,
        closed: false,
        onPropose: () => undefined,
      }),
    ),
  );
  expect(markup).toContain('Browser observation stopped.');
  expect(markup).toContain(
    'Reading lineage does not admit a successor or resubmit a job',
  );
  expect(markup).not.toContain('Submit revised progress');
});

it('validates bounded versioned admission and refuses automatic enablement in a control body', () => {
  const admission = {
    schema_version: 'haze.nightshift.chain.admission.v2',
    task_id: taskId,
    expected_run_id: initialRun,
    expected_generation: 1,
    expected_objective_revision: 1,
    expected_state_revision: 1,
    total_runs: 3,
    max_jobs: 4,
    max_attempts: 16,
    lifetime_seconds: 3600,
    automatic_opt_in: true,
    automatic_followup_runs: 2,
    initial_progress: progress,
  };
  expect(
    automaticChainAdmissionSchema.parse(admission).automatic_followup_runs,
  ).toBe(2);
  expect(
    automaticChainAdmissionSchema.parse({
      ...admission,
      previous_chain_id: chainId,
    }).previous_chain_id,
  ).toBe(chainId);
  expect(
    automaticChainAdmissionSchema.safeParse({
      ...admission,
      automatic_opt_in: false,
    }).success,
  ).toBe(false);
  expect(
    automaticChainAdmissionSchema.safeParse({
      ...admission,
      automatic_followup_runs: 3,
      total_runs: 3,
    }).success,
  ).toBe(false);
  expect(
    chainControlSchema.safeParse({
      schema_version: 'haze.nightshift.chain.control.v1',
      expected_run_id: initialRun,
      expected_generation: 1,
      expected_objective_revision: 1,
      expected_state_revision: 1,
      expected_chain_revision: 1,
      action: 'resume',
      automatic_opt_in: true,
    }).success,
  ).toBe(false);
  expect(
    chainControlSchema.safeParse({
      schema_version: 'haze.nightshift.chain.control.v2',
      expected_run_id: initialRun,
      expected_generation: 1,
      expected_objective_revision: 1,
      expected_state_revision: 1,
      expected_chain_revision: 1,
      action: 'resume',
      automatic_followup_runs: 3,
    }).success,
  ).toBe(false);
});

it('reads validated release and lineage using only GET requests and bounded same-origin transport', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json(automaticReleaseBlocked('Live gates unmet.')),
    )
    .mockResolvedValueOnce(Response.json(view()));
  const client = new NightshiftClient(fetcher),
    signal = new AbortController().signal;
  expect((await client.automationReadiness(signal)).released).toBe(false);
  expect((await client.chainAutomation(chainId, signal)).current_run_id).toBe(
    successor,
  );
  for (const [url, options] of fetcher.mock.calls) {
    expect(String(url)).toMatch(/^\/api\/nightshift\//u);
    expect(options).toMatchObject({
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
    expect(options?.body).toBeUndefined();
  }
  fetcher.mockResolvedValueOnce(
    Response.json({ ...view(), credential: 'hidden' }),
  );
  await expect(client.chainAutomation(chainId, signal)).rejects.toThrow(
    'unsupported response',
  );
});

it('preserves the exact progress body and key for an unchanged explicit retry', async () => {
  const record = nightshiftProgressRecordSchema.parse(view().progress);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(Response.json(record)));
  const client = new NightshiftClient(fetcher),
    intent = new MutationIntent();
  const body = {
    schema_version: 'haze.nightshift.chain.progress.proposal.v1',
    expected_run_id: successor,
    expected_generation: 2,
    expected_objective_revision: 1,
    expected_state_revision: 4,
    expected_chain_revision: 3,
    progress,
  };
  const prepared = await intent.prepare(
    'same-progress',
    () => body,
    () => 'progress-key',
  );
  await client.proposeProgress(
    chainId,
    prepared.body,
    prepared.key,
    new AbortController().signal,
  );
  const retry = await intent.prepare(
    'same-progress',
    () => ({ ...body, expected_state_revision: 99 }),
    () => 'different-key',
  );
  await client.proposeProgress(
    chainId,
    retry.body,
    retry.key,
    new AbortController().signal,
  );
  expect(retry).toBe(prepared);
  expect(fetcher.mock.calls[0]?.[1]?.body).toEqual(
    fetcher.mock.calls[1]?.[1]?.body,
  );
  expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({
    'Content-Type': 'application/json',
    'Idempotency-Key': 'progress-key',
  });
});
