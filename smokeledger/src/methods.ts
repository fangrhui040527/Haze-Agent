// Method endpoints for an embedding app whose own agents (one Manager, HazeOps,
// WorkerShield, EvidenceCritic) orchestrate the work. Each call runs one SmokeLedger
// computation directly: no workflow graph, no SmokeLedger Manager or critic agent,
// no optional narrative. Responses keep the run contract's field names so callers
// read summaries, claims, evidence and sponsor provenance the same way.

import { CONFIG } from "./config.ts";
import { assess } from "./agents/hazeops.ts";
import { investigate } from "./agents/peatfire.ts";
import { synthesize } from "./agents/manager.ts";
import { review } from "./agents/critic.ts";
import { previews } from "./agents/communityalert.ts";
import { hostedAvailable } from "./llm.ts";
import { hmem } from "./meterless/hmem.ts";
import { worldModel } from "./meterless/worldModel.ts";
import { InputError, validate } from "./run.ts";
import { withRun, type RunCounters } from "./tracing/context.ts";
import { logFile, trace } from "./tracing/trace.ts";
import type { Assessment, Draft, EvidenceRef, Mode, Operation, RunRequest, Scope } from "./orchestration/types.ts";

type Body = Record<string, unknown>;

const mode = (): Mode => (CONFIG.sampleMode ? "offline_sample" : "live");

/** Same validation as POST /run; unsupported scope is returned, never thrown. */
async function scopeFor(b: Body, operation: Operation): Promise<{ runId: string; scope: Scope | null; unsupported?: string }> {
  const window = b.window as { start?: unknown; end?: unknown } | undefined;
  const req: RunRequest = {
    run_id: String(b.run_id ?? ""),
    input: {
      operation,
      town: typeof b.town === "string" ? b.town : undefined,
      timezone: "Asia/Kuala_Lumpur",
      time_window: { start: String(window?.start ?? ""), end: String(window?.end ?? "") },
      ...(typeof b.as_of === "string" ? { as_of: b.as_of } : {}),
    },
  };
  const { scope, unsupported } = await validate(req, mode());
  return { runId: req.run_id, scope, ...(unsupported ? { unsupported } : {}) };
}

/** Runs fn under fresh counters and reports only what actually executed. */
async function counted<T>(runId: string, label: string, fn: () => Promise<T>) {
  const ctx: RunCounters = {
    run_id: runId,
    mode: mode(),
    engine_operations_executed: {},
    remote_calls_executed: {},
    remote_calls_skipped: {},
    remote_call_ids: [],
    failures: [],
    deadlineMs: Date.now() + CONFIG.limits.runSeconds * 1000,
  };
  const t0 = Date.now();
  const result = await withRun(ctx, async () => {
    trace({ run_id: runId, trace_id: runId, agent_name: "method", action: label, status: "start" });
    try {
      const r = await fn();
      trace({ run_id: runId, trace_id: runId, agent_name: "method", action: label, status: "ok", duration_ms: Date.now() - t0 });
      return r;
    } catch (e) {
      trace({ run_id: runId, trace_id: runId, agent_name: "method", action: label, status: "error", output_summary: (e as Error).message.slice(0, 300), duration_ms: Date.now() - t0 });
      throw e;
    }
  });
  return {
    result,
    provenance: {
      engine_operations_executed: ctx.engine_operations_executed,
      remote_calls_executed: ctx.remote_calls_executed,
      remote_calls_skipped: ctx.remote_calls_skipped,
      sponsor_integration_evidence: {
        zetaris: {
          executed: ctx.remote_calls_executed["zetaris.sql"] ?? 0,
          skipped: ctx.remote_calls_skipped["zetaris.sql"] ?? 0,
          request_ids: ctx.remote_call_ids.filter((x) => x.startsWith("zetaris")).slice(0, 20),
        },
        meterless_hmem: Object.fromEntries(Object.entries(ctx.engine_operations_executed).filter(([k]) => k.startsWith("hmem"))),
        meterless_world_model: Object.fromEntries(Object.entries(ctx.engine_operations_executed).filter(([k]) => k.startsWith("world_model"))),
        nightshift: {
          executed: ctx.remote_calls_executed["nightshift.chat"] ?? 0,
          skipped: ctx.remote_calls_skipped["nightshift.chat"] ?? 0,
          available: hostedAvailable(),
          model_route: CONFIG.llm.modelDeep,
        },
      },
      log_file: logFile(runId),
      execution_time_seconds: Math.round((Date.now() - t0) / 100) / 10,
    },
  };
}

