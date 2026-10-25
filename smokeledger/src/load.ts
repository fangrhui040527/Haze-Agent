// Loaders for the files you fetch yourself. Each one validates the shape,
// converts units, and writes to Postgres. Run `npm run sl -- urls` to print
// the exact API calls whose output these loaders expect.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG, DEFAULT_TOWNS, PARAMS } from "./config.ts";
import { db, insertMany } from "./db.ts";
import { PolygonIndex, areaHa, windToUV, type Geometry } from "./geo.ts";

// ---------- tiny CSV parser (quotes, commas, CRLF) ----------
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((c) => c !== "")) rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

// ---------- towns ----------
export async function loadTowns(csvPath?: string): Promise<number> {
  const towns = csvPath
    ? parseCsv(fs.readFileSync(csvPath, "utf8")).map((r) => ({
        town: r.town,
        district: r.district ?? "",
        state: r.state ?? "",
        lat: Number(r.lat),
        lon: Number(r.lon),
      }))
    : DEFAULT_TOWNS;
  return insertMany(
    "towns",
    ["town", "district", "state", "lat", "lon"],
    towns.map((t) => [t.town, t.district, t.state, t.lat, t.lon]),
    "ON CONFLICT (town) DO UPDATE SET district=EXCLUDED.district, state=EXCLUDED.state, lat=EXCLUDED.lat, lon=EXCLUDED.lon",
  );
}

// ---------- geo layers (concessions + peat) ----------
interface Feature {
  type: "Feature";
  geometry: Geometry | null;
  properties: Record<string, unknown> | null;
}

function readFeatures(file: string): Feature[] {
  const gj = JSON.parse(fs.readFileSync(file, "utf8"));
  const feats: Feature[] = gj.type === "FeatureCollection" ? gj.features : gj.type === "Feature" ? [gj] : [];
  return feats.filter((f) => f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"));
}

function geoPath(name: "concessions" | "peat"): string {
  return path.join(CONFIG.geoDir, `${name}.geojson`);
}

function writeFeatures(name: "concessions" | "peat", feats: Feature[]): void {
  fs.mkdirSync(CONFIG.geoDir, { recursive: true });
  fs.writeFileSync(geoPath(name), JSON.stringify({ type: "FeatureCollection", features: feats }));
}

const pick = (props: Record<string, unknown>, explicit: string | undefined, candidates: string[]): string | null => {
  const keys = explicit ? [explicit] : candidates;
  for (const k of keys) {
    const hit = Object.keys(props).find((p) => p.toLowerCase() === k.toLowerCase());
    if (hit && props[hit] !== null && props[hit] !== undefined && String(props[hit]).trim() !== "")
      return String(props[hit]).trim();
  }
  return null;
};

export interface ConcessionFieldMap {
  id?: string;
  name?: string;
  company?: string;
  group?: string;
  type?: string;
  country?: string;
  source: string; // e.g. "GFW Indonesia oil palm concessions"
  date: string; // e.g. "2019" - age of the boundaries
}

export async function loadConcessions(file: string, map: ConcessionFieldMap): Promise<number> {
  const feats = readFeatures(file);
  const existing = fs.existsSync(geoPath("concessions")) ? readFeatures(geoPath("concessions")) : [];
  const byId = new Map(existing.map((f) => [String(f.properties?.concession_id), f]));
  const rows: unknown[][] = [];
  const prefix = path.basename(file).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]+/g, "_").slice(0, 20);
  feats.forEach((f, i) => {
    const p = f.properties ?? {};
    const rawId = pick(p, map.id, ["concession_id", "id", "objectid", "cartodb_id", "fid"]) ?? String(i);
    const id = `${prefix}:${rawId}`.replace(/[^A-Za-z0-9_.:\-]/g, "_");
    const row = [
      id,
      pick(p, map.name, ["name", "concession", "concession_name", "nama"]),
      pick(p, map.company, ["company", "company_name", "perusahaan"]),
      pick(p, map.group, ["group_comp", "group", "group_name", "parent", "grup"]),
      pick(p, map.type, ["type", "commodity", "ctype", "source_type"]),
      pick(p, map.country, ["country", "iso", "negara"]) ?? "Indonesia",
      Math.round(areaHa(f.geometry!)),
      map.source,
      map.date,
    ];
    rows.push(row);
    byId.set(id, { type: "Feature", geometry: f.geometry, properties: { concession_id: id } });
  });
  writeFeatures("concessions", [...byId.values()]);
  return insertMany(
    "concessions",
    ["concession_id", "name", "company", "group_name", "ctype", "country", "area_ha", "map_source", "map_date"],
    rows,
    `ON CONFLICT (concession_id) DO UPDATE SET name=EXCLUDED.name, company=EXCLUDED.company,
       group_name=EXCLUDED.group_name, ctype=EXCLUDED.ctype, country=EXCLUDED.country,
       area_ha=EXCLUDED.area_ha, map_source=EXCLUDED.map_source, map_date=EXCLUDED.map_date`,
  );
}

