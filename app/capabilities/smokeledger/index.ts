import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  artifactRefSchema,
  type Artifact,
} from '../../contracts/artifacts.js';
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
  criticInputSchema,
  criticOutputSchema,
  frameSmokeLedgerScope,
  previewsInputSchema,
  previewsOutputSchema,
  runToolOutputSchema,
  SMOKELEDGER_OPERATIONS,
  smokeLedgerScopeSchema,
  verifyInputSchema,
  verifyOutputSchema,
  type RunToolOutput,
  type SmokeLedgerRunTool,
} from './contracts.js';

import { smokeLedgerWorldModelAdapter } from './world.js';

export { frameSmokeLedgerScope } from './contracts.js';
export { smokeLedgerWorldModelAdapter } from './world.js';
export { SmokeLedgerError } from './client.js';

export const SMOKELEDGER_CAPABILITY = 'smokeledger-episode';
export const SMOKELEDGER_TOOLS = {
  airOutlook: 'haze.air_outlook',
  traceSources: 'haze.trace_sources',
  verify: 'haze.evidence.verify',
  claimCheck: 'haze.claim_check',
  critic: 'haze.evidence_critic',
  previews: 'haze.message_previews',
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
      // One computation, no SmokeLedger agents: this task's own agents orchestrate and review.
      const { status, body } = await sidecar.method(
        operation === 'assess_haze' ? 'outlook' : 'trace',
        {
          run_id,
          town: scope.town,
          window: scope.window,
          ...(as_of ? { as_of } : {}),
        },
        context.signal,
      );
      if (status !== 200)
        throw new SmokeLedgerError(
          errorMessage(body, `SmokeLedger method failed (HTTP ${status}).`),
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
      'Hourly PM2.5, 24 h API and school-closure probability for a supported town and window (UTC+8, at most 72 h), with hashed evidence ids. Records its run and evidence; read-only toward sources.',
    ),
    runTool(
      SMOKELEDGER_TOOLS.traceSources,
      "Backward attribution of a town's smoke to fires, peat and concession land with ranges, map source/date and a confidence label (PeatFire Sentinel's computation). Results are leads, not responsibility.",
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
    {
      id: SMOKELEDGER_TOOLS.critic,
      version: '1',
      mode,
      description:
        "SmokeLedger's independent checks on one outlook or trace result: citations, re-running every cited query and comparing hashes, window coverage and hindsight disclosure.",
      inputSchema: criticInputSchema,
      outputSchema: criticOutputSchema,
      async execute(input, context) {
        const { operation, scope, result } = criticInputSchema.parse(input);
        const sidecar = client();
        await ready(sidecar, mode, context.signal);
        const { status, body } = await sidecar.method(
          'critic',
          {
            operation,
            run_id: result.run_id,
            town: scope.town,
            window: scope.window,
            result,
          },
          context.signal,
        );
        const parsed = criticOutputSchema.safeParse(body);
        if (status !== 200 || !parsed.success)
          throw new SmokeLedgerError(
            errorMessage(body, `Critic checks failed (HTTP ${status}).`),
            'provider_failure',
          );
        return parsed.data;
      },
    },
    {
      id: SMOKELEDGER_TOOLS.previews,
      version: '1',
      mode,
      description:
        "CommunityAlert's Malay/English message previews for a reviewed outlook. Previews only: nothing is sent.",
      inputSchema: previewsInputSchema,
      outputSchema: previewsOutputSchema,
      async execute(input, context) {
        const { scope, assessment, bound_to } = previewsInputSchema.parse(input);
        const sidecar = client();
        await ready(sidecar, mode, context.signal);
        const { status, body } = await sidecar.method(
          'previews',
          {
            run_id: runIdFor(context, 'previews'),
            town: scope.town,
            window: scope.window,
            assessment,
            bound_to,
          },
          context.signal,
        );
        const parsed = previewsOutputSchema.safeParse(body);
        if (status !== 200 || !parsed.success)
          throw new SmokeLedgerError(
            errorMessage(body, `Message previews failed (HTTP ${status}).`),
            'provider_failure',
          );
        return parsed.data;
      },
    },
  ];
}

