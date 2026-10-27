// From hourly PM2.5 to the official-style 24 h API and a school-closure probability.

import { HOUR, PARAMS } from "./config.ts";

export function pm25ToApi(conc: number, bps = PARAMS.api.breakpoints): number {
  if (!Number.isFinite(conc) || conc < 0) return NaN;
  const c = Math.floor(conc * 10) / 10; // breakpoints are defined to 0.1 ug/m3
  for (const [cLo, cHi, iLo, iHi] of bps)
    if (c >= cLo && c <= cHi) return Math.round(((iHi - iLo) / (cHi - cLo)) * (c - cLo) + iLo);
  const last = bps[bps.length - 1];
  return c > last[1] ? last[3] : NaN;
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) *
      Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Probability that the true API exceeds the closure threshold, given a projected API. */
export function closureProbability(api: number, threshold = PARAMS.api.closeThreshold): number {
  if (!Number.isFinite(api)) return NaN;
  const sigma = Math.max(PARAMS.api.sigmaMin, PARAMS.api.sigmaFrac * api);
  return normCdf((api - threshold) / sigma);
}

export interface PmPoint {
  tMs: number;
  pm25: number;
  kind: "observed" | "model";
  issuedMs: number | null;
}

/**
 * Best hourly series as seen at time `asOfMs`:
 *  - hours <= asOf: observed if available, else model
 *  - hours  > asOf: model only, and only forecasts issued at or before asOf
 *    (rows with no issue time are hindsight downloads; allowed only if allowHindsight)
 */
export function bestSeries(points: PmPoint[], asOfMs: number, allowHindsight: boolean): Map<number, number> {
  const series = new Map<number, { v: number; rank: number }>();
  for (const p of points) {
    const hour = Math.round(p.tMs / HOUR) * HOUR;
    let rank: number;
    if (hour <= asOfMs) {
      if (p.kind === "observed") rank = 3;
      else if (p.issuedMs === null || p.issuedMs <= asOfMs) rank = 1;
      else continue;
    } else {
      if (p.kind !== "model") continue;
      if (p.issuedMs === null) {
        if (!allowHindsight) continue;
        rank = 1;
      } else if (p.issuedMs <= asOfMs) rank = 2 + p.issuedMs / 1e15; // latest issue wins
      else continue;
    }
    const cur = series.get(hour);
    if (!cur || rank > cur.rank) series.set(hour, { v: p.pm25, rank });
  }
  return new Map([...series].map(([h, x]) => [h, x.v]));
}

export interface ProjectionHour {
  tMs: number;
  pm25_24h: number;
  api: number;
  p_close: number;
}

/** Rolling 24 h mean -> API -> closure probability, hourly from asOf to asOf + hoursAhead. */
export function project(series: Map<number, number>, asOfMs: number, hoursAhead = 72): ProjectionHour[] {
  const out: ProjectionHour[] = [];
  const start = Math.round(asOfMs / HOUR) * HOUR;
  for (let h = 0; h <= hoursAhead; h++) {
    const t = start + h * HOUR;
    const window: number[] = [];
    for (let k = 0; k < 24; k++) {
      const v = series.get(t - k * HOUR);
      if (v !== undefined && Number.isFinite(v)) window.push(v);
    }
    if (window.length < 18) continue; // not enough data for a fair 24 h mean
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const api = pm25ToApi(mean);
    out.push({ tMs: t, pm25_24h: mean, api, p_close: closureProbability(api) });
  }
  return out;
}

/** Schools decide in the morning: probability at the next few 07:00 local times. */
export function morningDecisions(proj: ProjectionHour[], localOffsetHours = PARAMS.localUtcOffsetHours) {
  return proj.filter((p) => new Date(p.tMs + localOffsetHours * HOUR).getUTCHours() === 7);
}
