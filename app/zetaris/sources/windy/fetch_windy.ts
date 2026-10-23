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

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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
  dryRun: boolean;
  testOnly: boolean;
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
    dryRun: false,
    testOnly: false,
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
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--test-only") options.testOnly = true;
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

const PYTHON_BIN = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");

function runCommand(command: string, args: string[], cwd: string = REPO_ROOT): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command '${command} ${args.join(" ")}' failed with exit code ${code}`));
    });
  });
}

async function runSqlText(text: string, options: { dryRun: boolean; skipExists?: boolean }): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zetaris-windy-"));
  const sqlFile = path.join(tempDir, "windy.sql");

  try {
    fs.writeFileSync(sqlFile, text, "utf-8");
    const cmdArgs = ["scripts/run_sql.py"];
    if (options.skipExists) cmdArgs.push("--skip-exists");
    if (options.dryRun) cmdArgs.push("--dry-run");
    cmdArgs.push(sqlFile);
    await runCommand(PYTHON_BIN, cmdArgs, REPO_ROOT);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function toGfsCsv(spec: RequestSpec, data: PointForecastResponse): string {
  const times = data.ts ?? [];
  const temp = (data["temp-surface"] as number[]) ?? [];
  const rh = (data["rh-surface"] as number[]) ?? [];
  const pressure = (data["pressure-surface"] as number[]) ?? [];
  const windU = (data["wind_u-surface"] as number[]) ?? [];
  const windV = (data["wind_v-surface"] as number[]) ?? [];
  const gust = (data["gust-surface"] as number[]) ?? [];

  const headers = [
    "location_name",
    "requested_latitude",
    "requested_longitude",
    "forecast_time",
    "temp_c",
    "relative_humidity_pct",
    "pressure_hpa",
    "wind_u_ms",
    "wind_v_ms",
    "wind_speed_ms",
    "wind_direction_deg",
    "wind_gust_ms",
  ];

  const rows: string[] = [headers.join(",")];

  for (let i = 0; i < times.length; i++) {
    const t = new Date(times[i]!).toISOString().replace("T", " ").replace(".000Z", "");
    const tc = temp[i] != null ? (temp[i]! - 273.15).toFixed(2) : "";
    const rhVal = rh[i]?.toFixed(2) ?? "";
    const pVal = pressure[i] != null ? (pressure[i]! / 100).toFixed(2) : "";
    const u = windU[i] ?? 0;
    const v = windV[i] ?? 0;
    const speed = Math.sqrt(u * u + v * v).toFixed(2);
    const dir = (((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360).toFixed(1);
    const gustVal = gust[i]?.toFixed(2) ?? "";

    rows.push([
      `"${spec.locationName ?? "WP Kuala Lumpur"}"`,
      spec.lat,
      spec.lon,
      `"${t}"`,
      tc,
      rhVal,
      pVal,
      u.toFixed(2),
      v.toFixed(2),
      speed,
      dir,
      gustVal,
    ].join(","));
  }

  return rows.join("\n");
}

function toCamsCsv(spec: RequestSpec, data: PointForecastResponse): string {
  const times = data.ts ?? [];
  const pm25 = (data["pm2p5-surface"] as number[]) ?? [];
  const pm10 = (data["pm10-surface"] as number[]) ?? [];
  const aqi = (data["aqi_us-surface"] as number[]) ?? [];
  const no2 = (data["no2-surface"] as number[]) ?? [];
  const dust = (data["chem_dustsm-surface"] as number[]) ?? [];

  const headers = [
    "location_name",
    "requested_latitude",
    "requested_longitude",
    "observation_time",
    "pm2_5_ug_m3",
    "pm10_ug_m3",
    "aqi_us",
    "no2_ug_m3",
    "dust_ug_m3",
  ];

  const rows: string[] = [headers.join(",")];

  for (let i = 0; i < times.length; i++) {
    const t = new Date(times[i]!).toISOString().replace("T", " ").replace(".000Z", "");
    const p25 = pm25[i]?.toFixed(2) ?? "";
    const p10 = pm10[i]?.toFixed(2) ?? "";
    const aq = aqi[i]?.toFixed(1) ?? "";
    const n2 = no2[i]?.toFixed(2) ?? "";
    const dst = dust[i]?.toFixed(2) ?? "";

    rows.push([
      `"${spec.locationName ?? "WP Kuala Lumpur"}"`,
      spec.lat,
      spec.lon,
      `"${t}"`,
      p25,
      p10,
      aq,
      n2,
      dst,
    ].join(","));
  }

  return rows.join("\n");
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

  // Fetch both GFS weather and CAMS air quality to produce complete datasets
  const specs: RequestSpec[] = options.all || !options.testOnly
    ? [
        {
          lat: options.lat,
          lon: options.lon,
          model: "gfs",
          parameters: options.parameters && options.model === "gfs" ? options.parameters : ["wind", "temp", "rh", "pressure", "windGust"],
          levels: options.levels,
          locationName: options.locationName,
        },
        {
          lat: options.lat,
          lon: options.lon,
          model: "cams",
          parameters: options.parameters && options.model === "cams" ? options.parameters : ["pm2p5", "pm10", "aqi", "no2", "dustsm"],
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

  // ---------------------------------------------------------------------------
  // Export CSVs & Register in Zetaris FileStore
  // ---------------------------------------------------------------------------
  const DATA_DIR = path.join(__dirname, "data");
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const gfsResult = results.find((r) => r.spec.model === "gfs");
  if (gfsResult) {
    const gfsCsv = toGfsCsv(gfsResult.spec, gfsResult.data);
    const gfsPath = path.join(DATA_DIR, "windy_gfs.csv");
    fs.writeFileSync(gfsPath, gfsCsv, "utf-8");
    console.log(`\n  ✓ Wrote GFS dataset: ${gfsPath} (${(gfsResult.data.ts ?? []).length} rows)`);
  }

  const camsResult = results.find((r) => r.spec.model === "cams");
  if (camsResult) {
    const camsCsv = toCamsCsv(camsResult.spec, camsResult.data);
    const camsPath = path.join(DATA_DIR, "windy_cams.csv");
    fs.writeFileSync(camsPath, camsCsv, "utf-8");
    console.log(`  ✓ Wrote CAMS dataset: ${camsPath} (${(camsResult.data.ts ?? []).length} rows)`);
  }

  if (!options.testOnly) {
    console.log("\n========================================================");
    console.log(" Publishing CSVs & Registering FileStore in Zetaris");
    console.log("========================================================");

    const CONTAINER_DIR = "/home/zetaris/customer-data/shared/windy";
    if (options.dryRun) {
      console.log(`[DRY-RUN] docker exec zetaris-driver-1 mkdir -p ${CONTAINER_DIR}`);
      console.log(`[DRY-RUN] docker cp ${DATA_DIR}/. zetaris-driver-1:${CONTAINER_DIR}/`);
    } else {
      try {
        await runCommand("docker", ["exec", "zetaris-driver-1", "mkdir", "-p", CONTAINER_DIR], REPO_ROOT);
        await runCommand("docker", ["cp", `${DATA_DIR}/.`, `zetaris-driver-1:${CONTAINER_DIR}/`], REPO_ROOT);
        console.log(`  ✓ Copied CSV data → zetaris-driver-1:${CONTAINER_DIR}`);
      } catch (err) {
        console.warn(`  ⚠ docker cp warning: ${(err as Error).message}`);
      }
    }

    const registrationSql = `