export function loadPeat(file: string): number {
  const feats = readFeatures(file);
  const existing = fs.existsSync(geoPath("peat")) ? readFeatures(geoPath("peat")) : [];
  const all = [...existing, ...feats.map((f) => ({ type: "Feature" as const, geometry: f.geometry, properties: {} }))];
  writeFeatures("peat", all);
  return feats.length;
}

export function loadIndexes(): { concessions: PolygonIndex<string>; peat: PolygonIndex<true> } {
  const concessions = new PolygonIndex<string>(0.25);
  const peat = new PolygonIndex<true>(0.25);
  if (fs.existsSync(geoPath("concessions")))
    for (const f of readFeatures(geoPath("concessions")))
      concessions.add(f.geometry!, String(f.properties?.concession_id));
  if (fs.existsSync(geoPath("peat"))) for (const f of readFeatures(geoPath("peat"))) peat.add(f.geometry!, true);
  return { concessions, peat };
}

export async function loadCompanies(file: string): Promise<number> {
  const rows = parseCsv(fs.readFileSync(file, "utf8")).map((r) => [
    r.group_name,
    r.parent_country || null,
    r.rspo_member ? /^(1|true|yes|y)$/i.test(r.rspo_member) : null,
    r.grievance_contact || null,
    r.known_buyers || null,
    r.notes || null,
  ]);
  return insertMany(
    "companies",
    ["group_name", "parent_country", "rspo_member", "grievance_contact", "known_buyers", "notes"],
    rows,
    `ON CONFLICT (group_name) DO UPDATE SET parent_country=EXCLUDED.parent_country, rspo_member=EXCLUDED.rspo_member,
       grievance_contact=EXCLUDED.grievance_contact, known_buyers=EXCLUDED.known_buyers, notes=EXCLUDED.notes`,
  );
}

// ---------- fires (NASA FIRMS area CSV) ----------
function keepConfidence(c: string): boolean {
  if (!c) return true;
  if (/^[lnh]$/i.test(c)) return c.toLowerCase() !== "l";
  if (/^(low|nominal|high)$/i.test(c)) return c.toLowerCase() !== "low";
  const n = Number(c);
  return Number.isFinite(n) ? n >= PARAMS.minModisConfidence : true;
}