export function createSmokeLedgerCapability(
  now: () => Date = () => new Date(),
): CapabilityDefinition {
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
        DRAFTS_KIND,
        'evidence.gap',
      ],
      required_tools: Object.values(SMOKELEDGER_TOOLS),
      roles: ['HazeOps', 'WorkerShield', 'EvidenceCritic'],
      readiness: 'implemented',
      limitations: [
        ...SMOKELEDGER_LIMITATIONS,
        'Community message previews are drafts; nothing is sent.',
      ],
    },
    // Both producer outputs need the independent review before the Manager may select them.
    review_requirements: [
      {
        artifact_kind: 'smokeledger.air_outlook',
        review_definition_id: 'smokeledger.review',
        producer_definition_ids: ['smokeledger.air_outlook'],
      },
      {
        artifact_kind: 'smokeledger.trace_sources',
        review_definition_id: 'smokeledger.review',
        producer_definition_ids: ['smokeledger.trace_sources'],
      },
      {
        artifact_kind: DRAFTS_KIND,
        review_definition_id: 'smokeledger.review',
        producer_definition_ids: ['smokeledger.previews'],
      },
    ],
    // Reviewed findings are recorded in the team World Model, the single fact authority.
    worldModel: smokeLedgerWorldModelAdapter,
    // Live Managers rewrote the plan (wrong input shape, extra reviews); the templates are the plan.
    exact_templates: true,
    normalizeReview(artifact) {
      if (artifact.kind !== 'review') return undefined;
      const content = z
        .looseObject({
          valid: z.boolean(),
          reviewed_artifacts: z.array(artifactRefSchema),
          findings: z.array(z.string()).default([]),
        })
        .safeParse(artifact.content);
      // Passed checks support the exact reviewed revisions; any failed hash or claim rejects them.
      return content.success
        ? {
            verdict: content.data.valid ? 'supported' : 'rejected',
            artifacts: content.data.reviewed_artifacts,
            limitations: content.data.findings,
          }
        : undefined;
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
      // A window that has already ended is traced back only: an outlook looks forward,
      // and community messages warn about air that is still to come.
      const scope = smokeLedgerScopeSchema.safeParse(input);
      const upcoming =
        !scope.success || Date.parse(scope.data.window.end) > now().getTime();
      const wantsMessages =
        upcoming && MESSAGE_REQUEST.test(request.objective);
      return [
        ...(upcoming
          ? [
              {
                key: 'air-outlook',
                definition_id: 'smokeledger.air_outlook',
                brief:
                  'Assess the air over the town for the window from hashed SmokeLedger evidence.',
                depends_on: [],
                input,
              },
            ]
          : []),
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
          depends_on: [
            ...(upcoming ? ['air-outlook'] : []),
            'trace-sources',
            ...(wantsMessages ? ['message-previews'] : []),
          ],
          input,
        },
        // Community message drafts only when the question asks for them: each extra
        // assignment adds artifacts to the Manager's bounded context.
        ...(wantsMessages
          ? [
              {
                key: 'message-previews',
                definition_id: 'smokeledger.previews',
                brief:
                  'Draft Malay/English community message previews from the outlook for review; never send.',
                depends_on: ['air-outlook'],
                input,
              },
            ]
          : []),
      ];
    },
  };
}

// Live Managers re-planned other SmokeLedger steps to "load data"; no step can.
const NO_IN_TASK_FIX =
  'No assignment in this task can load more data: report this as a data gap in the answer.';

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
// The kind avoids the word "review": Manager selection treats such kinds as review records.
const DRAFTS_KIND = 'smokeledger.community_message_drafts';
const MESSAGE_REQUEST =
  /\b(messages?|notices?|parents?|schools?|alerts?|warn(?:ing|ings)?|drafts?)\b/iu;
const draftsSchema = z.looseObject({
  bound_to_outlook: artifactRefSchema,
  messages: z.looseObject({ status: z.string() }),
});

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
    const reason = `${error instanceof Error ? error.message : 'Tool failed.'} ${NO_IN_TASK_FIX}`;
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
    const reason = `${
      response.error?.message ?? `SmokeLedger run ${response.run_id} failed.`
    } ${NO_IN_TASK_FIX}`;
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

