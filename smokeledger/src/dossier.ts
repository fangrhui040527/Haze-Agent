// Backward attribution -> evidence (Zetaris queries, hashed) -> a dossier where every
// factual line cites the query that backs it. Optional Nemotron narrative, judged.

import fs from "node:fs";
import path from "node:path";
import { CONFIG, HOUR, PARAMS } from "./config.ts";
import type { BackwardResult } from "./engine.ts";
import { chat } from "./llm.ts";
import { recordFailure } from "./tracing/context.ts";
import { judge, type Verdict } from "./judge.ts";
import { epoch, evidence, fmtUtc, safeId, safeText, type Evidence } from "./query.ts";

const ts = (ms: number) => `CAST('${new Date(ms).toISOString()}' AS TIMESTAMP)`;
// One decimal: whole-percent rounding can move a range outside the rows it cites.
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const num = (v: unknown) => Number(v ?? 0);
export const localTime = (ms: number) => {
  const d = new Date(ms + PARAMS.localUtcOffsetHours * HOUR);
  return `${d.toUTCString().slice(0, 22)} MYT`;
};

export interface Share {
  label: string;
  central: number;
  low: number;
  high: number;
  fires: number;
}

/** Per-scale weights -> share of the total for the central run and the range across wind scales. */
export function sharesFromRows(rows: { label: string; scale: number; w: number; fires?: number }[], totals: Map<number, number>): Share[] {
  const byLabel = new Map<string, { perScale: Map<number, number>; fires: number }>();
  for (const r of rows) {
    const e = byLabel.get(r.label) ?? { perScale: new Map(), fires: 0 };
    e.perScale.set(r.scale, r.w / (totals.get(r.scale) || 1));
    if (r.scale === 1) e.fires = r.fires ?? 0;
    byLabel.set(r.label, e);
  }
  const scales = [...totals.keys()];
  return [...byLabel.entries()]
    .map(([label, e]) => {
      const vals = scales.map((s) => e.perScale.get(s) ?? 0);
      return { label, central: e.perScale.get(1) ?? 0, low: Math.min(...vals), high: Math.max(...vals), fires: e.fires };
    })
    .sort((a, b) => b.central - a.central);
}

export function confidenceFromRange(low: number, high: number): "high" | "medium" | "low" {
  const width = (high - low) * 100;
  return width <= 10 ? "high" : width <= 25 ? "medium" : "low";
}

/**
 * Approximate area boxes for where weighted fires were. The Strait of Malacca is
 * approximated by a straight line, so these are not province or national boundaries.
 */
const AREA_CASE = `CASE
  WHEN f.lat BETWEEN 1.2 AND 7.0 AND f.lon BETWEEN 99.5 AND 104.6 AND f.lat > 6.0 - (f.lon - 98.0) * 0.8333 THEN 'Peninsular Malaysia and Singapore'
  WHEN f.lat BETWEEN -6.2 AND 6.0 AND f.lon BETWEEN 95.0 AND 106.8 THEN 'Sumatra and nearby islands'
  WHEN f.lat BETWEEN -4.5 AND 7.5 AND f.lon BETWEEN 108.5 AND 119.5 THEN 'Borneo (Kalimantan, Sarawak, Sabah, Brunei)'
  WHEN f.lat BETWEEN -9.0 AND -5.8 AND f.lon BETWEEN 105.0 AND 115.0 THEN 'Java'
  ELSE 'elsewhere' END`;
/** Hotspot grid cell size in degrees (about 28 km at the equator). */
const CELL_DEG = 0.25;

export interface AreaShare {
  area: string;
  central: number;
  low: number;
  high: number;
  fires: number;
}
export interface Hotspot {
  lat: number;
  lon: number;
  fires: number;
  maxFrp: number;
  pct: number;
  firstSeen: number;
  lastSeen: number;
}