export async function loadFires(files: string[]): Promise<{ read: number; kept: number; inserted: number }> {
  const { concessions, peat } = loadIndexes();
  let read = 0;
  const rows: unknown[][] = [];
  for (const file of files) {
    for (const r of parseCsv(fs.readFileSync(file, "utf8"))) {
      read++;
      if (!("latitude" in r) || !("acq_date" in r)) throw new Error(`${file} is not a FIRMS CSV (no latitude/acq_date columns)`);
      if (!keepConfidence(r.confidence)) continue;
      const lat = Number(r.latitude);
      const lon = Number(r.longitude);
      const hhmm = r.acq_time.padStart(4, "0");
      const t = new Date(`${r.acq_date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Number.isNaN(t.getTime())) continue;
      const sat = r.satellite || r.instrument || "unknown";
      const id = crypto.createHash("sha1").update(`${lat},${lon},${r.acq_date},${hhmm},${sat}`).digest("hex").slice(0, 16);
      rows.push([
        id,
        lat,
        lon,
        t.toISOString(),
        Number(r.frp) || 0,
        r.confidence,
        sat,
        r.daynight ?? null,
        concessions.find(lon, lat),
        peat.find(lon, lat) === true,
        path.basename(file),
      ]);
    }
  }
  const inserted = await insertMany(
    "fires",
    ["fire_id", "lat", "lon", "acq_utc", "frp", "confidence", "satellite", "daynight", "concession_id", "on_peat", "source_file"],
    rows,
    "ON CONFLICT (fire_id) DO NOTHING",
  );
  return { read, kept: rows.length, inserted };
}

/** Re-run the concession/peat overlay for every stored fire (after loading new maps). */
export async function overlayAll(): Promise<number> {
  const { concessions, peat } = loadIndexes();
  const res = await db().query("SELECT fire_id, lat, lon FROM fires");
  const updates = res.rows.map((r) => [r.fire_id, concessions.find(r.lon, r.lat), peat.find(r.lon, r.lat) === true]);
  let n = 0;
  for (let i = 0; i < updates.length; i += 1000) {
    const part = updates.slice(i, i + 1000);
    const params: unknown[] = [];
    const values = part
      .map((u) => {
        params.push(...u);
        const k = params.length;
        return `($${k - 2}::text, $${k - 1}::text, $${k}::boolean)`;
      })
      .join(",");
    const r = await db().query(
      `UPDATE fires f SET concession_id = v.cid, on_peat = v.peat FROM (VALUES ${values}) v(fid, cid, peat) WHERE f.fire_id = v.fid`,
      params,
    );
    n += r.rowCount ?? 0;
  }
  return n;
}

// ---------- Open-Meteo JSON (wind grid + town PM2.5) ----------
interface OpenMeteoLocation {
  latitude: number;
  longitude: number;
  utc_offset_seconds?: number;
  hourly?: Record<string, (number | null)[] | string[]>;
  hourly_units?: Record<string, string>;
}

function readOpenMeteo(file: string): OpenMeteoLocation[] {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const locs: OpenMeteoLocation[] = Array.isArray(j) ? j : [j];
  for (const l of locs) {
    if ((l as { error?: boolean }).error) throw new Error(`${file}: Open-Meteo returned an error: ${JSON.stringify(l)}`);
    if (!l.hourly?.time) throw new Error(`${file}: no hourly.time - is this an Open-Meteo response?`);
    if (l.utc_offset_seconds && l.utc_offset_seconds !== 0) throw new Error(`${file}: fetch with timezone=GMT`);
  }
  return locs;
}

const toMs = (speed: number, unit = "m/s"): number => {
  const u = unit.toLowerCase();
  if (u === "km/h") return speed / 3.6;
  if (u === "kn") return speed * 0.514444;
  if (u === "mp/h" || u === "mph") return speed * 0.44704;
  return speed;
};
const snap = (x: number, step: number) => Number((Math.round(x / step) * step).toFixed(4));
const hourIso = (t: string) => new Date(t.length === 16 ? `${t}:00Z` : t).toISOString();

export async function loadWind(files: string[]): Promise<number> {
  const step = CONFIG.windGridStep;
  const rows = new Map<string, unknown[]>();
  for (const file of files)
    for (const loc of readOpenMeteo(file)) {
      const h = loc.hourly!;
      const units = loc.hourly_units ?? {};
      const lat = snap(loc.latitude, step);
      const lon = snap(loc.longitude, step);
      for (const level of ["850hPa", "10m"]) {
        const sp = h[`wind_speed_${level}`] as (number | null)[] | undefined;
        const dir = h[`wind_direction_${level}`] as (number | null)[] | undefined;
        if (!sp || !dir) continue;
        (h.time as string[]).forEach((t, i) => {
          if (sp[i] === null || dir[i] === null) return;
          const { u, v } = windToUV(toMs(sp[i]!, units[`wind_speed_${level}`]), dir[i]!);
          const iso = hourIso(t);
          rows.set(`${level}|${lat}|${lon}|${iso}`, [level, lat, lon, iso, u, v]);
        });
      }
    }
  if (!rows.size) throw new Error("No wind_speed_850hPa/wind_direction_850hPa or *_10m variables found.");
  return insertMany(
    "wind",
    ["level", "lat", "lon", "valid_utc", "u", "v"],
    [...rows.values()],
    "ON CONFLICT (level, lat, lon, valid_utc) DO UPDATE SET u=EXCLUDED.u, v=EXCLUDED.v",
  );
}

/**
 * PM2.5. Accepts:
 *  - Open-Meteo air-quality JSON for several towns (locations in the SAME order as `towns`)
 *  - CSV with columns town,valid_utc,pm25 (ground observations you collected)
 */
export async function loadPm25(
  files: string[],
  opts: { kind: "model" | "observed"; issued: string | null; towns?: string[]; source: string },
): Promise<number> {
  const townOrder = opts.towns ?? DEFAULT_TOWNS.map((t) => t.town);
  const rows: unknown[][] = [];
  for (const file of files) {
    if (file.endsWith(".csv")) {
      for (const r of parseCsv(fs.readFileSync(file, "utf8")))
        rows.push([r.town, new Date(r.valid_utc).toISOString(), opts.kind, opts.issued, Number(r.pm25), opts.source]);
      continue;
    }
    const locs = readOpenMeteo(file);
    if (locs.length !== townOrder.length)
      throw new Error(
        `${file} has ${locs.length} locations but ${townOrder.length} towns are expected. ` +
          `Fetch with the URL from \`npm run sl -- urls\`, or pass --towns "A,B,C" in request order.`,
      );
    locs.forEach((loc, i) => {
      const pm = loc.hourly!.pm2_5 as (number | null)[] | undefined;
      if (!pm) throw new Error(`${file}: no hourly.pm2_5`);
      (loc.hourly!.time as string[]).forEach((t, k) => {
        if (pm[k] === null || pm[k] === undefined) return;
        rows.push([townOrder[i], hourIso(t), opts.kind, opts.issued, pm[k], opts.source]);
      });
    });
  }
  return insertMany(
    "pm25",
    ["town", "valid_utc", "kind", "issued_utc", "pm25", "source"],
    rows,
    "ON CONFLICT (town, valid_utc, kind, COALESCE(issued_utc, 'epoch'::timestamptz)) DO UPDATE SET pm25 = EXCLUDED.pm25, ingested_utc = now() WHERE pm25.pm25 IS DISTINCT FROM EXCLUDED.pm25",
  );
}

// ---------- helper: print the exact requests to make ----------
export function printUrls(fromDate: string, toDate: string): string {
  const lines: string[] = [];
  const bbox = { west: 95, south: -6, east: 120, north: 8 };
  lines.push("# 1. NASA FIRMS hotspots (one call per 5-day window per satellite; save each as .csv)");
  const start = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 5 * 86_400_000)) {
    const day = d.toISOString().slice(0, 10);
    for (const src of ["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"])
      lines.push(
        `https://firms.modaps.eosdis.nasa.gov/api/area/csv/YOUR_MAP_KEY/${src}/${bbox.west},${bbox.south},${bbox.east},${bbox.north}/5/${day}`,
      );
  }
  const step = CONFIG.windGridStep;
  const pts: [number, number][] = [];
  for (let la = bbox.south; la <= bbox.north + 1e-9; la += step)
    for (let lo = bbox.west; lo <= bbox.east + 1e-9; lo += step) pts.push([Number(la.toFixed(3)), Number(lo.toFixed(3))]);
  lines.push("", `# 2. Open-Meteo wind grid (${pts.length} points, ${step} deg; save each response as .json)`);
  lines.push("#    Use api.open-meteo.com for the last 92 days; historical-forecast-api.open-meteo.com for older episodes.");
  lines.push("#    For LIVE use, replace start_date/end_date with &past_days=4&forecast_days=4 so forward runs have future wind.");
  for (let i = 0; i < pts.length; i += 100) {
    const part = pts.slice(i, i + 100);
    lines.push(
      `https://api.open-meteo.com/v1/forecast?latitude=${part.map((p) => p[0]).join(",")}&longitude=${part
        .map((p) => p[1])
        .join(",")}&hourly=wind_speed_850hPa,wind_direction_850hPa,wind_speed_10m,wind_direction_10m` +
        `&wind_speed_unit=ms&timezone=GMT&start_date=${fromDate}&end_date=${toDate}`,
    );
  }
  lines.push("", "# 3. Open-Meteo PM2.5 for the receptor towns (town order matters; save as .json)");
  lines.push(
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${DEFAULT_TOWNS.map((t) => t.lat).join(",")}` +
      `&longitude=${DEFAULT_TOWNS.map((t) => t.lon).join(",")}&hourly=pm2_5&timezone=GMT&start_date=${fromDate}&end_date=${toDate}`,
  );
  lines.push(`#    Towns in order: ${DEFAULT_TOWNS.map((t) => t.town).join(", ")}`);
  lines.push(
    "#    For LIVE forecasts, fetch with &past_days=2&forecast_days=5 instead of dates, and load with --issued now (daily, so backtests stay honest).",
  );
  return lines.join("\n");
}
