// End-to-end tests of the merged harness in offline_sample mode (embedded DB, no network,
// no credentials). Covers the three scenario families, idempotency, crash/resume,
// unsupported scope and honest labelling of skipped remote calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haze-harness-"));
Object.assign(process.env, {
  SAMPLE_MODE: "true",
  DB_MODE: "memory",
  STATE_DIR: dir,
  LOG_DIR: path.join(dir, "logs"),
  METERLESS_RUNTIME_TOKEN: "",
  ZETARIS_API_KEY: "",
});
const enginesInstalled = fs.existsSync("vendor/hmem/src/index.ts") && fs.existsSync("vendor/world-model/src/index.ts");

const load = (f: string) => JSON.parse(fs.readFileSync(path.join("input_examples", f), "utf8"));
let run: typeof import("../src/run.ts");
let seed: typeof import("../src/seed.ts");
let hb: typeof import("../src/heartbeat.ts");
let wm: typeof import("../src/meterless/worldModel.ts");
let hm: typeof import("../src/meterless/hmem.ts");

before(async () => {
  if (!enginesInstalled) return;
  run = await import("../src/run.ts");
  seed = await import("../src/seed.ts");
  hb = await import("../src/heartbeat.ts");
  wm = await import("../src/meterless/worldModel.ts");
  hm = await import("../src/meterless/hmem.ts");
  await seed.prepare();
});
after(async () => {
  if (enginesInstalled) await (await import("../src/db.ts")).closeDb();
});

const opts = { skip: !enginesInstalled && "run npm run setup first" };
const out = (r: Record<string, unknown>) => r.output as { summary: string; claims: { kind: string; text: string }[]; validity: { unserved: string[] }; proposed_plan: { schedule: { label: string; task: string | null; basis: string }[] } };

test("family 1: plan and explain -> critic approves, memory captured, world model revision", opts, async () => {
  const r = await run.executeRun(load("example_1.json"));
  assert.equal(r.status, "success");
  assert.equal(r.conclusion_status, "current");
  assert.equal((r.critic as { final: { decision: string } }).final.decision, "approve");
  assert.ok(String(r.conclusion_revision_id).startsWith("fact_"));
  const mem = r.memory as { captured: string; audit_entries: number; recalled: { content: string }[] };
  assert.ok(mem.captured, "reviewed decision captured in H-MEM");
  assert.ok(mem.audit_entries >= 1, "trust ledger has the capture");
  assert.ok(out(r).claims.some((c) => /Remembered crew constraint applied/.test(c.text)), "recalled constraint shaped the plan");
  const sched = out(r).proposed_plan.schedule;
  assert.ok(!sched.some((s) => s.label >= "11:00" && /trimming|clearing/.test(s.task ?? "")), "no heavy work after 11:00");
  assert.ok(fs.existsSync(String(r.log_file)), "JSONL trace written");
});

test("family 1 (offline): remote calls are labelled skipped, never executed", opts, async () => {
  const r = await run.getRun("judge-001");
  assert.ok(r);
  assert.deepEqual(r!.remote_calls_executed, {});
  const s = r!.sponsor_integration_evidence as { zetaris: { executed: number; skipped: number }; meterless_hmem: object; meterless_world_model: object };
  assert.equal(s.zetaris.executed, 0);
  assert.ok(s.zetaris.skipped > 0);
  assert.ok(Object.keys(s.meterless_hmem).length > 0 && Object.keys(s.meterless_world_model).length > 0, "both engines executed locally");
  assert.equal(r!.reasoning_backend, "deterministic");
});

test("idempotency: same run_id returns the stored result without new writes", opts, async () => {
  const before = (await run.getRun("judge-001"))!;
  const again = await run.executeRun(load("example_1.json"));
  assert.equal(again.conclusion_revision_id, before.conclusion_revision_id);
  assert.equal(again.checkpoint_id, before.checkpoint_id);
});

test("family 2: real coverage gap -> critic blocks, plan narrowed, unserved interval disclosed", opts, async () => {
  const r = await run.executeRun(load("example_2.json"));
  const hist = (r.critic as { history: { decision: string; findings: string[] }[] }).history;
  assert.equal(hist[0].decision, "revise");
  assert.ok(hist[0].findings.includes("coverage_gap"));
  assert.equal(hist.at(-1)!.decision, "approve");
  assert.equal(r.status, "partial");
  assert.ok(out(r).validity.unserved.some((u) => u.startsWith("09:00-12:00")));
  assert.ok(out(r).proposed_plan.schedule.filter((s) => s.basis === "unserved").every((s) => s.task === null));
});