/** Rows of [area, scale, n_fires, pct_of_signal] -> per-area central (scale 1) share and range across scales. */
export function areaShares(rows: unknown[][]): AreaShare[] {
  const by = new Map<string, AreaShare>();
  for (const [area, scale, n, pctOf] of rows) {
    const label = String(area);
    const value = num(pctOf);
    const e = by.get(label) ?? { area: label, central: 0, low: Infinity, high: -Infinity, fires: 0 };
    e.low = Math.min(e.low, value);
    e.high = Math.max(e.high, value);
    if (num(scale) === 1) {
      e.central = value;
      e.fires = num(n);
    }
    by.set(label, e);
  }
  return [...by.values()].sort((a, b) => b.central - a.central);
}

export interface Dossier {
  run_id: string;
  town: string;
  evidence: Evidence[];
  summary: {
    concession: Share;
    peat: Share;
    holders: Share[];
    countries: Share[];
    areas: AreaShare[];
    hotspots: Hotspot[];
    confidence: string;
    meanPm25: number | null;
  };
  text: string;
  narrative: string | null;
  narrativeVerdict: Verdict | null;
  file: string;
}

export async function buildDossier(r: BackwardResult, opts: { useLlm?: boolean } = {}): Promise<Dossier> {
  const run = safeId(r.run_id);
  const town = safeText(r.town.town);
  const from = r.centerMs - r.windowHours * HOUR;

  const eRun = await evidence(`SELECT run_id, kind, town, center_utc, params FROM {src}.runs WHERE run_id = '${run}'`);
  // Without a map, zero detections inside concessions or on peat means "not assessed", never 0%.
  // The run row records which maps existed for this run, so "not assessed" lines cite real evidence.
  const runParams = (() => {
    const raw = eRun.rows[0]?.[4];
    try {
      return (typeof raw === "string" ? JSON.parse(raw) : raw) as {
        inputMaps?: { concessionPolygons?: number; peatPolygons?: number; peatSource?: string };
      };
    } catch {
      return {};
    }
  })();
  const concessionMap = (runParams.inputMaps?.concessionPolygons ?? 0) > 0;
  const peatMap = (runParams.inputMaps?.peatPolygons ?? 0) > 0;
  const eAir = await evidence(
    `SELECT kind, COUNT(*) AS hours, AVG(pm25) AS mean_pm25, MAX(pm25) AS max_pm25 FROM {src}.pm25
      WHERE town = '${town}' AND valid_utc > ${ts(from)} AND valid_utc <= ${ts(r.centerMs)} GROUP BY kind ORDER BY kind`,
  );
  const eSplit = await evidence(
    `SELECT a.scale AS wind_speed_scale, SUM(a.weight) AS w_total,
            SUM(CASE WHEN f.concession_id IS NOT NULL THEN a.weight ELSE 0 END) AS w_concession,
            SUM(CASE WHEN f.on_peat THEN a.weight ELSE 0 END) AS w_peat,
            COUNT(*) AS n_fires,
            SUM(CASE WHEN f.concession_id IS NOT NULL THEN 1 ELSE 0 END) AS n_in_concession,
            SUM(CASE WHEN f.on_peat THEN 1 ELSE 0 END) AS n_peat,
            CAST(100 * SUM(CASE WHEN f.concession_id IS NOT NULL THEN a.weight ELSE 0 END) / SUM(a.weight) AS DECIMAL(6,1)) AS pct_concession,
            CAST(100 * SUM(CASE WHEN f.on_peat THEN a.weight ELSE 0 END) / SUM(a.weight) AS DECIMAL(6,1)) AS pct_peat
       FROM {src}.attribution a JOIN {src}.fires f ON a.fire_id = f.fire_id
      WHERE a.run_id = '${run}' GROUP BY a.scale ORDER BY a.scale`,
  );
  // Shares are computed in SQL so every cited percentage is a value in the evidence rows.
  const eArea = await evidence(
    `SELECT area, wind_speed_scale, n_fires, CAST(100 * w / SUM(w) OVER (PARTITION BY wind_speed_scale) AS DECIMAL(6,1)) AS pct_of_signal FROM (
       SELECT ${AREA_CASE} AS area, a.scale AS wind_speed_scale, COUNT(*) AS n_fires, SUM(a.weight) AS w
         FROM {src}.attribution a JOIN {src}.fires f ON a.fire_id = f.fire_id
        WHERE a.run_id = '${run}' GROUP BY ${AREA_CASE}, a.scale) t
      ORDER BY wind_speed_scale, pct_of_signal DESC, area`,
  );
  const cell = (col: string) => `FLOOR(${col} / ${CELL_DEG}) * ${CELL_DEG} + ${CELL_DEG / 2}`;
  const eHot = await evidence(
    `SELECT cell_lat, cell_lon, n_fires, max_frp, CAST(100 * w / total AS DECIMAL(6,1)) AS pct_of_signal, first_seen_epoch, last_seen_epoch FROM (
       SELECT ${cell("f.lat")} AS cell_lat, ${cell("f.lon")} AS cell_lon, COUNT(*) AS n_fires, MAX(f.frp) AS max_frp,
              SUM(a.weight) AS w, SUM(SUM(a.weight)) OVER () AS total,
              MIN(${epoch("f.acq_utc")}) AS first_seen_epoch, MAX(${epoch("f.acq_utc")}) AS last_seen_epoch
         FROM {src}.attribution a JOIN {src}.fires f ON a.fire_id = f.fire_id
        WHERE a.run_id = '${run}' AND a.scale = 1 GROUP BY ${cell("f.lat")}, ${cell("f.lon")}) t
      ORDER BY w DESC, cell_lat, cell_lon LIMIT 5`,
  );
  const eHolders = await evidence(
    `SELECT COALESCE(c.group_name, c.company, c.name, c.concession_id) AS holder, a.scale AS wind_speed_scale, SUM(a.weight) AS w, COUNT(*) AS n_fires
       FROM {src}.attribution a JOIN {src}.fires f ON a.fire_id = f.fire_id
       JOIN {src}.concessions c ON f.concession_id = c.concession_id
      WHERE a.run_id = '${run}' GROUP BY COALESCE(c.group_name, c.company, c.name, c.concession_id), a.scale
      ORDER BY holder, wind_speed_scale`,
  );
  const eCountry = await evidence(
    `SELECT COALESCE(co.parent_country, 'not recorded') AS parent_country, a.scale AS wind_speed_scale, SUM(a.weight) AS w, COUNT(*) AS n_fires
       FROM {src}.attribution a JOIN {src}.fires f ON a.fire_id = f.fire_id
       JOIN {src}.concessions c ON f.concession_id = c.concession_id
       LEFT JOIN {src}.companies co ON co.group_name = c.group_name
      WHERE a.run_id = '${run}' GROUP BY COALESCE(co.parent_country, 'not recorded'), a.scale
      ORDER BY parent_country, wind_speed_scale`,
  );
  const eTop = await evidence(
    `SELECT c.concession_id, c.name, c.company, c.group_name, c.map_source, c.map_date,
            COUNT(*) AS n_fires, SUM(CASE WHEN f.on_peat THEN 1 ELSE 0 END) AS peat_fires, SUM(a.weight) AS w,
            MIN(${epoch("f.acq_utc")}) AS first_seen_epoch, MAX(${epoch("f.acq_utc")}) AS last_seen_epoch
       FROM {src}.attribution a JOIN {src}.fires f ON a.fire_id = f.fire_id
       JOIN {src}.concessions c ON f.concession_id = c.concession_id
      WHERE a.run_id = '${run}' AND a.scale = 1
      GROUP BY c.concession_id, c.name, c.company, c.group_name, c.map_source, c.map_date
      ORDER BY w DESC, c.concession_id LIMIT 8`,
  );
  const topIds = eTop.rows.map((x) => safeId(String(x[0])));
  const eHistory = topIds.length
    ? await evidence(
        `SELECT concession_id, EXTRACT(YEAR FROM acq_utc) AS yr, COUNT(*) AS n_fires FROM {src}.fires
          WHERE concession_id IN (${topIds.map((i) => `'${i}'`).join(",")}) AND acq_utc < ${ts(from - 30 * 24 * HOUR)}
          GROUP BY concession_id, EXTRACT(YEAR FROM acq_utc) ORDER BY concession_id, yr`,
      )
    : null;

  // ---- numbers, computed from the evidence rows only ----
  const totals = new Map<number, number>();
  const conc: { label: string; scale: number; w: number; fires: number }[] = [];
  const peat: typeof conc = [];
  for (const [scale, wTot, wConc, wPeat, , nConc, nPeat] of eSplit.rows) {
    totals.set(num(scale), num(wTot));
    conc.push({ label: "concession", scale: num(scale), w: num(wConc), fires: num(nConc) });
    peat.push({ label: "peat", scale: num(scale), w: num(wPeat), fires: num(nPeat) });
  }
  if (!totals.size) throw new Error(`No fires matched the air arriving at ${r.town.town}. Check fires and wind cover the window.`);
  const concShare = sharesFromRows(conc, totals)[0];
  const peatShare = sharesFromRows(peat, totals)[0];
  const holders = sharesFromRows(eHolders.rows.map(([h, s, w, n]) => ({ label: String(h), scale: num(s), w: num(w), fires: num(n) })), totals);
  const countries = sharesFromRows(eCountry.rows.map(([c, s, w, n]) => ({ label: String(c), scale: num(s), w: num(w), fires: num(n) })), totals);
  const confidence = confidenceFromRange(concShare.low, concShare.high);
  const areas = areaShares(eArea.rows);
  const hotspots: Hotspot[] = eHot.rows.map(([lat, lon, n, frp, p, first, last]) => ({
    lat: num(lat),
    lon: num(lon),
    fires: num(n),
    maxFrp: num(frp),
    pct: num(p),
    firstSeen: num(first),
    lastSeen: num(last),
  }));
  const airModel = eAir.rows.find((x) => x[0] === "observed") ?? eAir.rows.find((x) => x[0] === "model");
  const range = (s: Share) => `${pct(s.central)} (range ${pct(s.low)}-${pct(s.high)})`;
  // Concession and peat percentages as the shares query states them (pct_* columns), so the
  // judge compares numbers instead of dividing weights.
  const stated = (column: number) => {
    const values = eSplit.rows.map((row) => ({ scale: num(row[0]), pct: num(row[column]) }));
    const all = values.map((v) => v.pct);
    return {
      central: values.find((v) => v.scale === 1)?.pct ?? all[0] ?? 0,
      low: Math.min(...all),
      high: Math.max(...all),
    };
  };
  const statedRange = (column: number) => {
    const v = stated(column);
    return `${v.central.toFixed(1)}% (range ${v.low.toFixed(1)}%-${v.high.toFixed(1)}%)`;
  };
  const id = (e: Evidence) => `[${e.evidence_id}]`;

  // ---- the dossier text: every line with a number cites its evidence ----
  const L: string[] = [];
  L.push(`# Smoke source dossier: ${r.town.town}`);
  L.push("");
  L.push(`Window: the ${r.windowHours} hours up to ${localTime(r.centerMs)} ${id(eRun)}.`);
  if (airModel)
    L.push(
      `Air quality: ${airModel[0]} PM2.5 at ${r.town.town} averaged ${num(airModel[2]).toFixed(1)} ug/m3 with a peak of ${num(airModel[3]).toFixed(1)} ug/m3 ${id(eAir)}.`,
    );
  L.push(
    `Method: the air arriving at ${r.town.town} was traced backwards with an ensemble of ${r.members} trajectories, and each satellite fire was weighted by fire radiative power (FRP), a peat emission factor and its closeness to that air in space and time ${id(eRun)}.`,
  );
  L.push("");
  L.push("## Findings");
  if (areas.length)
    L.push(
      `- Where the smoke-relevant fires were (approximate area boxes, not province boundaries): ${areas
        .slice(0, 4)
        .map((a) => `${a.area} ${a.central.toFixed(1)}% of the smoke signal (range ${a.low.toFixed(1)}-${a.high.toFixed(1)}%), ${a.fires} detections`)
        .join("; ")} ${id(eArea)}.`,
    );
  for (const h of hotspots)
    L.push(
      `- Fire hotspot centred at ${h.lat.toFixed(3)}, ${h.lon.toFixed(3)} (${CELL_DEG} degree cell): ${h.pct.toFixed(1)}% of the smoke signal, ${h.fires} detections, peak FRP ${h.maxFrp.toFixed(1)} MW, seen ${fmtUtc(h.firstSeen)} to ${fmtUtc(h.lastSeen)} ${id(eHot)}.`,
    );
  L.push(
    concessionMap
      ? `- Fires inside mapped concessions: ${statedRange(7)} of the smoke signal, from ${concShare.fires} detections ${id(eSplit)}.`
      : `- Fires inside mapped concessions: not assessed, because no concession map is loaded; this is not evidence that the fires were outside concessions ${id(eRun)}.`,
  );
  L.push(
    peatMap
      ? `- Fires on peat: ${statedRange(8)} of the smoke signal, from ${peatShare.fires} detections ${id(eSplit)}.${
          runParams.inputMaps?.peatSource ? ` Peat map used: ${runParams.inputMaps.peatSource} ${id(eRun)}.` : ""
        }`
      : `- Fires on peat: not assessed, because no peat map is loaded; this is not evidence that the fires were off peat ${id(eRun)}.`,
  );
  L.push(
    concessionMap
      ? `- Confidence: ${confidence} by SmokeLedger's rule (high when the concession share varies by 10 percentage points or less across wind speeds, medium up to 25), since pct_concession is ${stated(7).low.toFixed(1)}% to ${stated(7).high.toFixed(1)}% across the wind_speed_scale values, which are the run's ensemble windScales ${id(eSplit)} ${id(eRun)}.`
      : `- Confidence: not assessed, because the concession share cannot be computed without a concession map ${id(eRun)}.`,
  );
  // The calculation itself, stated from the run's recorded PARAMS so it is checked like any finding.
  L.push(
    `- How each share is calculated: a fire's weight is its fire radiative power, multiplied by the peatEmissionFactor ${PARAMS.peatEmissionFactor} if on peat, by exp(-d^2/2 sigma^2) for its distance d from the air path with sigma = ${PARAMS.kernel.sigmaKm0} km + ${PARAMS.kernel.sigmaKmPerHour} km per hour back (fires beyond ${PARAMS.kernel.maxSigmas} sigma do not count), and by 1 - |time gap| / ${PARAMS.kernel.timeTolHours} h (${PARAMS.kernel.peatTimeTolHours} h on peat), summed over every path point that passes it; a share is a group's summed weight divided by all fires' summed weight, and the range repeats this at each of the ensemble windScales ${id(eRun)}.`,
  );
  if (holders.length) {
    L.push("");
    L.push("## Concession holders whose land the smoke-relevant fires were on");
    for (const h of holders.slice(0, 6)) L.push(`- ${h.label}: ${range(h)}, ${h.fires} detections ${id(eHolders)}.`);
  }
  // Without a company-country table every row is "not recorded": nothing to report.
  if (countries.some((c) => c.label !== "not recorded")) {
    L.push("");
    L.push("## By parent-company country");
    for (const c of countries.slice(0, 6)) L.push(`- ${c.label}: ${range(c)} ${id(eCountry)}.`);
  }
  if (eTop.rows.length) {
    L.push("");
    L.push("## Concessions to investigate first");
    for (const [cid, name, company, group, src, mdate, n, pf, , first, last] of eTop.rows)
      L.push(
        `- ${name ?? cid} (${company ?? "company not listed"}, group ${group ?? "not listed"}): ${n} detections, ${pf} on peat, seen ${fmtUtc(first)} to ${fmtUtc(last)}; boundary from ${src}, dated ${mdate} ${id(eTop)}.`,
      );
  }
  if (eHistory && eHistory.rows.length) {
    L.push("");
    L.push("## Earlier fire years on the same concessions");
    for (const [cid, yr, n] of eHistory.rows) L.push(`- ${cid}: ${n} detections in ${num(yr)} ${id(eHistory)}.`);
  }
  L.push("");
  L.push("## What this does and does not show");
  L.push(
    `- The peat factor (${PARAMS.peatEmissionFactor}x) is an uncalibrated assumption that peat smoulders and smokes more than surface fires; fire radiative power stands in for smoke output. Shares are of the modelled smoke signal at the town, not measured PM2.5.`,
  );
  L.push("- A fire inside a concession shows where land burned, not who started it. Treat names here as leads for investigation.");
  L.push("- Concession boundaries come from public compilations and may be outdated; the map source and date are listed with each concession.");
  L.push("- Area names come from latitude/longitude boxes, not province or national boundaries; hotspot positions are grid-cell centres.");
  L.push("- Trajectories are approximate. The range shows how much the result depends on wind speed.");
  L.push("- Every cited query can be re-run with: npm run sl -- verify <evidence id>.");
  const text = L.join("\n");

  const all = [eRun, eAir, eArea, eHot, eSplit, eHolders, eCountry, eTop, ...(eHistory ? [eHistory] : [])];
  const findingsOnly = text.split("## What this does and does not show")[0];
  const det = await judge(findingsOnly, all, { useModel: false });
  if (!det.ok) throw new Error(`Template failed its own citation check: ${det.problems.join("; ")}`);

  // ---- optional Nemotron narrative, which must pass the judge lane ----
  let narrative: string | null = null;
  let narrativeVerdict: Verdict | null = null;
  if (opts.useLlm) {
    let feedback = "";
    // Optional prose: a slow or failed model call drops the narrative, never the cited findings.
    try {
      for (let attempt = 0; attempt < 2 && !narrative; attempt++) {
        const { message } = await chat([
          {
            role: "system",
            content:
              "Write a 120-word plain-language summary of this haze dossier for a Malaysian journalist. " +
              "Use ONLY facts from the dossier. End every sentence that contains a number with the evidence id it came from, " +
              "e.g. [E-0123456789]. Never say or imply a company is guilty or deliberately burned land: say the fires were on its concession.",
          },
          { role: "user", content: text + feedback },
        ]);
        const draft = (message.content ?? "").trim();
        narrativeVerdict = await judge(draft, all);
        if (narrativeVerdict.ok) narrative = draft;
        else feedback = `\n\nYour previous draft was rejected for: ${narrativeVerdict.problems.join("; ")}. Fix these.`;
      }
    } catch (e) {
      narrative = null;
      narrativeVerdict = { ok: false, problems: [`Narrative skipped: ${(e as Error).message.slice(0, 200)}`] };
      recordFailure("nightshift", `dossier narrative: ${(e as Error).message}`);
    }
  }

  const dir = path.join(CONFIG.outboxDir, "dossiers");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${run}.md`);
  const evidenceAppendix = all
    .map((e) => `### ${e.evidence_id}\n- backend: ${e.backend}\n- rows: ${e.row_count}\n- sha256: ${e.sha256}\n\n\`\`\`sql\n${e.sql}\n\`\`\``)
    .join("\n\n");
  fs.writeFileSync(
    file,
    `${narrative ? `> ${narrative.replace(/\n/g, "\n> ")}\n>\n> (Summary written by Nemotron via Nightshift and checked by the judge lane.)\n\n` : ""}${text}\n\n## Evidence\n\n${evidenceAppendix}\n`,
  );

  return {
    run_id: run,
    town: r.town.town,
    evidence: all,
    summary: {
      concession: concShare,
      peat: peatShare,
      holders,
      countries,
      areas,
      hotspots,
      confidence: concessionMap ? confidence : "not assessed",
      meanPm25: airModel ? num(airModel[2]) : null,
    },
    text,
    narrative,
    narrativeVerdict,
    file,
  };
}
