// CommunityAlert: prepares message PREVIEWS bound to an approved conclusion revision.
// It never sends anything; delivery stays a separate, human-authorised step.

import type { Assessment, Messages, Proposal, Scope } from "../orchestration/types.ts";
import { tarikhBM } from "../warning.ts";

export const COMMUNITYALERT_VERSION = "communityalert-1.0";

export function previews(scope: Scope, conclusionRevision: string, a?: Assessment, p?: Proposal): Messages {
  const out: Messages["previews"] = [];
  if (scope.operation === "assess_haze" && a?.drafts) {
    out.push({ audience: "parents", language: "ms", text: a.drafts.parentNoticeBM });
    out.push({ audience: "school", language: "ms", text: a.drafts.schoolNoticeBM });
  }
  if (scope.operation === "plan_outdoor_work" && p) {
    const day = tarikhBM(scope.startMs);
    const lines = p.schedule.map((s) => `${s.label}: ${s.task ?? (s.basis === "unserved" ? "belum dirancang (tiada ramalan)" : "tiada tugas")}`);
    out.push({
      audience: "crew",
      language: "ms",
      text: [`Taklimat kru, ${scope.town}, ${day}`, ...lines, ...(p.controls.length ? ["Kawalan:", ...p.controls] : []), "Laporkan segera jika ada sesak nafas atau pening."].join("\n"),
    });
    out.push({
      audience: "crew",
      language: "en",
      text: [`Crew briefing, ${scope.town}`, ...p.schedule.map((s) => `${s.label}: ${s.task ?? (s.basis === "unserved" ? "not planned (no forecast)" : "no task")}`), ...p.controls, "Report breathing difficulty or dizziness immediately."].join("\n"),
    });
  }
  return { bound_to: conclusionRevision, previews: out, status: "preview" };
}
