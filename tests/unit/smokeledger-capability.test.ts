import { describe, expect, it } from 'vitest';
import type { Artifact } from '../../app/contracts/artifacts.js';
import type {
  AssignmentServices,
  ExecutionMode,
  ToolContext,
} from '../../app/orchestration/ports.js';
import {
  createSmokeLedgerAssignments,
  createSmokeLedgerCapability,
  createSmokeLedgerTools,
  frameSmokeLedgerScope,
  SmokeLedgerError,
} from '../../app/capabilities/smokeledger/index.js';

// Fake sidecar responses only; the live sidecar is exercised by integration tests.

const scope = {
  town: 'Batu Pahat',
  window: {
    start: '2026-10-06T00:00:00+08:00',
    end: '2026-10-08T00:00:00+08:00',
  },
};

type Route = (body: unknown) => [number, unknown];
function fakeSidecar(routes: Record<string, Route>) {
  const calls: { path: string; body: unknown }[] = [];
  const fetcher = ((url: URL, init?: RequestInit) => {
    const path = `${init?.method ?? 'GET'} ${url.pathname}`;
    const body: unknown = init?.body
      ? JSON.parse(init.body as string)
      : undefined;
    calls.push({ path, body });
    const route = routes[path];
    if (!route) return Promise.reject(new TypeError('fetch failed'));
    const [status, payload] = route(body);
    return Promise.resolve(new Response(JSON.stringify(payload), { status }));
  }) as typeof fetch;
  return { fetcher, calls };
}

const health =
  (mode: 'offline_sample' | 'live', status = 'ready'): Route =>
  () => [
    200,
    { status, reasons: status === 'ready' ? [] : ['starting'], mode },
  ];

const runResponse = (run_id: string, overrides: object = {}) => ({
  run_id,
  status: 'success',
  mode: 'offline_sample',
  output: {
    summary: 'Fires on peat: 92% of the smoke signal [E-c2b0c3cd57].',
    claims: [
      {
        id: 'c1',
        kind: 'calculation',
        text: 'Fires on peat: 92% of the smoke signal [E-c2b0c3cd57].',
        evidence_ids: ['E-c2b0c3cd57'],
      },
    ],
    evidence: [{ evidence_id: 'E-c2b0c3cd57', sha256: 'c2b0c3cd57ab' }],
    limitations: ['Names are leads for verification.'],
  },
  critic: { final: { decision: 'approve' } },
  sponsor_integration_evidence: { zetaris: { executed: false } },
  engine_operations_executed: { 'hmem.query': 2 },
  remote_calls_executed: {},
  remote_calls_skipped: { 'zetaris.sql': 13 },
  error: null,
  ...overrides,
});

const provenance = {
  mode: 'offline_sample',
  engine_operations_executed: {},
  remote_calls_executed: {},
  remote_calls_skipped: {},
  remote_call_ids: [],
  failures: [],
};

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    taskId: 'task-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    objectiveRevision: 1,
    generation: 1,
    identity: { principal: 'p', workspace: 'w' },
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
    inputs: [],
    peers: [],
    outputs: [],
    ...overrides,
  };
}

function tools(fetcher: typeof fetch, mode: ExecutionMode = 'fixture') {
  return new Map(
    createSmokeLedgerTools({ mode, env: {}, fetcher }).map((tool) => [
      tool.id,
      tool,
    ]),
  );
}

/** Minimal assignment services: tools run directly, saves become artifacts. */
function services(
  fetcher: typeof fetch,
  input: unknown,
  inputs: Artifact[] = [],
) {
  const registry = tools(fetcher);
  const saved: Artifact[] = [];
  const questions: string[] = [];
  const ctx = context({ inputs });
  const value: AssignmentServices = {
    context: ctx,
    input,
    tool: (id, toolInput) => registry.get(id)!.execute(toolInput, ctx),
    save: (kind, content, metadata) => {
      const artifact = {
        id: crypto.randomUUID(),
        version: 1,
        sha256: 'a'.repeat(64),
        kind,
        content,
        ...(metadata?.evidence_origin
          ? { evidence_origin: metadata.evidence_origin }
          : {}),
      } as unknown as Artifact;
      saved.push(artifact);
      return artifact;
    },
    question: (prompt) => questions.push(prompt),
    message: () => undefined,
    inbox: () => [],
    read: () => {
      throw new Error('not used');
    },
  };
  return { value, saved, questions };
}

const definition = (id: string) =>
  createSmokeLedgerAssignments().find((entry) => entry.id === id)!;

