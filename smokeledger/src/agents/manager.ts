// Manager: owns the objective. Admits the request (scope, H-MEM recall, World Model
// snapshot), routes work to specialists, synthesises the cited answer, turns critic
// findings into targeted revisions, and runs the freshness/publication gate.
// It cannot override a blocking critic finding.

import { HOUR } from "../config.ts";
import { chat, hostedAvailable, HostedInferenceSkipped } from "../llm.ts";
import { recall, remember, type Recalled } from "../meterless/hmem.ts";
import { eventCount, publishConclusion, recordEvidence, upsertDecision, upsertDistrict } from "../meterless/worldModel.ts";
import type { Assessment, Claim, CriticDecision, Draft, EvidenceRef, Proposal, Scope, SourceAssessment } from "../orchestration/types.ts";
import { localHHMM, newerRelevantEvidence, shortHash, watermark } from "./common.ts";

export const MANAGER_VERSION = "manager-1.0";

export interface Snapshot {
  snapshot_id: string;
  watermark: string;
  wm_events: number;
}

export async function admit(scope: Scope, runId: string, decisionKey: string) {
  const wmark = await watermark();
  const at = new Date(scope.asOfMs).toISOString();
  const districtEntity = await upsertDistrict(scope.district_id, { town: scope.town, lat: scope.lat, lon: scope.lon }, at, runId);
  const decisionEntity = await upsertDecision(
    decisionKey,
    { operation: scope.operation, window_start: new Date(scope.startMs).toISOString(), window_end: new Date(scope.endMs).toISOString() },
    districtEntity,
    at,
    runId,
  );
  const events = await eventCount();
  const snapshot: Snapshot = { snapshot_id: `S-${shortHash(`${wmark}|${events}|${scope.asOfMs}|${scope.town}`, 12)}`, watermark: wmark, wm_events: events };

  // User-supplied crew constraints are captured once as reviewed memory, then recalled like any other.
  for (const c of scope.crew_constraints)
    await remember(`Crew constraint for ${scope.town}: ${c}`, [`district:${scope.district_id}`, "kind:crew_constraint"], "crew constraint (user)", [runId]);
  const r = await recall(`${scope.town} crew constraint ${scope.operation} decision`, 10);
  const memories = r.items.filter((m) => m.tags.includes(`district:${scope.district_id}`));

  const queue =
    scope.operation === "plan_outdoor_work" ? ["hazeops", "workershield"] : scope.operation === "assess_haze" ? ["hazeops"] : ["peatfire"];
  return { snapshot, memories, queue, districtEntity, decisionEntity };
}

const range = (xs: number[]) => (!xs.length ? "n/a" : Math.min(...xs) === Math.max(...xs) ? `${xs[0]}` : `${Math.min(...xs)}-${Math.max(...xs)}`);

export async function synthesize(
  scope: Scope,
  a: Assessment | null,
  p: Proposal | null,
  src: SourceAssessment | null,
  memories: Recalled[],
  allowNarrative: boolean,
): Promise<Draft> {
  const claims: Claim[] = [...(a?.claims ?? []), ...(p?.claims ?? []), ...(src?.claims ?? [])];
  const limitations: string[] = [...(p?.limitations ?? [])];
  const assumptions: string[] = [...(p?.assumptions ?? []), `District conditions are represented by ${scope.town} town-centre data.`];
  if (a?.hindsight)
    limitations.push("Future hours use archived model values (hindsight), as in a replay or the offline sample: a test of the method, not a true forecast.");
  if (a?.uncovered_intervals.length && !p) limitations.push(`No forecast for ${a.uncovered_intervals.join(", ")}.`);
  if (src)
    limitations.push(
      "Fire detections inside a concession show where land burned, not who lit it; names are leads for verification.",
      "Concession boundaries come from public compilations and may be outdated.",
    );
  if (memories.length) limitations.push("Recalled memories are context only; they never establish current air conditions.");

  const projId = a?.claims.find((c) => c.kind === "forecast")?.evidence_ids[0];
  let summary = "";
  let rationale = "";
  if (scope.operation === "plan_outdoor_work" && p) {
    const planned = p.schedule.filter((s) => s.basis !== "unserved");
    const heavy = p.schedule.filter((s) => s.intensity === "heavy");
    const gId = p.claims.find((c) => c.kind === "recommendation")?.evidence_ids.find((e) => e !== projId);
    const cites = [projId, gId].filter(Boolean).map((e) => `[${e}]`).join("");
    summary =
      `Outdoor crew plan for ${scope.town}, ${localHHMM(scope.startMs)}-${localHHMM(scope.endMs)} MYT: ${planned.length} of ${p.schedule.length} hours are planned on forecast evidence` +
      `${heavy.length ? `, with heavy work at ${heavy.map((s) => s.label).join(", ")} where indicative hourly API is ${range(heavy.map((s) => s.api_hourly!))}` : ""} ${cites}.`;
    if (p.unserved_intervals.length) summary += ` The rest of the shift is not planned because no forecast covers it.`;
    rationale = `Each hour's band and action come from guidance ${p.guidance_version} applied to HazeOps hourly projections ${cites}.`;
  } else if (scope.operation === "assess_haze" && a) {
    const apis = a.hourly.map((h) => Math.round(h.api));
    const ps = a.hourly.map((h) => Math.round(h.p_close * 100));
    summary = apis.length
      ? `Haze outlook for ${scope.town} in the requested window: 24-hour API ${range(apis)}, with a ${range(ps)}% chance of exceeding the school-closure level [${projId}].`
      : `No forecast covers the requested window for ${scope.town}.`;
    rationale = apis.length ? `Projected from hourly PM2.5 (observed where available, model otherwise) as a rolling 24-hour average [${projId}].` : "";
  } else if (src) {
    // Where the weighted fires were and the strongest hotspot, then the map-based shares.
    const inferences = src.claims.filter((c) => c.kind === "inference");
    const hotspots = inferences.filter((c) => /^Fire hotspot/.test(c.text));
    const rest = inferences.filter((c) => !/^Fire hotspot/.test(c.text));
    // ...followed by how each share is calculated, so no share reaches a reader without its method.
    const how = rest.filter((c) => /^How each share is calculated/.test(c.text));
    const shares = rest.filter((c) => !/^How each share is calculated/.test(c.text));
    summary = [...shares.slice(0, 1), ...hotspots.slice(0, 1), ...shares.slice(1, 4), ...how].map((c) => c.text).join(" ");
    rationale = src.claims.find((c) => c.kind === "calculation")?.text ?? "";
  }

  let narrative: string | null = null;
  if (allowNarrative && hostedAvailable()) {
    try {
      const { message } = await chat([
        {
          role: "system",
          content:
            "Explain this result in under 80 words for the person who asked. Use only facts below. Every sentence with a number ends with its evidence id in square brackets, e.g. [E-0123456789]. Never say a company is guilty.",
        },
        { role: "user", content: [summary, rationale, ...claims.map((c) => c.text)].join("\n") },
      ]);
      narrative = (message.content ?? "").trim() || null;
    } catch (e) {
      if (!(e instanceof HostedInferenceSkipped)) narrative = null;
    }
  }

  return { summary, claims, narrative, limitations, assumptions, rationale, guidance_versions: p?.guidance_version ? [p.guidance_version] : [] };
}