// Critic findings that mean a claim or its evidence cannot be trusted reject the material;
// coverage findings leave it usable but partial (its gaps are already disclosed).
const REJECTING_FINDINGS = new Set([
  'citation',
  'hash_mismatch',
  'hindsight_undisclosed',
  'unsupported_narrative',
]);

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
  const cited = [
    ...new Set(
      runs.flatMap((run) =>
        (run.response.output?.claims ?? []).flatMap((c) => c.evidence_ids),
      ),
    ),
  ]
    .filter((id) => /^E-[a-f0-9]{10}$/.test(id))
    .sort();
  // Message drafts must be previews of the exact outlook under review, or they are rejected with it.
  const drafts = services.context.inputs.filter((a) => a.kind === DRAFTS_KIND);
  const draftProblems = drafts.flatMap((draft) => {
    const content = draftsSchema.safeParse(draft.content);
    if (!content.success) return [`drafts ${draft.id}: unreadable draft content.`];
    const bound = content.data.bound_to_outlook;
    return [
      ...(reviewed.some(
        (a) =>
          a.kind === KIND['haze.air_outlook'] &&
          a.id === bound.id &&
          a.sha256 === bound.sha256,
      )
        ? []
        : [`drafts ${draft.id}: not bound to the outlook under review.`]),
      ...(content.data.messages.status === 'preview'
        ? []
        : [`drafts ${draft.id}: messages are not marked as previews.`]),
    ];
  });
  try {
    // SmokeLedger's checks on every claim: citations, every cited query re-run, coverage, hindsight.
    const critic = [];
    for (const run of runs)
      critic.push({
        operation: run.operation,
        run_id: run.run_id,
        ...criticOutputSchema.parse(
          await services.tool(SMOKELEDGER_TOOLS.critic, {
            operation: run.operation,
            scope: run.scope,
            result: run.response,
          }),
        ),
      });
    // The sentences that reach the synthesis also get the model judge when one is configured.
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
    const criticFindings = critic.flatMap((c) =>
      c.decision.findings.map((f) => ({ operation: c.operation, ...f })),
    );
    const valid =
      !criticFindings.some((f) => REJECTING_FINDINGS.has(f.code)) &&
      (synthesisCheck?.ok ?? true) &&
      draftProblems.length === 0;
    const complete =
      criticFindings.length === 0 &&
      runs.every((run) => run.response.status === 'success');
    const findings = [
      ...criticFindings.map((f) => `${f.operation} ${f.code}: ${f.message}`),
      ...(synthesisCheck?.problems ?? []),
      ...draftProblems,
    ];
    const reruns = critic.reduce(
      (sum, c) => sum + (c.remote_calls_executed?.['zetaris.sql'] ?? 0),
      0,
    );
    const artifact = services.save('review', {
      valid,
      verdict: valid ? (complete ? 'supported' : 'partial') : 'rejected',
      critic,
      synthesis_check: synthesisCheck,
      findings,
      reviewed_artifacts: [...reviewed, ...drafts].map(
        ({ id, version, sha256 }) => ({ id, version, sha256 }),
      ),
    });
    const checks = [...new Set(critic.flatMap((c) => c.decision.checks_run))];
    return {
      status: 'completed',
      summary: valid
        ? `Independent checks passed (${checks.join(', ')}${synthesisCheck ? ', answer sentences judged' : ''}): ${cited.length} cited evidence ids, ${reruns} live Zetaris re-runs.`
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

/**
 * CommunityAlert's previews drafted from the outlook. They are bound to its exact
 * revision and reviewed with it, so they reach an answer only if the review supports both.
 */
async function messagePreviews(
  services: AssignmentServices,
): Promise<AssignmentOutput> {
  const outlook = services.context.inputs.find(
    (a) => a.kind === KIND['haze.air_outlook'],
  );
  const run = outlook
    ? runToolOutputSchema.safeParse(outlook.content)
    : undefined;
  const assessment = z
    .looseObject({ hourly: z.array(z.unknown()) })
    .safeParse(run?.success ? run.data.response['assessment'] : undefined);
  if (!outlook || !run?.success || !assessment.success)
    return {
      status: 'completed',
      summary: 'Message previews unavailable: no air outlook to draft from.',
      support: 'gap',
      uncertainty: ['Previews are drafted only from an air outlook.'],
      outputs: [],
    };
  const output = previewsOutputSchema.parse(
    await services.tool(SMOKELEDGER_TOOLS.previews, {
      scope: run.data.scope,
      assessment: assessment.data,
      bound_to: `${outlook.id}@${outlook.sha256.slice(0, 12)}`,
    }),
  );
  const artifact = services.save(DRAFTS_KIND, {
    notice:
      'PREVIEW ONLY - not sent. Delivery needs a separate, human-authorised step.',
    bound_to_outlook: {
      id: outlook.id,
      version: outlook.version,
      sha256: outlook.sha256,
    },
    messages: output.messages,
  });
  return {
    status: 'completed',
    summary: `${output.messages.previews.length} message previews drafted (${[...new Set(output.messages.previews.map((p) => p.language))].join(', ')}); nothing was sent.`,
    support: 'supported',
    uncertainty: ['Previews are drafts for human review; no message was sent.'],
    outputs: [artifact],
  };
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
      tools: [SMOKELEDGER_TOOLS.critic, SMOKELEDGER_TOOLS.claimCheck],
      instructions:
        'Independently re-run decisive evidence and check every claim. A producer cannot approve its own work; reject any failed check.',
      execute: review,
    },
    {
      id: 'smokeledger.previews',
      version: '1',
      capability: SMOKELEDGER_CAPABILITY,
      agent: 'WorkerShield',
      tools: [SMOKELEDGER_TOOLS.previews],
      instructions:
        'Draft community message previews from the outlook for independent review. Never send anything.',
      execute: messagePreviews,
    },
  ];
}
