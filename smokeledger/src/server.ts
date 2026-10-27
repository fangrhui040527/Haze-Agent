// JSON API on 0.0.0.0:$PORT (default 8000).
//   GET  /health            readiness, mode, adapters (no secrets)
//   POST /run               run contract (validated, bounded, idempotent by run_id)
//   GET  /runs/:id          stored run result
//   POST /heartbeat/tick    one refresh/replay tick: {"now": "..."} optional
// Extra product endpoints under /api/* (cases, ask, evidence verify, fixtures in sample mode).

import http from "node:http";
import { APP, CONFIG } from "./config.ts";
import { db } from "./db.ts";
import { prepare, loadFixture } from "./seed.ts";
import { executeRun, getRun, InputError } from "./run.ts";
import { tick } from "./heartbeat.ts";
import { approve, draftNotice, listCases } from "./cases.ts";
import { ask } from "./agent.ts";
import { loadEvidence, verifyEvidence } from "./query.ts";
import { judge } from "./judge.ts";
import { criticMethod, outlookMethod, previewsMethod, traceMethod } from "./methods.ts";
import { withRun, type RunCounters } from "./tracing/context.ts";
import { hmem, memoryStatus } from "./meterless/hmem.ts";
import { worldModel, worldModelStatus } from "./meterless/worldModel.ts";
import { hostedAvailable } from "./llm.ts";
import type { RunRequest } from "./orchestration/types.ts";

let readyState: { ready: boolean; error?: string } = { ready: false };

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new InputError("Body too large");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new InputError("Body is not valid JSON");
  }
}

async function health() {
  const hm = await hmem();
  const wm = await worldModel();
  const degraded: string[] = [];
  if (!readyState.ready) degraded.push(readyState.error ?? "starting");
  if (!hm) degraded.push(memoryStatus());
  if (!wm) degraded.push(worldModelStatus());
  if (!CONFIG.sampleMode && CONFIG.queryBackend === "zetaris" && !CONFIG.zetaris.apiKey) degraded.push("ZETARIS_API_KEY not set");
  return {
    status: degraded.length ? "degraded" : "ready",
    reasons: degraded,
    mode: CONFIG.sampleMode ? "offline_sample" : "live",
    schema_version: "run-contract-1",
    app: APP,
    adapters: {
      evidence_query: CONFIG.sampleMode ? "local_store (sample)" : CONFIG.queryBackend === "zetaris" ? "zetaris_rest" : "local_store",
      store: db().kind,
      hosted_model: hostedAvailable() ? "meterless_nightshift" : "none",
      workflow: "langgraph + sqlite checkpoints",
      engines: { hmem: !!hm, world_model: !!wm },
    },
  };
}

/** Resume runs interrupted by a crash/restart, within their original deadline. */
async function resumeUnfinished() {
  const r = await db().query("SELECT run_id, request, deadline_utc FROM agent_runs WHERE status = 'running'");
  for (const row of r.rows) {
    if (new Date(row.deadline_utc).getTime() <= Date.now()) {
      await db().query(
        "UPDATE agent_runs SET status = 'error', response = $2, updated_utc = now() WHERE run_id = $1",
        [row.run_id, JSON.stringify({ run_id: row.run_id, status: "error", error: { type: "deadline", message: "Deadline passed while the service was down", recoverable: false, failed_dependencies: [] } })],
      );
      continue;
    }
    executeRun(JSON.parse(row.request) as RunRequest).catch((e) => console.error(`resume ${row.run_id}: ${(e as Error).message}`));
  }
}

/** Run a standalone check under its own counters so its remote calls are reported, never implied. */
async function counted<T>(op: string, fn: () => Promise<T>): Promise<T & { provenance: Record<string, unknown> }> {
  const ctx: RunCounters = {
    run_id: `${op}-${Date.now()}`,
    mode: CONFIG.sampleMode ? "offline_sample" : "live",
    engine_operations_executed: {},
    remote_calls_executed: {},
    remote_calls_skipped: {},
    remote_call_ids: [],
    failures: [],
    deadlineMs: Date.now() + CONFIG.limits.taskSeconds * 1000,
  };
  const result = await withRun(ctx, fn);
  const { run_id: _id, deadlineMs: _deadline, ...provenance } = ctx;
  return { ...result, provenance };
}

