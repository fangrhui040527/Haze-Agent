// Map layers for one backward run: the air paths arriving at the town, where the
// weighted fires were, and the outlines of the concessions those fires were in.
// It also carries the calculation behind every share (method, per-wind-speed sums and
// each drawn fire's breakdown) so a reader can redo it instead of trusting a number.
// Display only; every cited figure stays in the dossier findings and their evidence.

import fs from "node:fs";
import path from "node:path";
import { CONFIG, PARAMS } from "./config.ts";
import { db } from "./db.ts";
import type { FireExplanation } from "./plume.ts";

const CELL_DEG = 0.25;
const round = (x: number, places: number) => Number(x.toFixed(places));
const sig = (x: number) => Number(x.toPrecision(6));

type Position = [number, number];
type Geometry = { type: string; coordinates: unknown };
type Range = { central: number; low: number; high: number };

export interface MapLayers {
  backward_run_id: string;
  town: { name: string; lat: number; lon: number } | null;
  /** Trajectory centre paths at 850 hPa for the central wind speed, [lat, lon] from the town backwards. */
  paths: Position[][];
  hotspots: { lat: number; lon: number; fires: number; max_frp: number; pct_of_signal: number }[];
  /** The most heavily weighted individual fires (central wind speed). */
  fires: {
    lat: number;
    lon: number;
    pct_of_signal: number;
    frp: number;
    on_peat: boolean;
    in_concession: boolean;
    /** How this fire earned its weight at the central wind speed; null if not recorded for this run. */
    why: {
      weight: number;
      contacts: number;
      peat_factor: number;
      closest: {
        distance_km: number;
        spread_km: number;
        gap_hours: number;
        window_hours: number;
        hours_back: number;
        space_factor: number;
        time_factor: number;
      };
    } | null;
  }[];
  fire_count: number;
  total_weight: number;
  /** Share of the smoke signal; null when the map needed to assess it is not loaded. */
  shares: { concession: Range | null; peat: Range | null };
  /** The settings every weight was computed with. */
  method: {
    paths_per_wind_speed: number;
    hours_back: number;
    wind_scales: number[];
    spread_km_at_town: number;
    spread_km_per_hour_back: number;
    max_spreads: number;
    time_window_hours: number;
    peat_time_window_hours: number;
    peat_factor: number;
    assumptions: string[];
  };
  /** Per wind-speed variant: summed weights and the resulting shares (central = scale 1). */
  arithmetic: {
    wind_speed_scale: number;
    total_weight: number;
    concession_weight: number;
    peat_weight: number;
    concession_pct: number;
    peat_pct: number;
  }[];
  concessions: {
    type: "FeatureCollection";
    features: {
      type: "Feature";
      geometry: Geometry;
      properties: {
        concession_id: string;
        name: string | null;
        company: string | null;
        group_name: string | null;
        map_source: string | null;
        map_date: string | null;
        fires: number;
        weight: number;
        pct_of_signal: number;
      };
    }[];
  };
  note: string;
}

const roundCoordinates = (value: unknown): unknown =>
  Array.isArray(value) && typeof value[0] === "number"
    ? [round(value[0] as number, 4), round(value[1] as number, 4)]
    : Array.isArray(value)
      ? value.map(roundCoordinates)
      : value;

function concessionGeometries(ids: string[]): Map<string, Geometry> {
  const file = path.join(CONFIG.geoDir, "concessions.geojson");
  if (!ids.length || !fs.existsSync(file)) return new Map();
  const wanted = new Set(ids);
  const { features = [] } = JSON.parse(fs.readFileSync(file, "utf8")) as {
    features?: { geometry?: Geometry; properties?: { concession_id?: string } }[];
  };
  const found = new Map<string, Geometry>();
  for (const f of features) {
    const id = f.properties?.concession_id;
    if (id && wanted.has(id) && f.geometry) found.set(id, { type: f.geometry.type, coordinates: roundCoordinates(f.geometry.coordinates) });
  }
  return found;
}

