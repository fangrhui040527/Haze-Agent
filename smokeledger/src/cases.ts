// Warn -> record -> re-check -> escalate.
//
//  DETECTED -> (draft) NOTICE_PENDING -> (human approves) NOTIFIED
//  NOTIFIED -> (re-check, still burning after grace) ESCALATION_PENDING -> (approve) ESCALATED
//  NOTIFIED -> (re-check, quiet long enough) RESOLVED
//
// Every transition is a row in case_events (queryable in Zetaris) and a memory in
// H-MEM (recalled the next time the same concession or group burns).

import fs from "node:fs";
import path from "node:path";
import { CONFIG, HOUR, PARAMS } from "./config.ts";
import { db, insertMany } from "./db.ts";
import type { ForwardResult, Reach } from "./engine.ts";
import { judge } from "./judge.ts";
import { localTime } from "./dossier.ts";
import { recall, remember } from "./meterless/hmem.ts";
import { epoch, evidence, fmtUtc, safeId, type Evidence } from "./query.ts";

export type CaseStatus = "DETECTED" | "NOTICE_PENDING" | "NOTIFIED" | "ESCALATION_PENDING" | "ESCALATED" | "RESOLVED";
export const OPEN: CaseStatus[] = ["DETECTED", "NOTICE_PENDING", "NOTIFIED", "ESCALATION_PENDING"];

export interface CaseRow {
  case_id: string;
  concession_id: string;
  status: CaseStatus;
  opened_utc: Date;
  notified_utc: Date | null;
  recheck_due_utc: Date | null;
  escalated_utc: Date | null;
  closed_utc: Date | null;
  draft_path: string | null;
}

// ---------------- pure transitions (unit-tested) ----------------

export function onApprove(status: CaseStatus, nowMs: number): { status: CaseStatus; notifiedMs?: number; recheckDueMs?: number; escalatedMs?: number } {
  if (status === "NOTICE_PENDING")
    return { status: "NOTIFIED", notifiedMs: nowMs, recheckDueMs: nowMs + PARAMS.cases.recheckAfterHours * HOUR };
  if (status === "ESCALATION_PENDING") return { status: "ESCALATED", escalatedMs: nowMs };
  throw new Error(`Nothing to approve in status ${status}`);
}

export function onRecheck(
  c: { status: CaseStatus; notifiedMs: number; recheckDueMs: number },
  firesAfterGrace: number,
  nowMs: number,
): { status: CaseStatus; recheckDueMs?: number } {
  if (c.status !== "NOTIFIED" || nowMs < c.recheckDueMs) return { status: c.status };
  if (firesAfterGrace > 0) return { status: "ESCALATION_PENDING" };
  if (nowMs - c.notifiedMs >= PARAMS.cases.resolveAfterQuietHours * HOUR) return { status: "RESOLVED" };
  return { status: "NOTIFIED", recheckDueMs: nowMs + PARAMS.cases.recheckAfterHours * HOUR };
}

// ---------------- persistence helpers ----------------

const iso = (ms: number) => new Date(ms).toISOString();
/** Only memories tagged with this concession (or its group) may be quoted in its notices. */
const aboutThis = (tags: string[], concessionId: string, group: string | null | undefined) =>
  tags.includes(`concession:${concessionId}`) || (!!group && tags.includes(`group:${group}`));
/** Quote a memory as one sentence so the citation covers all of it. */
const oneSentence = (s: string) =>
  s.replace(/(?<!\b(?:Sdn|Bhd|PT|Tbk|Ltd|Co|Inc|No|Jl|Jln|St|Dr|Mr|Mrs))\.\s+(?=\S)/g, "; ").replace(/\.$/, "");
const ts = (ms: number) => `CAST('${iso(ms)}' AS TIMESTAMP)`;

async function event(caseId: string, atMs: number, name: string, detail: object, ev: Evidence[] = []) {
  await insertMany("case_events", ["case_id", "at_utc", "event", "detail", "evidence_ids"], [
    [caseId, iso(atMs), name, JSON.stringify(detail), ev.map((e) => e.evidence_id).join(",")],
  ]);
}

