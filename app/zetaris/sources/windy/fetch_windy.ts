#!/usr/bin/env node
/**
 * Test the Windy Point Forecast API.
 *
 * Windy issues one API key per product (Map Forecast, Point Forecast, Webcams,
 * ...). The key in .env.local is a Point Forecast key: it is called against
 *   POST https://api.windy.com/api/point-forecast/v2
 * and never against the Map Forecast endpoints, which serve a JS map widget
 * rather than raw data.
 *
 * The key is read from WINDY_API_KEY in .env.local and is never printed,
 * logged or written to disk.
 *
 * Usage:
 *   node --experimental-strip-types sources/windy/fetch_windy.ts                       # Defaults to KL from location.json
 *   node --experimental-strip-types sources/windy/fetch_windy.ts --location penang     # Resolves from location.json
 *   node --experimental-strip-types sources/windy/fetch_windy.ts --lat 3.14 --lon 101.69
 *   node --experimental-strip-types sources/windy/fetch_windy.ts --model gfs --parameters wind,temp,rh,pressure --levels surface
 *   node --experimental-strip-types sources/windy/fetch_windy.ts --model cams --parameters pm2p5,pm10,aqi --levels surface
 *   node --experimental-strip-types sources/windy/fetch_windy.ts --json windy_sample.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../");

const API_URL = "https://api.windy.com/api/point-forecast/v2";
const LOCATIONS_FILE = path.join(__dirname, "location.json");
const MAX_ROWS = 8;

interface LocationItem {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  index: number;
  codes?: string[] | undefined;
}

interface PointForecastResponse {
  ts: number[];
  units: Record<string, string>;
  [parameterLevel: string]: unknown;
}

interface RequestSpec {
  lat: number;
  lon: number;
  model: string;
  parameters: string[];
  levels: string[];
  locationName?: string | undefined;
}

interface CliOptions {
  lat: number;
  lon: number;
  model: string;
  parameters: string[] | null;
  levels: string[];
  jsonPath: string | null;
  all: boolean;
  locationName?: string | undefined;
}

function loadLocations(): LocationItem[] {
  if (!fs.existsSync(LOCATIONS_FILE)) {
    return [];
  }
  const content = fs.readFileSync(LOCATIONS_FILE, "utf-8");
  return JSON.parse(content) as LocationItem[];
}

function resolveLocation(
  query: string | null,
  locations: LocationItem[],
): LocationItem | null {
  if (!query) {
    // Default to Kuala Lumpur
    return (
      locations.find((l) => l.id === "wp-kuala-lumpur" || l.id === "kuala-lumpur") ??
      locations.find((l) => l.name.toLowerCase().includes("kuala lumpur")) ??
      null
    );
  }
  const q = query.trim().toLowerCase();
  return (
    locations.find((l) => l.id.toLowerCase() === q) ??
    locations.find((l) => l.name.toLowerCase() === q) ??
    locations.find((l) => l.name.toLowerCase().includes(q)) ??
    null
  );
}

// .env.local is the only supported env file. Look in the repo root first, then
// the enclosing checkouts (a gitignored file does not exist in a git worktree).
function loadEnvLocal(): string | null {
  const candidates = [
    path.join(REPO_ROOT, ".env.local"),
    path.resolve(REPO_ROOT, "..", ".env.local"),
    path.resolve(REPO_ROOT, "..", "..", ".env.local"),
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const raw of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const i = line.indexOf("=");
      const key = line.slice(0, i).trim();
      let value = line.slice(i + 1).trim();
      if (
        value.length >= 2 && value[0] === value[value.length - 1] &&
        (value[0] === '"' || value[0] === "'")
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
    return file;
  }
  return null;
}

function parseCliArgs(locations: LocationItem[]): CliOptions {
  const args = process.argv.slice(2);
  let locationQuery: string | null = null;
  let customLat: number | null = null;
  let customLon: number | null = null;

  const options: CliOptions = {
    lat: 3.14,
    lon: 101.69,
    model: "gfs",
    parameters: null,
    levels: ["surface"],
    jsonPath: null,
    all: false,
    locationName: "WP Kuala Lumpur",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = (): string => {
      const value = args[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      i++;
      return value;
    };

    if (arg === "--location" || arg === "--loc") locationQuery = next();
    else if (arg === "--lat") customLat = Number(next());
    else if (arg === "--lon") customLon = Number(next());
    else if (arg === "--model") options.model = next();
    else if (arg === "--parameters") options.parameters = next().split(",").map((p) => p.trim()).filter(Boolean);
    else if (arg === "--levels") options.levels = next().split(",").map((l) => l.trim()).filter(Boolean);
    else if (arg === "--json") options.jsonPath = next();
    else if (arg === "--all") options.all = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("See the header of this file for usage.");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  // Resolve location from location.json (defaults to Kuala Lumpur if not specified)
  const matchedLoc = resolveLocation(locationQuery, locations);
  if (matchedLoc) {
    options.lat = Number(matchedLoc.latitude);
    options.lon = Number(matchedLoc.longitude);
    options.locationName = matchedLoc.name;
  } else if (locationQuery) {
    console.warn(`[WARN] Location "${locationQuery}" not found in location.json; using default coordinates.`);
  }

  // Explicit lat/lon arguments override location lookup
  if (customLat !== null) {
    options.lat = customLat;
    if (customLon !== null) {
      options.locationName = `Custom (${customLat}, ${customLon})`;
    }
  }
  if (customLon !== null) {
    options.lon = customLon;
  }

  return options;
}

async function callPointForecast(spec: RequestSpec, key: string): Promise<PointForecastResponse> {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...spec, key }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Windy returned HTTP ${response.status} for model "${spec.model}": ${text.slice(0, 400)}`,
    );
  }

  return (await response.json()) as PointForecastResponse;
}

function formatRow(value: unknown): string {
  return typeof value === "number" ? value.toFixed(2) : String(value);
}

function printTable(spec: RequestSpec, data: PointForecastResponse): void {
  const times = (data.ts ?? []).slice(0, MAX_ROWS);
  // Only array-valued keys are time series; scalar extras (e.g. "warning")
  // are reported separately.
  const valueKeys = Object.keys(data).filter(
    (k) => k !== "ts" && k !== "units" && Array.isArray(data[k]),
  );
  const scalarKeys = Object.keys(data).filter(
    (k) => k !== "ts" && k !== "units" && !Array.isArray(data[k]),
  );

  const locLabel = spec.locationName ? ` location="${spec.locationName}"` : "";
  console.log(`\nmodel=${spec.model}${locLabel} point=(${spec.lat}, ${spec.lon}) series=${data.ts?.length ?? 0} rows`);
  console.log(`columns: ${valueKeys.join(", ")}`);

  for (let row = 0; row < times.length; row++) {
    const stamp = new Date(times[row]!).toISOString();
    const cells = valueKeys.map((k) => {
      const series = data[k] as number[] | null;
      return `${k}=${formatRow(series?.[row])}`;
    });
    console.log(`  ${stamp}  ${cells.join("  ")}`);
  }

  console.log("units:", JSON.stringify(data.units ?? {}));
  if (scalarKeys.length > 0) {
    console.log("extra:", JSON.stringify(Object.fromEntries(scalarKeys.map((k) => [k, data[k]]))));
  }
}

async function main(): Promise<void> {
  const locations = loadLocations();
  const options = parseCliArgs(locations);
  const envFile = loadEnvLocal();
  const key = process.env.WINDY_API_KEY;

  if (!key) {
    throw new Error(
      `WINDY_API_KEY is not set${envFile ? ` (loaded ${envFile})` : " (.env.local not found)"}.`,
    );
  }

  // A weather call and an air-quality call cover the two model families the
  // Haze Agent cares about: wind/rh/temp and PM2.5 / PM10.
  const specs: RequestSpec[] = options.all
    ? [
        {
          lat: options.lat,
          lon: options.lon,
          model: "gfs",
          parameters: options.parameters ?? ["wind", "temp", "rh", "pressure", "windGust"],
          levels: options.levels,
          locationName: options.locationName,
        },
        {
          lat: options.lat,
          lon: options.lon,
          model: "cams",
          parameters: options.parameters ?? ["pm2p5", "pm10", "aqi", "no2", "dustsm"],
          levels: options.levels,
          locationName: options.locationName,
        },
      ]
    : [
        {
          lat: options.lat,
          lon: options.lon,
          model: options.model,
          parameters: options.parameters ??
            (options.model === "cams"
              ? ["pm2p5", "pm10", "aqi", "no2", "dustsm"]
              : ["wind", "temp", "rh", "pressure", "windGust"]),
          levels: options.levels,
          locationName: options.locationName,
        },
      ];

  console.log(`Windy Point Forecast test | env=${envFile ?? "none"}`);

  const results: Array<{ spec: RequestSpec; data: PointForecastResponse }> = [];

  for (const spec of specs) {
    const data = await callPointForecast(spec, key);
    results.push({ spec, data });
    printTable(spec, data);
  }

  if (options.jsonPath) {
    const payload = results.length === 1 ? results[0]!.data : results.map((r) => ({ model: r.spec.model, ...r.data }));
    fs.writeFileSync(options.jsonPath, JSON.stringify(payload, null, 2), "utf-8");
    console.log(`\nWrote raw response to ${options.jsonPath}`);
  }

  console.log("\n✓ Windy Point Forecast test finished.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
