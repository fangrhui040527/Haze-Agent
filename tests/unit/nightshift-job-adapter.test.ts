import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CliNightshiftJobAdapter,
  discoverNightshiftCli,
  parseNightshiftEnvelope,
  runNightshiftCli,
  inspectCloudCompute,
  inspectLocalCompute,
  reviewedNightshiftJobSourceHashes,
  type NightshiftCliInvocation,
  type NightshiftCliRunner,
} from '../../app/adapters/nightshift/jobs.js';
import { NightshiftJobTransportError } from '../../app/orchestration/ports.js';
import {
  chainAdmissionSchema,
  jobSubmitSchema,
  jobsReadinessSchema,
  type NightshiftJobReadiness,
  type NightshiftSubmitRequest,
} from '../../app/contracts/nightshift.js';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(directory));
    if (!rel || rel.startsWith('..'))
      throw new Error('Unsafe fixture cleanup.');
    rmSync(directory, { recursive: true, force: true });
  }
});
function script(content = '') {
  const directory = mkdtempSync(join(tmpdir(), 'haze-ns-cli-'));
  directories.push(directory);
  const path = join(directory, 'ns.mjs');
  writeFileSync(path, content);
  return path;
}
const okay = (data: unknown) => ({
  stdout: JSON.stringify({ ns: 1, ok: true, data }),
  exit_code: 0,
});
const request: NightshiftSubmitRequest = {
  prompt: 'Untrusted literal: $(touch nope) `exit` --n 999',
  n: 1,
  judge: 'accuracy',
  budget: 'low',
  window: 'now',
  privacy: 'local-only',
  max_spend_usd: 0,
};
const ready: NightshiftJobReadiness = {
  schema_version: 'haze.nightshift.jobs.readiness.v1',
  checked_at: '2026-10-27T00:00:00Z',
  cli_available: true,
  schema_compatible: true,
  runtime_reachable: true,
  local_only_enforced: true,
  cloud_enforced: false,
  ready: true,
  runtime_version: 'fixture',
  adapter_version: 'fixture',
  schema_hash: 'fixture-hash',
  can_reconcile: false,
  cancellation_idempotent: false,
  reason: null,
  options: {
    judges: ['accuracy'],
    budgets: ['low'],
    windows: ['now', 'quiet'],
    max_attempts: 16,
    fleets: [],
  },
};
function adapter(runner: NightshiftCliRunner) {
  return new CliNightshiftJobAdapter(
    { HAZE_NIGHTSHIFT_CLI: script(), SAMPLE_MODE: 'false' },
    runner,
  );
}

