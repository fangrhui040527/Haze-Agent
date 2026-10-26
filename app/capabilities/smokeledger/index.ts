import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Artifact } from '../../contracts/artifacts.js';
import type {
  AssignmentDefinition,
  AssignmentOutput,
  AssignmentServices,
  CapabilityDefinition,
  ExecutionMode,
  ToolContext,
  ToolDefinition,
} from '../../orchestration/ports.js';
import {
  createSmokeLedgerClient,
  SmokeLedgerError,
  type SmokeLedgerClient,
} from './client.js';
import {
  claimCheckInputSchema,
  claimCheckOutputSchema,
  frameSmokeLedgerScope,
  runToolOutputSchema,
  SMOKELEDGER_OPERATIONS,
  smokeLedgerScopeSchema,
  verifyInputSchema,
  verifyOutputSchema,
  type RunToolOutput,
  type SmokeLedgerRunTool,
} from './contracts.js';

export { frameSmokeLedgerScope } from './contracts.js';
export { SmokeLedgerError } from './client.js';

export const SMOKELEDGER_CAPABILITY = 'smokeledger-episode';
export const SMOKELEDGER_TOOLS = {
  airOutlook: 'haze.air_outlook',
  traceSources: 'haze.trace_sources',
  verify: 'haze.evidence.verify',
  claimCheck: 'haze.claim_check',
} as const;

/** Limits that must stay visible in every SmokeLedger-backed answer. */
export const SMOKELEDGER_LIMITATIONS = [
  'Fires inside a concession show where land burned, not who lit it; concession names are leads for verification.',
  'Public concession maps may be outdated; each result shows the map source and date.',
  'Trajectories use a simple model, not NOAA HYSPLIT; source shares come with ranges.',
  "PM2.5-to-API breakpoints (US EPA, pre-2024) are unverified against Malaysia's DOE; the 3x peat factor is an assumption.",
  'Offline and replay runs use archived model values (hindsight) and say so.',
];

const SIDECAR_MODE = { live: 'live', fixture: 'offline_sample' } as const;

const healthSchema = z.looseObject({
  status: z.enum(['ready', 'degraded']),
  reasons: z.array(z.string()),
  mode: z.enum(['live', 'offline_sample']),
});
const errorBodySchema = z.looseObject({
  error: z.looseObject({ message: z.string() }),
});
const verifyBodySchema = z.strictObject({
  ok: z.boolean(),
  stored: z.string(),
  now: z.string(),
  sql: z.string(),
  provenance: verifyOutputSchema.shape.results.element.shape.provenance.unwrap(),
});
const claimBodySchema = z.looseObject({
  ok: z.boolean(),
  problems: z.array(z.string()),
  judgeModel: z.string().optional(),
  checked_evidence_ids: z.array(z.string()),
  lanes: claimCheckOutputSchema.shape.lanes,
  provenance: claimCheckOutputSchema.shape.provenance,
});

function errorMessage(body: unknown, fallback: string): string {
  const parsed = errorBodySchema.safeParse(body);
  return parsed.success ? parsed.data.error.message.slice(0, 1000) : fallback;
}

/** Readiness is checked before every request, never assumed from configuration. */
async function ready(
  client: SmokeLedgerClient,
  mode: ExecutionMode,
  signal: AbortSignal,
) {
  if (mode === 'replay')
    throw new SmokeLedgerError(
      'No SmokeLedger replay source is configured; no request was made.',
      'unavailable',
    );
  const { status, body } = await client.health(signal);
  const health = healthSchema.safeParse(body);
  if (status !== 200 || !health.success)
    throw new SmokeLedgerError(
      'SmokeLedger health check failed; no request was made.',
      'unavailable',
    );
  if (health.data.mode !== SIDECAR_MODE[mode])
    throw new SmokeLedgerError(
      `SmokeLedger runs in ${health.data.mode} mode but the task was admitted as ${mode}; no request was made.`,
      'unavailable',
    );
  if (health.data.status !== 'ready')
    throw new SmokeLedgerError(
      `SmokeLedger is not ready: ${health.data.reasons.join('; ')}`,
      'unavailable',
    );
}