export async function getCase(caseId: string): Promise<CaseRow> {
  const r = await db().query("SELECT * FROM cases WHERE case_id = $1", [caseId]);
  if (!r.rows.length) throw new Error(`No case ${caseId}`);
  return r.rows[0];
}

export async function listCases(): Promise<(CaseRow & { name: string | null; group_name: string | null })[]> {
  const r = await db().query(
    `SELECT k.*, c.name, c.group_name FROM cases k LEFT JOIN concessions c ON c.concession_id = k.concession_id
      ORDER BY k.opened_utc DESC`,
  );
  return r.rows;
}

async function concessionInfo(concessionId: string) {
  const r = await db().query(
    `SELECT c.*, co.parent_country, co.rspo_member, co.grievance_contact, co.known_buyers
       FROM concessions c LEFT JOIN companies co ON co.group_name = c.group_name WHERE c.concession_id = $1`,
    [concessionId],
  );
  return r.rows[0] ?? { concession_id: concessionId };
}

// ---------------- scan: open cases from a forward run ----------------

export async function scan(fw: ForwardResult): Promise<string[]> {
  const opened: string[] = [];
  const windowStart = fw.nowMs - PARAMS.cases.detectWindowHours * HOUR;
  for (const c of fw.clusters) {
    const reach = (fw.reach.get(c.cluster_id) ?? []).sort((a, b) => a.etaHours - b.etaHours);
    if (!reach.length) continue; // plume never comes near a Malaysian town
    for (const concessionId of c.concession_ids) {
      const open = await db().query("SELECT 1 FROM cases WHERE concession_id = $1 AND status = ANY($2)", [concessionId, OPEN]);
      if (open.rows.length) continue;
      const cid = safeId(concessionId);
      const caseId = `case-${cid.replace(/[^A-Za-z0-9]+/g, "-").slice(-24)}-${iso(fw.nowMs).slice(0, 13).replace(/[-:T]/g, "")}`;
      const eFires = await evidence(
        `SELECT f.concession_id, c.name, c.company, c.group_name, COUNT(*) AS n_fires, SUM(f.frp) AS total_frp,
                SUM(CASE WHEN f.on_peat THEN 1 ELSE 0 END) AS peat_fires, MIN(${epoch("f.acq_utc")}) AS first_seen_epoch,
                MAX(${epoch("f.acq_utc")}) AS last_seen_epoch, MAX(c.map_source) AS map_source, MAX(c.map_date) AS map_date
           FROM {src}.fires f JOIN {src}.concessions c ON f.concession_id = c.concession_id
          WHERE f.concession_id = '${cid}' AND f.acq_utc > ${ts(windowStart)} AND f.acq_utc <= ${ts(fw.nowMs)}
          GROUP BY f.concession_id, c.name, c.company, c.group_name`,
      );
      if (!eFires.rows.length) continue;
      await insertMany("cases", ["case_id", "concession_id", "status", "opened_utc"], [[caseId, concessionId, "DETECTED", iso(fw.nowMs)]]);
      await event(caseId, fw.nowMs, "DETECTED", { forward_run: fw.run_id, cluster: c.cluster_id, reach }, [eFires]);
      const [, name, company, group, n] = eFires.rows[0];
      const first: Reach = reach[0];
      await remember(
        `${localTime(fw.nowMs)}: ${n} fire detections inside concession ${name ?? concessionId} (${company ?? "company not listed"}, group ${group ?? "not listed"}). Forecast plume passes within ${first.minKm} km of ${first.town} in about ${first.etaHours} h. Case ${caseId} opened.`,
        [`concession:${concessionId}`, `group:${group ?? "unknown"}`, "event:detected"],
        "fire detected in concession",
        [caseId, eFires.evidence_id],
      );
      opened.push(caseId);
    }
  }
  return opened;
}

// ---------------- notices ----------------

