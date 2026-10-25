import { test } from "node:test";
import assert from "node:assert/strict";
import { integrate, ensemble } from "../src/trajectory.ts";
import { uniformField } from "./helpers.ts";
import { haversineKm } from "../src/geo.ts";
import { HOUR } from "../src/config.ts";

const t0 = Date.UTC(2026, 9, 5, 0);

test("forward: 10 m/s eastward for 24 h moves ~864 km east", () => {
  const f = uniformField(10, 0, t0, 48);
  const pts = integrate(f, { lat: 0, lon: 100, tMs: t0 }, 24, 1);
  const end = pts[pts.length - 1];
  assert.equal(pts.length, 25);
  assert.ok(Math.abs(haversineKm(0, 100, end.lat, end.lon) - 864) < 5);
  assert.ok(end.lon > 107.7 && end.lon < 107.9);
});

test("backward retraces forward", () => {
  const f = uniformField(6, 4, t0, 48);
  const fwd = integrate(f, { lat: 1, lon: 100, tMs: t0 }, 12, 1);
  const end = fwd[fwd.length - 1];
  const back = integrate(f, { lat: end.lat, lon: end.lon, tMs: end.tMs }, 12, -1);
  const start = back[back.length - 1];
  assert.ok(haversineKm(1, 100, start.lat, start.lon) < 1);
  assert.equal(start.tMs, t0);
});

test("integration stops when the parcel leaves the data", () => {
  const f = uniformField(10, 0, t0, 6);
  const pts = integrate(f, { lat: 0, lon: 100, tMs: t0 }, 24, 1);
  assert.ok(pts.length <= 7, `got ${pts.length}`);
});

test("ensemble = offsets x scales x levels, one central member per level", () => {
  const a = uniformField(5, 0, t0, 24, "850hPa");
  const b = uniformField(5, 0, t0, 24, "10m");
  const ens = ensemble([a, b], { lat: 0, lon: 100, tMs: t0 + 12 * HOUR }, 6, -1);
  assert.equal(ens.length, 2 * 3 * 5);
  assert.equal(ens.filter((m) => m.central).length, 2);
});
