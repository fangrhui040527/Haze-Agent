// PeatFire Sentinel: fire-signal investigation. Traces the air over the town backwards,
// weights the fires on its path, and reports peat / concession shares with ranges.
// Detections show where land burned, not who lit it; names are leads for verification.

import { HOUR } from "../config.ts";
import { runBackward } from "../engine.ts";
import { buildDossier } from "../dossier.ts";
import { db } from "../db.ts";
import type { Claim, EvidenceRef, Scope, SourceAssessment } from "../orchestration/types.ts";
import { upsertConcession } from "../meterless/worldModel.ts";
import { ref, shortHash } from "./common.ts";

export const PEATFIRE_VERSION = "peatfire-sentinel-1.0";

// recordConcessions=false leaves facts to an embedding app's own World Model (single authority).
export async function investigate(scope: Scope, runId: string, recordConcessions = true): Promise<{ assessment: SourceAssessment; evidence: EvidenceRef[] }> {
  const windowHours = Math.max(1, Math.round((scope.endMs - scope.startMs) / HOUR));
  const r = await runBackward(scope.town, scope.endMs, windowHours, shortHash(runId));
  const d = await buildDossier(r);
  const claims: Claim[] = [];
  const findings = d.text.split("## What this does and does not show")[0];
  for (const [i, line] of findings.split("\n").entries())
    if (/\[E-[0-9a-f]{10}\]/.test(line))
      claims.push({
        id: `${runId}-p-${i}`,
        kind: /^Air quality/.test(line) ? "observation" : /^(Window|Method)/.test(line) ? "calculation" : "inference",
        text: line.replace(/^-\s*/, ""),
        evidence_ids: [...line.matchAll(/\[(E-[0-9a-f]{10})\]/g)].map((m) => m[1]),
      });
  // Concessions named in the dossier become World Model entities (held_by -> group).
  // The top-concessions query: ordered by weight and limited to the first eight.
  const top = d.evidence.find((e) => /ORDER BY w DESC\b[^]*\bLIMIT 8\b/.test(e.sql));
  const tops = (top?.rows ?? []).map((row) => ({ concession_id: String(row[0]), name: row[1] as string | null, group_name: row[3] as string | null }));
  for (const c of recordConcessions ? tops : []) {
    const info = await db().query("SELECT map_source, map_date FROM concessions WHERE concession_id = $1", [c.concession_id]);
    await upsertConcession({ ...c, ...(info.rows[0] ?? {}) }, new Date(scope.endMs).toISOString(), runId);
  }
  return {
    assessment: {
      event_assessment_id: `S-${shortHash(runId)}`,
      backward_run_id: r.run_id,
      claims,
      top_concessions: tops,
      confidence: d.summary.confidence,
      dossier_file: d.file,
    },
    evidence: d.evidence.map((e) => ref(e, "peatfire")),
  };
}