describe('Nightshift job transport contracts', () => {
  it('accepts only the reviewed original or complete strict-overlay installation', () => {
    const original = {
      'cli/ns.mjs':
        'f6c05c9c30f549eacebefe1a0413730a0e346c20f37896a29f7fc2da52e0f378',
      'cli/lib/transport.mjs':
        '2ba85dbdd7ea8e4d31fc76c60d44e9c4267b097a194d0123e24612d3284eb3a7',
      'engine/js/engine/jobs.js':
        '94bafd05f32a9b7a58ff91be0a7feaf549f5513c078232e9b5d2f26a76a2757a',
      'engine/js/engine/providers.js':
        '04fae12dfdeb4299ee2a36016b437de7bf5120006393d0c8c1d88ac75f288825',
      'engine/host.mjs':
        'ab9e35a78b6545780c904a1d7bc3d6e576598edf5e3e063aebc0c4d2d3e5ce00',
    };
    const strict = {
      ...original,
      'engine/host.mjs':
        'e1668b09429e1aca3364a3cbefe2c2b9acb2a2cdc94a0ead9dca582a17bab350',
      'engine/server.mjs':
        'e0ba7c357f688b096c60d7d09937d68ff2102424c329ea55d58a3ddd108e8e80',
      'engine/haze-strict/integration.mjs':
        '8fa11bc9801d62f70a86f7183e4ab3524e1bc49fc5578f3d602e85c03b23233c',
      'engine/haze-strict/handler.mjs':
        '8c709532e5845419b177ff8edc4bcaac345a19ff2aa81d476802cc051422c5d0',
    };
    for (const installation of [original, strict]) {
      expect(reviewedNightshiftJobSourceHashes(installation)).toBe(true);
      for (const path of Object.keys(installation)) {
        expect(
          reviewedNightshiftJobSourceHashes({
            ...installation,
            [path]: '0'.repeat(64),
          }),
          path,
        ).toBe(false);
        const missing: Record<string, string> = { ...installation };
        delete missing[path];
        expect(reviewedNightshiftJobSourceHashes(missing), path).toBe(false);
      }
    }
    expect(
      reviewedNightshiftJobSourceHashes({
        ...original,
        'engine/host.mjs': strict['engine/host.mjs'],
      }),
    ).toBe(false);
  });

  it('treats literal prompt text as stdin and never a shell or command argument', async () => {
    const calls: NightshiftCliInvocation[] = [];
    const instance = adapter((input) => {
      calls.push(input);
      return Promise.resolve(okay({ job_id: 'job_fixture-1' }));
    });
    vi.spyOn(instance, 'readiness').mockResolvedValue(ready);
    await expect(instance.submit(request)).resolves.toEqual({
      remote_id: 'job_fixture-1',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.stdin).toBe(request.prompt);
    expect(calls[0]?.args).not.toContain(request.prompt);
    expect(calls[0]?.args).toContain('best_of_n');
    expect(calls[0]?.args).toContain('local-only');
    expect(calls[0]?.args).not.toContain('--wait');
    expect(calls[0]?.args).not.toContain('--idempotency-key');
    expect(calls[0]?.args).not.toContain('--fleet');
    expect(calls[0]?.mutation).toBe(true);
  });
  it('submits cloud-enabled jobs without the CLI zero-spend override or a false monetary ceiling', async () => {
    const calls: NightshiftCliInvocation[] = [];
    const instance = adapter((input) => {
      calls.push(input);
      return Promise.resolve(okay({ job_id: 'cloud-job1' }));
    });
    vi.spyOn(instance, 'readiness').mockResolvedValue({
      ...ready,
      cloud_enforced: true,
      cloud_compute_available: true,
      local_compute_available: false,
    });
    await expect(
      instance.submit({ ...request, privacy: 'cloud-ok', max_spend_usd: null }),
    ).resolves.toEqual({ remote_id: 'cloud-job1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain('cloud-ok');
    expect(calls[0]?.args).not.toContain('--max-spend');
    expect(calls[0]?.args).not.toContain('local-only');
    expect(calls[0]?.stdin).toBe(request.prompt);
    expect(calls[0]?.mutation).toBe(true);
  });
  it.each([
    { cloud_enforced: false, cloud_compute_available: true },
    { cloud_enforced: true, cloud_compute_available: false },
    { cloud_enforced: true, cloud_compute_available: undefined },
  ])(
    'refuses cloud work without reviewed policy and ready cloud compute (%j)',
    async (policy) => {
      const runner = vi.fn<NightshiftCliRunner>();
      const instance = adapter(runner);
      vi.spyOn(instance, 'readiness').mockResolvedValue({
        ...ready,
        ...policy,
      });
      await expect(
        instance.submit({
          ...request,
          privacy: 'cloud-ok',
          max_spend_usd: null,
        }),
      ).rejects.toMatchObject({
        outcome: 'rejected-before-acceptance',
        diagnostic_code: 'unavailable',
      });
      expect(runner).not.toHaveBeenCalled();
    },
  );
  it('keeps local-only jobs blocked when only cloud compute is ready', async () => {
    const runner = vi.fn<NightshiftCliRunner>();
    const instance = adapter(runner);
    vi.spyOn(instance, 'readiness').mockResolvedValue({
      ...ready,
      cloud_enforced: true,
      cloud_compute_available: true,
      local_compute_available: false,
    });
    await expect(instance.submit(request)).rejects.toMatchObject({
      outcome: 'rejected-before-acceptance',
      diagnostic_code: 'unavailable',
    });
    expect(runner).not.toHaveBeenCalled();
  });
  it('rejects an explicit fleet before invoking the CLI even if stale readiness advertises it', async () => {
    const runner = vi.fn<NightshiftCliRunner>();
    const instance = adapter(runner);
    vi.spyOn(instance, 'readiness').mockResolvedValue({
      ...ready,
      options: { ...ready.options, fleets: ['known'] },
    });
    await expect(
      instance.submit({ ...request, fleet: 'known' }),
    ).rejects.toMatchObject({
      outcome: 'rejected-before-acceptance',
      diagnostic_code: 'fleet_unverified',
    });
    expect(runner).not.toHaveBeenCalled();
  });
  it('rejects inconsistent privacy, unsupported fleet and positive monetary caps before invoking the mutation', async () => {
    const runner = vi.fn<NightshiftCliRunner>();
    const instance = adapter(runner);
    vi.spyOn(instance, 'readiness').mockResolvedValue(ready);
    for (const input of [
      { ...request, fleet: 'unknown' },
      { ...request, privacy: 'cloud-ok' },
      { ...request, privacy: 'local-only', max_spend_usd: null },
      { ...request, privacy: 'cloud-ok', max_spend_usd: 1 },
      { ...request, max_spend_usd: 1 },
      { ...request, n: 17 },
    ]) {
      await expect(
        instance.submit(input as NightshiftSubmitRequest),
      ).rejects.toMatchObject({ outcome: 'rejected-before-acceptance' });
    }
    expect(runner).not.toHaveBeenCalled();
  });
  it('does not interpret a stream frame, duplicate final response, or malformed JSON as an acknowledgement', () => {
    for (const text of [
      '{"ns":1,"t":"started"}',
      '{"ns":1,"ok":true,"data":{}}\n{"ns":1,"t":"progress"}',
      '{"ns":1,"ok":true}\n{"ns":1,"ok":true}',
      '{"ns":1,"ok":false,"ok":true}',
      'not json',
    ]) {
      expect(() => parseNightshiftEnvelope(text, true)).toThrow(
        NightshiftJobTransportError,
      );
      try {
        parseNightshiftEnvelope(text, true);
      } catch (error) {
        expect(error).toMatchObject({ outcome: 'unknown' });
      }
    }
    expect(
      parseNightshiftEnvelope(
        '{"ns":1,"t":"progress"}\n{"ns":1,"ok":true,"data":{"job_id":"job1"}}',
        true,
      ),
    ).toEqual({ job_id: 'job1' });
  });
  it('retains charged ambiguity after dispatch and only classifies proven HTTP refusals as pre-acceptance', () => {
    for (const [error, outcome] of [
      [
        { source: 'engine', status: 401, message: 'secret-key' },
        'rejected-before-acceptance',
      ],
      [{ source: 'engine', status: 503, message: 'secret-key' }, 'unknown'],
      [
        { source: 'transport', code: 'E_DEADLINE', message: 'secret-key' },
        'unknown',
      ],
    ] as const) {
      try {
        parseNightshiftEnvelope(
          JSON.stringify({ ns: 1, ok: false, error }),
          true,
        );
        throw new Error('accepted');
      } catch (failure) {
        expect(failure).toMatchObject({ outcome });
        expect(String(failure)).not.toContain('secret-key');
      }
    }
  });
  it('keeps requested policy separate from actual job state and cancellation acknowledgement', async () => {
    const calls: NightshiftCliInvocation[] = [];
    const instance = adapter((input) => {
      calls.push(input);
      return Promise.resolve(
        okay(
          input.args.includes('get')
            ? {
                id: 'job1',
                status: 'running',
                generated: 1,
                n: 4,
                privacy: 'local-only',
                fleet_id: 'known',
              }
            : { status: 'cancelling' },
        ),
      );
    });
    await expect(instance.inspect('job1')).resolves.toMatchObject({
      remote_id: 'job1',
      terminal: false,
      generated: 1,
      requested_attempts: 4,
      privacy: 'local-only',
    });
    await expect(instance.cancel('job1')).resolves.toEqual({
      acknowledged: true,
    });
    expect(calls.filter((call) => call.mutation)).toHaveLength(1);
    await expect(
      instance.verifyReconciliation('job1', request),
    ).resolves.toMatchObject({ verified: false });
  });
  it('does not treat the installed cancellation label as confirmed provider termination', async () => {
    const instance = adapter(() =>
      Promise.resolve(
        okay({ id: 'job1', status: 'cancelled', privacy: 'local-only', n: 1 }),
      ),
    );
    await expect(instance.inspect('job1')).resolves.toMatchObject({
      execution_state: 'cancelled',
      terminal: false,
    });
  });
  it.each([
    ['errored', 'failed'],
    ['sealed', 'completed'],
  ])(
    'normalizes known native terminal state %s while preserving the safe diagnostic',
    async (native, normalized) => {
      const instance = adapter(() =>
        Promise.resolve(
          okay({
            id: 'job1',
            status: native,
            privacy: 'local-only',
            n: 1,
            error:
              'no attempt produced a candidate: 1 × privacy_floor_refuses_pinned_model',
          }),
        ),
      );
      await expect(instance.inspect('job1')).resolves.toMatchObject({
        execution_state: normalized,
        native_execution_state: native,
        terminal: true,
        failure_code: 'privacy_floor_refuses_pinned_model',
      });
    },
  );
  it('distinguishes reachable cloud lanes and configured missing local models from ready local compute', () => {
    const fleets = {
      fleets: [
        {
          id: 'local',
          lanes: [{ id: 'local1', kind: 'local', model: 'local.gguf' }],
        },
        {
          id: 'cloud',
          lanes: [{ id: 'cloud1', kind: 'cloud', model: 'cloud/model' }],
        },
      ],
    };
    expect(
      inspectLocalCompute(fleets, {
        lanes: [
          { id: 'cloud1', kind: 'cloud', state: 'ready', model: 'cloud/model' },
        ],
      }),
    ).toEqual({ available: false, fleets: [] });
    expect(
      inspectLocalCompute(fleets, {
        lanes: [
          {
            id: 'local1',
            kind: 'local',
            state: 'loading',
            model: 'local.gguf',
          },
        ],
      }),
    ).toEqual({ available: false, fleets: [] });
    expect(
      inspectLocalCompute(fleets, {
        lanes: [
          { id: 'local1', kind: 'local', state: 'ready', model: 'local.gguf' },
        ],
      }),
    ).toEqual({ available: true, fleets: ['local'] });
    expect(
      inspectLocalCompute(fleets, {
        lanes: [
          {
            id: 'local1',
            kind: 'local',
            state: 'ready',
            model: 'different.gguf',
          },
        ],
      }),
    ).toEqual({ available: true, fleets: [] });
  });
  it.each([{ disabled: true }, { races: false }])(
    'does not count a ready local lane excluded from the installed host roster (%j)',
    (eligibility) => {
      const lane = {
        id: 'local1',
        kind: 'local',
        state: 'ready',
        model: 'local.gguf',
      };
      const fleet = { fleets: [{ id: 'local', lanes: [lane] }] };
      expect(
        inspectLocalCompute(fleet, { lanes: [{ ...lane, ...eligibility }] }),
      ).toEqual({ available: false, fleets: [] });
      for (const flags of [{}, { disabled: false, races: true }])
        expect(
          inspectLocalCompute(fleet, { lanes: [{ ...lane, ...flags }] }),
        ).toEqual({ available: true, fleets: ['local'] });
    },
  );

  it.each([{ kind: 'cloud' }, { provider: 'nvidia' }])(
    'recognizes a ready cloud race lane independently of local compute (%j)',
    (classification) => {
      const status = {
        lanes: [
          {
            id: 'cloud1',
            model: 'nvidia/nemotron',
            state: 'ready',
            ...classification,
          },
        ],
      };
      expect(inspectCloudCompute(status)).toBe(true);
      expect(inspectLocalCompute({ fleets: [] }, status).available).toBe(false);
    },
  );
  it.each([
    { state: 'loading' },
    { disabled: true },
    { races: false },
    { model: '' },
    { kind: 'local', provider: 'nvidia' },
    { kind: undefined, provider: undefined },
  ])(
    'does not advertise unavailable or unclassified cloud compute (%j)',
    (change) => {
      expect(
        inspectCloudCompute({
          lanes: [
            {
              id: 'cloud1',
              kind: 'cloud',
              model: 'nvidia/nemotron',
              state: 'ready',
              ...change,
            },
          ],
        }),
      ).toBe(false);
      expect(inspectCloudCompute(null)).toBe(false);
    },
  );

  it.each([
    [undefined, 'local-only', 0],
    ['historical-local', 'local-only', 0],
    [undefined, 'cloud-ok', null],
  ] as const)(
    'verifies an exact native request and its fleet and privacy metadata (%s, %s)',
    async (fleet, privacy, max_spend_usd) => {
      const marked = {
        ...request,
        privacy,
        max_spend_usd,
        ...(fleet ? { fleet } : {}),
        prompt:
          '[Haze request 11111111-1111-4111-8111-111111111111]\nOriginal synthetic objective.',
      };
      const native = {
        id: 'job1',
        app: 'ns',
        kind: 'best_of_n',
        prompt_full: marked.prompt,
        messages: [{ role: 'user', content: marked.prompt }],
        n: 1,
        window: 'now',
        privacy,
        judge_mode: 'accuracy',
        attempt_budget: { level: 'low' },
        ...(fleet ? { fleet_id: fleet } : {}),
      };
      const instance = adapter((input) =>
        Promise.resolve(
          okay(
            input.args.includes('list')
              ? {
                  jobs: [{ id: 'job1', prompt: marked.prompt.slice(0, 160) }],
                  total: 1,
                }
              : native,
          ),
        ),
      );
      vi.spyOn(instance, 'readiness').mockResolvedValue({
        ...ready,
        ready: false,
        local_compute_available: false,
        cloud_enforced: true,
        cloud_compute_available: false,
        can_reconcile: true,
      });
      await expect(
        instance.verifyReconciliation('job1', marked),
      ).resolves.toEqual({ verified: true, reason: null });
    },
  );
  it.each([
    { app: 'cockpit' },
    { kind: 'batch' },
    { n: 2 },
    { window: 'quiet' },
    { privacy: 'cloud-ok' },
    { judge_mode: 'quality' },
    { attempt_budget: { level: 'max' } },
    { fleet_id: 'unexpected' },
    { prompt_full: 'similar but changed' },
    { messages: undefined },
    { messages: [{ role: 'user', content: 'changed' }] },
  ])(
    'refuses native reconciliation when any authority-bearing request field differs: %j',
    async (change) => {
      const marked = {
        ...request,
        prompt:
          '[Haze request 11111111-1111-4111-8111-111111111111]\nOriginal synthetic objective.',
      };
      const native = {
        id: 'job1',
        app: 'ns',
        kind: 'best_of_n',
        prompt_full: marked.prompt,
        messages: [{ role: 'user', content: marked.prompt }],
        n: 1,
        window: 'now',
        privacy: 'local-only',
        judge_mode: 'accuracy',
        attempt_budget: { level: 'low' },
        ...change,
      };
      const instance = adapter((input) =>
        Promise.resolve(
          okay(
            input.args.includes('list')
              ? { jobs: [{ id: 'job1', prompt: marked.prompt }], total: 1 }
              : native,
          ),
        ),
      );
      vi.spyOn(instance, 'readiness').mockResolvedValue({
        ...ready,
        can_reconcile: true,
      });
      await expect(
        instance.verifyReconciliation('job1', marked),
      ).resolves.toMatchObject({ verified: false });
    },
  );
  it('refuses duplicate/noncanonical/missing nonce and copied ownership markers', async () => {
    const marker = '[Haze request 11111111-1111-4111-8111-111111111111]\n';
    const marked = {
      ...request,
      prompt: marker + 'Original synthetic objective.',
    };
    const native = {
      id: 'job1',
      app: 'ns',
      kind: 'best_of_n',
      prompt_full: marked.prompt,
      messages: [{ role: 'user', content: marked.prompt }],
      n: 1,
      window: 'now',
      privacy: 'local-only',
      judge_mode: 'accuracy',
      attempt_budget: { level: 'low' },
    };
    const instance = adapter((input) =>
      Promise.resolve(
        okay(
          input.args.includes('list')
            ? {
                jobs: [
                  { id: 'job1', prompt: marked.prompt },
                  { id: 'job2', prompt: marked.prompt },
                ],
                total: 2,
              }
            : native,
        ),
      ),
    );
    vi.spyOn(instance, 'readiness').mockResolvedValue({
      ...ready,
      can_reconcile: true,
    });
    await expect(
      instance.verifyReconciliation('job1', marked),
    ).resolves.toMatchObject({ verified: false });
    for (const prompt of [
      request.prompt,
      marker + marker + 'duplicated',
      marker.replace('Haze', 'HAZE') + 'noncanonical',
    ])
      await expect(
        instance.verifyReconciliation('job1', { ...marked, prompt }),
      ).resolves.toMatchObject({ verified: false });
  });
  it('retains actual model and total usage without inventing absent split counts', async () => {
    const instance = adapter(() =>
      Promise.resolve(
        okay({
          winner_seq: 2,
          truncated: false,
          selected_attempts: [
            { seq: 1, text: 'rejected', tokens: null },
            {
              seq: 2,
              text: 'Candidate <script>text</script>',
              lane: 'lane1',
              model: { requested: 'alias', resolved: 'actual-model' },
              tokens: 35,
              tokens_source: 'measured',
              receipt_id: 'receipt2',
            },
          ],
        }),
      ),
    );
    const result = await instance.result('job1');
    expect(result.text).toBe('Candidate <script>text</script>');
    expect(result.winner_seq).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.attempts[1]).toMatchObject({
      model: 'actual-model',
      total_tokens: 35,
      input_tokens: null,
      output_tokens: null,
      finish_reason: null,
    });
    expect(result.attempts[0]).toMatchObject({
      model: null,
      lane: null,
      total_tokens: null,
    });
  });
  it('redacts runtime credentials from candidate and metadata fields', async () => {
    const instance = new CliNightshiftJobAdapter(
      { HAZE_NIGHTSHIFT_CLI: script(), METERLESS_TOKEN: 'server-secret' },
      () =>
        Promise.resolve(
          okay({
            winner_seq: 1,
            truncated: false,
            selected_attempts: [
              {
                seq: 1,
                text: 'Echo server-secret',
                lane: 'server-secret',
                model: 'server-secret',
                receipt_id: 'server-secret',
                finish_reason: 'server-secret',
              },
            ],
          }),
        ),
    );
    const result = await instance.result('job1');
    expect(JSON.stringify(result)).not.toContain('server-secret');
    expect(result.text).toBe('Echo [redacted]');
  });
  it('retains reported estimates separately while actual usage remains unknown', async () => {
    const instance = adapter(() =>
      Promise.resolve(
        okay({
          winner_seq: 1,
          truncated: false,
          selected_attempts: [
            {
              seq: 1,
              text: 'A bounded candidate.',
              tokens: 48,
              tokens_source: 'estimated',
            },
          ],
        }),
      ),
    );
    const result = await instance.result('job1');
    expect(result.attempts[0]).toMatchObject({
      total_tokens: null,
      reported_tokens: 48,
      tokens_source: 'estimated',
      input_tokens: null,
      output_tokens: null,
    });
  });
  it.each([
    { winner_seq: 1, truncated: true, selected_attempts: [] },
    {
      winner_seq: 1,
      truncated: false,
      selected_attempts: [{ seq: 1, text: 'x'.repeat(65_537) }],
    },
  ])(
    'never truncates oversized or incomplete results into usable candidates',
    async (data) => {
      const instance = adapter(() => Promise.resolve(okay(data)));
      await expect(instance.result('job1')).rejects.toMatchObject({
        outcome: 'read-failed',
      });
    },
  );
  it('reports missing winner text as a retrieval failure with unknown metadata', async () => {
    const instance = adapter(() =>
      Promise.resolve(
        okay({ winner_seq: null, truncated: false, selected_attempts: [] }),
      ),
    );
    const result = await instance.result('job1');
    expect(result).toMatchObject({
      text: null,
      attempts: [],
    });
    expect(result.retrieval_error).toBeTypeOf('string');
  });
  it('keeps unavailable CLI/readiness loadable and never treats an unreviewed source as local-only proof', async () => {
    const instance = new CliNightshiftJobAdapter({
      HAZE_NIGHTSHIFT_CLI: join(tmpdir(), 'definitely-not-installed.cmd'),
    });
    const result = await instance.readiness();
    expect(result.ready).toBe(false);
    expect(result.cli_available).toBe(false);
    expect(jobsReadinessSchema.safeParse(result).success).toBe(true);
    const sample = adapter(() => Promise.resolve(okay({})));
    const readiness = await sample.readiness();
    expect(readiness.local_only_enforced).toBe(false);
    expect(readiness.ready).toBe(false);
  });
  it('validates server-only loopback endpoints without surfacing credentials', () => {
    for (const url of [
      'http://secret@localhost:8088',
      'http://example.com',
      'file:///secret',
      'http://localhost:8088?key=secret',
    ])
      expect(
        () =>
          new CliNightshiftJobAdapter({
            HAZE_NIGHTSHIFT_CLI: script(),
            NS_BASE_URL: url,
          }),
      ).toThrow('credential-free local HTTP');
    expect(
      discoverNightshiftCli({ HAZE_NIGHTSHIFT_CLI: script() }).prefix,
    ).toHaveLength(1);
  });
  it('bounds a real child response instead of retaining a usable prefix', async () => {
    const path = script("process.stdout.write('x'.repeat(3*1024*1024));");
    await expect(
      runNightshiftCli({
        command: process.execPath,
        args: [path],
        env: process.env,
        mutation: true,
      }),
    ).rejects.toMatchObject({
      outcome: 'unknown',
      diagnostic_code: 'response_oversized',
    });
  });
  it('defaults new grants to cloud permission without a monetary cap and preserves explicit local-only grants', () => {
    const authority = {
      expected_run_id: '11111111-1111-4111-8111-111111111111',
      expected_generation: 1,
      expected_objective_revision: 1,
      expected_state_revision: 1,
    };
    const chain = {
      schema_version: 'haze.nightshift.chain.admission.v1',
      task_id: authority.expected_run_id,
      ...authority,
    };
    expect(chainAdmissionSchema.parse(chain).automatic_followup_runs).toBe(0);
    expect(chainAdmissionSchema.parse(chain)).toMatchObject({
      privacy: 'cloud-ok',
      max_spend_usd: null,
    });
    expect(
      chainAdmissionSchema.parse({
        ...chain,
        privacy: 'local-only',
        max_spend_usd: 0,
      }),
    ).toMatchObject({ privacy: 'local-only', max_spend_usd: 0 });
    expect(
      chainAdmissionSchema.safeParse({ ...chain, automatic_followup_runs: 1 })
        .success,
    ).toBe(false);
    expect(
      jobSubmitSchema.safeParse({
        schema_version: 'haze.nightshift.job.submit.v1',
        chain_id: authority.expected_run_id,
        ...authority,
        expected_chain_revision: 1,
        ...request,
        privacy: 'cloud-ok',
      }).success,
    ).toBe(false);
  });
});
