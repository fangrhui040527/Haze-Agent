// Orchestrates the physics: read wind + fires from the store, run trajectories,
// write runs / points / attribution / projections back so Zetaris can query them.

import fs from "node:fs";
import path from "node:path";
import { CONFIG, HOUR, PARAMS } from "./config.ts";
import { db, insertMany } from "./db.ts";
import { haversineKm } from "./geo.ts";
import { attribute, clusterFires, smokeIndex, type Cluster, type Fire, type SmokeHour } from "./plume.ts";
import { backwardFromTown, ensemble, type MemberPath } from "./trajectory.ts";
import { bestSeries, project, type PmPoint, type ProjectionHour } from "./closure.ts";
import { WindField, type WindSample } from "./wind.ts";

export interface Town {
  town: string;
  district: string;
  state: string;
  lat: number;
  lon: number;
}

const iso = (ms: number) => new Date(ms).toISOString();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const stamp = (ms: number) => iso(ms).slice(0, 13).replace(/[-:T]/g, "");

export async function getTowns(): Promise<Town[]> {
  const r = await db().query("SELECT town, district, state, lat, lon FROM towns ORDER BY town");
  return r.rows;
}

export async function getTown(name: string): Promise<Town> {
  const r = await db().query("SELECT town, district, state, lat, lon FROM towns WHERE lower(town) = lower($1)", [name]);
  if (!r.rows.length) throw new Error(`Unknown town '${name}'. Run: npm run sl -- load towns`);
  return r.rows[0];
}

export async function loadWindFields(fromMs: number, toMs: number): Promise<WindField[]> {
  const r = await db().query(
    `SELECT level, lat, lon, (extract(epoch FROM valid_utc) * 1000)::bigint AS t, u, v
       FROM wind WHERE valid_utc BETWEEN $1 AND $2`,
    [iso(fromMs), iso(toMs)],
  );
  const byLevel = new Map<string, WindSample[]>();
  for (const row of r.rows) {
    const list = byLevel.get(row.level) ?? [];
    list.push({ lat: Number(row.lat), lon: Number(row.lon), tMs: Number(row.t), u: Number(row.u), v: Number(row.v) });
    byLevel.set(row.level, list);
  }
  const fields: WindField[] = [];
  for (const level of ["850hPa", "10m"]) {
    const s = byLevel.get(level);
    if (s && s.length) fields.push(new WindField(s, level));
  }
  if (!fields.length) throw new Error(`No wind data between ${iso(fromMs)} and ${iso(toMs)}. Load Open-Meteo wind first.`);
  return fields;
}

export async function loadFireRows(fromMs: number, toMs: number): Promise<Fire[]> {
  const r = await db().query(
    `SELECT fire_id, lat, lon, (extract(epoch FROM acq_utc) * 1000)::bigint AS t, frp, on_peat, concession_id
       FROM fires WHERE acq_utc BETWEEN $1 AND $2`,
    [iso(fromMs), iso(toMs)],
  );
  return r.rows.map((x) => ({
    fire_id: x.fire_id,
    lat: Number(x.lat),
    lon: Number(x.lon),
    tMs: Number(x.t),
    frp: Number(x.frp),
    on_peat: x.on_peat,
    concession_id: x.concession_id,
  }));
}

/** Map polygons available to this run; 0 means the share cannot be assessed, not that it is zero. */
async function inputMaps(): Promise<{ concessionPolygons: number; peatPolygons: number }> {
  const c = await db().query("SELECT COUNT(*) AS n FROM concessions");
  const peatFile = path.join(CONFIG.geoDir, "peat.geojson");
  const peat = fs.existsSync(peatFile) ? (JSON.parse(fs.readFileSync(peatFile, "utf8")) as { features?: unknown[] }).features?.length ?? 0 : 0;
  return { concessionPolygons: Number(c.rows[0]?.n ?? 0), peatPolygons: peat };
}

async function saveRun(runId: string, kind: string, town: string | null, centerMs: number, params: object) {
  for (const t of ["runs", "trajectory_points", "attribution", "projections"])
    await db().query(`DELETE FROM ${t} WHERE run_id = $1`, [runId]);
  await insertMany("runs", ["run_id", "kind", "town", "center_utc", "params"], [
    [runId, kind, town, iso(centerMs), JSON.stringify(params)],
  ]);
}

async function savePoints(runId: string, paths: MemberPath[]) {
  const rows: unknown[][] = [];
  for (const p of paths)
    if (p.central) for (const pt of p.points) rows.push([runId, p.member, p.scale, p.level, iso(p.releaseMs), iso(pt.tMs), pt.lat, pt.lon]);
  await insertMany("trajectory_points", ["run_id", "member", "scale", "level", "release_utc", "step_utc", "lat", "lon"], rows);
}

// ---------------- Backward: where did this town's air come from? ----------------

export interface BackwardResult {
  run_id: string;
  town: Town;
  centerMs: number;
  windowHours: number;
  members: number;
  firesConsidered: number;
  firesWithWeight: number;
}