/** Stable per task, assignment and objective revision, so a resumed branch reuses the sidecar's stored run. */
function runIdFor(context: ToolContext, operation: string): string {
  const digest = createHash('sha256')
    .update(
      [
        context.taskId,
        context.assignmentId,
        context.objectiveRevision,
        operation,
      ].join('|'),
    )
    .digest('hex');
  return `haze-${operation}-${digest.slice(0, 32)}`;
}

export function createSmokeLedgerTools(
  options: {
    mode?: ExecutionMode;
    env?: NodeJS.ProcessEnv;
    fetcher?: typeof fetch;
  } = {},
): ToolDefinition[] {
  const mode = options.mode ?? 'live';
  // Configuration errors surface when a tool runs, not when the registry is built.
  const client = () => createSmokeLedgerClient(options.env ?? {}, options.fetcher);

  const runTool = (
    id: SmokeLedgerRunTool,
    description: string,
  ): ToolDefinition<z.infer<typeof smokeLedgerScopeSchema>, RunToolOutput> => ({
    id,
    version: '1',
    mode,
    description,
    inputSchema: smokeLedgerScopeSchema,
    outputSchema: runToolOutputSchema,
    async execute(input, context) {
      const scope = smokeLedgerScopeSchema.parse(input);
      const operation = SMOKELEDGER_OPERATIONS[id];
      const sidecar = client();
      await ready(sidecar, mode, context.signal);
      const run_id = runIdFor(context, operation);
      // A live outlook for a window that has not ended is decided now (not rounded: the sidecar
      // uses only forecasts issued at or before as_of); past windows keep its earlier default.
      const now = Date.now();
      const as_of =
        mode === 'live' &&
        operation === 'assess_haze' &&
        Date.parse(scope.window.end) > now
          ? new Date(now).toISOString()
          : undefined;
      const { status, body } = await sidecar.run(
        {
          run_id,
          input: {
            operation,
            town: scope.town,
            timezone: 'Asia/Kuala_Lumpur',
            time_window: scope.window,
            ...(as_of ? { as_of } : {}),
          },
          options: { sample_mode: mode === 'fixture' },
        },
        context.signal,
      );
      if (status !== 200)
        throw new SmokeLedgerError(
          errorMessage(body, `SmokeLedger run failed (HTTP ${status}).`),
          'provider_failure',
        );
      const output = runToolOutputSchema.parse({
        operation,
        scope,
        run_id,
        response: body,
      });
      if (output.response.mode !== SIDECAR_MODE[mode as 'live' | 'fixture'])
        throw new SmokeLedgerError(
          'SmokeLedger answered in a different execution mode than admitted.',
          'invalid_evidence',
        );
      return output;
    },
  });

  return [
    runTool(
      SMOKELEDGER_TOOLS.airOutlook,
      'Hourly PM2.5, 24 h API and school-closure probability for a supported town and window (UTC+8, at most 72 h), with hashed evidence ids and the sidecar critic decision. Read-only.',
    ),
    runTool(
      SMOKELEDGER_TOOLS.traceSources,
      'Backward attribution of a town\'s smoke to fires, peat and concession land with ranges, map source/date and a confidence label. Read-only; results are leads, not responsibility.',
    ),
    {
      id: SMOKELEDGER_TOOLS.verify,
      version: '1',
      mode,
      description:
        'Re-run stored evidence queries and compare their result hashes. Read-only.',
      inputSchema: verifyInputSchema,
      outputSchema: verifyOutputSchema,
      async execute(input, context) {
        const { evidence_ids } = verifyInputSchema.parse(input);
        const sidecar = client();
        await ready(sidecar, mode, context.signal);
        const results = [];
        for (const evidence_id of evidence_ids) {
          const { status, body } = await sidecar.verify(
            evidence_id,
            context.signal,
          );
          const parsed = verifyBodySchema.safeParse(body);
          results.push(
            status === 200 && parsed.success
              ? {
                  evidence_id,
                  verified: parsed.data.ok,
                  stored_sha256: parsed.data.stored,
                  current_sha256: parsed.data.now,
                  reason: parsed.data.ok
                    ? null
                    : 'The re-run result hash differs from the stored hash.',
                  provenance: parsed.data.provenance,
                }
              : {
                  evidence_id,
                  verified: false,
                  stored_sha256: null,
                  current_sha256: null,
                  reason: errorMessage(
                    body,
                    `Verification failed (HTTP ${status}).`,
                  ),
                  provenance: null,
                },
          );
        }
        return { results };
      },
    },
    {
      id: SMOKELEDGER_TOOLS.claimCheck,
      version: '1',
      mode,
      description:
        'Check text against evidence ids: unknown citations, numbers without citations and guilt wording; Nemotron judge lane when hosted inference is configured. Read-only.',
      inputSchema: claimCheckInputSchema,
      outputSchema: claimCheckOutputSchema,
      async execute(input, context) {
        const request = claimCheckInputSchema.parse(input);
        const sidecar = client();
        await ready(sidecar, mode, context.signal);
        const { status, body } = await sidecar.claimCheck(
          request,
          context.signal,
        );
        const parsed = claimBodySchema.safeParse(body);
        if (status !== 200 || !parsed.success)
          throw new SmokeLedgerError(
            errorMessage(body, `Claim check failed (HTTP ${status}).`),
            'provider_failure',
          );
        return {
          ok: parsed.data.ok,
          problems: parsed.data.problems,
          checked_evidence_ids: parsed.data.checked_evidence_ids,
          lanes: parsed.data.lanes,
          judge_model: parsed.data.judgeModel ?? null,
          provenance: parsed.data.provenance,
        };
      },
    },
  ];
}

