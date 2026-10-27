// EvidenceCritic: independent of the authors. It re-runs every cited query itself
// (through Zetaris in live mode) and compares hashes, runs its own coverage query for
// every hour a recommendation talks about, checks guidance and disclosure, and only
// then approves. It can block publication; the manager cannot override it.

import { CONFIG } from "../config.ts";
import { deterministicCheck, judge } from "../judge.ts";
import { hostedAvailable } from "../llm.ts";
import { epoch, evidence, loadEvidence, safeText, toMs, verifyEvidence } from "../query.ts";
import type { Assessment, CriticDecision, CriticFinding, Draft, EvidenceRef, Proposal, Scope } from "../orchestration/types.ts";
import type { Recalled } from "../meterless/hmem.ts";
import { hourLabel, ref, tsSql } from "./common.ts";

export const CRITIC_VERSION = "evidence-critic-1.0";

export async function review(
  scope: Scope,
  draft: Draft,
  evidenceRefs: EvidenceRef[],
  memories: Recalled[],
  round: number,
  a?: Assessment,
  p?: Proposal,
): Promise<{ decision: CriticDecision; evidence: EvidenceRef[] }> {
  const findings: CriticFinding[] = [];
  const checks: string[] = [];
  const independent: EvidenceRef[] = [];

  // 1. Citations: every sentence with a number cites evidence that exists; no guilt wording.
  checks.push("citations");
  const allText = [draft.summary, draft.rationale, draft.narrative ?? "", ...draft.claims.map((c) => c.text)].join(" ");
  const cited = new Set([...draft.claims.flatMap((c) => c.evidence_ids), ...[...allText.matchAll(/\[(E-[0-9a-f]{10})\]/g)].map((m) => m[1])]);
  const known = evidenceRefs.filter((e) => cited.has(e.evidence_id));
  const evForCheck = known.map((e) => ({ ...e, executed_utc: "", rows: [] as unknown[][] }));
  const memCites = memories.map((m) => ({ id: m.id, content: m.content }));
  const det = deterministicCheck(
    [draft.summary, draft.rationale, ...draft.claims.map((c) => c.text), draft.narrative ?? ""].join("\n"),
    evForCheck,
    memCites,
  );
  for (const prob of det.problems) findings.push({ code: "citation", message: prob, target: "manager" });

  // 2. Re-run every cited query independently and compare result hashes.
  checks.push("independent re-query of cited evidence");
  for (const e of known) {
    try {
      const v = await verifyEvidence(e.evidence_id);
      if (!v.ok) findings.push({ code: "hash_mismatch", message: `${e.evidence_id} returns different rows now than when cited.`, target: e.produced_by as CriticFinding["target"] });
    } catch (err) {
      findings.push({ code: "hash_mismatch", message: `${e.evidence_id} could not be re-run: ${(err as Error).message}`, target: "manager" });
    }
  }

  // 3. Coverage: the critic's own query for the hours the plan relies on.
  if (a && (scope.operation === "plan_outdoor_work" || scope.operation === "assess_haze")) {
    checks.push("coverage of requested window");
    const eCov = await evidence(
      `SELECT ${epoch("valid_utc")} AS valid_epoch FROM {src}.projections
        WHERE run_id = '${a.projection_run_id}' AND town = '${safeText(scope.town)}' AND pm25_hour IS NOT NULL
          AND valid_utc >= ${tsSql(scope.startMs)} AND valid_utc < ${tsSql(scope.endMs)} ORDER BY valid_utc`,
    );
    independent.push(ref(eCov, "critic"));
    const coveredHours = new Set(eCov.rows.map((r) => toMs(r[0])));
    if (!coveredHours.size)
      findings.push({ code: "no_coverage", message: "No forecast covers any hour of the requested window.", target: "none" });
    const claimHours = [...(p?.claims ?? []), ...draft.claims].filter((c) => c.hourMs && c.kind !== "unserved");
    const gaps = [...new Set(claimHours.filter((c) => !coveredHours.has(c.hourMs!)).map((c) => c.hourMs!))];
    if (gaps.length)
      findings.push({
        code: "coverage_gap",
        message: `Recommendations for ${gaps.map(hourLabel).join(", ")} MYT rest on assumed (persisted) values, not on evidence. Narrow the plan or obtain a forecast for those hours.`,
        target: "workershield",
      });
  }

  // 4. Recommendations must cite a guidance version the plan actually loaded.
  if (scope.operation === "plan_outdoor_work") {
    checks.push("guidance binding");
    const recs = draft.claims.filter((c) => c.kind === "recommendation");
    if (!p?.guidance_version || recs.some((c) => c.guidance_version !== p.guidance_version))
      findings.push({ code: "missing_guidance", message: "Recommendations without a loaded, versioned guidance row.", target: "none" });
  }

  // 5. Hindsight runs must say so.
  if (a?.hindsight) {
    checks.push("hindsight disclosure");
    if (!draft.limitations.some((l) => /hindsight/i.test(l)))
      findings.push({ code: "hindsight_undisclosed", message: "The run used archived model values but the limitations do not say so.", target: "manager" });
  }

  // 6. Optional model narrative: Nemotron judge lane (live mode only).
  if (draft.narrative && hostedAvailable()) {
    checks.push("nemotron judge on narrative");
    try {
      const v = await judge(draft.narrative, await loadEvidence(known.map((e) => e.evidence_id)), { memories: memCites });
      if (!v.ok) findings.push({ code: "unsupported_narrative", message: v.problems.join("; "), target: "manager" });
    } catch (err) {
      findings.push({ code: "unsupported_narrative", message: `Judge lane unavailable: ${(err as Error).message}`, target: "manager" });
    }
  }

  const fatal = findings.some((f) => f.code === "no_coverage" || f.code === "missing_guidance");
  const decision: CriticDecision["decision"] = !findings.length
    ? "approve"
    : fatal || round >= CONFIG.limits.feedbackRounds
      ? "insufficient_evidence"
      : "revise";
  return {
    decision: {
      decision,
      findings,
      required_evidence: findings.filter((f) => f.code === "coverage_gap" || f.code === "no_coverage").map((f) => f.message),
      checks_run: checks,
      independent_queries: [...known.map((e) => `re-run:${e.evidence_id}`), ...independent.map((e) => e.evidence_id)],
    },
    evidence: independent,
  };
}
