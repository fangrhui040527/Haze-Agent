import type { Location } from '../../contracts/haze-evidence.js';

/** Great-circle distance in kilometres. */
export function distanceKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function nearestLocation(
  point: { lat: number; lon: number },
  candidates: readonly Location[],
): { location: Location; km: number } | null {
  let best: { location: Location; km: number } | null = null;
  for (const location of candidates) {
    const km = distanceKm(point, location);
    if (!best || km < best.km) best = { location, km };
  }
  return best;
}