export function createSmokeLedgerCapability(): CapabilityDefinition {
  return {
    card: {
      id: SMOKELEDGER_CAPABILITY,
      version: '1',
      purpose:
        'Investigate a haze episode for a supported Malaysian town: air outlook and backward source attribution from hashed, re-runnable evidence, independently verified before synthesis.',
      work_products: [
        'smokeledger.air_outlook',
        'smokeledger.trace_sources',
        'review',
        'evidence.gap',
      ],
      required_tools: Object.values(SMOKELEDGER_TOOLS),
      roles: ['HazeOps', 'WorkerShield', 'EvidenceCritic'],
      readiness: 'implemented',
      limitations: SMOKELEDGER_LIMITATIONS,
    },
    // Claim only requests with a readable town and window; other haze questions stay with
    // the team's capabilities or become explicit gaps there.
    matches(request) {
      if (!/\b(haze|smoke|episode)\b/iu.test(request.objective)) return false;
      try {
        frameSmokeLedgerScope(request);
        return true;
      } catch {
        return false;
      }
    },
    assignments(request) {
      let input: unknown;
      try {
        input = frameSmokeLedgerScope(request);
      } catch {
        input = { needs_scope: true };
      }
      return [
        {
          key: 'air-outlook',
          definition_id: 'smokeledger.air_outlook',
          brief:
            'Assess the air over the town for the window from hashed SmokeLedger evidence.',
          depends_on: [],
          input,
        },
        {
          key: 'trace-sources',
          definition_id: 'smokeledger.trace_sources',
          brief:
            'Trace where the smoke likely came from, with ranges; leads, not responsibility.',
          depends_on: [],
          input,
        },
        {
          key: 'review',
          definition_id: 'smokeledger.review',
          brief:
            'Independently re-run decisive evidence and check every claim before synthesis.',
          depends_on: ['air-outlook', 'trace-sources'],
          input,
        },
      ];
    },
  };
}

