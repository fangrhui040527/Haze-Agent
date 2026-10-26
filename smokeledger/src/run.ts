// The run contract shared by POST /run, `node run.mjs --input FILE` and the heartbeat.
// Validates input, resolves the mode, runs the LangGraph workflow under a hard deadline,
// and returns a response built only from what actually executed.

import fs from "node:fs";
import { APP, CONFIG, HOUR } from "./config.ts";
import { db } from "./db.ts";
import { graph, type GraphState } from "./orchestration/graph.ts";
import type { Mode, Operation, RunRequest, Scope } from "./orchestration/types.ts";
import { resolveDistrict, shortHash } from "./agents/common.ts";
import { DEFAULT_TASKS } from "./agents/workershield.ts";
import { withRun, type RunCounters } from "./tracing/context.ts";
import { logFile, trace } from "./tracing/trace.ts";
import { hmemInfo, auditMemory, hmem } from "./meterless/hmem.ts";
import { wmInfo, worldModel } from "./meterless/worldModel.ts";
import { hostedAvailable } from "./llm.ts";
import { activeBackend } from "./query.ts";

export class InputError extends Error {}

const OPS: Operation[] = ["plan_outdoor_work", "assess_haze", "trace_sources"];
const ZONES = ["Asia/Kuala_Lumpur", "Asia/Singapore"];

export interface RunResponse {
  [k: string]: unknown;
  run_id: string;
  status: "success" | "partial" | "error";
}

function engineSources(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync("engine_sources.json", "utf8"));
  } catch {
    return {};
  }
}

