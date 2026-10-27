import { test } from "node:test";
import assert from "node:assert/strict";
import { bestSeries, closureProbability, morningDecisions, pm25ToApi, project, type PmPoint } from "../src/closure.ts";
import { HOUR } from "../src/config.ts";

test("PM2.5 to API at breakpoints", () => {
  assert.equal(pm25ToApi(0), 0);
  assert.equal(pm25ToApi(12), 50);
  assert.equal(pm25ToApi(35.4), 100);
  assert.equal(pm25ToApi(150.4), 200);
  assert.equal(pm25ToApi(150.5), 201);
  assert.equal(pm25ToApi(250.4), 300);
});

test("closure probability is 50% at the threshold and rises with API", () => {
  assert.ok(Math.abs(closureProbability(200) - 0.5) < 1e-6);
  assert.ok(closureProbability(260) > 0.8);
  assert.ok(closureProbability(300) > 0.9);
  assert.ok(closureProbability(120) < 0.01);
});

const t0 = Date.UTC(2026, 9, 6, 0);
const pts = (from: number, n: number, f: (i: number) => number, kind: PmPoint["kind"], issuedMs: number | null): PmPoint[] =>
  Array.from({ length: n }, (_, i) => ({ tMs: from + i * HOUR, pm25: f(i), kind, issuedMs }));

test("backtest honesty: future hours use only forecasts issued before 'now'", () => {
  const obs = pts(t0 - 24 * HOUR, 25, () => 100, "observed", null);
  const early = pts(t0, 48, () => 200, "model", t0 - 6 * HOUR); // issued before now
  const late = pts(t0, 48, () => 400, "model", t0 + 6 * HOUR); // issued after now: must be ignored
  const hindsight = pts(t0, 48, () => 999, "model", null);
  const s = bestSeries([...obs, ...early, ...late, ...hindsight], t0, false);
  assert.equal(s.get(t0 + 10 * HOUR), 200);
  const h = bestSeries([...obs, ...hindsight], t0, true);
  assert.equal(h.get(t0 + 10 * HOUR), 999);
  const none = bestSeries([...obs, ...hindsight], t0, false);
  assert.equal(none.get(t0 + 10 * HOUR), undefined);
});

test("rolling 24 h mean, API and morning decisions", () => {
  const series = new Map<number, number>();
  for (let i = -24; i <= 72; i++) series.set(t0 + i * HOUR, i < 12 ? 60 : 200);
  const proj = project(series, t0, 72);
  const at = (h: number) => proj.find((p) => p.tMs === t0 + h * HOUR)!;
  assert.equal(at(0).pm25_24h, 60);
  assert.equal(at(40).pm25_24h, 200);
  assert.ok(at(40).api > 200 && at(40).p_close > 0.8);
  const mornings = morningDecisions(proj);
  assert.ok(mornings.length >= 3);
  for (const m of mornings) assert.equal(new Date(m.tMs + 8 * HOUR).getUTCHours(), 7);
});