CREATE LIGHTNING DATABASE WINDY_FILES
DESCRIBE BY "Windy Point Forecast CSV files";

CREATE SCHEMASTORE CONTAINER windy;

CREATE LIGHTNING FILESTORE TABLE windy_gfs_raw
FROM WINDY_FILES
FORMAT CSV
OPTIONS (
    PATH "/home/zetaris/customer-data/shared/windy/windy_gfs.csv",
    header "true",
    inferSchema "true"
);

CREATE LIGHTNING FILESTORE TABLE windy_cams_raw
FROM WINDY_FILES
FORMAT CSV
OPTIONS (
    PATH "/home/zetaris/customer-data/shared/windy/windy_cams.csv",
    header "true",
    inferSchema "true"
);
`.trim();

    const viewSql = `
CREATE SCHEMASTORE VIEW gfs_forecast WITH CONTAINER windy AS
SELECT
    location_name,
    CAST(requested_latitude AS DOUBLE) AS requested_latitude,
    CAST(requested_longitude AS DOUBLE) AS requested_longitude,
    CAST(forecast_time AS TIMESTAMP) AS forecast_time,
    CAST(temp_c AS DOUBLE) AS temp_c,
    CAST(relative_humidity_pct AS DOUBLE) AS relative_humidity_pct,
    CAST(pressure_hpa AS DOUBLE) AS pressure_hpa,
    CAST(wind_u_ms AS DOUBLE) AS wind_u_ms,
    CAST(wind_v_ms AS DOUBLE) AS wind_v_ms,
    CAST(wind_speed_ms AS DOUBLE) AS wind_speed_ms,
    CAST(wind_direction_deg AS DOUBLE) AS wind_direction_deg,
    CAST(wind_gust_ms AS DOUBLE) AS wind_gust_ms
FROM WINDY_FILES.windy_gfs_raw;

CREATE SCHEMASTORE VIEW cams_air_quality WITH CONTAINER windy AS
SELECT
    location_name,
    CAST(requested_latitude AS DOUBLE) AS requested_latitude,
    CAST(requested_longitude AS DOUBLE) AS requested_longitude,
    CAST(observation_time AS TIMESTAMP) AS observation_time,
    CAST(pm2_5_ug_m3 AS DOUBLE) AS pm2_5_ug_m3,
    CAST(pm10_ug_m3 AS DOUBLE) AS pm10_ug_m3,
    CAST(aqi_us AS DOUBLE) AS aqi_us,
    CAST(no2_ug_m3 AS DOUBLE) AS no2_ug_m3,
    CAST(dust_ug_m3 AS DOUBLE) AS dust_ug_m3
FROM WINDY_FILES.windy_cams_raw;
`.trim();

    console.log("Registering WINDY_FILES database, container, and FileStore tables in Zetaris...");
    await runSqlText(registrationSql, { dryRun: options.dryRun, skipExists: true });

    console.log("Refreshing windy.gfs_forecast and windy.cams_air_quality views...");
    if (!options.dryRun) {
      try {
        await runSqlText("DROP VIEW IF EXISTS windy.gfs_forecast;\nDROP VIEW IF EXISTS windy.cams_air_quality;", { dryRun: false });
      } catch {
        // ignore drop warning
      }
    }

    await runSqlText(viewSql, { dryRun: options.dryRun });
    console.log("✓ Successfully registered in Zetaris!");
    console.log("  You can now query:");
    console.log("    SELECT * FROM windy.gfs_forecast LIMIT 10;");
    console.log("    SELECT * FROM windy.cams_air_quality LIMIT 10;");
  }

  console.log("\n✓ Windy Point Forecast pipeline finished.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