export async function mapLayers(
  backwardRunId: string,
  townName: string,
  concessionIds: string[],
  maps: { concession: boolean; peat: boolean },
  explain?: Map<string, FireExplanation>,
): Promise<MapLayers> {
  const town = await db().query("SELECT lat, lon FROM towns WHERE town = $1", [townName]);
  const points = await db().query(
    `SELECT member, release_utc, lat, lon FROM trajectory_points
      WHERE run_id = $1 AND scale = 1 AND level = '850hPa' ORDER BY member, release_utc, step_utc`,
    [backwardRunId],
  );
  const byPath = new Map<string, Position[]>();
  for (const row of points.rows) {
    const key = `${row.member}|${new Date(row.release_utc).toISOString()}`;
    const list = byPath.get(key) ?? [];
    list.push([round(Number(row.lat), 3), round(Number(row.lon), 3)]);
    byPath.set(key, list);
  }
  const cell = (col: string) => `FLOOR(${col} / ${CELL_DEG}) * ${CELL_DEG} + ${CELL_DEG / 2}`;
  const cells = await db().query(
    `SELECT ${cell("f.lat")} AS lat, ${cell("f.lon")} AS lon, COUNT(*) AS fires, MAX(f.frp) AS max_frp, SUM(a.weight) AS w,
            SUM(SUM(a.weight)) OVER () AS total
       FROM attribution a JOIN fires f ON a.fire_id = f.fire_id
      WHERE a.run_id = $1 AND a.scale = 1 GROUP BY ${cell("f.lat")}, ${cell("f.lon")} ORDER BY w DESC LIMIT 40`,
    [backwardRunId],
  );
  const fires = await db().query(
    `SELECT f.fire_id, f.lat, f.lon, f.frp, f.on_peat, f.concession_id IS NOT NULL AS in_concession, a.weight,
            SUM(a.weight) OVER () AS total, COUNT(*) OVER () AS n
       FROM attribution a JOIN fires f ON a.fire_id = f.fire_id
      WHERE a.run_id = $1 AND a.scale = 1 ORDER BY a.weight DESC, f.fire_id LIMIT 400`,
    [backwardRunId],
  );
  const split = await db().query(
    `SELECT a.scale, SUM(a.weight) AS total,
            SUM(CASE WHEN f.concession_id IS NOT NULL THEN a.weight ELSE 0 END) AS w_concession,
            SUM(CASE WHEN f.on_peat THEN a.weight ELSE 0 END) AS w_peat
       FROM attribution a JOIN fires f ON a.fire_id = f.fire_id WHERE a.run_id = $1 GROUP BY a.scale ORDER BY a.scale`,
    [backwardRunId],
  );
  const arithmetic = split.rows.map((r) => {
    const total = Number(r.total) || 1;
    return {
      wind_speed_scale: Number(r.scale),
      total_weight: sig(Number(r.total)),
      concession_weight: sig(Number(r.w_concession)),
      peat_weight: sig(Number(r.w_peat)),
      concession_pct: round((100 * Number(r.w_concession)) / total, 1),
      peat_pct: round((100 * Number(r.w_peat)) / total, 1),
    };
  });
  const share = (column: "concession_pct" | "peat_pct"): Range | null => {
    if (!arithmetic.length) return null;
    const all = arithmetic.map((a) => a[column]);
    return { central: arithmetic.find((a) => a.wind_speed_scale === 1)?.[column] ?? all[0]!, low: Math.min(...all), high: Math.max(...all) };
  };
  const run = await db().query("SELECT params FROM runs WHERE run_id = $1", [backwardRunId]);
  const params = run.rows[0]?.params;
  const members = Number((typeof params === "string" ? JSON.parse(params) : params)?.members ?? 0);
  const concessions = concessionIds.length
    ? await db().query(
        `SELECT c.concession_id, c.name, c.company, c.group_name, c.map_source, c.map_date,
                COUNT(*) AS fires, SUM(a.weight) AS w,
                (SELECT SUM(weight) FROM attribution WHERE run_id = $1 AND scale = 1) AS total
           FROM attribution a JOIN fires f ON a.fire_id = f.fire_id JOIN concessions c ON c.concession_id = f.concession_id
          WHERE a.run_id = $1 AND a.scale = 1 AND c.concession_id = ANY($2)
          GROUP BY c.concession_id, c.name, c.company, c.group_name, c.map_source, c.map_date`,
        [backwardRunId, concessionIds],
      )
    : { rows: [] };
  const geometries = concessionGeometries(concessionIds);
  const central = arithmetic.find((a) => a.wind_speed_scale === 1);
  return {
    backward_run_id: backwardRunId,
    town: town.rows[0] ? { name: townName, lat: Number(town.rows[0].lat), lon: Number(town.rows[0].lon) } : null,
    paths: [...byPath.values()],
    hotspots: cells.rows.map((r) => ({
      lat: Number(r.lat),
      lon: Number(r.lon),
      fires: Number(r.fires),
      max_frp: round(Number(r.max_frp), 1),
      pct_of_signal: round((100 * Number(r.w)) / (Number(r.total) || 1), 1),
    })),
    fires: fires.rows.map((r) => {
      const e = explain?.get(String(r.fire_id));
      return {
        lat: round(Number(r.lat), 4),
        lon: round(Number(r.lon), 4),
        pct_of_signal: round((100 * Number(r.weight)) / (Number(r.total) || 1), 2),
        frp: round(Number(r.frp), 1),
        on_peat: Boolean(r.on_peat),
        in_concession: Boolean(r.in_concession),
        why: e
          ? {
              weight: sig(e.weight),
              contacts: e.contacts,
              peat_factor: e.peatFactor,
              closest: {
                distance_km: round(e.best.distanceKm, 1),
                spread_km: round(e.best.sigmaKm, 1),
                gap_hours: round(e.best.gapHours, 1),
                window_hours: e.best.windowHours,
                hours_back: round(e.best.hoursBack, 1),
                space_factor: round(e.best.spaceFactor, 3),
                time_factor: round(e.best.timeFactor, 3),
              },
            }
          : null,
      };
    }),
    fire_count: Number(fires.rows[0]?.n ?? 0),
    total_weight: central?.total_weight ?? 0,
    shares: { concession: maps.concession ? share("concession_pct") : null, peat: maps.peat ? share("peat_pct") : null },
    method: {
      paths_per_wind_speed: Math.round(members / PARAMS.ensemble.windScales.length),
      hours_back: PARAMS.backHours,
      wind_scales: PARAMS.ensemble.windScales,
      spread_km_at_town: PARAMS.kernel.sigmaKm0,
      spread_km_per_hour_back: PARAMS.kernel.sigmaKmPerHour,
      max_spreads: PARAMS.kernel.maxSigmas,
      time_window_hours: PARAMS.kernel.timeTolHours,
      peat_time_window_hours: PARAMS.kernel.peatTimeTolHours,
      peat_factor: PARAMS.peatEmissionFactor,
      assumptions: [
        `Peat fires count ${PARAMS.peatEmissionFactor}x their fire radiative power because peat smoulders and smokes more; this factor is an uncalibrated placeholder, not a measured emission ratio.`,
        "Fire radiative power stands in for smoke output; real emissions also depend on fuel and burn phase.",
        "Air paths come from a simple trajectory model on gridded winds (not HYSPLIT); the wind-speed variants show how much the result depends on it.",
        "A share is part of the modelled smoke signal arriving at the town, not a measured share of PM2.5.",
      ],
    },
    arithmetic,
    concessions: {
      type: "FeatureCollection",
      features: concessions.rows
        .filter((r) => geometries.has(String(r.concession_id)))
        .map((r) => ({
          type: "Feature" as const,
          geometry: geometries.get(String(r.concession_id))!,
          properties: {
            concession_id: String(r.concession_id),
            name: r.name ?? null,
            company: r.company ?? null,
            group_name: r.group_name ?? null,
            map_source: r.map_source ?? null,
            map_date: r.map_date ?? null,
            fires: Number(r.fires),
            weight: sig(Number(r.w)),
            pct_of_signal: round((100 * Number(r.w)) / (Number(r.total) || 1), 1),
          },
        })),
    },
    note: "Display layers from the same backward run. Fire detections show where land burned, not who lit it; concession names are leads for verification. Cited figures are in the findings.",
  };
}
