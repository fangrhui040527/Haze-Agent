// Forward and backward air-parcel trajectories through a WindField.
// Forward  = "where will smoke from this fire go?"   (warning)
// Backward = "where did the air over this town come from?" (attribution)

import { advect } from "./geo.ts";
import { HOUR, PARAMS } from "./config.ts";
import type { WindField } from "./wind.ts";

export interface PathPoint {
  tMs: number;
  lat: number;
  lon: number;
  hoursFromRelease: number;
}

export interface MemberPath {
  member: number;
  scale: number;
  level: string;
  releaseMs: number;
  startLat: number;
  startLon: number;
  central: boolean; // unjittered start point and unscaled wind
  points: PathPoint[]; // hourly, starting with the release point
}

/**
 * Integrate one parcel with a midpoint (RK2) scheme. direction = +1 forward, -1 backward.
 * Stops early if the parcel leaves the wind data. Returns hourly points.
 */
export function integrate(
  field: WindField,
  start: { lat: number; lon: number; tMs: number },
  hours: number,
  direction: 1 | -1,
  scale = 1,
  stepSeconds = PARAMS.stepSeconds,
): PathPoint[] {
  const points: PathPoint[] = [{ tMs: start.tMs, lat: start.lat, lon: start.lon, hoursFromRelease: 0 }];
  let lat = start.lat;
  let lon = start.lon;
  let t = start.tMs;
  const dt = direction * stepSeconds;
  const stepsPerHour = Math.round(3600 / stepSeconds);
  const totalSteps = Math.round(hours * stepsPerHour);
  for (let s = 1; s <= totalSteps; s++) {
    const w1 = field.sample(lat, lon, t);
    if (!w1) break;
    const [midLat, midLon] = advect(lat, lon, w1.u * scale, w1.v * scale, dt / 2);
    const w2 = field.sample(midLat, midLon, t + (dt * 1000) / 2);
    if (!w2) break;
    [lat, lon] = advect(lat, lon, w2.u * scale, w2.v * scale, dt);
    t += dt * 1000;
    if (s % stepsPerHour === 0) {
      points.push({ tMs: t, lat, lon, hoursFromRelease: Math.abs(t - start.tMs) / HOUR });
    }
  }
  return points;
}

/** Ensemble = start-point jitter x wind-speed scaling x available levels. */
export function ensemble(
  fields: WindField[],
  start: { lat: number; lon: number; tMs: number },
  hours: number,
  direction: 1 | -1,
  memberOffset = 0,
): MemberPath[] {
  const out: MemberPath[] = [];
  let member = memberOffset;
  for (const field of fields)
    for (const scale of PARAMS.ensemble.windScales)
      for (const [dLat, dLon] of PARAMS.ensemble.offsetsDeg) {
        const s = { lat: start.lat + dLat, lon: start.lon + dLon, tMs: start.tMs };
        out.push({
          member: member++,
          scale,
          level: field.level,
          releaseMs: start.tMs,
          startLat: s.lat,
          startLon: s.lon,
          central: dLat === 0 && dLon === 0 && scale === 1,
          points: integrate(field, s, hours, direction, scale),
        });
      }
  return out;
}

/** Backward runs from a town, released every few hours over a window ending at centerMs. */
export function backwardFromTown(
  fields: WindField[],
  town: { lat: number; lon: number },
  centerMs: number,
  windowHours: number,
): MemberPath[] {
  const paths: MemberPath[] = [];
  for (let h = 0; h <= windowHours; h += PARAMS.releaseEveryHours) {
    const tMs = centerMs - h * HOUR;
    paths.push(...ensemble(fields, { ...town, tMs }, PARAMS.backHours, -1, paths.length));
  }
  return paths;
}
