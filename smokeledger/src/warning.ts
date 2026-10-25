// Forward run -> evidence -> a warning for one town, plus ready-to-send messages
// (parent absence notice, school pre-notice). Message numbers are filled in from
// verified evidence rows by code, never written freehand by the model.

import fs from "node:fs";
import path from "node:path";
import { CONFIG, PARAMS } from "./config.ts";
import type { ForwardResult } from "./engine.ts";
import { judge } from "./judge.ts";
import { localTime } from "./dossier.ts";
import { epoch, evidence, safeId, safeText, toMs, type Evidence } from "./query.ts";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const num = (v: unknown) => Number(v ?? 0);

export interface Warning {
  town: string;
  evidence: Evidence[];
  firstOver200Ms: number | null;
  mornings: { tMs: number; api: number; p: number }[];
  peakSmoke: { tMs: number; index: number } | null;
  text: string;
  parentNoticeBM: string;
  schoolNoticeBM: string;
  file: string;
}

const HARI = ["Ahad", "Isnin", "Selasa", "Rabu", "Khamis", "Jumaat", "Sabtu"];
const BULAN = ["Januari", "Februari", "Mac", "April", "Mei", "Jun", "Julai", "Ogos", "September", "Oktober", "November", "Disember"];
/** Malaysian-time date in Bahasa Malaysia, e.g. "Rabu, 7 Oktober 2026". */
export function tarikhBM(ms: number): string {
  const d = new Date(ms + PARAMS.localUtcOffsetHours * 3_600_000);
  return `${HARI[d.getUTCDay()]}, ${d.getUTCDate()} ${BULAN[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function adviceFor(api: number): string {
  if (api > 300) return "Worst projected level: hazardous. Stay indoors with windows shut; anyone with breathing or heart problems should have medication ready and seek care if symptoms appear.";
  if (api > 200) return "Worst projected level: very unhealthy. If the official reading goes above 200, district schools close; plan to keep children and older people indoors.";
  if (api > 100) return "Worst projected level: unhealthy. Outdoor school activities stop; children with asthma should stay indoors and carry their inhaler.";
  if (api > 50) return "Moderate. Sensitive people should limit long outdoor exertion.";
  return "Good. No special precautions.";
}

export async function buildWarning(fw: ForwardResult, townName: string): Promise<Warning> {
  const run = safeId(fw.run_id);
  const town = safeText(townName);
  const eProj = await evidence(
    `SELECT ${epoch("valid_utc")} AS valid_epoch, pm25_24h, api, p_close, smoke_index FROM {src}.projections
      WHERE run_id = '${run}' AND town = '${town}' ORDER BY valid_utc`,
  );
  if (!eProj.rows.length)
    throw new Error(`No projection for ${townName}: load PM2.5 for this town (at least 18 of the last 24 hours plus a forecast).`);

  const rows = eProj.rows.map(([t, pm, api, p, s]) => ({ tMs: toMs(t), pm: num(pm), api: num(api), p: num(p), smoke: num(s) }));
  const first = rows.find((r) => r.api > PARAMS.api.closeThreshold) ?? null;
  const mornings = rows
    .filter((r) => new Date(r.tMs + PARAMS.localUtcOffsetHours * 3_600_000).getUTCHours() === 7)
    .map((r) => ({ tMs: r.tMs, api: r.api, p: r.p }));
  const peak = rows.reduce<{ tMs: number; index: number } | null>(
    (best, r) => (r.smoke > (best?.index ?? 0) ? { tMs: r.tMs, index: r.smoke } : best),
    null,
  );

  // Which fire clusters drive the smoke at this town?
  const contrib = new Map<string, number>();
  for (const h of fw.smoke.get(townName) ?? []) for (const [cid, w] of h.byCluster) contrib.set(cid, (contrib.get(cid) ?? 0) + w);
  const topClusters = [...contrib.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([cid]) => fw.clusters.find((c) => c.cluster_id === cid)!);
  const fireIds = topClusters.flatMap((c) => c.fire_ids).slice(0, 300).map(safeId);
  const eFires = fireIds.length
    ? await evidence(
        `SELECT COUNT(*) AS n_fires, SUM(frp) AS total_frp, SUM(CASE WHEN on_peat THEN 1 ELSE 0 END) AS peat_fires,
                SUM(CASE WHEN concession_id IS NOT NULL THEN 1 ELSE 0 END) AS in_concessions,
                MIN(lat) AS min_lat, MAX(lat) AS max_lat, MIN(lon) AS min_lon, MAX(lon) AS max_lon
           FROM {src}.fires WHERE fire_id IN (${fireIds.map((f) => `'${f}'`).join(",")})`,
      )
    : null;

  const id = (e: Evidence) => `[${e.evidence_id}]`;
  const L: string[] = [];
  L.push(`# Haze outlook: ${townName}`);
  L.push("");
  L.push(`Issued for ${localTime(fw.nowMs)} ${id(eProj)}.`);
  const now = rows[0];
  L.push(`Now: the 24-hour average PM2.5 is ${now.pm.toFixed(1)} ug/m3, about API ${Math.round(now.api)} ${id(eProj)}.`);
  if (first)
    L.push(`Projected 24-hour API first goes above the school-closure level at ${localTime(first.tMs)}, reaching ${Math.round(first.api)} ${id(eProj)}.`);
  else L.push(`Projected 24-hour API stays at or below the school-closure level for the next ${rows.length - 1} hours ${id(eProj)}.`);
  for (const m of mornings)
    L.push(`- ${localTime(m.tMs)}: projected API ${Math.round(m.api)}, chance it is above the closure level ${pct(m.p)} ${id(eProj)}.`);
  if (peak && peak.index >= PARAMS.forward.smokeAlertIndex && eFires) {
    const [n, , pf, inc, la0, la1, lo0, lo1] = eFires.rows[0];
    L.push(
      `Smoke plumes from today's fire clusters pass closest at ${localTime(peak.tMs)} ${id(eProj)}; the main clusters hold ${n} fire detections, ${pf} on peat and ${inc} inside mapped concessions, between ${num(la0).toFixed(1)} and ${num(la1).toFixed(1)} degrees latitude and ${num(lo0).toFixed(1)} and ${num(lo1).toFixed(1)} degrees longitude ${id(eFires)}.`,
    );
  }
  if (fw.hindsight)
    L.push("Note: this run used archived model values for future hours (hindsight). Use it to test the method, not as a true forecast.");
  const worst = Math.max(...rows.map((r) => r.api));
  L.push("");
  L.push("## What to do");
  L.push(adviceFor(worst));
  L.push("Schools close on the official APIMS reading, not on this projection. Use this outlook to plan childcare and medication early.");
  const text = L.join("\n");
  const all = [eProj, ...(eFires ? [eFires] : [])];
  const v = await judge(text.split("## What to do")[0], all, { useModel: false });
  if (!v.ok) throw new Error(`Warning failed its own citation check: ${v.problems.join("; ")}`);

  // Ready-to-send messages (Bahasa Malaysia). Numbers come from the verified rows above.
  const decisive = mornings.find((m) => m.p >= 0.5) ?? mornings[0];
  const day = decisive ? tarikhBM(decisive.tMs) : "[tarikh]";
  const apiTxt = decisive ? String(Math.round(decisive.api)) : "[bacaan]";
  const parentNoticeBM = [
    "Kepada Guru Kelas / Pentadbir Sekolah [nama sekolah],",
    "",
    `Saya, [nama ibu/bapa], ibu/bapa kepada [nama murid] ([kelas]), ingin memaklumkan bahawa anak saya tidak akan hadir ke sekolah pada ${day} kerana keadaan jerebu.`,
    `Bacaan Indeks Pencemar Udara (IPU) purata 24 jam di ${townName} dijangka sekitar ${apiTxt}, dan anak saya [menghidap asma / mempunyai masalah pernafasan].`,
    "Makluman ini dibuat selaras dengan kelonggaran Kementerian Pendidikan yang membenarkan ibu bapa tidak menghantar anak ke sekolah semasa jerebu dengan memaklumkan pihak sekolah.",
    "",
    "Sekian, terima kasih.",
    "[nama ibu/bapa], [no. telefon]",
  ].join("\n");
  const schoolNoticeBM = [
    "MAKLUMAN KEPADA IBU BAPA",
    "",
    `Unjuran kualiti udara menunjukkan bacaan IPU di kawasan ${townName} berkemungkinan melebihi 200 menjelang ${day}.`,
    "Sekiranya bacaan rasmi APIMS melebihi 200, sekolah akan ditutup serta-merta dan Pengajaran dan Pembelajaran di Rumah (PdPR) akan dilaksanakan.",
    "Sila sediakan penjagaan anak dan pastikan anak yang menghidap asma membawa ubat. Pantau pengumuman rasmi sekolah.",
  ].join("\n");

  const dir = path.join(CONFIG.outboxDir, "warnings");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${run}-${townName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`);
  fs.writeFileSync(
    file,
    `${text}\n\n## Draft: parent absence notice (BM)\n\n${parentNoticeBM}\n\n## Draft: school pre-notice (BM)\n\n${schoolNoticeBM}\n\n## Evidence\n\n${all
      .map((e) => `- ${e.evidence_id}: ${e.row_count} rows, sha256 ${e.sha256}\n\n\`\`\`sql\n${e.sql}\n\`\`\``)
      .join("\n\n")}\n`,
  );
  return { town: townName, evidence: all, firstOver200Ms: first?.tMs ?? null, mornings, peakSmoke: peak, text, parentNoticeBM, schoolNoticeBM, file };
}