/** Turn critic findings into targeted work. Returns the new queue and switches. */
export function planRevision(c: CriticDecision, operation: Scope["operation"]) {
  const queue: string[] = [];
  let narrow = false;
  let disableNarrative = false;
  for (const f of c.findings) {
    if (f.code === "coverage_gap") {
      narrow = true;
      if (!queue.includes("workershield")) queue.push("workershield");
    }
    if (f.code === "unsupported_narrative" || f.code === "citation") disableNarrative = true;
    if (f.code === "hash_mismatch" && (f.target === "hazeops" || f.target === "peatfire") && !queue.includes(f.target)) {
      queue.unshift(f.target);
      if (operation === "plan_outdoor_work" && !queue.includes("workershield")) queue.push("workershield");
    }
  }
  return { queue, narrow, disableNarrative };
}

export interface Outcome {
  status: "success" | "partial";
  conclusion_status: "current" | "needs_review" | "insufficient_evidence";
  conclusion_revision_id: string | null;
  memory_id: string | null;
  freshness: { newer_pm25_rows: number; newer_fire_rows: number };
}

/** Freshness + publication: World Model conclusion revision, then reviewed H-MEM capture. */
export async function publish(
  scope: Scope,
  runId: string,
  decisionKey: string,
  decisionEntity: string,
  snapshot: Snapshot,
  draft: Draft,
  evidence: EvidenceRef[],
  p: Proposal | null,
  approved: boolean,
): Promise<Outcome> {
  const fresh = await newerRelevantEvidence(scope.town, snapshot.watermark, scope.startMs, scope.endMs, scope.operation);
  const stale = fresh.pm25_rows + fresh.fire_rows > 0;
  const conclusion_status = !approved ? "insufficient_evidence" : stale ? "needs_review" : "current";
  const at = new Date().toISOString();
  const cited = new Set(draft.claims.flatMap((c) => c.evidence_ids));
  for (const e of evidence.filter((x) => cited.has(x.evidence_id)))
    await recordEvidence({ ...e, executed_utc: at, rows: [] }, decisionEntity, runId);
  const conclusionId = await publishConclusion(
    decisionEntity,
    {
      run_id: runId,
      status: conclusion_status,
      summary: draft.summary,
      evidence_ids: [...cited],
      snapshot_id: snapshot.snapshot_id,
      validity: {
        start: new Date(scope.startMs).toISOString(),
        end: new Date(scope.endMs).toISOString(),
        unserved: p?.unserved_intervals ?? [],
      },
    },
    at,
  );
  // Reviewed memory is captured only after critic approval, and supersedes this decision's previous memory.
  let memoryId: string | null = null;
  if (approved) {
    const prev = (await recall(`reviewed decision ${scope.operation} ${scope.town}`, 10)).items.find((m) => m.tags.includes(`decision:${decisionKey}`));
    memoryId = await remember(
      `Reviewed decision (${scope.operation}, ${scope.town}, window ${new Date(scope.startMs).toISOString()} to ${new Date(scope.endMs).toISOString()}): ${draft.summary.replace(/\s*\[[^\]]+\]/g, "")} Conclusion ${conclusionId}.`,
      [`district:${scope.district_id}`, `op:${scope.operation}`, `decision:${decisionKey}`, "kind:reviewed_decision"],
      "reviewed decision",
      [conclusionId, runId],
      prev?.id,
    );
  }
  return {
    status: approved && !(p?.narrowed ?? false) ? "success" : "partial",
    conclusion_status,
    conclusion_revision_id: conclusionId,
    memory_id: memoryId,
    freshness: { newer_pm25_rows: fresh.pm25_rows, newer_fire_rows: fresh.fire_rows },
  };
}

export const hours = (ms: number) => ms / HOUR;
