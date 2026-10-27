// HazeOps (MVP role): owns the air-quality situation and outlook for the requested
// place and time. Runs the forward engine, retrieves pinned rows through Zetaris,
// reports exactly which hours are covered and which are not. Never invents values.

import { HOUR } from "../config.ts";
import { runForward } from "../engine.ts";
import { buildWarning } from "../warning.ts";
import { pm25ToApi } from "../closure.ts";
import { epoch, evidence, safeText, toMs } from "../query.ts";
import type { Assessment, Claim, EvidenceRef, HourRow, Scope } from "../orchestration/types.ts";
import { hourLabel, hoursIn, intervals, ref, shortHash, tsSql } from "./common.ts";

export const HAZEOPS_VERSION = "hazeops-1.0";

const n = (v: unknown) => Number(v ?? 0);

export async function assess(scope: Scope, runId: string, revision: number): Promise<{ assessment: Assessment; evidence: EvidenceRef[] }> {
  const fw = await runForward(scope.asOfMs, { allowHindsight: scope.allowHindsight, runSuffix: shortHash(runId, 6) });
  const town = safeText(scope.town);

  const eProj = await evidence(
    `SELECT ${epoch("valid_utc")} AS valid_epoch, pm25_hour, pm25_24h, api, p_close, smoke_index
       FROM {src}.projections WHERE run_id = '${fw.run_id}' AND town = '${town}'
        AND valid_utc >= ${tsSql(scope.startMs)} AND valid_utc < ${tsSql(scope.endMs)} ORDER BY valid_utc`,
  );
  const eObs = await evidence(
    `SELECT kind, COUNT(*) AS hours, AVG(pm25) AS mean_pm25, MAX(${epoch("valid_utc")}) AS latest_epoch FROM {src}.pm25
      WHERE town = '${town}' AND valid_utc > ${tsSql(scope.asOfMs - 24 * HOUR)} AND valid_utc <= ${tsSql(scope.asOfMs)}
      GROUP BY kind ORDER BY kind`,
  );

  const hourly: HourRow[] = eProj.rows.map(([t, ph, p24, api, p, s]) => ({
    tMs: toMs(t),
    pm25_hour: ph === null || ph === undefined ? null : n(ph),
    pm25_24h: n(p24),
    api: n(api),
    p_close: n(p),
    smoke_index: n(s),
  }));
  const wanted = hoursIn(scope.startMs, scope.endMs);
  const have = new Set(hourly.filter((h) => h.pm25_hour !== null).map((h) => h.tMs));
  const covered = wanted.filter((h) => have.has(h));
  const uncovered = wanted.filter((h) => !have.has(h));

  const claims: Claim[] = [];
  const cite = (e: { evidence_id: string }) => `[${e.evidence_id}]`;
  const obs = eObs.rows.find((r) => r[0] === "observed") ?? eObs.rows.find((r) => r[0] === "model");
  if (obs)
    claims.push({
      id: `${runId}-h-obs`,
      kind: "observation",
      text: `In the 24 hours before the assessment time, ${obs[0]} PM2.5 at ${scope.town} averaged ${n(obs[2]).toFixed(1)} ug/m3 over ${n(obs[1])} hours ${cite(eObs)}.`,
      evidence_ids: [eObs.evidence_id],
    });
  for (const h of hourly.filter((x) => x.pm25_hour !== null))
    claims.push({
      id: `${runId}-h-${h.tMs}`,
      kind: "forecast",
      hourMs: h.tMs,
      basis: "forecast",
      text: `${hourLabel(h.tMs)} MYT: projected hourly PM2.5 ${h.pm25_hour!.toFixed(1)} ug/m3 (indicative hourly API ${pm25ToApi(h.pm25_hour!)}); 24-hour API ${Math.round(h.api)} with a ${Math.round(h.p_close * 100)}% chance of exceeding the school-closure level ${cite(eProj)}.`,
      evidence_ids: [eProj.evidence_id],
    });

  const ev: EvidenceRef[] = [ref(eProj, "hazeops"), ref(eObs, "hazeops")];
  let drafts: Assessment["drafts"];
  if (scope.operation === "assess_haze") {
    // Town outlook (next mornings, smoke arrival) + BM drafts that CommunityAlert will bind to the approved revision.
    const w = await buildWarning(fw, scope.town);
    for (const e of w.evidence) if (!ev.some((x) => x.evidence_id === e.evidence_id)) ev.push(ref(e, "hazeops"));
    for (const [i, line] of w.text.split("## What to do")[0].split("\n").entries())
      if (/\[E-[0-9a-f]{10}\]/.test(line))
        claims.push({
          id: `${runId}-h-out-${i}`,
          kind: "forecast",
          text: line.replace(/^-\s*/, ""),
          evidence_ids: [...line.matchAll(/\[(E-[0-9a-f]{10})\]/g)].map((m) => m[1]),
        });
    drafts = { parentNoticeBM: w.parentNoticeBM, schoolNoticeBM: w.schoolNoticeBM };
  }

  return {
    assessment: {
      assessment_id: `A-${shortHash(runId)}-${revision}`,
      revision,
      as_of: new Date(scope.asOfMs).toISOString(),
      projection_run_id: fw.run_id,
      hindsight: scope.allowHindsight,
      hourly,
      covered_intervals: intervals(covered),
      uncovered_intervals: intervals(uncovered),
      claims,
      uncertainty_basis:
        "24-hour API uses the pre-2024 US EPA PM2.5 breakpoints (to verify against DOE); closure probability assumes a 20% spread on the projected API; hourly API is indicative only.",
      recheck_conditions: ["a newer PM2.5 forecast or observation for this town", "new fire detections upwind", "the requested window starting"],
      drafts,
    },
    evidence: ev,
  };
}
