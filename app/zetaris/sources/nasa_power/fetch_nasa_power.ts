#!/usr/bin/env node
/**
 * Fetch & register NASA POWER daily climate data (20 variables) in Zetaris
 * for all 345 Malaysian canonical locations.
 *
 * Creates:
 *   - Database: NASA_POWER_REST
 *   - Container: power
 *   - REST tables: power_<location_id>_raw for each monitored location
 *   - View: power.power_daily (unified view across all locations)
 *
 * Usage:
 *   node --experimental-strip-types app/zetaris/sources/nasa_power/fetch_nasa_power.ts
 *   node --experimental-strip-types app/zetaris/sources/nasa_power/fetch_nasa_power.ts --location kuala-lumpur
 *   node --experimental-strip-types app/zetaris/sources/nasa_power/fetch_nasa_power.ts --date 20261018
 *   node --experimental-strip-types app/zetaris/sources/nasa_power/fetch_nasa_power.ts --dry-run
 *   npx tsx app/zetaris/sources/nasa_power/fetch_nasa_power.ts
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ZETARIS_ROOT = path.resolve(__dirname, "../../");
const LOCATIONS_FILE = path.join(__dirname, "locations.json");
const VIEW_NAME = "power.power_daily";

// Cross-platform python executable detection (python3 on Unix/macOS, python on Windows)
const PYTHON_BIN = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");

const PARAMETERS = [
  "WS10M", "WD10M", "RH2M", "QV2M", "GWETTOP", "GWETROOT",
  "PRECTOTCORR", "T2M", "T2M_MAX", "T2M_MIN", "T2MDEW", "WS10M_MAX",
  "GWETPROF", "WS2M", "T2MWET", "PS", "WS50M", "WD50M", "TS", "EVLAND",
];

interface LocationInfo {
  name: string;
  latitude: number;
  longitude: number;
}

interface RawLocation {
  id: string;
  name: string;
  latitude: string | number;
  longitude: string | number;
}

interface RunSqlOptions {
  dryRun: boolean;
  skipExists?: boolean;
}

function defaultDay(): string {
  const d = new Date();
  d.setDate(d.getDate() - 4);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

async function readLocations(filePath = LOCATIONS_FILE): Promise<Record<string, LocationInfo>> {
  const content = await fs.readFile(filePath, "utf-8");
  const rawList = JSON.parse(content) as RawLocation[];
  const locations: Record<string, LocationInfo> = {};

  for (const item of rawList) {
    if (locations[item.id]) {
      continue;
    }
    locations[item.id] = {
      name: item.name.trim(),
      latitude: Number(item.latitude),
      longitude: Number(item.longitude),
    };
  }

  return locations;
}

function endpoint(latitude: number, longitude: number, parameters: string[], day: string): string {
  const parameterText = parameters.join(",");
  return (
    "https://power.larc.nasa.gov/api/temporal/daily/point" +
    `?parameters=${parameterText}&community=AG` +
    `&latitude=${latitude}&longitude=${longitude}` +
    `&start=${day}&end=${day}&format=JSON`
  );
}

function tableName(locationId: string): string {
  return `power_${locationId.replace(/-/g, "_")}_raw`;
}

function registerStatement(locationId: string, location: LocationInfo, day: string): string {
  return `CREATE LIGHTNING REST TABLE ${tableName(locationId)}
FROM NASA_POWER_REST
REQUEST(
    endpoint "${endpoint(location.latitude, location.longitude, PARAMETERS, day)}",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER () BODY ();`;
}

function viewSelect(locationId: string, location: LocationInfo): string {
  const table = tableName(locationId);
  const mapValue = "from_json(to_json(properties.parameter.WS10M), 'map<string,double>')";
  const val = (name: string): string =>
    `element_at(from_json(to_json(properties.parameter.${name}), 'map<string,double>'), observation_key)`;

  return `SELECT
    '${locationId}' AS region,
    CAST(${location.latitude} AS DOUBLE) AS latitude,
    CAST(${location.longitude} AS DOUBLE) AS longitude,
    to_date(observation_key, 'yyyyMMdd') AS observation_date,
    observation_value AS WS10M,
    ${val("WD10M")} AS WD10M,
    ${val("RH2M")} AS RH2M,
    ${val("QV2M")} AS QV2M,
    ${val("GWETTOP")} AS GWETTOP,
    ${val("GWETROOT")} AS GWETROOT,
    ${val("PRECTOTCORR")} AS PRECTOTCORR,
    ${val("T2M")} AS T2M,
    ${val("T2M_MAX")} AS T2M_MAX,
    ${val("T2M_MIN")} AS T2M_MIN,
    ${val("T2MDEW")} AS T2MDEW,
    ${val("WS10M_MAX")} AS WS10M_MAX,
    ${val("GWETPROF")} AS GWETPROF,
    ${val("WS2M")} AS WS2M,
    ${val("T2MWET")} AS T2MWET,
    ${val("PS")} AS PS,
    ${val("WS50M")} AS WS50M,
    ${val("WD50M")} AS WD50M,
    ${val("TS")} AS TS,
    ${val("EVLAND")} AS EVLAND
FROM NASA_POWER_REST.${table}
LATERAL VIEW explode(${mapValue}) AS observation_key, observation_value`;
}

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command '${command} ${args.join(" ")}' failed with exit code ${code}`));
      }
    });
  });
}

async function runSqlText(text: string, options: RunSqlOptions): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zetaris-np-"));
  const sqlFile = path.join(tempDir, "pipeline.sql");

  try {
    await fs.writeFile(sqlFile, text, "utf-8");

    const cmdArgs = ["scripts/run_sql.py"];
    if (options.skipExists) {
      cmdArgs.push("--skip-exists");
    }
    if (options.dryRun) {
      cmdArgs.push("--dry-run");
    }
    cmdArgs.push(sqlFile);

    await runCommand(PYTHON_BIN, cmdArgs, ZETARIS_ROOT);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function parseCliArgs(): { locationIds: string[]; date: string; dryRun: boolean } {
  const args = process.argv.slice(2);
  const locationIds: string[] = [];
  let date = defaultDay();
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--date") {
      if (i + 1 < args.length) {
        date = args[i + 1]!;
        i++;
      }
    } else if (arg?.startsWith("--date=")) {
      date = arg.slice("--date=".length);
    } else if (arg === "--location") {
      if (i + 1 < args.length) {
        locationIds.push(args[i + 1]!);
        i++;
      }
    } else if (arg?.startsWith("--location=")) {
      locationIds.push(arg.slice("--location=".length));
    }
  }

  return { locationIds, date, dryRun };
}

async function main(): Promise<void> {
  const { locationIds, date, dryRun } = parseCliArgs();

  const locations = await readLocations();
  const selectedIds = locationIds.length > 0
    ? locationIds.filter((lid) => lid in locations)
    : Object.keys(locations);

  console.log(`Preparing NASA POWER pipeline for ${selectedIds.length} location(s) on date ${date}...`);

  // 1. Base registration
  const baseSql = `CREATE LIGHTNING DATABASE NASA_POWER_REST
DESCRIBE BY "NASA POWER daily weather REST source";

CREATE SCHEMASTORE CONTAINER power;
`;

  const tableStmts = selectedIds.map((lid) => registerStatement(lid, locations[lid]!, date));
  const fullRegSql = `${baseSql}\n\n${tableStmts.join("\n\n")}`;

  // 2. View generation
  const selects = selectedIds.map((lid) => viewSelect(lid, locations[lid]!));
  const viewSql = `CREATE SCHEMASTORE VIEW power_daily WITH CONTAINER power AS
${selects.join(" UNION ALL ")};
`;

  if (dryRun) {
    console.log("[Dry run] Registration statements:");
    await runSqlText(fullRegSql, { dryRun: true, skipExists: true });
    console.log("[Dry run] View statements:");
    await runSqlText(viewSql, { dryRun: true });
    return;
  }

  console.log("Registering REST tables in Zetaris...");
  await runSqlText(fullRegSql, { dryRun: false, skipExists: true });

  console.log(`Refreshing ${VIEW_NAME} view...`);
  try {
    await runCommand(
      PYTHON_BIN,
      ["scripts/run_sql.py", "-e", `DROP VIEW IF EXISTS ${VIEW_NAME}`],
      ZETARIS_ROOT,
    );
  } catch {
    // Drop view may report warning if it does not exist yet; ignore and continue
  }

  await runSqlText(viewSql, { dryRun: false });
  console.log(`✓ NASA POWER ingestion pipeline completed for ${selectedIds.length} locations.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
