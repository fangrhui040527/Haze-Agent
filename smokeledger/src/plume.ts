// Turning trajectories into numbers.
//  - attribute(): backward paths from a town -> how much each fire plausibly contributed
//  - clusterFires() + smokeIndex(): forward paths from fires -> when smoke reaches each town

import { haversineKm } from "./geo.ts";
import { HOUR, PARAMS } from "./config.ts";
import type { MemberPath } from "./trajectory.ts";

export interface Fire {
  fire_id: string;
  lat: number;
  lon: number;
  tMs: number;
  frp: number;
  on_peat: boolean;
  concession_id: string | null;
}

export const emissionOf = (f: Pick<Fire, "frp" | "on_peat">): number =>
  Math.max(0, f.frp) * (f.on_peat ? PARAMS.peatEmissionFactor : 1);

export const sigmaKm = (hoursFromRelease: number): number =>
  PARAMS.kernel.sigmaKm0 + PARAMS.kernel.sigmaKmPerHour * hoursFromRelease;

const CELL = 0.5;
function gridIndex<T extends { lat: number; lon: number }>(items: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = `${Math.floor(it.lon / CELL)}:${Math.floor(it.lat / CELL)}`;
    const list = m.get(k);
    if (list) list.push(it);
    else m.set(k, [it]);
  }
  return m;
}

function* near<T>(index: Map<string, T[]>, lat: number, lon: number, radiusKm: number): Generator<T> {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  for (let ix = Math.floor((lon - dLon) / CELL); ix <= Math.floor((lon + dLon) / CELL); ix++)
    for (let iy = Math.floor((lat - dLat) / CELL); iy <= Math.floor((lat + dLat) / CELL); iy++) {
      const list = index.get(`${ix}:${iy}`);
      if (list) yield* list;
    }
}

/**
 * Backward attribution. For every point on every backward path, fires near that
 * point (Gaussian in distance, widening with travel time) and burning at about that
 * time (triangular in time) receive weight proportional to their emission.
 * Returns fire_id -> (wind scale -> weight), averaged over the members of each scale.
 */
/** How one fire earned its weight at the central wind speed: its strongest contact with the air. */
export interface FireExplanation {
  contacts: number;
  weight: number;
  frp: number;
  peatFactor: number;
  best: { distanceKm: number; sigmaKm: number; gapHours: number; windowHours: number; spaceFactor: number; timeFactor: number; hoursBack: number };
}

/**
 * weight(fire) = sum over air-path points near it of
 *   FRP x peat factor x exp(-d^2 / 2 sigma^2) x (1 - |dt| / window) / paths at that wind speed,
 * with sigma = sigmaKm0 + sigmaKmPerHour x hours back, d <= maxSigmas x sigma and |dt| <= window.
 * `explain` (optional) receives each fire's central-wind-speed breakdown.
 */
export function attribute(fires: Fire[], paths: MemberPath[], explain?: Map<string, FireExplanation>): Map<string, Map<number, number>> {
  const idx = gridIndex(fires);
  const membersPerScale = new Map<number, number>();
  for (const p of paths) membersPerScale.set(p.scale, (membersPerScale.get(p.scale) ?? 0) + 1);
  const out = new Map<string, Map<number, number>>();
  const { maxSigmas, timeTolHours, peatTimeTolHours } = PARAMS.kernel;

  for (const path of paths) {
    const norm = 1 / (membersPerScale.get(path.scale) ?? 1);
    for (const pt of path.points) {
      const sigma = sigmaKm(pt.hoursFromRelease);
      for (const f of near(idx, pt.lat, pt.lon, maxSigmas * sigma)) {
        const tolMs = (f.on_peat ? peatTimeTolHours : timeTolHours) * HOUR;
        const dt = Math.abs(f.tMs - pt.tMs);
        if (dt > tolMs) continue;
        const d = haversineKm(pt.lat, pt.lon, f.lat, f.lon);
        if (d > maxSigmas * sigma) continue;
        const space = Math.exp(-(d * d) / (2 * sigma * sigma));
        const time = 1 - dt / tolMs;
        const w = emissionOf(f) * space * time * norm;
        if (w <= 0) continue;
        if (explain && path.scale === 1) {
          const e = explain.get(f.fire_id) ?? {
            contacts: 0,
            weight: 0,
            frp: f.frp,
            peatFactor: f.on_peat ? PARAMS.peatEmissionFactor : 1,
            best: { distanceKm: 0, sigmaKm: 0, gapHours: 0, windowHours: 0, spaceFactor: 0, timeFactor: 0, hoursBack: 0 },
          };
          e.contacts++;
          e.weight += w;
          if (space * time > e.best.spaceFactor * e.best.timeFactor)
            e.best = { distanceKm: d, sigmaKm: sigma, gapHours: dt / HOUR, windowHours: tolMs / HOUR, spaceFactor: space, timeFactor: time, hoursBack: pt.hoursFromRelease };
          explain.set(f.fire_id, e);
        }
        let byScale = out.get(f.fire_id);
        if (!byScale) out.set(f.fire_id, (byScale = new Map()));
        byScale.set(path.scale, (byScale.get(path.scale) ?? 0) + w);
      }
    }
  }
  return out;
}