type Handler = (b: Record<string, unknown>, m: RegExpMatchArray) => Promise<[number, unknown]>;
const routes: [string, RegExp, Handler][] = [
  ["GET", /^\/health$/, async () => [200, await health()]],
  [
    "POST",
    /^\/run$/,
    async (b) => {
      const r = await executeRun(b as unknown as RunRequest);
      return [200, r];
    },
  ],
  [
    "GET",
    /^\/runs\/([^/]+)$/,
    async (_b, m) => {
      const r = await getRun(decodeURIComponent(m[1]));
      return r ? [200, r] : [404, { error: { type: "not_found", message: "No such run" } }];
    },
  ],
  ["POST", /^\/heartbeat\/tick$/, async (b) => [200, await tick(typeof b.now === "string" ? Date.parse(b.now) : Date.now())]],
  // ---- product extras ----
  ["GET", /^\/api\/cases$/, async () => [200, await listCases()]],
  ["POST", /^\/api\/cases\/([^/]+)\/draft$/, async (b, m) => [200, await draftNotice(m[1], typeof b.now === "string" ? Date.parse(b.now) : Date.now())]],
  [
    "POST",
    /^\/api\/cases\/([^/]+)\/approve$/,
    async (b, m) => {
      if (b.confirm !== true) throw new InputError('A person must approve: send {"confirm": true}');
      return [200, await approve(m[1], typeof b.now === "string" ? Date.parse(b.now) : Date.now())];
    },
  ],
  ["POST", /^\/api\/ask$/, async (b) => {
    const r = await ask(String(b.question ?? ""));
    return [200, { ...r, answer: r.verified ? r.answer : null, evidence: r.evidence.map(({ rows, ...e }) => e) }];
  }],
  ["GET", /^\/api\/evidence\/([^/]+)\/verify$/, async (_b, m) => [200, await counted("verify", () => verifyEvidence(m[1]))]],
  // Method endpoints for an embedding app's own agents (no SmokeLedger graph or agents).
  ["POST", /^\/api\/methods\/outlook$/, async (b) => [200, await outlookMethod(b)]],
  ["POST", /^\/api\/methods\/trace$/, async (b) => [200, await traceMethod(b)]],
  ["POST", /^\/api\/methods\/critic$/, async (b) => [200, await criticMethod(b)]],
  ["POST", /^\/api\/methods\/previews$/, async (b) => [200, await previewsMethod(b)]],
  [
    "POST",
    /^\/api\/claims\/check$/,
    async (b) => {
      // Read-only: cited ids, uncited numbers and guilt wording; Nemotron judge lane only when hosted inference is configured.
      if (typeof b.text !== "string" || !b.text.trim() || b.text.length > 20_000) throw new InputError("text is required (at most 20000 characters)");
      const ids = b.evidence_ids;
      if (!Array.isArray(ids) || ids.length > 200 || !ids.every((id) => typeof id === "string")) throw new InputError("evidence_ids must be an array of at most 200 strings");
      if (b.use_model !== undefined && typeof b.use_model !== "boolean") throw new InputError("use_model must be a boolean");
      // Callers may limit the slower model lane to the sentences that matter; it is never forced on offline.
      const useModel = b.use_model !== false && !CONFIG.sampleMode && hostedAvailable();
      return [
        200,
        await counted("claim-check", async () => {
          const evidence = await loadEvidence(ids as string[]);
          const verdict = await judge(b.text as string, evidence, { useModel });
          return { ...verdict, checked_evidence_ids: evidence.map((e) => e.evidence_id), lanes: useModel ? ["deterministic", "nemotron_judge"] : ["deterministic"] };
        }),
      ];
    },
  ],
  [
    "POST",
    /^\/api\/fixtures\/([^/]+)$/,
    async (_b, m) => {
      if (!CONFIG.sampleMode) throw new InputError("Fixtures can only be loaded in SAMPLE_MODE");
      return [200, { message: await loadFixture(m[1]) }];
    },
  ],
];

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  const url = new URL(req.url ?? "/", "http://x");
  for (const [method, re, handler] of routes) {
    const m = url.pathname.match(re);
    if (!m || req.method !== method) continue;
    try {
      const [code, out] = await handler(method === "POST" ? await body(req) : {}, m);
      res.statusCode = code;
      res.end(JSON.stringify(out));
    } catch (e) {
      res.statusCode = e instanceof InputError ? 400 : 500;
      res.end(JSON.stringify({ status: "error", error: { type: e instanceof InputError ? "invalid_input" : "internal", message: (e as Error).message, recoverable: !(e instanceof InputError) } }));
    }
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: { type: "not_found", message: `${req.method} ${url.pathname}` } }));
});

// HOST lets an embedding app keep the sidecar on loopback; the Docker default stays 0.0.0.0.
const host = process.env.HOST ?? "0.0.0.0";
server.listen(CONFIG.port, host, () => console.log(`SmokeLedger haze harness on http://${host}:${CONFIG.port} (${CONFIG.sampleMode ? "offline_sample" : "live"})`));
prepare()
  .then(() => resumeUnfinished())
  .then(() => (readyState = { ready: true }))
  .catch((e) => (readyState = { ready: false, error: `startup: ${(e as Error).message}` }));
