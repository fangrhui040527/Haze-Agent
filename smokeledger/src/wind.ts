// A gridded, hourly wind field with bilinear (space) + linear (time) interpolation.

export interface WindSample {
  lat: number;
  lon: number;
  tMs: number;
  u: number;
  v: number;
}

export class WindField {
  readonly lats: number[];
  readonly lons: number[];
  readonly times: number[];
  private u: Float32Array;
  private v: Float32Array;

  constructor(samples: WindSample[], readonly level: string) {
    const uniq = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);
    this.lats = uniq(samples.map((s) => s.lat));
    this.lons = uniq(samples.map((s) => s.lon));
    this.times = uniq(samples.map((s) => s.tMs));
    if (this.lats.length < 2 || this.lons.length < 2 || this.times.length < 2)
      throw new Error(`Wind field '${level}' needs at least a 2x2 grid and 2 time steps.`);
    const n = this.times.length * this.lats.length * this.lons.length;
    this.u = new Float32Array(n).fill(NaN);
    this.v = new Float32Array(n).fill(NaN);
    const li = new Map(this.lats.map((x, i) => [x, i]));
    const oi = new Map(this.lons.map((x, i) => [x, i]));
    const ti = new Map(this.times.map((x, i) => [x, i]));
    for (const s of samples) {
      const k = this.idx(ti.get(s.tMs)!, li.get(s.lat)!, oi.get(s.lon)!);
      this.u[k] = s.u;
      this.v[k] = s.v;
    }
  }

  private idx(t: number, y: number, x: number): number {
    return (t * this.lats.length + y) * this.lons.length + x;
  }

  get startMs(): number {
    return this.times[0];
  }
  get endMs(): number {
    return this.times[this.times.length - 1];
  }

  /** Lower bracket index and fraction for a sorted axis; null when outside. */
  private static bracket(axis: number[], x: number): [number, number] | null {
    if (x < axis[0] || x > axis[axis.length - 1]) return null;
    let lo = 0;
    let hi = axis.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (axis[mid] <= x) lo = mid;
      else hi = mid;
    }
    const span = axis[hi] - axis[lo];
    return [lo, span === 0 ? 0 : (x - axis[lo]) / span];
  }

  private spatial(t: number, y: number, fy: number, x: number, fx: number): [number, number] | null {
    const k00 = this.idx(t, y, x);
    const k01 = this.idx(t, y, x + 1);
    const k10 = this.idx(t, y + 1, x);
    const k11 = this.idx(t, y + 1, x + 1);
    const vals = [this.u[k00], this.u[k01], this.u[k10], this.u[k11], this.v[k00], this.v[k01], this.v[k10], this.v[k11]];
    if (vals.some((n) => Number.isNaN(n))) return null;
    const lerp2 = (a: number, b: number, c: number, d: number) =>
      (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    return [lerp2(vals[0], vals[1], vals[2], vals[3]), lerp2(vals[4], vals[5], vals[6], vals[7])];
  }

  /** Wind (u, v) in m/s at a point and time, or null if outside the data. */
  sample(lat: number, lon: number, tMs: number): { u: number; v: number } | null {
    const by = WindField.bracket(this.lats, lat);
    const bx = WindField.bracket(this.lons, lon);
    const bt = WindField.bracket(this.times, tMs);
    if (!by || !bx || !bt) return null;
    const [y, fy] = by;
    const [x, fx] = bx;
    const [t, ft] = bt;
    const yy = Math.min(y, this.lats.length - 2);
    const xx = Math.min(x, this.lons.length - 2);
    const fyy = y > yy ? 1 : fy;
    const fxx = x > xx ? 1 : fx;
    const a = this.spatial(t, yy, fyy, xx, fxx);
    if (!a) return null;
    if (ft === 0 || t === this.times.length - 1) return { u: a[0], v: a[1] };
    const b = this.spatial(t + 1, yy, fyy, xx, fxx);
    if (!b) return null;
    return { u: a[0] * (1 - ft) + b[0] * ft, v: a[1] * (1 - ft) + b[1] * ft };
  }
}