const unsupportedResponse = (runId: string, message: string) => ({
  run_id: runId,
  status: "error" as const,
  mode: mode(),
  output: null,
  error: { type: "unsupported", message, recoverable: false, failed_dependencies: [] },
});

function methodResponse(runId: string, draft: Draft, evidence: EvidenceRef[], extra: Body, provenance: Body, validity: Body) {
  const cited = new Set(draft.claims.flatMap((c) => c.evidence_ids));
  return {
    run_id: runId,
    status: "success" as const,
    mode: mode(),
    output: {
      summary: draft.summary,
      claims: draft.claims,
      evidence: evidence.filter((e) => cited.has(e.evidence_id)),
      limitations: draft.limitations,
      assumptions: draft.assumptions,
      rationale: draft.rationale,
      validity,
    },
    ...extra,
    ...provenance,
    error: null,
  };
}

/** HazeOps method: forward outlook for a town and window. */
export async function outlookMethod(b: Body) {
  const { runId, scope, unsupported } = await scopeFor(b, "assess_haze");
  if (!scope) return unsupportedResponse(runId, unsupported!);
  await Promise.all([hmem(), worldModel()]);
  const { result, provenance } = await counted(runId, "outlook", async () => {
    const { assessment, evidence } = await assess(scope, runId, 1);
    const draft = await synthesize(scope, assessment, null, null, [], false);
    return { assessment, evidence, draft };
  });
  return methodResponse(runId, result.draft, result.evidence, { assessment: result.assessment }, provenance, {
    start: new Date(scope.startMs).toISOString(),
    end: new Date(scope.endMs).toISOString(),
    unserved: result.assessment.uncovered_intervals,
  });
}

/** Source-trace method (PeatFire Sentinel's computation) for a town and window. */
export async function traceMethod(b: Body) {
  const { runId, scope, unsupported } = await scopeFor(b, "trace_sources");
  if (!scope) return unsupportedResponse(runId, unsupported!);
  await Promise.all([hmem(), worldModel()]);
  const { result, provenance } = await counted(runId, "trace", async () => {
    const { assessment, evidence } = await investigate(scope, runId);
    const draft = await synthesize(scope, null, null, assessment, [], false);
    return { assessment, evidence, draft };
  });
  return methodResponse(runId, result.draft, result.evidence, { sources: result.assessment }, provenance, {
    start: new Date(scope.startMs).toISOString(),
    end: new Date(scope.endMs).toISOString(),
    unserved: [],
  });
}

/**
 * EvidenceCritic method: SmokeLedger's independent checks (citations, re-running
 * every cited query, window coverage, hindsight disclosure) on a method result.
 */
export async function criticMethod(b: Body) {
  const operation = b.operation === "assess_haze" || b.operation === "trace_sources" ? b.operation : null;
  if (!operation) throw new InputError("operation must be assess_haze or trace_sources");
  const result = b.result as { run_id?: unknown; output?: Partial<Draft> & { evidence?: EvidenceRef[] }; assessment?: Assessment } | undefined;
  if (!result?.output || !Array.isArray(result.output.claims) || !Array.isArray(result.output.evidence))
    throw new InputError("result must be a method response with output.claims and output.evidence");
  const { runId, scope, unsupported } = await scopeFor({ ...b, run_id: b.run_id }, operation);
  if (!scope) throw new InputError(unsupported!);
  const draft: Draft = {
    summary: String(result.output.summary ?? ""),
    claims: result.output.claims,
    narrative: null,
    limitations: result.output.limitations ?? [],
    assumptions: result.output.assumptions ?? [],
    rationale: String(result.output.rationale ?? ""),
    guidance_versions: [],
  };
  const { result: r, provenance } = await counted(runId, "critic", () =>
    review(scope, draft, result.output!.evidence!, [], 0, result.assessment ?? undefined),
  );
  return { run_id: runId, mode: mode(), decision: r.decision, independent_evidence: r.evidence, ...provenance };
}

/** CommunityAlert's preview text for an outlook. Previews only: nothing is sent. */
export async function previewsMethod(b: Body) {
  const { runId, scope, unsupported } = await scopeFor(b, "assess_haze");
  if (!scope) throw new InputError(unsupported!);
  const assessment = b.assessment as Assessment | undefined;
  if (!assessment || !Array.isArray(assessment.hourly)) throw new InputError("assessment from an outlook result is required");
  const boundTo = typeof b.bound_to === "string" && b.bound_to ? b.bound_to : runId;
  return { run_id: runId, mode: mode(), messages: previews(scope, boundTo, assessment) };
}
