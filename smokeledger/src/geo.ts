// Small, dependency-free geometry helpers.

const EARTH_RADIUS_KM = 6371.0088;
const M_PER_DEG_LAT = 111_320;

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Meteorological convention: direction is where the wind blows FROM, degrees clockwise from north. */
export function windToUV(speedMs: number, dirFromDeg: number): { u: number; v: number } {
  const rad = (dirFromDeg * Math.PI) / 180;
  return { u: -speedMs * Math.sin(rad), v: -speedMs * Math.cos(rad) };
}

/** Move a point by a velocity (m/s) for dtSec seconds (negative dt moves backwards). */
export function advect(lat: number, lon: number, u: number, v: number, dtSec: number): [number, number] {
  const newLat = lat + (v * dtSec) / M_PER_DEG_LAT;
  const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const newLon = lon + (u * dtSec) / (M_PER_DEG_LAT * cosLat);
  return [newLat, newLon];
}

// ---- Polygons (GeoJSON order: [lon, lat]) ----
export type Position = [number, number];
export type Ring = Position[];
export type PolygonCoords = Ring[];
export type Geometry =
  | { type: "Polygon"; coordinates: PolygonCoords }
  | { type: "MultiPolygon"; coordinates: PolygonCoords[] };

export interface BBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygonCoords(lon: number, lat: number, poly: PolygonCoords): boolean {
  if (!poly.length || !pointInRing(lon, lat, poly[0])) return false;
  for (let h = 1; h < poly.length; h++) if (pointInRing(lon, lat, poly[h])) return false;
  return true;
}

export function pointInGeometry(lon: number, lat: number, geom: Geometry): boolean {
  if (geom.type === "Polygon") return pointInPolygonCoords(lon, lat, geom.coordinates);
  return geom.coordinates.some((p) => pointInPolygonCoords(lon, lat, p));
}

export function bboxOf(geom: Geometry): BBox {
  const b: BBox = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys)
    for (const [x, y] of poly[0] ?? []) {
      if (x < b.minLon) b.minLon = x;
      if (x > b.maxLon) b.maxLon = x;
      if (y < b.minLat) b.minLat = y;
      if (y > b.maxLat) b.maxLat = y;
    }
  return b;
}

/** Grid-bucketed polygon lookup so point-in-polygon stays fast on big maps. */
export class PolygonIndex<T> {
  private cells = new Map<string, number[]>();
  private items: { geom: Geometry; bbox: BBox; props: T }[] = [];

  constructor(private cellDeg = 0.5) {}

  private key(ix: number, iy: number): string {
    return `${ix}:${iy}`;
  }

  add(geom: Geometry, props: T): void {
    const bbox = bboxOf(geom);
    if (!Number.isFinite(bbox.minLon)) return;
    const id = this.items.push({ geom, bbox, props }) - 1;
    const x0 = Math.floor(bbox.minLon / this.cellDeg);
    const x1 = Math.floor(bbox.maxLon / this.cellDeg);
    const y0 = Math.floor(bbox.minLat / this.cellDeg);
    const y1 = Math.floor(bbox.maxLat / this.cellDeg);
    for (let ix = x0; ix <= x1; ix++)
      for (let iy = y0; iy <= y1; iy++) {
        const k = this.key(ix, iy);
        const list = this.cells.get(k);
        if (list) list.push(id);
        else this.cells.set(k, [id]);
      }
  }

  get size(): number {
    return this.items.length;
  }

  /** Properties of the first polygon containing the point, or null. */
  find(lon: number, lat: number): T | null {
    const ids = this.cells.get(this.key(Math.floor(lon / this.cellDeg), Math.floor(lat / this.cellDeg)));
    if (!ids) return null;
    for (const id of ids) {
      const it = this.items[id];
      const b = it.bbox;
      if (lon < b.minLon || lon > b.maxLon || lat < b.minLat || lat > b.maxLat) continue;
      if (pointInGeometry(lon, lat, it.geom)) return it.props;
    }
    return null;
  }
}

/** Polygon area in hectares (spherical approximation, good enough for reporting). */
export function areaHa(geom: Geometry): number {
  const ringArea = (ring: Ring): number => {
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      sum += ((x2 - x1) * Math.PI) / 180 * (2 + Math.sin((y1 * Math.PI) / 180) + Math.sin((y2 * Math.PI) / 180));
    }
    return Math.abs((sum * 6378137 * 6378137) / 2);
  };
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let m2 = 0;
  for (const p of polys) {
    if (!p.length) continue;
    m2 += ringArea(p[0]);
    for (let h = 1; h < p.length; h++) m2 -= ringArea(p[h]);
  }
  return m2 / 10_000;
}