describe('smokeledger scope framing', () => {
  it('reads the town and whole Malaysian days from the objective', () => {
    expect(
      frameSmokeLedgerScope({
        objective:
          'Investigate the haze over Batu Pahat on 6–7 October 2026. What does the evidence support?',
      }),
    ).toEqual(scope);
  });

  it('lets an explicit scope (for example a correction) win', () => {
    const klang = { ...scope, town: 'Klang' };
    expect(
      frameSmokeLedgerScope({
        objective: 'Investigate the haze over Batu Pahat on 6–7 October 2026.',
        scope: klang,
      }),
    ).toEqual(klang);
  });

  it.each([
    'What is the haze like?',
    'Investigate the haze over Batu Pahat on 31 February 2026.',
  ])('needs an explicit scope for %j', (objective) => {
    expect(() => frameSmokeLedgerScope({ objective })).toThrow();
  });

  it('asks for scope instead of guessing when framing fails', () => {
    const plans = createSmokeLedgerCapability().assignments({
      schema_version: 'haze.task.request.v3',
      objective: 'Tell me about the haze.',
    } as never);
    expect(plans.map((plan) => plan.input)).toEqual([
      { needs_scope: true },
      { needs_scope: true },
      { needs_scope: true },
    ]);
  });
});

describe('smokeledger tools', () => {
  it('runs in sample mode with a stable run id per task, assignment and revision', async () => {
    const sidecar = fakeSidecar({
      'GET /health': health('offline_sample'),
      'POST /run': (body) => [
        200,
        runResponse((body as { run_id: string }).run_id),
      ],
    });
    const tool = tools(sidecar.fetcher).get('haze.trace_sources')!;
    const first = (await tool.execute(scope, context())) as { run_id: string };
    const again = (await tool.execute(scope, context())) as { run_id: string };
    const revised = (await tool.execute(
      scope,
      context({ objectiveRevision: 2 }),
    )) as { run_id: string };
    expect(first.run_id).toBe(again.run_id);
    expect(revised.run_id).not.toBe(first.run_id);
    expect(first.run_id).toMatch(/^[A-Za-z0-9_.:-]{1,80}$/);
    expect(sidecar.calls[1]!.body).toMatchObject({
      input: {
        operation: 'trace_sources',
        town: 'Batu Pahat',
        timezone: 'Asia/Kuala_Lumpur',
      },
      options: { sample_mode: true },
    });
  });

  it.each([
    ['a live sidecar for a fixture task', health('live'), 'fixture'],
    ['a sample sidecar for a live task', health('offline_sample'), 'live'],
    ['a degraded sidecar', health('offline_sample', 'degraded'), 'fixture'],
  ] as const)('refuses %s without requesting a run', async (_, route, mode) => {
    const sidecar = fakeSidecar({ 'GET /health': route });
    const tool = tools(sidecar.fetcher, mode).get('haze.air_outlook')!;
    await expect(tool.execute(scope, context())).rejects.toThrow(
      SmokeLedgerError,
    );
    expect(sidecar.calls.map((call) => call.path)).toEqual(['GET /health']);
  });

  it('refuses replay mode without any request', async () => {
    const sidecar = fakeSidecar({});
    const tool = tools(sidecar.fetcher, 'replay').get('haze.air_outlook')!;
    await expect(tool.execute(scope, context())).rejects.toThrow(
      'no request was made',
    );
    expect(sidecar.calls).toEqual([]);
  });

  it('reports an unanswered run as an unknown outcome, but a failed check as failed', async () => {
    const sidecar = fakeSidecar({ 'GET /health': health('offline_sample') });
    const registry = tools(sidecar.fetcher);
    await expect(
      registry.get('haze.air_outlook')!.execute(scope, context()),
    ).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(
      registry
        .get('haze.claim_check')!
        .execute({ text: 'x', evidence_ids: [] }, context()),
    ).rejects.toMatchObject({ outcome: 'failed' });
  });

  it('marks unknown evidence as unverified rather than failing open', async () => {
    const sidecar = fakeSidecar({
      'GET /health': health('offline_sample'),
      'GET /api/evidence/E-0000000000/verify': () => [
        500,
        { error: { message: 'No evidence E-0000000000' } },
      ],
    });
    const output = await tools(sidecar.fetcher)
      .get('haze.evidence.verify')!
      .execute({ evidence_ids: ['E-0000000000'] }, context());
    expect(output).toEqual({
      results: [
        {
          evidence_id: 'E-0000000000',
          verified: false,
          stored_sha256: null,
          current_sha256: null,
          reason: 'No evidence E-0000000000',
          provenance: null,
        },
      ],
    });
  });
});

