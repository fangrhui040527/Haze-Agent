import { WindField, type WindSample } from "../src/wind.ts";
import { HOUR } from "../src/config.ts";

/** Uniform wind (u, v m/s) on a grid covering lat -10..10, lon 90..125 for `hours` hours from t0. */
export function uniformField(u: number, v: number, t0: number, hours: number, level = "850hPa"): WindField {
  const s: WindSample[] = [];
  for (let h = 0; h <= hours; h++)
    for (let lat = -10; lat <= 10; lat += 1)
      for (let lon = 90; lon <= 125; lon += 1) s.push({ lat, lon, tMs: t0 + h * HOUR, u, v });
  return new WindField(s, level);
}
