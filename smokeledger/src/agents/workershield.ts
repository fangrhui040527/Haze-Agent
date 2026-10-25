// WorkerShield (MVP role): turns the HazeOps assessment into a feasible plan for one
// outdoor crew, using versioned guidance. First pass fills hours the forecast does not
// cover by persistence (an explicit assumption); the critic rejects that for approval,
// and the revision narrows validity to the evidenced hours and lists the unserved ones.

import { pm25ToApi } from "../closure.ts";
import { evidence } from "../query.ts";
import type { Assessment, Claim, EvidenceRef, Proposal, ScheduleSlot, Scope, Task } from "../orchestration/types.ts";
import type { Recalled } from "../meterless/hmem.ts";
import { hourLabel, hoursIn, intervals, localHHMM, ref, shortHash } from "./common.ts";

export const WORKERSHIELD_VERSION = "workershield-1.0";
export const GUIDANCE_ID = "outdoor-work";
export const GUIDANCE_VERSION = "0.1-placeholder";

export const DEFAULT_TASKS: Task[] = [
  { name: "drain clearing", hours: 2, intensity: "heavy" },
  { name: "signage inspection", hours: 1, intensity: "light" },
  { name: "verge trimming", hours: 1, intensity: "heavy" },
];

interface Band {
  band: string;
  min: number;
  max: number;
  action: string;
  heavy: "allowed" | "limit" | "postpone" | "stop";
}

/** Remembered crew constraints ("no heavy work after 11:00", "no outdoor work before 09:00"). */
export function parseConstraints(items: { id: string; text: string }[]) {
  const out: { id: string; kind: "heavy_after" | "outdoor_before"; hhmm: string }[] = [];
  for (const it of items) {
    const a = it.text.match(/no heavy work after (\d{1,2}):(\d{2})/i);
    if (a) out.push({ id: it.id, kind: "heavy_after", hhmm: `${a[1].padStart(2, "0")}:${a[2]}` });
    const b = it.text.match(/no outdoor work before (\d{1,2}):(\d{2})/i);
    if (b) out.push({ id: it.id, kind: "outdoor_before", hhmm: `${b[1].padStart(2, "0")}:${b[2]}` });
  }
  return out;
}