test("family 3: newer forecast -> heartbeat re-runs only the affected decision and explains the change", opts, async () => {
  const scen = load("example_3.json").scenario_steps;
  const first = await run.executeRun(scen[0].request);
  const unrelated = await run.executeRun(scen[1].request);
  assert.equal(first.status, "success");
  assert.equal(unrelated.status, "success");
  await seed.loadFixture("pm25_forecast_update");
  const t = await hb.tick(Date.parse(scen[3].now));
  assert.ok(t.unchanged.includes("judge-003-unrelated"), "unrelated decision unchanged");
  const a = t.affected.find((x) => x.previous_run_id === "judge-003");
  assert.ok(a, "affected decision re-run");
  assert.match(a!.change_reason, /newer PM2\.5 rows/);
  assert.match(a!.change_reason, /->/);
  // World Model: the old conclusion is superseded by the new revision.
  const hist = await wm.conclusionHistory(`decision:smokeledger:${(await (await import("../src/db.ts")).db().query("SELECT decision_key FROM agent_runs WHERE run_id = 'judge-003'")).rows[0].decision_key}`);
  assert.ok(hist.length >= 2);
  assert.ok(hist[0].supersededBy, "previous conclusion revision superseded");
  // H-MEM: a stale marker supersedes the old reviewed-decision memory.
  const rec = await hm.recall("marked stale Klang plan_outdoor_work", 10);
  assert.ok(rec.items.some((m) => m.tags.includes("kind:stale_marker")));
  const old = (await run.getRun("judge-003"))!;
  const db = (await import("../src/db.ts")).db();
  const st = await db.query("SELECT conclusion_status FROM agent_runs WHERE run_id = 'judge-003'");
  assert.equal(st.rows[0].conclusion_status, "superseded");
  assert.equal(old.status, "success", "previous decision preserved");
});

test("unsupported district returns structured unsupported; malformed input is rejected", opts, async () => {
  const r = await run.executeRun(load("example_6_unsupported.json"));
  assert.equal(r.status, "error");
  assert.equal((r.error as { type: string }).type, "unsupported");
  await assert.rejects(() => run.executeRun({ run_id: "x" } as never), run.InputError);
});

test("unseen input (other town, other date) is computed, not matched", opts, async () => {
  const r = await run.executeRun({
    run_id: "unseen-muar",
    input: {
      operation: "plan_outdoor_work",
      town: "Muar",
      timezone: "Asia/Kuala_Lumpur",
      time_window: { start: "2026-10-05T09:00:00+08:00", end: "2026-10-05T13:00:00+08:00" },
      tasks: [{ name: "pothole patching", hours: 2, intensity: "heavy" }],
    },
    options: { sample_mode: true },
  });
  assert.ok(r.status === "success" || r.status === "partial");
  assert.ok(out(r).proposed_plan.schedule.some((s) => s.task === "pothole patching"));
});

test("crash/resume: an interrupted thread resumes from its checkpoint without redoing finished nodes", opts, async () => {
  const { graph } = await import("../src/orchestration/graph.ts");
  const { withRun } = await import("../src/tracing/context.ts");
  const req = { ...load("example_1.json"), run_id: "resume-1" };
  const mode = run.resolveMode(req);
  const { scope } = await run.validate(req, mode);
  const db = (await import("../src/db.ts")).db();
  await db.query(
    "INSERT INTO agent_runs (run_id, decision_key, status, mode, request, validity_start, validity_end, deadline_utc) VALUES ($1,'D-resume','running',$2,$3,now(),now() + interval '1 day', now() + interval '5 minutes')",
    ["resume-1", mode, JSON.stringify(req)],
  );
  // Simulate a crash right after HazeOps finished.
  await withRun(
    { run_id: "resume-1", mode, engine_operations_executed: {}, remote_calls_executed: {}, remote_calls_skipped: {}, remote_call_ids: [], failures: [], deadlineMs: Date.now() + 300_000 },
    async () => {
      await graph().invoke(
        { run_id: "resume-1", mode, scope: scope!, decision_key: "D-resume", assessment: null, sources: null, proposal: null, draft: null, verdict: null, outcome: null, messages: null, queue: [], next: "" },
        { configurable: { thread_id: "resume-1" }, interruptAfter: ["hazeops"] },
      );
    },
  );
  const r = await run.executeRun(req);
  assert.equal(r.status, "success");
  const agents = r.agents as { role: string; executions: number }[];
  assert.equal(agents.find((a) => a.role === "hazeops")!.executions, 1, "HazeOps not re-run after resume");
});

// Last on purpose: it removes the sample maps from the shared test state.
test("missing concession and peat maps are reported as not assessed, never as 0%", opts, async () => {
  const trace = (run_id: string) =>
    run.executeRun({
      run_id,
      input: {
        operation: "trace_sources",
        town: "Batu Pahat",
        timezone: "Asia/Kuala_Lumpur",
        time_window: { start: "2026-10-06T02:00:00+08:00", end: "2026-10-07T02:00:00+08:00" },
      },
      options: { sample_mode: true },
    });
  const mapped = out(await trace("maps-present"));
  assert.match(mapped.summary, /Fires inside mapped concessions: \d+% \(range/);

  const { CONFIG } = await import("../src/config.ts");
  await (await import("../src/db.ts")).db().query("DELETE FROM concessions");
  fs.rmSync(path.join(CONFIG.geoDir, "peat.geojson"), { force: true });
  const r = await trace("maps-missing");
  const text = out(r).claims.map((c) => c.text).join("\n");
  assert.match(text, /Fires inside mapped concessions: not assessed, because no concession map is loaded/);
  assert.match(text, /Fires on peat: not assessed, because no peat map is loaded/);
  assert.match(text, /Confidence: not assessed/);
  assert.doesNotMatch(text, /(concessions|peat): 0%/);
  assert.equal((r.sources as { confidence: string } | undefined)?.confidence ?? "not assessed", "not assessed");
});