// ---------------- Forward ----------------

export interface Cluster {
  cluster_id: string;
  lat: number;
  lon: number;
  tMs: number; // latest detection in the cluster
  emission: number;
  fire_ids: string[];
  concession_ids: string[];
}

/** Group active fires into grid cells so we run a manageable number of forward trajectories. */
export function clusterFires(fires: Fire[], cellDeg = PARAMS.forward.clusterCellDeg): Cluster[] {
  const cells = new Map<string, Fire[]>();
  for (const f of fires) {
    const k = `${Math.floor(f.lat / cellDeg)}:${Math.floor(f.lon / cellDeg)}`;
    const list = cells.get(k);
    if (list) list.push(f);
    else cells.set(k, [f]);
  }
  const clusters: Cluster[] = [];
  for (const [k, list] of cells) {
    const e = list.map(emissionOf);
    const total = e.reduce((a, b) => a + b, 0);
    if (total <= 0) continue;
    clusters.push({
      cluster_id: `c${k.replace(":", "_").replace(/-/g, "m")}`,
      lat: list.reduce((a, f, i) => a + f.lat * e[i], 0) / total,
      lon: list.reduce((a, f, i) => a + f.lon * e[i], 0) / total,
      tMs: Math.max(...list.map((f) => f.tMs)),
      emission: total,
      fire_ids: list.map((f) => f.fire_id),
      concession_ids: [...new Set(list.map((f) => f.concession_id).filter((c): c is string => !!c))],
    });
  }
  return clusters.sort((a, b) => b.emission - a.emission).slice(0, PARAMS.forward.maxClusters);
}

export interface SmokeHour {
  tMs: number;
  index: number; // share of total active emission whose plume passes near the town (0..1)
  byCluster: Map<string, number>;
}

/**
 * Forward smoke index per town and hour. Paths must carry their cluster id in pathCluster.
 */
export function smokeIndex(
  paths: MemberPath[],
  pathCluster: Map<number, string>,
  clusters: Cluster[],
  towns: { town: string; lat: number; lon: number }[],
): Map<string, SmokeHour[]> {
  const byId = new Map(clusters.map((c) => [c.cluster_id, c]));
  const totalEmission = clusters.reduce((a, c) => a + c.emission, 0) || 1;
  const membersPerCluster = new Map<string, number>();
  for (const p of paths) {
    const cid = pathCluster.get(p.member)!;
    membersPerCluster.set(cid, (membersPerCluster.get(cid) ?? 0) + 1);
  }
  const result = new Map<string, Map<number, SmokeHour>>();
  for (const t of towns) result.set(t.town, new Map());

  for (const path of paths) {
    const cid = pathCluster.get(path.member)!;
    const c = byId.get(cid)!;
    const norm = c.emission / totalEmission / (membersPerCluster.get(cid) ?? 1);
    for (const pt of path.points) {
      if (pt.hoursFromRelease === 0) continue;
      const sigma = sigmaKm(pt.hoursFromRelease);
      const hourMs = Math.round(pt.tMs / HOUR) * HOUR;
      for (const t of towns) {
        const d = haversineKm(pt.lat, pt.lon, t.lat, t.lon);
        if (d > PARAMS.kernel.maxSigmas * sigma) continue;
        const w = norm * Math.exp(-(d * d) / (2 * sigma * sigma));
        const hours = result.get(t.town)!;
        let h = hours.get(hourMs);
        if (!h) hours.set(hourMs, (h = { tMs: hourMs, index: 0, byCluster: new Map() }));
        h.index += w;
        h.byCluster.set(cid, (h.byCluster.get(cid) ?? 0) + w);
      }
    }
  }
  const out = new Map<string, SmokeHour[]>();
  for (const [town, hours] of result) out.set(town, [...hours.values()].sort((a, b) => a.tMs - b.tMs));
  return out;
}