export async function runBackward(townName: string, centerMs: number, windowHours = 24): Promise<BackwardResult> {
  const town = await getTown(townName);
  const fromMs = centerMs - (windowHours + PARAMS.backHours + 1) * HOUR;
  const fields = await loadWindFields(fromMs, centerMs + HOUR);
  const fires = await loadFireRows(fromMs - PARAMS.kernel.peatTimeTolHours * HOUR, centerMs);
  const paths = backwardFromTown(fields, town, centerMs, windowHours);
  const weights = attribute(fires, paths);

  const runId = `bw-${slug(town.town)}-${stamp(centerMs)}`;
  await saveRun(runId, "backward", town.town, centerMs, {
    windowHours,
    members: paths.length,
    backHours: PARAMS.backHours,
    levels: fields.map((f) => f.level),
    // Recorded so cited run evidence shows the weighting and which maps existed for this run.
    fireWeighting: "fire radiative power (FRP) x peat emission factor x space-time kernel",
    inputMaps: await inputMaps(),
    PARAMS,
  });
  await savePoints(runId, paths);
  const rows: unknown[][] = [];
  for (const [fireId, byScale] of weights) for (const [scale, w] of byScale) rows.push([runId, fireId, scale, w]);
  await insertMany("attribution", ["run_id", "fire_id", "scale", "weight"], rows);
  return {
    run_id: runId,
    town,
    centerMs,
    windowHours,
    members: paths.length,
    firesConsidered: fires.length,
    firesWithWeight: weights.size,
  };
}

// ---------------- Forward: where will today's smoke go? ----------------

export interface Reach {
  town: string;
  etaHours: number;
  minKm: number;
}

export interface ForwardResult {
  run_id: string;
  nowMs: number;
  clusters: Cluster[];
  smoke: Map<string, SmokeHour[]>;
  reach: Map<string, Reach[]>; // cluster_id -> towns its central plume passes near
  projections: Map<string, ProjectionHour[]>;
  hindsight: boolean;
}

/** Central plume from each cluster: which towns does it pass within radiusKm of, and when? */
export function plumeReach(paths: MemberPath[], pathCluster: Map<number, string>, towns: Town[], radiusKm = 100) {
  const reach = new Map<string, Reach[]>();
  for (const p of paths) {
    if (!p.central) continue;
    const cid = pathCluster.get(p.member)!;
    const list = reach.get(cid) ?? [];
    for (const t of towns) {
      let best: Reach | null = null;
      for (const pt of p.points) {
        const d = haversineKm(pt.lat, pt.lon, t.lat, t.lon);
        if (d <= radiusKm && (!best || d < best.minKm)) best = { town: t.town, etaHours: Math.round(pt.hoursFromRelease), minKm: Math.round(d) };
      }
      if (best && !list.some((r) => r.town === best!.town && r.etaHours <= best!.etaHours)) list.push(best);
    }
    reach.set(cid, list);
  }
  return reach;
}

export async function runForward(
  nowMs: number,
  opts: { allowHindsight?: boolean; skipTrajectories?: boolean; runSuffix?: string } = {},
): Promise<ForwardResult> {
  const towns = await getTowns();
  const fires = await loadFireRows(nowMs - PARAMS.forward.activeWindowHours * HOUR, nowMs);
  const clusters = clusterFires(fires);
  const runId = `fw-${stamp(nowMs)}${opts.allowHindsight ? "-h" : ""}${opts.runSuffix ? `-${opts.runSuffix}` : ""}`;
  await saveRun(runId, "forward", null, nowMs, { PARAMS, clusters: clusters.length });

  let smoke = new Map<string, SmokeHour[]>();
  let reach = new Map<string, Reach[]>();
  if (clusters.length && !opts.skipTrajectories) {
    const fields = await loadWindFields(nowMs - HOUR, nowMs + (PARAMS.forwardHours + 1) * HOUR);
    const paths: MemberPath[] = [];
    const pathCluster = new Map<number, string>();
    for (const c of clusters) {
      const ens = ensemble(fields, { lat: c.lat, lon: c.lon, tMs: nowMs }, PARAMS.forwardHours, 1, paths.length);
      for (const p of ens) pathCluster.set(p.member, c.cluster_id);
      paths.push(...ens);
    }
    smoke = smokeIndex(paths, pathCluster, clusters, towns);
    reach = plumeReach(paths, pathCluster, towns);
    await savePoints(runId, paths);
  }

  // PM2.5 projection per town (rolling 24 h -> API -> closure probability)
  const pm = await db().query(
    `SELECT town, (extract(epoch FROM valid_utc)*1000)::bigint AS t, pm25, kind,
            (extract(epoch FROM issued_utc)*1000)::bigint AS issued
       FROM pm25 WHERE valid_utc BETWEEN $1 AND $2`,
    [iso(nowMs - 30 * HOUR), iso(nowMs + (PARAMS.forwardHours + 1) * HOUR)],
  );
  const byTown = new Map<string, PmPoint[]>();
  for (const r of pm.rows) {
    const list = byTown.get(r.town) ?? [];
    list.push({ tMs: Number(r.t), pm25: Number(r.pm25), kind: r.kind, issuedMs: r.issued === null ? null : Number(r.issued) });
    byTown.set(r.town, list);
  }
  const projections = new Map<string, ProjectionHour[]>();
  const rows: unknown[][] = [];
  for (const t of towns) {
    const series = bestSeries(byTown.get(t.town) ?? [], nowMs, !!opts.allowHindsight);
    const proj = project(series, nowMs, PARAMS.forwardHours);
    projections.set(t.town, proj);
    const smokeByHour = new Map((smoke.get(t.town) ?? []).map((h) => [h.tMs, h.index]));
    for (const p of proj)
      rows.push([runId, t.town, iso(p.tMs), series.get(p.tMs) ?? null, p.pm25_24h, p.api, p.p_close, smokeByHour.get(p.tMs) ?? 0]);
  }
  await insertMany("projections", ["run_id", "town", "valid_utc", "pm25_hour", "pm25_24h", "api", "p_close", "smoke_index"], rows);
  return { run_id: runId, nowMs, clusters, smoke, reach, projections, hindsight: !!opts.allowHindsight };
}
