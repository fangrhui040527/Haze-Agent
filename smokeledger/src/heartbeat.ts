// Heartbeat: one bounded refresh / replay tick (POST /heartbeat/tick, or a scheduler).
//  1. Act loop: open cases for burning concessions whose plume reaches Malaysia; re-check notified cases.
//  2. Decisions: for each published, still-valid decision, look for evidence that arrived after its
//     snapshot and touches its town and window. If found: mark the conclusion needs_review in
//     World Model, mark its H-MEM memory stale, re-run the same request on a new linked run,
//     and explain what changed. Unrelated updates leave decisions unchanged.
import { CONFIG, HOUR } from "./config.ts";
import { db } from "./db.ts";
import { runForward } from "./engine.ts";
import { recheck, scan } from "./cases.ts";
import { newerRelevantEvidence } from "./agents/common.ts";
import { executeRun, resolveMode, validate, type RunResponse } from "./run.ts";
import { recall, remember } from "./meterless/hmem.ts";
import { setConclusionStatus, worldModel } from "./meterless/worldModel.ts";
import type { RunRequest } from "./orchestration/types.ts";
import { withRun } from "./tracing/context.ts";

const iso = (ms: number) => new Date(ms).toISOString();
const decisionEntityId = (key: string) => `decision:smokeledger:${key}`;

type Slot = { label: string; task: string | null; action: string; api_hourly: number | null; basis: string };

/** Plain-language difference between two run outputs. */
export function describeChange(oldR: RunResponse, newR: RunResponse, newer: { pm25_rows: number; fire_rows: number }): string {
  const parts: string[] = [`${newer.pm25_rows} newer PM2.5 rows and ${newer.fire_rows} newer fire rows arrived after the previous snapshot.`];
  const po = (oldR.output as { proposed_plan?: { schedule?: Slot[] } } | null)?.proposed_plan?.schedule;
  const pn = (newR.output as { proposed_plan?: { schedule?: Slot[] } } | null)?.proposed_plan?.schedule;
  if (po && pn) {
    for (const n of pn) {
      const o = po.find((x) => x.label === n.label);
      if (!o) continue;
      if (o.api_hourly !== n.api_hourly || o.task !== n.task || o.action !== n.action)
        parts.push(`${n.label}: hourly API ${o.api_hourly ?? "n/a"} -> ${n.api_hourly ?? "n/a"}; task ${o.task ?? "none"} -> ${n.task ?? "none"}${o.action !== n.action ? `; action now "${n.action}"` : ""}.`);
    }
  } else {
    const so = (oldR.output as { summary?: string } | null)?.summary ?? "";
    const sn = (newR.output as { summary?: string } | null)?.summary ?? "";
    if (so !== sn) parts.push(`Previous: ${so.replace(/\s*\[[^\]]+\]/g, "")} Now: ${sn.replace(/\s*\[[^\]]+\]/g, "")}`);
  }
  if (parts.length === 1) parts.push("The re-run reached the same conclusion.");
  return parts.join(" ");
}

export async function tick(nowMs: number) {
  const now = Math.floor(nowMs / HOUR) * HOUR;
  const mode = CONFIG.sampleMode ? "offline_sample" : "live";
  await worldModel();
  const result = {
    now: iso(now),
    mode,
    cases_opened: [] as string[],
    cases_rechecked: [] as { case_id: string; status: string; firesAfter: number }[],
    affected: [] as { decision_key: string; previous_run_id: string; new_run_id: string; new_status: string; change_reason: string }[],
    unchanged: [] as string[],
  };

  // 1. Warn -> record -> escalate.
  await withRun(
    { run_id: `heartbeat-${iso(now)}`, mode, engine_operations_executed: {}, remote_calls_executed: {}, remote_calls_skipped: {}, remote_call_ids: [], failures: [], deadlineMs: Date.now() + CONFIG.limits.runSeconds * 1000 },
    async () => {
      const fw = await runForward(now, { allowHindsight: CONFIG.sampleMode, runSuffix: "hb" });
      result.cases_opened = await scan(fw);
      result.cases_rechecked = await recheck(now);
    },
  );

  // 2. Dependency + coverage subscription matching for published decisions.
  const rows = await db().query(
    `SELECT run_id, decision_key, request, response, watermark_utc FROM agent_runs
      WHERE status IN ('success','partial') AND conclusion_status IN ('current','needs_review') AND validity_end > $1
      ORDER BY created_utc`,
    [iso(now)],
  );
  for (const r of rows.rows) {
    const req = JSON.parse(r.request) as RunRequest;
    const { scope } = await validate(req, resolveMode(req));
    if (!scope || !r.watermark_utc) continue;
    const newer = await newerRelevantEvidence(scope.town, new Date(r.watermark_utc).toISOString(), scope.startMs, scope.endMs, scope.operation);
    if (newer.pm25_rows + newer.fire_rows === 0) {
      result.unchanged.push(r.run_id);
      continue;
    }
    const reason = `New evidence after snapshot: ${newer.pm25_rows} PM2.5 rows, ${newer.fire_rows} fire rows.`;
    await setConclusionStatus(decisionEntityId(r.decision_key), "needs_review", reason, iso(now), r.run_id);
    await db().query("UPDATE agent_runs SET conclusion_status = 'needs_review', updated_utc = now() WHERE run_id = $1", [r.run_id]);
    const mem = (await recall(`reviewed decision ${scope.operation} ${scope.town}`, 10)).items.find((m) => m.tags.includes(`decision:${r.decision_key}`));
    if (mem)
      await remember(
        `Decision ${r.decision_key} (${scope.operation}, ${scope.town}) marked stale at ${iso(now)}: ${reason}`,
        [`district:${scope.district_id}`, `decision:${r.decision_key}`, "kind:stale_marker"],
        "stale memory",
        [r.run_id],
        mem.id,
      );
    const newRunId = `${req.run_id}-hb${iso(now).slice(0, 13).replace(/[-:T]/g, "")}`;
    const resp = await executeRun({ ...req, run_id: newRunId, input: { ...req.input, as_of: iso(now) } }, { parentRunId: r.run_id });
    const change = describeChange(JSON.parse(r.response), resp, newer);
    resp.change_reason = change;
    await db().query("UPDATE agent_runs SET response = $2 WHERE run_id = $1", [newRunId, JSON.stringify(resp)]);
    result.affected.push({ decision_key: r.decision_key, previous_run_id: r.run_id, new_run_id: newRunId, new_status: String(resp.conclusion_status ?? resp.status), change_reason: change });
  }
  return result;
}
