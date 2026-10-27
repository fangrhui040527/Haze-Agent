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
  // Same shape as the real sidecar's sample-mode response.
  sponsor_integration_evidence: {
    zetaris: { executed: 0, skipped: 13, request_ids: [] },
    nightshift: { executed: 0, skipped: 0, available: false },
  },
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
    assignmentRevision: 1,
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

  // The task runtime appends each correction to the objective as a new line.
  it('applies a text-only town correction and keeps the dates', () => {
    expect(
      frameSmokeLedgerScope({
        objective:
          'Investigate the haze over Batu Pahat on 6–7 October 2026.\ncorrection: Change the area to Klang.',
      }),
    ).toEqual({ ...scope, town: 'Klang' });
  });

  it('applies the latest of several corrections', () => {
    expect(
      frameSmokeLedgerScope({
        objective: [
          'Investigate the haze over Batu Pahat on 6–7 October 2026.',
          'correction: Change the area to Klang.',
          'correction: Change the dates to 8 October 2026.',
          'correction: Switch the town to Muar',
        ].join('\n'),
      }),
    ).toEqual({
      town: 'Muar',
      window: {
        start: '2026-10-08T00:00:00+08:00',
        end: '2026-10-09T00:00:00+08:00',
      },
    });
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

  // The live chat Manager rewrites the objective and adds a scope in its own shape.
  it.each([
    'Assess evidence for haze over Batu Pahat on 6–7 October 2026, identify likely smoke sources.',
    'Assess haze evidence and recommend data for the specified Batu Pahat 6–7 October 2026.',
    'Identify the smoke sources for haze observed over Batu Pahat, Johor, on 6–7 October 2026.',
  ])('reads a Manager rewrite %j and ignores a foreign scope', (objective) => {
    expect(
      frameSmokeLedgerScope({
        objective,
        scope: {
          location: 'Batu Pahat',
          period: {
            start: '2026-10-06T00:00:00Z',
            end: '2026-10-07T23:59:59Z',
          },
        },
      }),
    ).toEqual(scope);
  });

  it.each([
    'What is the haze like?',
    'Investigate the haze over Batu Pahat on 31 February 2026.',
  ])('needs an explicit scope for %j', (objective) => {
    expect(() => frameSmokeLedgerScope({ objective })).toThrow();
  });

  it.each([
    ['Investigate the haze over Batu Pahat on 6–7 October 2026.', true],
    ['What is the haze like?', false],
    [
      'Investigate PM2.5 evidence for Klang during 2026-10-06 to 2026-10-07.',
      false,
    ],
  ])(
    'claims %j only with a readable town and window: %s',
    (objective, expected) => {
      expect(
        createSmokeLedgerCapability().matches({
          schema_version: 'haze.task.request.v3',
          objective,
        } as never),
      ).toBe(expected);
    },
  );

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

  it('plans community message drafts only when the question asks for them', () => {
    // Before the window: the outlook still looks forward.
    const plan = (objective: string) =>
      createSmokeLedgerCapability(() => new Date('2026-10-05T00:00:00Z'))
        .assignments({
          schema_version: 'haze.task.request.v3',
          objective,
        } as never)
        .map((p) => [p.key, p.depends_on]);
    expect(
      plan('Investigate the haze over Batu Pahat on 6–7 October 2026.'),
    ).toEqual([
      ['air-outlook', []],
      ['trace-sources', []],
      ['review', ['air-outlook', 'trace-sources']],
    ]);
    expect(
      plan(
        'Investigate the haze over Batu Pahat on 6–7 October 2026 and draft notices for parents.',
      ),
    ).toEqual([
      ['air-outlook', []],
      ['trace-sources', []],
      ['review', ['air-outlook', 'trace-sources', 'message-previews']],
      ['message-previews', ['air-outlook']],
    ]);
  });

  it('only traces sources back for a window that has already ended', () => {
    const plan = createSmokeLedgerCapability(
      () => new Date('2026-10-08T00:00:00+08:00'),
    )
      .assignments({
        schema_version: 'haze.task.request.v3',
        objective:
          'Investigate the haze over Batu Pahat on 6–7 October 2026 and draft notices for parents.',
      } as never)
      .map((p) => [p.key, p.depends_on]);
    expect(plan).toEqual([
      ['trace-sources', []],
      ['review', ['trace-sources']],
    ]);
  });
});