function writeDraft(caseId: string, kind: string, body: string): string {
  const dir = path.join(CONFIG.outboxDir, "drafts");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${caseId}-${kind}.md`);
  fs.writeFileSync(file, body);
  return file;
}

export async function draftNotice(caseId: string, nowMs: number): Promise<{ file: string; text: string }> {
  const k = await getCase(caseId);
  if (k.status !== "DETECTED") throw new Error(`Case ${caseId} is ${k.status}; a notice is drafted only for DETECTED cases`);
  const info = await concessionInfo(k.concession_id);
  const cid = safeId(k.concession_id);
  const eFires = await evidence(
    `SELECT COUNT(*) AS n_fires, SUM(CASE WHEN on_peat THEN 1 ELSE 0 END) AS peat_fires,
            MIN(${epoch("acq_utc")}) AS first_seen_epoch, MAX(${epoch("acq_utc")}) AS last_seen_epoch
       FROM {src}.fires WHERE concession_id = '${cid}'
        AND acq_utc > ${ts(new Date(k.opened_utc).getTime() - PARAMS.cases.detectWindowHours * HOUR)} AND acq_utc <= ${ts(new Date(k.opened_utc).getTime())}`,
  );
  const eReach = await evidence(`SELECT case_id, event, at_utc, detail FROM {src}.case_events WHERE case_id = '${safeId(caseId)}' AND event = 'DETECTED'`);
  const reach: Reach[] = JSON.parse(String(eReach.rows[0]?.[3] ?? "{}")).reach ?? [];
  const mem = await recall(`concession ${info.name ?? k.concession_id} group ${info.group_name ?? ""} fire notice`, 8);
  const prior = mem.items.filter((m) => !m.content.includes(caseId) && aboutThis(m.tags, k.concession_id, info.group_name));

  const [n, pf, first, last] = eFires.rows[0] ?? [0, 0, "", ""];
  const to = info.grievance_contact ?? "(no contact on file: add it to companies.csv)";
  const L = [
    `To: ${to}`,
    `Subject: Active fire detected in concession ${info.name ?? k.concession_id}: please confirm suppression`,
    "",
    `Satellite monitoring recorded ${n} fire detections, ${pf} of them on peat, inside the mapped boundary of ${info.name ?? k.concession_id} (${info.company ?? "company not listed"}) between ${fmtUtc(first)} and ${fmtUtc(last)} [${eFires.evidence_id}].`,
  ];
  if (reach[0])
    L.push(`Forecast wind trajectories carry smoke from this area to within ${reach[0].minKm} km of ${reach[0].town}, Malaysia, in about ${reach[0].etaHours} hours [${eReach.evidence_id}].`);
  for (const p of prior.slice(0, 2)) L.push(`Our records also hold this earlier entry: "${oneSentence(p.content)}" [M:${p.id}].`);
  L.push(
    "Please confirm whether fire crews are responding. We will re-check satellite detections in the coming day.",
    "This notice records when you were informed. It is not a finding of responsibility for the fire.",
    "",
    "SmokeLedger (independent haze evidence project)",
  );
  const text = L.join("\n");
  const v = await judge(text, [eFires, eReach], { useModel: false, memories: prior });
  if (!v.ok) throw new Error(`Notice failed the citation check: ${v.problems.join("; ")}`);
  const file = writeDraft(caseId, "notice", text);
  await db().query("UPDATE cases SET status = 'NOTICE_PENDING', draft_path = $2 WHERE case_id = $1", [caseId, file]);
  await event(caseId, nowMs, "NOTICE_DRAFTED", { file, memories_used: prior.map((p) => p.id) }, [eFires, eReach]);
  return { file, text };
}

/** "Send" after human approval. In DEMO_MODE everything goes to the sandbox recipient. */
export async function approve(caseId: string, nowMs: number): Promise<{ status: CaseStatus; sentFile: string; intended: string }> {
  const k = await getCase(caseId);
  if (!k.draft_path || !fs.existsSync(k.draft_path)) throw new Error(`Case ${caseId} has no draft to send`);
  const draft = fs.readFileSync(k.draft_path, "utf8");
  const intended = (draft.match(/^To: (.*)$/m)?.[1] ?? "").trim();
  const actualTo = CONFIG.demoMode ? CONFIG.sandboxRecipient : intended;
  const dir = path.join(CONFIG.outboxDir, "sent");
  fs.mkdirSync(dir, { recursive: true });
  const sentFile = path.join(dir, `${caseId}-${k.status === "ESCALATION_PENDING" ? "escalation" : "notice"}.eml`);
  fs.writeFileSync(
    sentFile,
    `To: ${actualTo}\nX-Intended-Recipient: ${intended}\nDate: ${new Date(nowMs).toUTCString()}\nX-SmokeLedger-Case: ${caseId}\n\n${draft.replace(/^To: .*\n/m, "")}`,
  );
  const t = onApprove(k.status, nowMs);
  await db().query(
    `UPDATE cases SET status = $2, notified_utc = COALESCE($3, notified_utc), recheck_due_utc = COALESCE($4, recheck_due_utc),
            escalated_utc = COALESCE($5, escalated_utc) WHERE case_id = $1`,
    [caseId, t.status, t.notifiedMs ? iso(t.notifiedMs) : null, t.recheckDueMs ? iso(t.recheckDueMs) : null, t.escalatedMs ? iso(t.escalatedMs) : null],
  );
  await event(caseId, nowMs, t.status === "NOTIFIED" ? "NOTIFIED" : "ESCALATED", { intended, sent_to: actualTo, demo: CONFIG.demoMode, file: sentFile });
  const info = await concessionInfo(k.concession_id);
  await remember(
    `${localTime(nowMs)}: ${t.status === "NOTIFIED" ? "notice" : "escalation"} for concession ${info.name ?? k.concession_id} (group ${info.group_name ?? "not listed"}) sent to ${intended} (case ${caseId}).`,
    [`concession:${k.concession_id}`, `group:${info.group_name ?? "unknown"}`, `event:${t.status.toLowerCase()}`],
    "notice sent",
    [caseId],
  );
  return { status: t.status, sentFile, intended };
}

// ---------------- re-check and escalation ----------------

export async function recheck(nowMs: number): Promise<{ case_id: string; status: CaseStatus; firesAfter: number }[]> {
  const due = await db().query("SELECT * FROM cases WHERE status = 'NOTIFIED' AND recheck_due_utc <= $1", [iso(nowMs)]);
  const out: { case_id: string; status: CaseStatus; firesAfter: number }[] = [];
  for (const k of due.rows as CaseRow[]) {
    const notifiedMs = new Date(k.notified_utc!).getTime();
    const cid = safeId(k.concession_id);
    const eAfter = await evidence(
      `SELECT COUNT(*) AS n_fires_after_notice, SUM(CASE WHEN on_peat THEN 1 ELSE 0 END) AS peat_fires,
              MIN(${epoch("acq_utc")}) AS first_after_epoch, MAX(${epoch("acq_utc")}) AS last_after_epoch
         FROM {src}.fires WHERE concession_id = '${cid}'
          AND acq_utc > ${ts(notifiedMs + PARAMS.cases.graceHours * HOUR)} AND acq_utc <= ${ts(nowMs)}`,
    );
    const firesAfter = Number(eAfter.rows[0]?.[0] ?? 0);
    const t = onRecheck({ status: "NOTIFIED", notifiedMs, recheckDueMs: new Date(k.recheck_due_utc!).getTime() }, firesAfter, nowMs);
    await db().query(
      `UPDATE cases SET status = $2, recheck_due_utc = COALESCE($3, recheck_due_utc), closed_utc = $4 WHERE case_id = $1`,
      [k.case_id, t.status, t.recheckDueMs ? iso(t.recheckDueMs) : null, t.status === "RESOLVED" ? iso(nowMs) : null],
    );
    await event(k.case_id, nowMs, `RECHECK_${t.status}`, { firesAfter }, [eAfter]);
    const info = await concessionInfo(k.concession_id);
    await remember(
      `${localTime(nowMs)}: re-check of concession ${info.name ?? k.concession_id} (group ${info.group_name ?? "not listed"}) found ${firesAfter} fire detections after the notice grace period; case ${k.case_id} is now ${t.status}.`,
      [`concession:${k.concession_id}`, `group:${info.group_name ?? "unknown"}`, `event:recheck`],
      "re-check",
      [k.case_id, eAfter.evidence_id],
    );
    if (t.status === "ESCALATION_PENDING") await draftEscalation(k.case_id, nowMs);
    out.push({ case_id: k.case_id, status: t.status, firesAfter });
  }
  return out;
}

export async function draftEscalation(caseId: string, nowMs: number): Promise<{ file: string; text: string }> {
  const k = await getCase(caseId);
  const info = await concessionInfo(k.concession_id);
  const cid = safeId(k.concession_id);
  const notifiedMs = new Date(k.notified_utc!).getTime();
  const eNotice = await evidence(
    `SELECT case_id, event, ${epoch("at_utc")} AS at_epoch FROM {src}.case_events WHERE case_id = '${safeId(caseId)}' AND event = 'NOTIFIED'`,
  );
  const eAfter = await evidence(
    `SELECT COUNT(*) AS n_fires_after_notice, SUM(CASE WHEN on_peat THEN 1 ELSE 0 END) AS peat_fires, MAX(${epoch("acq_utc")}) AS last_seen_epoch
       FROM {src}.fires WHERE concession_id = '${cid}'
        AND acq_utc > ${ts(notifiedMs + PARAMS.cases.graceHours * HOUR)} AND acq_utc <= ${ts(nowMs)}`,
  );
  const eOwner = await evidence(
    `SELECT c.concession_id, c.name, c.company, c.group_name, co.parent_country, co.rspo_member, co.known_buyers, c.map_source, c.map_date
       FROM {src}.concessions c LEFT JOIN {src}.companies co ON co.group_name = c.group_name WHERE c.concession_id = '${cid}'`,
  );
  const memAll = await recall(`concession ${info.name ?? k.concession_id} group ${info.group_name ?? ""}`, 10);
  const mem = { ...memAll, items: memAll.items.filter((m) => aboutThis(m.tags, k.concession_id, info.group_name)) };
  const [nAfter, pfAfter, lastSeen] = eAfter.rows[0] ?? [0, 0, ""];

  const routes: string[] = [];
  if (info.rspo_member) routes.push("RSPO complaints system (the group is listed as an RSPO member)");
  if (info.known_buyers) routes.push(`Buyers' grievance channels: ${info.known_buyers}`);
  if (/malaysia/i.test(info.parent_country ?? "")) routes.push("Malaysian regulators (MPOB / MSPO certification), since the parent group is Malaysian");
  routes.push("Journalists and NGOs following the haze (attach this file and the dossier)");

  const L = [
    `# Escalation pack: ${info.name ?? k.concession_id}`,
    "",
    `The concession holder was notified at ${fmtUtc(eNotice.rows[0]?.[2])} [${eNotice.evidence_id}].`,
    `After the grace period, satellites recorded ${nAfter} further fire detections inside the concession, ${pfAfter} of them on peat, the latest at ${fmtUtc(lastSeen)} [${eAfter.evidence_id}].`,
    `Holder on record: ${info.company ?? "company not listed"}, group ${info.group_name ?? "not listed"}; boundary from ${info.map_source ?? "unknown source"}, dated ${info.map_date ?? "unknown"} [${eOwner.evidence_id}].`,
    "",
    "## History held in memory",
    ...mem.items.slice(0, 4).map((m) => `- ${oneSentence(m.content)} [M:${m.id}]`),
    "",
    "## Suggested routes (a person decides)",
    ...routes.map((r) => `- ${r}`),
    "",
    "Fire detections inside a concession show where land burned after the holder was told, not who lit the fire.",
  ];
  const text = L.join("\n");
  const v = await judge(text.split("## Suggested routes")[0], [eNotice, eAfter, eOwner], { useModel: false, memories: mem.items });
  if (!v.ok) throw new Error(`Escalation failed the citation check: ${v.problems.join("; ")}`);
  const file = writeDraft(caseId, "escalation", `To: ${info.grievance_contact ?? "(choose recipients from the routes below)"}\n${text}`);
  await db().query("UPDATE cases SET draft_path = $2 WHERE case_id = $1", [caseId, file]);
  await event(caseId, nowMs, "ESCALATION_DRAFTED", { file }, [eNotice, eAfter, eOwner]);
  return { file, text };
}