/** Throws InputError for malformed input; returns null scope + reason for unsupported scope. */
export async function validate(req: RunRequest, mode: Mode): Promise<{ scope: Scope | null; unsupported?: string }> {
  if (!req || typeof req !== "object") throw new InputError("Body must be a JSON object");
  if (!req.run_id || !/^[A-Za-z0-9_.:\-]{1,80}$/.test(req.run_id)) throw new InputError("run_id is required (letters, digits, _ . : -)");
  const i = req.input;
  if (!i) throw new InputError("input is required");
  if (!i.time_window?.start || !i.time_window?.end) throw new InputError("input.time_window.start and .end are required (ISO 8601 with offset)");
  const startMs = Date.parse(i.time_window.start);
  const endMs = Date.parse(i.time_window.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new InputError("time_window must be valid ISO times with start < end");
  if (!i.timezone) throw new InputError("input.timezone is required");
  if (!OPS.includes(i.operation)) return { scope: null, unsupported: `Operation '${i.operation}' is not supported. Supported: ${OPS.join(", ")}.` };
  if (!ZONES.includes(i.timezone)) return { scope: null, unsupported: `Timezone '${i.timezone}' is not supported (UTC+08:00 zones only).` };
  if (endMs - startMs > 72 * HOUR) return { scope: null, unsupported: "Windows longer than 72 hours are not supported." };
  if (i.operation === "plan_outdoor_work" && endMs - startMs > 12 * HOUR) return { scope: null, unsupported: "An outdoor shift longer than 12 hours is not supported." };
  const { hit, supported } = await resolveDistrict(i);
  if (!hit) return { scope: null, unsupported: `District '${i.district_id ?? i.town}' is not supported. Supported: ${supported.join(", ")}.` };
  const asOfMs = i.as_of ? Date.parse(i.as_of) : i.operation === "trace_sources" ? endMs : startMs - 12 * HOUR;
  if (!Number.isFinite(asOfMs)) throw new InputError("input.as_of must be ISO 8601");
  const tasks = (i.tasks ?? []).filter((t) => t && t.name && t.hours > 0 && (t.intensity === "heavy" || t.intensity === "light"));
  return {
    scope: {
      operation: i.operation,
      district_id: hit.district_id,
      town: hit.town,
      lat: hit.lat,
      lon: hit.lon,
      startMs,
      endMs,
      asOfMs,
      tasks: tasks.length ? tasks : DEFAULT_TASKS,
      query: i.query ?? "",
      crew_constraints: (i.crew_constraints ?? []).map(String).slice(0, 5),
      // Sample fixtures and very recent downloads are "latest model values"; older replays must not see the future.
      allowHindsight: mode === "offline_sample" || Math.abs(Date.now() - asOfMs) < 6 * HOUR,
      narrative: req.options?.narrative !== false,
    },
  };
}

export function resolveMode(req: RunRequest): Mode {
  if (CONFIG.sampleMode) return "offline_sample"; // server setting wins; a request cannot unlock live
  return req.options?.sample_mode ? "offline_sample" : "live";
}

const decisionKeyOf = (s: Scope) => `D-${shortHash(`${s.operation}|${s.district_id}|${s.startMs}|${s.endMs}`, 12)}`;

export async function getRun(runId: string): Promise<RunResponse | null> {
  const r = await db().query("SELECT status, response FROM agent_runs WHERE run_id = $1", [runId]);
  if (!r.rows.length) return null;
  return r.rows[0].response ? JSON.parse(r.rows[0].response) : { run_id: runId, status: r.rows[0].status as RunResponse["status"] };
}

export async function executeRun(req: RunRequest, opts: { parentRunId?: string; changeReason?: string } = {}): Promise<RunResponse> {
  const t0 = Date.now();
  const mode = resolveMode(req);

  // Idempotency: a finished run_id returns its stored result.
  const prior = await db().query("SELECT status, response, deadline_utc FROM agent_runs WHERE run_id = $1", [req.run_id]);
  if (prior.rows.length && prior.rows[0].status !== "running" && prior.rows[0].response) return JSON.parse(prior.rows[0].response);

  const { scope, unsupported } = await validate(req, mode);
  if (!scope)
    return {
      run_id: req.run_id,
      status: "error",
      mode,
      error: { type: "unsupported", message: unsupported, recoverable: false, failed_dependencies: [] },
      execution_time_seconds: (Date.now() - t0) / 1000,
    };

  await Promise.all([hmem(), worldModel()]);
  const deadlineMs = prior.rows.length ? new Date(prior.rows[0].deadline_utc).getTime() : t0 + CONFIG.limits.runSeconds * 1000;
  const decisionKey = decisionKeyOf(scope);
  if (!prior.rows.length)
    await db().query(
      `INSERT INTO agent_runs (run_id, parent_run_id, decision_key, status, mode, request, validity_start, validity_end, deadline_utc)
       VALUES ($1, $2, $3, 'running', $4, $5, $6, $7, $8) ON CONFLICT (run_id) DO NOTHING`,
      [req.run_id, opts.parentRunId ?? null, decisionKey, mode, JSON.stringify(req), new Date(scope.startMs).toISOString(), new Date(scope.endMs).toISOString(), new Date(deadlineMs).toISOString()],
    );

  const ctx: RunCounters = {
    run_id: req.run_id,
    mode,
    engine_operations_executed: {},
    remote_calls_executed: {},
    remote_calls_skipped: {},
    remote_call_ids: [],
    failures: [],
    deadlineMs,
  };
  const config = { configurable: { thread_id: req.run_id }, recursionLimit: 60 };
  let final: GraphState | null = null;
  let error: { type: string; message: string; recoverable: boolean; failed_dependencies: string[] } | null = null;

  await withRun(ctx, async () => {
    trace({ run_id: req.run_id, trace_id: req.run_id, agent_name: "harness", action: prior.rows.length ? "resume" : "start", status: "ok", input_summary: `${scope.operation} ${scope.district_id} ${req.input.time_window.start}..${req.input.time_window.end} as_of ${new Date(scope.asOfMs).toISOString()}` });
    try {
      const g = graph();
      const existing = await g.getState(config);
      const input = existing?.next?.length
        ? null // resume an interrupted thread from its last checkpoint
        : { run_id: req.run_id, mode, scope, decision_key: decisionKey, assessment: null, sources: null, proposal: null, draft: null, verdict: null, outcome: null, messages: null, queue: [], next: "" };
      const timer = new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error("Run deadline exceeded"), { name: "DeadlineError" })), Math.max(1, deadlineMs - Date.now())).unref());
      final = (await Promise.race([g.invoke(input as never, config), timer])) as GraphState;
    } catch (e) {
      const deps = [...new Set(ctx.failures.map((f) => f.dependency))];
      error = { type: (e as Error).name === "DeadlineError" ? "deadline" : deps.length ? "dependency_failure" : "internal", message: (e as Error).message.slice(0, 400), recoverable: true, failed_dependencies: deps };
    }
  });

  const snap = final ? await graph().getState(config) : null;
  const checkpointId = (snap?.config?.configurable as { checkpoint_id?: string } | undefined)?.checkpoint_id;
  const s = final as GraphState | null;
  const err = error as { type: string; message: string; recoverable: boolean; failed_dependencies: string[] } | null;
  const response = await buildResponse(req, mode, scope, s, ctx, err, checkpointId, t0, opts);

  await db().query(
    `UPDATE agent_runs SET status = $2, response = $3, snapshot_id = $4, watermark_utc = $5, conclusion_status = $6, updated_utc = now() WHERE run_id = $1`,
    [req.run_id, response.status, JSON.stringify(response), s?.snapshot?.snapshot_id ?? null, s?.snapshot?.watermark ?? null, s?.outcome?.conclusion_status ?? null],
  );
  if (opts.parentRunId && s?.outcome)
    await db().query("UPDATE agent_runs SET conclusion_status = 'superseded', updated_utc = now() WHERE run_id = $1", [opts.parentRunId]);
  trace({ run_id: req.run_id, trace_id: req.run_id, agent_name: "harness", action: "finish", status: response.status, output_summary: String((response.output as { summary?: string } | undefined)?.summary ?? err?.message ?? "").slice(0, 300), duration_ms: Date.now() - t0 });
  return response;
}