const sponsorSchema = z.looseObject({
  zetaris: z
    .looseObject({
      executed: z.number(),
      skipped: z.number(),
      request_ids: z.array(z.string()).optional(),
    })
    .optional(),
  nightshift: z
    .looseObject({
      executed: z.number(),
      skipped: z.number(),
      model_route: z.string().optional(),
    })
    .optional(),
});

/** Recorded execution only: what ran, what was skipped, and where the trace is. */
function provenanceLine(response: RunToolOutput['response']): string {
  const sponsor = sponsorSchema.safeParse(
    response.sponsor_integration_evidence ?? {},
  );
  const zetaris = sponsor.success ? sponsor.data.zetaris : undefined;
  const nightshift = sponsor.success ? sponsor.data.nightshift : undefined;
  const ops = (prefix: string) =>
    Object.entries(response.engine_operations_executed ?? {})
      .filter(([key]) => key.startsWith(prefix))
      .reduce((sum, [, count]) => sum + count, 0);
  const remote = (name: string, entry?: { executed: number; skipped: number }) =>
    !entry
      ? `${name} not reported`
      : entry.executed > 0
        ? `${name} executed (${entry.executed})`
        : entry.skipped > 0
          ? `${name} skipped (${entry.skipped})`
          : `${name} not used`;
  const ids = zetaris?.request_ids?.length
    ? `, request ids ${zetaris.request_ids.slice(0, 5).join(', ')}`
    : '';
  return [
    `Provenance (${response.mode}): ${remote('Zetaris', zetaris)}${ids}`,
    // A model route is named only for calls that actually ran.
    `${remote('Nightshift', nightshift)}${nightshift && nightshift.executed > 0 && nightshift.model_route ? ` via ${nightshift.model_route}` : ''}`,
    `H-MEM ${ops('hmem.')} and World Model ${ops('world_model.')} operations executed locally`,
    `sidecar trace ${response.log_file ?? 'not recorded'}.`,
  ].join('; ');
}

/** Data that would narrow the conclusion, derived only from what the run reported. */
function dataNeeds(output: RunToolOutput): string[] {
  const response = output.response;
  const limitations = (response.output?.limitations ?? []).join(' ');
  const needs: string[] = [];
  for (const hours of response.output?.validity?.unserved ?? [])
    needs.push(`PM2.5 evidence for the uncovered period ${hours}`);
  if (/hindsight/i.test(limitations))
    needs.push(
      'a forecast issued before the window (these values are hindsight)',
    );
  if (output.operation === 'trace_sources')
    needs.push(
      'a current, dated concession map',
      'independent trajectories (for example NOAA HYSPLIT) to narrow the source ranges',
      'on-the-ground verification before naming any landholder',
    );
  if (response.mode === 'offline_sample')
    needs.push('a live run on real evidence (this is the fictional sample)');
  return needs;
}

const KIND: Record<SmokeLedgerRunTool, string> = {
  'haze.air_outlook': 'smokeledger.air_outlook',
  'haze.trace_sources': 'smokeledger.trace_sources',
};

