import { test } from "node:test";
import assert from "node:assert/strict";
import { attribute, clusterFires, smokeIndex, type Fire } from "../src/plume.ts";
import { backwardFromTown, ensemble } from "../src/trajectory.ts";
import { uniformField } from "./helpers.ts";
import { HOUR, PARAMS } from "../src/config.ts";

const t0 = Date.UTC(2026, 9, 5, 0);
// Wind blowing from the west (u = +8 m/s): air over the town came from fires to its WEST.
const field = uniformField(8, 0, t0, 120);
const town = { lat: 2, lon: 103 };
const center = t0 + 96 * HOUR;

const fire = (id: string, lat: number, lon: number, hoursBefore: number, extra: Partial<Fire> = {}): Fire => ({
  fire_id: id, lat, lon, tMs: center - hoursBefore * HOUR, frp: 50, on_peat: false, concession_id: null, ...extra,
});

test("upwind fire gets the weight, downwind fire gets none", () => {
  // 8 m/s = 28.8 km/h; 10 h back = 288 km = ~2.6 degrees west
  const fires = [fire("upwind", 2, 100.4, 10), fire("downwind", 2, 105.6, 10)];
  const w = attribute(fires, backwardFromTown([field], town, center, 0));
  assert.ok((w.get("upwind")?.get(1) ?? 0) > 0);
  assert.equal(w.get("downwind"), undefined);
});

test("peat fire weighs more than an identical surface fire", () => {
  const fires = [fire("surface", 2.05, 100.4, 10), fire("peat", 1.95, 100.4, 10, { on_peat: true })];
  const w = attribute(fires, backwardFromTown([field], town, center, 0));
  const ratio = w.get("peat")!.get(1)! / w.get("surface")!.get(1)!;
  // at least the emission factor; a bit more because peat stays "active" longer in time
  assert.ok(ratio >= PARAMS.peatEmissionFactor && ratio < PARAMS.peatEmissionFactor * 1.5, String(ratio));
});

test("a fire seen long before the air passed is excluded", () => {
  // air passes over this spot ~10-12 h before arrival (ensemble speeds vary); the fire was seen 36 h before
  const fires = [fire("stale", 2, 100.4, 36)];
  const w = attribute(fires, backwardFromTown([field], town, center, 0));
  assert.equal(w.size, 0);
});

test("forward smoke index reaches the downwind town, not the upwind one", () => {
  const fires = [fire("a", 2, 100.4, 1), fire("b", 2.05, 100.45, 1)];
  const clusters = clusterFires(fires);
  assert.equal(clusters.length, 1);
  const paths = ensemble([field], { lat: clusters[0].lat, lon: clusters[0].lon, tMs: center }, 24, 1);
  const pc = new Map(paths.map((p) => [p.member, clusters[0].cluster_id]));
  const idx = smokeIndex(paths, pc, clusters, [
    { town: "Down", lat: 2, lon: 103 },
    { town: "Up", lat: 2, lon: 97 },
  ]);
  const peak = (n: string) => Math.max(0, ...(idx.get(n) ?? []).map((h) => h.index));
  assert.ok(peak("Down") > 0.2, String(peak("Down")));
  assert.equal(peak("Up"), 0);
  const first = idx.get("Down")!.find((h) => h.index > 0.05)!;
  const eta = (first.tMs - center) / HOUR;
  assert.ok(eta >= 6 && eta <= 12, `eta ${eta}`); // ~290 km at 28.8 km/h
});