describe('smokeledger tools', () => {
  it('runs in sample mode with a stable run id per task, assignment and revision', async () => {
    const sidecar = fakeSidecar({
      'GET /health': health('offline_sample'),
      'POST /api/methods/trace': (body) => [
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
    // One method call: no SmokeLedger workflow, Manager or critic agent.
    expect(sidecar.calls[1]).toEqual({
      path: 'POST /api/methods/trace',
      body: { run_id: first.run_id, town: 'Batu Pahat', window: scope.window },
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

  it('decides a live outlook for an unfinished window now, but leaves past windows and traces to the sidecar default', async () => {
    const liveSidecar = () =>
      fakeSidecar({
        'GET /health': health('live'),
        'POST /api/methods/outlook': (body) => [
          200,
          runResponse((body as { run_id: string }).run_id, { mode: 'live' }),
        ],
        'POST /api/methods/trace': (body) => [
          200,
          runResponse((body as { run_id: string }).run_id, { mode: 'live' }),
        ],
      });
    const day = 86_400_000;
    const window = (fromNow: number) => ({
      start: new Date(Date.now() + fromNow).toISOString(),
      end: new Date(Date.now() + fromNow + day).toISOString(),
    });
    const current = liveSidecar();
    await tools(current.fetcher, 'live')
      .get('haze.air_outlook')!
      .execute({ town: 'Batu Pahat', window: window(-day / 2) }, context());
    const asOf = (current.calls[1]!.body as { as_of?: string }).as_of;
    expect(Date.parse(asOf!)).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - Date.parse(asOf!)).toBeLessThan(3_600_000);

    const past = liveSidecar();
    await tools(past.fetcher, 'live')
      .get('haze.air_outlook')!
      .execute({ town: 'Batu Pahat', window: window(-3 * day) }, context());
    const trace = liveSidecar();
    await tools(trace.fetcher, 'live')
      .get('haze.trace_sources')!
      .execute({ town: 'Batu Pahat', window: window(-day / 2) }, context());
    for (const sidecar of [past, trace])
      expect(sidecar.calls[1]!.body).not.toHaveProperty('as_of');
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
      'POST /api/methods/outlook': (body) => [
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

  it('keeps a branch partial when a finding was not assessed, even if the sidecar critic approves', async () => {
    const unassessed =
      'Fires inside mapped concessions: not assessed, because no concession map is loaded [E-aa6885079e].';
    const sidecar = fakeSidecar({
      'GET /health': health('offline_sample'),
      'POST /api/methods/trace': (body) => {
        const response = runResponse((body as { run_id: string }).run_id);
        response.output.claims.push({
          id: 'c2',
          kind: 'inference',
          text: unassessed,
          evidence_ids: ['E-aa6885079e'],
        });
        return [200, response];
      },
    });
    const { value } = services(sidecar.fetcher, scope);
    const output = await definition('smokeledger.trace_sources').execute!(
      value,
    );
    expect(output.support).toBe('partial');
    expect(output.uncertainty[0]).toBe(unassessed);
  });

  it('keeps the sidecar response verbatim and labels sample evidence fictional', async () => {
    const sidecar = fakeSidecar({
      'GET /health': health('offline_sample'),
      'POST /api/methods/trace': (body) => [
        200,
        runResponse((body as { run_id: string }).run_id),
      ],
    });
    const { value, saved } = services(sidecar.fetcher, scope);
    const output = await definition('smokeledger.trace_sources').execute!(
      value,
    );
    expect(output.support).toBe('supported');
    // Recorded provenance and data needs reach the synthesis, never implied execution.
    expect(output.summary).toContain(
      'Provenance (offline_sample): Zetaris skipped (13); Nightshift not used',
    );
    expect(output.summary).toContain(
      'H-MEM 2 and World Model 0 operations executed locally',
    );
    expect(output.summary).toContain(
      'Would improve the conclusion: a current, dated concession map',
    );
    expect(saved[0]).toMatchObject({
      kind: 'smokeledger.trace_sources',
      evidence_origin: 'synthetic_fixture',
      content: {
        response: {
          sponsor_integration_evidence: {
            zetaris: { executed: 0, skipped: 13, request_ids: [] },
          },
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

  type Finding = { code: string; message: string };
  const reviewWith = (findings: Finding[], problems: string[]) =>
    fakeSidecar({
      'GET /health': health('offline_sample'),
      'POST /api/methods/critic': () => [
        200,
        {
          decision: {
            decision: findings.length ? 'revise' : 'approve',
            findings,
            checks_run: ['citations', 'independent re-query of cited evidence'],
          },
          independent_evidence: [],
          remote_calls_executed: { 'zetaris.sql': 2 },
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

  it('approves only when the critic finds nothing and the answer sentences pass', async () => {
    const sidecar = reviewWith([], []);
    const { value, saved } = services(sidecar.fetcher, scope, [produced()]);
    const output = await definition('smokeledger.review').execute!(value);
    expect(output.support).toBe('supported');
    expect(saved[0]).toMatchObject({
      kind: 'review',
      content: { valid: true, verdict: 'supported' },
    });
    // SmokeLedger's critic checks the full result; the judge sees the answer's sentences.
    const critic = sidecar.calls.find(
      (call) => call.path === 'POST /api/methods/critic',
    );
    expect(critic!.body).toMatchObject({
      operation: 'trace_sources',
      town: 'Batu Pahat',
      result: { run_id: 'haze-trace_sources-x' },
    });
    const checks = sidecar.calls
      .filter((call) => call.path === 'POST /api/claims/check')
      .map((call) => call.body as { use_model?: boolean; text: string });
    expect(checks).toEqual([
      expect.objectContaining({
        text: 'Fires on peat: 92% of the smoke signal [E-c2b0c3cd57].',
      }),
    ]);
    expect(checks[0]).not.toHaveProperty('use_model');
  });

  it.each([
    [
      'a changed evidence hash',
      [{ code: 'hash_mismatch', message: 'E-c2b0c3cd57 changed.' }],
      [],
    ],
    [
      'an uncited claim',
      [{ code: 'citation', message: 'Number without a citation.' }],
      [],
    ],
    ['an unsupported answer sentence', [], ['S1: mean is 83, not 25']],
  ] as const)('blocks on %s', async (_, findings, problems) => {
    const { value, saved } = services(
      reviewWith([...findings], [...problems]).fetcher,
      scope,
      [produced()],
    );
    const output = await definition('smokeledger.review').execute!(value);
    expect(output.support).toBe('gap');
    // valid: false is what normalizeReview turns into a rejected review check.
    expect(saved[0]).toMatchObject({
      kind: 'review',
      content: { valid: false, verdict: 'rejected' },
    });
  });

  it('keeps disclosed coverage gaps usable but partial', async () => {
    const { value, saved } = services(
      reviewWith(
        [{ code: 'coverage_gap', message: 'No forecast for 09:00 MYT.' }],
        [],
      ).fetcher,
      scope,
      [produced()],
    );
    const output = await definition('smokeledger.review').execute!(value);
    expect(output.support).toBe('partial');
    expect(saved[0]).toMatchObject({
      kind: 'review',
      content: { valid: true, verdict: 'partial' },
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

  function outlookArtifact(): Artifact {
    return {
      id: crypto.randomUUID(),
      version: 1,
      sha256: 'd'.repeat(64),
      kind: 'smokeledger.air_outlook',
      content: {
        operation: 'assess_haze',
        scope,
        run_id: 'haze-assess_haze-x',
        response: {
          ...runResponse('haze-assess_haze-x'),
          assessment: { hourly: [] },
        },
      },
    } as unknown as Artifact;
  }
  const previewSidecar = () =>
    fakeSidecar({
      'GET /health': health('offline_sample'),
      'POST /api/methods/previews': (body) => [
        200,
        {
          messages: {
            bound_to: (body as { bound_to: string }).bound_to,
            status: 'preview',
            previews: [
              { audience: 'parents', language: 'ms', text: 'Kepada Guru…' },
            ],
          },
        },
      ],
    });

  it('drafts previews from the outlook, bound to its exact revision, and never sends them', async () => {
    const outlook = outlookArtifact();
    const sidecar = previewSidecar();
    const { value, saved } = services(sidecar.fetcher, scope, [outlook]);
    const output = await definition('smokeledger.previews').execute!(value);
    expect(output.support).toBe('supported');
    expect(output.summary).toContain('nothing was sent');
    expect(saved[0]).toMatchObject({
      kind: 'smokeledger.community_message_drafts',
      content: {
        bound_to_outlook: { id: outlook.id, sha256: outlook.sha256 },
        messages: { status: 'preview' },
      },
    });
    expect((saved[0]!.content as { notice: string }).notice).toContain(
      'not sent',
    );
  });

  it('drafts nothing without an outlook', async () => {
    const sidecar = previewSidecar();
    const { value, saved } = services(sidecar.fetcher, scope, []);
    const output = await definition('smokeledger.previews').execute!(value);
    expect(output.support).toBe('gap');
    expect(saved).toEqual([]);
    expect(sidecar.calls).toEqual([]);
  });

  it('reviews drafts with the outlook and rejects drafts bound to another outlook', async () => {
    const outlook = outlookArtifact();
    const drafts = (bound: Artifact) =>
      ({
        id: crypto.randomUUID(),
        version: 1,
        sha256: 'f'.repeat(64),
        kind: 'smokeledger.community_message_drafts',
        content: {
          bound_to_outlook: {
            id: bound.id,
            version: bound.version,
            sha256: bound.sha256,
          },
          messages: { status: 'preview', previews: [] },
        },
      }) as unknown as Artifact;
    const good = drafts(outlook);
    const passed = services(reviewWith([], []).fetcher, scope, [outlook, good]);
    await definition('smokeledger.review').execute!(passed.value);
    expect(passed.saved[0]).toMatchObject({
      content: { valid: true },
    });
    expect(
      (
        passed.saved[0]!.content as { reviewed_artifacts: { id: string }[] }
      ).reviewed_artifacts.map((ref) => ref.id),
    ).toEqual([outlook.id, good.id]);

    const stray = services(reviewWith([], []).fetcher, scope, [
      outlook,
      drafts(outlookArtifact()),
    ]);
    const output = await definition('smokeledger.review').execute!(stray.value);
    expect(output.support).toBe('gap');
    expect(stray.saved[0]).toMatchObject({
      content: { valid: false, verdict: 'rejected' },
    });
  });
});

describe('smokeledger review gate (task runtime review checks)', () => {
  const capability = createSmokeLedgerCapability();
  const ref = { id: crypto.randomUUID(), version: 1, sha256: 'c'.repeat(64) };
  const review = (content: unknown) =>
    ({ kind: 'review', content }) as unknown as Artifact;

  it('requires the independent review for both producer outputs', () => {
    expect(capability.review_requirements).toEqual([
      expect.objectContaining({
        artifact_kind: 'smokeledger.air_outlook',
        review_definition_id: 'smokeledger.review',
      }),
      expect.objectContaining({
        artifact_kind: 'smokeledger.trace_sources',
        review_definition_id: 'smokeledger.review',
      }),
      expect.objectContaining({
        artifact_kind: 'smokeledger.community_message_drafts',
        review_definition_id: 'smokeledger.review',
      }),
    ]);
  });

  it('maps passed checks to supported and any failed check to rejected', () => {
    expect(
      capability.normalizeReview!(
        review({ valid: true, reviewed_artifacts: [ref], findings: [] }),
      ),
    ).toEqual({ verdict: 'supported', artifacts: [ref], limitations: [] });
    expect(
      capability.normalizeReview!(
        review({
          valid: false,
          reviewed_artifacts: [ref],
          findings: ['E-0000000000: hash changed'],
        }),
      ),
    ).toEqual({
      verdict: 'rejected',
      artifacts: [ref],
      limitations: ['E-0000000000: hash changed'],
    });
  });

  it('gives no verdict for unreadable or non-review artifacts, leaving the default needs_review', () => {
    expect(capability.normalizeReview!(review({ verdict: 'ok' }))).toBe(
      undefined,
    );
    expect(
      capability.normalizeReview!({
        kind: 'evidence.gap',
        content: {},
      } as unknown as Artifact),
    ).toBe(undefined);
  });
});