async function runOperation(
  services: AssignmentServices,
  tool: SmokeLedgerRunTool,
): Promise<AssignmentOutput> {
  const scope = smokeLedgerScopeSchema.safeParse(services.input);
  if (!scope.success) {
    services.question(
      'Which town and window should the haze investigation cover? Provide {"town": ..., "window": {"start": ..., "end": ...}} (ISO 8601 with offset, end exclusive) as the correction scope.',
    );
    return {
      status: 'waiting_human',
      summary: 'Waiting for an explicit town and window.',
      support: 'gap',
      uncertainty: ['The town or window is missing or unreadable.'],
      outputs: [],
    };
  }
  let output: RunToolOutput;
  try {
    output = runToolOutputSchema.parse(
      await services.tool(tool, scope.data),
    );
  } catch (error) {
    services.context.signal.throwIfAborted();
    if (error instanceof SmokeLedgerError && error.outcome === 'unknown')
      throw error;
    const reason = error instanceof Error ? error.message : 'Tool failed.';
    const gap = services.save('evidence.gap', {
      source: tool,
      reason,
      available: false,
    });
    return {
      status: 'completed',
      summary: `${tool} was unavailable; no substitute was queried.`,
      support: 'gap',
      uncertainty: [reason],
      outputs: [gap],
    };
  }
  const { response } = output;
  if (response.status === 'error') {
    // Unsupported town or window, or a failed sidecar run: a scoped gap, never a server error.
    const reason =
      response.error?.message ?? `SmokeLedger run ${response.run_id} failed.`;
    const gap = services.save('evidence.gap', {
      source: tool,
      operation: output.operation,
      scope: output.scope,
      error_type: response.error?.type ?? 'unknown',
      reason,
      supported: response.error?.type !== 'unsupported',
    });
    return {
      status: 'completed',
      summary: reason,
      support: 'gap',
      uncertainty: [reason],
      outputs: [gap],
    };
  }
  const artifact = services.save(KIND[tool], output, {
    evidence_origin:
      response.mode === 'offline_sample'
        ? 'synthetic_fixture'
        : 'external_source',
  });
  const needs = dataNeeds(output);
  // A finding the sidecar could not assess keeps the branch partial even when its critic approves.
  const unassessed = (response.output?.claims ?? [])
    .map((claim) => claim.text)
    .filter((text) => /\bnot assessed\b/i.test(text));
  return {
    status: 'completed',
    summary: [
      response.output?.summary ??
        `SmokeLedger ${output.operation} completed without a summary.`,
      ...(needs.length
        ? [`Would improve the conclusion: ${needs.join('; ')}.`]
        : []),
      provenanceLine(response),
    ].join('\n'),
    support:
      response.status === 'success' && unassessed.length === 0
        ? 'supported'
        : 'partial',
    uncertainty: [
      ...unassessed,
      ...(response.output?.limitations ?? []),
      ...(response.mode === 'offline_sample'
        ? ['Offline sample: fictional 3–9 Oct 2026 episode; Zetaris and Nightshift were skipped.']
        : []),
    ],
    outputs: [artifact],
  };
}

function criticDecision(response: RunToolOutput['response']): string {
  const parsed = z
    .looseObject({ final: z.looseObject({ decision: z.string() }) })
    .safeParse(response.critic);
  return parsed.success ? parsed.data.final.decision : 'unknown';
}