export async function propose(
  scope: Scope,
  a: Assessment,
  runId: string,
  revision: number,
  narrow: boolean,
  memories: Recalled[],
): Promise<{ proposal: Proposal; evidence: EvidenceRef[] }> {
  const eG = await evidence(
    `SELECT band, api_min, api_max, action, heavy_work, version, status FROM {src}.guidance
      WHERE guidance_id = '${GUIDANCE_ID}' AND version = '${GUIDANCE_VERSION}' ORDER BY api_min`,
  );
  const bands: Band[] = eG.rows.map(([band, mn, mx, action, heavy]) => ({
    band: String(band),
    min: Number(mn),
    max: Number(mx),
    action: String(action),
    heavy: heavy as Band["heavy"],
  }));
  const ev = [ref(eG, "workershield")];
  const projId = a.claims.find((c) => c.kind === "forecast" && c.hourMs)?.evidence_ids[0];
  const assumptions: string[] = [];
  const limitations: string[] = [
    `Guidance ${GUIDANCE_ID} v${GUIDANCE_VERSION} is a PLACEHOLDER written for this demo, not official DOSH guidance.`,
    "Hourly API is an indicative hourly equivalent; official APIMS readings are 24-hour averages.",
  ];
  if (!bands.length) {
    return {
      proposal: {
        proposal_id: `P-${shortHash(runId)}-${revision}`,
        revision,
        schedule: [],
        controls: [],
        guidance_version: null,
        claims: [],
        assumptions,
        limitations,
        unmet_constraints: ["No reviewed guidance is loaded, so no work recommendation can be made."],
        unserved_intervals: [],
        narrowed: false,
      },
      evidence: ev,
    };
  }
  const bandFor = (api: number) => bands.find((b) => api >= b.min && api <= b.max) ?? bands[bands.length - 1];

  // Remembered constraints from earlier sessions (H-MEM) + this request's constraints.
  const constraints = parseConstraints(memories.map((m) => ({ id: m.id, text: m.content })));

  // Hourly air for each hour of the shift.
  const byHour = new Map(a.hourly.filter((h) => h.pm25_hour !== null).map((h) => [h.tMs, h.pm25_hour!]));
  const hours = hoursIn(scope.startMs, scope.endMs);
  let last: number | null = null;
  const air = hours.map((h) => {
    if (byHour.has(h)) {
      last = byHour.get(h)!;
      return { h, pm: last, basis: "forecast" as const };
    }
    if (!narrow && last !== null) return { h, pm: last, basis: "persistence" as const };
    return { h, pm: null, basis: "unserved" as const };
  });
  if (air.some((x) => x.basis === "persistence"))
    assumptions.push("Hours without a forecast assume the last forecast hour persists (persistence).");

  // Assign tasks: heavy work to the cleanest allowed hours, then light work.
  const slots: ScheduleSlot[] = air.map((x) => {
    const api = x.pm === null ? null : pm25ToApi(x.pm);
    const b = api === null ? null : bandFor(api);
    return {
      hourMs: x.h,
      label: hourLabel(x.h),
      task: null,
      intensity: null,
      api_hourly: api,
      band: b?.band ?? null,
      action: b ? b.action : "No evidence for this hour: not planned.",
      basis: x.basis,
    };
  });
  const heavyOk = (s: ScheduleSlot) => {
    if (s.api_hourly === null) return false;
    const b = bandFor(s.api_hourly);
    if (b.heavy === "postpone" || b.heavy === "stop") return false;
    return !constraints.some(
      (c) => (c.kind === "heavy_after" && localHHMM(s.hourMs) >= c.hhmm) || (c.kind === "outdoor_before" && localHHMM(s.hourMs) < c.hhmm),
    );
  };
  const outdoorOk = (s: ScheduleSlot) =>
    s.api_hourly !== null &&
    bandFor(s.api_hourly).heavy !== "stop" &&
    !constraints.some((c) => c.kind === "outdoor_before" && localHHMM(s.hourMs) < c.hhmm);

  const unmet: string[] = [];
  const tasks = (scope.tasks.length ? scope.tasks : DEFAULT_TASKS).slice().sort((x, y) => (x.intensity === y.intensity ? 0 : x.intensity === "heavy" ? -1 : 1));
  for (const t of tasks) {
    let need = Math.max(1, Math.round(t.hours));
    const pool = slots
      .filter((s) => s.task === null && (t.intensity === "heavy" ? heavyOk(s) : outdoorOk(s)))
      .sort((p, q) => (p.api_hourly! - q.api_hourly!) || p.hourMs - q.hourMs);
    for (const s of pool) {
      if (!need) break;
      s.task = t.name;
      s.intensity = t.intensity;
      need--;
    }
    if (need) unmet.push(`${t.name}: ${need} of ${t.hours} h could not be placed within the guidance and constraints; reschedule.`);
  }

  const claims: Claim[] = [];
  for (const s of slots) {
    if (s.basis === "unserved") {
      // Absence is evidence too: the forecast query for the window returned no row for this hour.
      claims.push({
        id: `${runId}-w-${s.hourMs}`,
        kind: "unserved",
        hourMs: s.hourMs,
        basis: "unserved",
        text: `${s.label} MYT: not planned because the forecast query has no row for this hour ${projId ? `[${projId}]` : ""}.`,
        evidence_ids: projId ? [projId] : [],
      });
      continue;
    }
    // Cite a remembered constraint only on the hours it actually restricted.
    const hit = constraints.filter(
      (c) => (c.kind === "heavy_after" && localHHMM(s.hourMs) >= c.hhmm) || (c.kind === "outdoor_before" && localHHMM(s.hourMs) < c.hhmm),
    );
    const cites = [projId, eG.evidence_id].filter(Boolean).map((id) => `[${id}]`).join("");
    const mem = hit.length ? ` Remembered crew constraint applied: ${hit.map((c) => `${c.kind === "heavy_after" ? "no heavy work after" : "no outdoor work before"} ${c.hhmm} [M:${c.id}]`).join("; ")}.` : "";
    claims.push({
      id: `${runId}-w-${s.hourMs}`,
      kind: "recommendation",
      hourMs: s.hourMs,
      basis: s.basis,
      guidance_version: GUIDANCE_VERSION,
      memory_ids: hit.map((c) => c.id),
      text:
        `${s.label} MYT: ${s.task ? `${s.task} (${s.intensity})` : "no task scheduled"}; indicative hourly API ${s.api_hourly}` +
        `${s.basis === "persistence" ? " assumed from the previous hour" : ""}, ${s.band} band: ${s.action.replace(/\.\s*$/, "").replace(/\.\s+/g, "; ")} ${cites}.${mem}`,
      evidence_ids: [projId, eG.evidence_id].filter((x): x is string => !!x),
    });
  }
  const unserved = intervals(slots.filter((s) => s.basis === "unserved").map((s) => s.hourMs));
  if (unserved.length) limitations.push(`No evidence for ${unserved.join(", ")}: that part of the shift is not planned. Re-check when a newer forecast arrives.`);
  const controls = [...new Set(slots.filter((s) => s.task && s.band).map((s) => bandFor(s.api_hourly!).action))];

  return {
    proposal: {
      proposal_id: `P-${shortHash(runId)}-${revision}`,
      revision,
      schedule: slots,
      controls,
      guidance_version: GUIDANCE_VERSION,
      claims,
      assumptions,
      limitations,
      unmet_constraints: unmet,
      unserved_intervals: unserved,
      narrowed: narrow && unserved.length > 0,
    },
    evidence: ev,
  };
}