describe('smokeledger assignments', () => {
  it('turns an unsupported town into a structured gap, not an error', async () => {
    const sidecar = fakeSidecar({
      'GET /health': health('offline_sample'),
      'POST /run': (body) => [
        200,
        {
          run_id: (body as { run_id: string }).run_id,
          status: 'error',
          mode: 'offline_sample',
          error: {
            type: 'unsupported',
            message: "District 'Tawau' is not supported.",
          },
        },
      ],
    });
    const { value, saved } = services(sidecar.fetcher, {
      ...scope,
      town: 'Tawau',
    });
    const output = await definition('smokeledger.air_outlook').execute!(value);
    expect(output).toMatchObject({ status: 'completed', support: 'gap' });
    expect(saved[0]).toMatchObject({
      kind: 'evidence.gap',
      content: { error_type: 'unsupported', supported: false },
    });
  });

  it('keeps the sidecar response verbatim and labels sample evidence fictional', async () => {
    const sidecar = fakeSidecar({
      'GET /health': health('offline_sample'),
      'POST /run': (body) => [
        200,
        runResponse((body as { run_id: string }).run_id),
      ],
    });
    const { value, saved } = services(sidecar.fetcher, scope);
    const output = await definition('smokeledger.trace_sources').execute!(
      value,
    );
    expect(output.support).toBe('supported');
    expect(saved[0]).toMatchObject({
      kind: 'smokeledger.trace_sources',
      evidence_origin: 'synthetic_fixture',
      content: {
        response: {
          sponsor_integration_evidence: { zetaris: { executed: false } },
          remote_calls_skipped: { 'zetaris.sql': 13 },
        },
      },
    });
  });

  it('asks a question when the scope is missing', async () => {
    const { value, questions } = services(fakeSidecar({}).fetcher, {
      needs_scope: true,
    });
    const output = await definition('smokeledger.air_outlook').execute!(value);
    expect(output.status).toBe('waiting_human');
    expect(questions).toHaveLength(1);
  });

  function produced(): Artifact {
    return {
      id: crypto.randomUUID(),
      version: 1,
      sha256: 'b'.repeat(64),
      kind: 'smokeledger.trace_sources',
      content: {
        operation: 'trace_sources',
        scope,
        run_id: 'haze-trace_sources-x',
        response: runResponse('haze-trace_sources-x'),
      },
    } as unknown as Artifact;
  }

  const reviewWith = (verifyOk: boolean, problems: string[]) =>
    fakeSidecar({
      'GET /health': health('offline_sample'),
      'GET /api/evidence/E-c2b0c3cd57/verify': () => [
        200,
        {
          ok: verifyOk,
          stored: 's',
          now: verifyOk ? 's' : 't',
          sql: 'SELECT 1',
          provenance,
        },
      ],
      'POST /api/claims/check': (body) => [
        200,
        {
          ok: problems.length === 0,
          problems,
          checked_evidence_ids: (body as { evidence_ids: string[] })
            .evidence_ids,
          lanes: ['deterministic'],
          provenance,
        },
      ],
    });

  it('approves only when every re-run matches and every claim is cited', async () => {
    const { value, saved } = services(reviewWith(true, []).fetcher, scope, [
      produced(),
    ]);
    const output = await definition('smokeledger.review').execute!(value);
    expect(output.support).toBe('supported');
    expect(saved[0]).toMatchObject({
      kind: 'review',
      content: { valid: true, verdict: 'supported' },
    });
  });

  it.each([
    ['a changed evidence hash', false, []],
    ['an uncited number', true, ['Number without a citation: "92%"']],
  ] as const)('blocks on %s', async (_, verifyOk, problems) => {
    const { value, saved } = services(
      reviewWith(verifyOk, [...problems]).fetcher,
      scope,
      [produced()],
    );
    const output = await definition('smokeledger.review').execute!(value);
    expect(output.support).toBe('gap');
    // valid: false is what the task runtime uses to exclude material from synthesis.
    expect(saved[0]).toMatchObject({
      kind: 'review',
      content: { valid: false, verdict: 'rejected' },
    });
  });

  it('leaves material unreviewed when the checker is unavailable', async () => {
    const { value, saved } = services(fakeSidecar({}).fetcher, scope, [
      produced(),
    ]);
    const output = await definition('smokeledger.review').execute!(value);
    expect(output.support).toBe('gap');
    expect(saved[0]!.kind).toBe('evidence.gap');
  });
});
