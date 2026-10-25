// Helpers shared by the role agents.
import crypto from "node:crypto";
import { HOUR, PARAMS } from "../config.ts";
import { db } from "../db.ts";
import type { Evidence } from "../query.ts";
import type { EvidenceRef } from "../orchestration/types.ts";

export const iso = (ms: number) => new Date(ms).toISOString();
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const shortHash = (s: string, n = 8) => crypto.createHash("sha256").update(s).digest("hex").slice(0, n);
export const tsSql = (ms: number) => `CAST('${iso(ms)}' AS TIMESTAMP)`;

/** "08:00" in Malaysia time. */
export function localHHMM(ms: number): string {
  const d = new Date(ms + PARAMS.localUtcOffsetHours * HOUR);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
export const hourLabel = (ms: number) => `${localHHMM(ms)}-${localHHMM(ms + HOUR)}`;

/** Merge a sorted list of hour starts into readable local intervals, e.g. "09:00-12:00 MYT". */
export function intervals(hours: number[]): string[] {
  const out: string[] = [];
  let start: number | null = null;
  let prev: number | null = null;
  for (const h of [...hours].sort((a, b) => a - b)) {
    if (start === null) start = h;
    else if (h !== prev! + HOUR) {
      out.push(`${localHHMM(start)}-${localHHMM(prev! + HOUR)} MYT (${iso(start).slice(0, 10)})`);
      start = h;
    }
    prev = h;
  }
  if (start !== null) out.push(`${localHHMM(start)}-${localHHMM(prev! + HOUR)} MYT (${iso(start).slice(0, 10)})`);
  return out;
}

export function hoursIn(startMs: number, endMs: number): number[] {
  const out: number[] = [];
  for (let t = Math.ceil(startMs / HOUR) * HOUR; t < endMs; t += HOUR) out.push(t);
  return out;
}

export const ref = (e: Evidence, producedBy: string): EvidenceRef => ({
  evidence_id: e.evidence_id,
  sha256: e.sha256,
  row_count: e.row_count,
  backend: e.backend,
  sql: e.sql,
  produced_by: producedBy,
});

export function districtIdFor(t: { state: string; district: string }): string {
  return `my-${slug(t.state)}-${slug(t.district)}`;
}

export async function resolveDistrict(input: { district_id?: string; town?: string }) {
  const r = await db().query("SELECT town, district, state, lat, lon FROM towns");
  const towns = r.rows.map((t) => ({ ...t, lat: Number(t.lat), lon: Number(t.lon), district_id: districtIdFor(t) }));
  const hit = input.district_id
    ? towns.find((t) => t.district_id === input.district_id)
    : towns.find((t) => t.town.toLowerCase() === String(input.town ?? "").toLowerCase());
  return { hit, supported: towns.map((t) => t.district_id) };
}

/** Newest ingestion time across observation tables: the evidence watermark. */
export async function watermark(): Promise<string> {
  const r = await db().query(
    "SELECT GREATEST((SELECT max(ingested_utc) FROM fires), (SELECT max(ingested_utc) FROM pm25)) AS w",
  );
  const w = r.rows[0]?.w;
  return w ? new Date(w).toISOString() : new Date(0).toISOString();
}

/** Evidence relevant to a decision that arrived after `sinceIso` (heartbeat + freshness gate). */
export async function newerRelevantEvidence(town: string, sinceIso: string, fromMs: number, toMs: number, operation?: string) {
  const pm = await db().query(
    "SELECT count(*) AS n FROM pm25 WHERE town = $1 AND ingested_utc > $2 AND valid_utc BETWEEN $3 AND $4",
    [town, sinceIso, iso(fromMs - 24 * HOUR), iso(toMs)],
  );
  // Fires change a source trace; outlooks and crew plans depend on the PM2.5 series.
  if (operation && operation !== "trace_sources") return { pm25_rows: Number(pm.rows[0].n), fire_rows: 0 };
  const fi = await db().query("SELECT count(*) AS n FROM fires WHERE ingested_utc > $1 AND acq_utc BETWEEN $2 AND $3", [
    sinceIso,
    iso(fromMs - 72 * HOUR),
    iso(toMs),
  ]);
  return { pm25_rows: Number(pm.rows[0].n), fire_rows: Number(fi.rows[0].n) };
}

export class DeadlineError extends Error {}