async function review(services: AssignmentServices): Promise<AssignmentOutput> {
  const reviewed = services.context.inputs.filter((artifact) =>
    Object.values(KIND).includes(artifact.kind),
  );
  if (!reviewed.length)
    return {
      status: 'completed',
      summary: 'Independent review has no SmokeLedger material to check.',
      support: 'gap',
      uncertainty: ['No air outlook or source trace was produced.'],
      outputs: [],
    };
  const runs = reviewed.map((artifact: Artifact) =>
    runToolOutputSchema.parse(artifact.content),
  );
  const claims = runs.flatMap((run) => run.response.output?.claims ?? []);
  const cited = [
    ...new Set(claims.flatMap((claim) => claim.evidence_ids)),
  ]
    .filter((id) => /^E-[a-f0-9]{10}$/.test(id))
    .sort();
  try {
    const verification = cited.length
      ? verifyOutputSchema.parse(
          await services.tool(SMOKELEDGER_TOOLS.verify, {
            evidence_ids: cited.slice(0, 40),
          }),
        )
      : { results: [] };
    // Every claim gets the deterministic lane; the sentences that reach the synthesis (each
    // run's summary) also get the model judge, which is too slow for dozens of hourly claims.
    const claimCheck = claims.length
      ? claimCheckOutputSchema.parse(
          await services.tool(SMOKELEDGER_TOOLS.claimCheck, {
            text: claims.map((claim) => claim.text).join('\n'),
            evidence_ids: cited.slice(0, 200),
            use_model: false,
          }),
        )
      : null;
    const synthesisText = runs
      .map((run) => run.response.output?.summary)
      .filter((summary): summary is string => Boolean(summary?.trim()))
      .join('\n');
    const synthesisCheck = synthesisText
      ? claimCheckOutputSchema.parse(
          await services.tool(SMOKELEDGER_TOOLS.claimCheck, {
            text: synthesisText,
            evidence_ids: cited.slice(0, 200),
          }),
        )
      : null;
    const unverified = verification.results.filter((result) => !result.verified);
    const decisions = runs.map((run) => ({
      operation: run.operation,
      run_id: run.run_id,
      status: run.response.status,
      decision: criticDecision(run.response),
    }));
    const valid =
      unverified.length === 0 &&
      (claimCheck?.ok ?? true) &&
      (synthesisCheck?.ok ?? true);
    const complete =
      cited.length <= 40 &&
      decisions.every((d) => d.status === 'success' && d.decision === 'approve');
    const findings = [
      ...unverified.map(
        (result) => `${result.evidence_id}: ${result.reason ?? 'not verified'}`,
      ),
      ...(claimCheck?.problems ?? []),
      ...(synthesisCheck?.problems ?? []),
      ...(cited.length > 40
        ? [`Only 40 of ${cited.length} cited evidence ids were re-run.`]
        : []),
    ];
    const artifact = services.save('review', {
      valid,
      verdict: valid ? (complete ? 'supported' : 'partial') : 'rejected',
      verification: verification.results,
      claim_check: claimCheck,
      synthesis_check: synthesisCheck,
      sidecar_critic: decisions,
      findings,
      reviewed_artifacts: reviewed.map(({ id, version, sha256 }) => ({
        id,
        version,
        sha256,
      })),
    });
    return {
      status: 'completed',
      summary: valid
        ? `Independent checks passed: ${verification.results.length} evidence re-runs matched and ${claims.length} claims cite known evidence.`
        : 'SmokeLedger material rejected by the independent checks.',
      support: valid ? (complete ? 'supported' : 'partial') : 'gap',
      uncertainty: findings,
      outputs: [artifact],
    };
  } catch (error) {
    services.context.signal.throwIfAborted();
    if (error instanceof SmokeLedgerError && error.outcome === 'unknown')
      throw error;
    // An unavailable checker leaves the material unreviewed; it never approves it.
    const reason = error instanceof Error ? error.message : 'Review failed.';
    const gap = services.save('evidence.gap', {
      source: 'smokeledger.review',
      reason,
      available: false,
    });
    return {
      status: 'completed',
      summary: 'Independent review could not run; the material stays unreviewed.',
      support: 'gap',
      uncertainty: [reason],
      outputs: [gap],
    };
  }
}

export function createSmokeLedgerAssignments(): AssignmentDefinition[] {
  return [
    {
      id: 'smokeledger.air_outlook',
      version: '1',
      capability: SMOKELEDGER_CAPABILITY,
      agent: 'HazeOps',
      tools: [SMOKELEDGER_TOOLS.airOutlook],
      instructions:
        'Retrieve the bounded air outlook. Preserve evidence ids, covered/uncovered hours and hindsight disclosure.',
      execute: (services) => runOperation(services, SMOKELEDGER_TOOLS.airOutlook),
    },
    {
      id: 'smokeledger.trace_sources',
      version: '1',
      capability: SMOKELEDGER_CAPABILITY,
      agent: 'WorkerShield',
      tools: [SMOKELEDGER_TOOLS.traceSources],
      instructions:
        'Trace likely smoke sources with ranges and map dates. Concessions are leads for verification, never proof of responsibility.',
      execute: (services) =>
        runOperation(services, SMOKELEDGER_TOOLS.traceSources),
    },
    {
      id: 'smokeledger.review',
      version: '1',
      capability: SMOKELEDGER_CAPABILITY,
      agent: 'EvidenceCritic',
      tools: [SMOKELEDGER_TOOLS.verify, SMOKELEDGER_TOOLS.claimCheck],
      instructions:
        'Independently re-run decisive evidence and check every claim. A producer cannot approve its own work; reject any failed check.',
      execute: review,
    },
  ];
}