async function buildResponse(
  req: RunRequest,
  mode: Mode,
  scope: Scope,
  s: GraphState | null,
  ctx: RunCounters,
  error: { type: string; message: string; recoverable: boolean; failed_dependencies: string[] } | null,
  checkpointId: string | undefined,
  t0: number,
  opts: { parentRunId?: string; changeReason?: string },
): Promise<RunResponse> {
  const sources = engineSources();
  const draft = s?.draft;
  const cited = new Set(draft?.claims.flatMap((c) => c.evidence_ids) ?? []);
  const evidence = (s?.evidence ?? []).filter((e) => cited.has(e.evidence_id) || e.produced_by === "critic");
  const audit = s?.outcome?.memory_id ? await auditMemory(s.outcome.memory_id) : [];
  const nightshiftCalls = ctx.remote_calls_executed["nightshift.chat"] ?? 0;
  const status: RunResponse["status"] = error ? "error" : (s?.outcome?.status ?? "error");
  return {
    run_id: req.run_id,
    status,
    mode,
    reasoning_backend: nightshiftCalls ? `nightshift (${CONFIG.llm.modelDeep}) + deterministic` : "deterministic",
    source_backend: mode === "offline_sample" ? (CONFIG.sampleMode ? "sample_fixture" : "local_store") : activeBackend() === "zetaris" ? "zetaris" : "local_store",
    engine_versions: {
      hmem: { ...hmemInfo(), ...((sources.hmem as object) ?? {}) },
      world_model: { ...wmInfo(), ...((sources.world_model as object) ?? {}) },
      app: APP,
    },
    workflow_backend: "langgraph",
    workflow_version: APP.workflowVersion,
    thread_id: req.run_id,
    checkpoint_id: checkpointId ?? null,
    engine_operations_executed: ctx.engine_operations_executed,
    remote_calls_executed: ctx.remote_calls_executed,
    remote_calls_skipped: ctx.remote_calls_skipped,
    output: draft
      ? {
          summary: draft.summary,
          narrative: draft.narrative,
          proposed_plan:
            scope.operation === "plan_outdoor_work"
              ? { proposal_id: s?.proposal?.proposal_id, revision: s?.proposal?.revision, schedule: s?.proposal?.schedule.map(({ hourMs, ...x }) => x), controls: s?.proposal?.controls, unmet_constraints: s?.proposal?.unmet_constraints }
              : scope.operation === "assess_haze"
                ? { covered: s?.assessment?.covered_intervals, uncovered: s?.assessment?.uncovered_intervals }
                : { top_concessions: s?.sources?.top_concessions, confidence: s?.sources?.confidence, dossier_file: s?.sources?.dossier_file },
          claims: draft.claims.map(({ hourMs, ...c }) => c),
          evidence: evidence.map((e) => ({ evidence_id: e.evidence_id, sha256: e.sha256, row_count: e.row_count, backend: e.backend, produced_by: e.produced_by, sql: e.sql })),
          limitations: draft.limitations,
          validity: {
            start: new Date(scope.startMs).toISOString(),
            end: new Date(scope.endMs).toISOString(),
            unserved: s?.proposal?.unserved_intervals ?? s?.assessment?.uncovered_intervals ?? [],
          },
          messages: s?.messages ?? null,
        }
      : null,
    rationale: draft?.rationale ?? null,
    guidance_versions: draft?.guidance_versions ?? [],
    assumptions: draft?.assumptions ?? [],
    change_reason: opts.changeReason ?? null,
    parent_run_id: opts.parentRunId ?? null,
    critic: { final: s?.verdict ?? null, rounds: s?.critic_history?.length ?? 0, history: s?.critic_history?.map((c) => ({ decision: c.decision, findings: c.findings.map((f) => f.code) })) ?? [] },
    agents: (s?.agents ?? []).map((a) => ({ role: a.role, version: a.version, executions: a.attempts })),
    memory: { recalled: (s?.memories ?? []).map((m) => ({ id: m.id, content: m.content })), captured: s?.outcome?.memory_id ?? null, audit_entries: audit.length },
    snapshot_id: s?.snapshot?.snapshot_id ?? null,
    conclusion_revision_id: s?.outcome?.conclusion_revision_id ?? null,
    conclusion_status: s?.outcome?.conclusion_status ?? null,
    trace_id: req.run_id,
    log_file: logFile(req.run_id),
    execution_time_seconds: Math.round((Date.now() - t0) / 100) / 10,
    sponsor_integration_evidence: {
      zetaris: { executed: ctx.remote_calls_executed["zetaris.sql"] ?? 0, skipped: ctx.remote_calls_skipped["zetaris.sql"] ?? 0, request_ids: ctx.remote_call_ids.filter((x) => x.startsWith("zetaris")).slice(0, 20) },
      meterless_hmem: Object.fromEntries(Object.entries(ctx.engine_operations_executed).filter(([k]) => k.startsWith("hmem"))),
      meterless_world_model: Object.fromEntries(Object.entries(ctx.engine_operations_executed).filter(([k]) => k.startsWith("world_model"))),
      nightshift: { executed: nightshiftCalls, skipped: ctx.remote_calls_skipped["nightshift.chat"] ?? 0, available: hostedAvailable(), model_route: CONFIG.llm.modelDeep },
    },
    error,
  };
}
