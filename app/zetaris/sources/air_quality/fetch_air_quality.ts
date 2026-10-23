#!/usr/bin/env node
/**
 * Fetch & register hourly Open-Meteo PM2.5 and PM10 air quality data in Zetaris
 * for all 345 Malaysian canonical locations.
 *
 * Creates:
 *   - Database: OPEN_METEO_AIR_QUALITY
 *   - Container: air_quality
 *   - REST tables: aq_<location_id> for each monitored location
 *   - View: air_quality.hourly_observations (unified view across all locations)
 *
 * Usage:
 *   node --experimental-strip-types app/zetaris/sources/air_quality/fetch_air_quality.ts
 *   node --experimental-strip-types app/zetaris/sources/air_quality/fetch_air_quality.ts --location kuala-lumpur
 *   node --experimental-strip-types app/zetaris/sources/air_quality/fetch_air_quality.ts --dry-run
 *   npx tsx app/zetaris/sources/air_quality/fetch_air_quality.ts
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
const VIEW_NAME = "air_quality.hourly_observations";
const API_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";

// Cross-platform python executable detection (python3 on Unix/macOS, python on Windows)
const PYTHON_BIN = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");

interface Location {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  tableName: string;
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

function toTableName(id: string): string {
  return `aq_${id.replace(/-/g, "_")}`;
}

async function readLocations(filePath = LOCATIONS_FILE): Promise<Location[]> {
  const content = await fs.readFile(filePath, "utf-8");
  const rawList = JSON.parse(content) as RawLocation[];
  const locations: Location[] = [];
  const seenIds = new Set<string>();

  for (const item of rawList) {
    if (seenIds.has(item.id)) {
      continue;
    }
    seenIds.add(item.id);
    locations.push({
      id: item.id,
      name: item.name.trim(),
      latitude: Number(item.latitude),
      longitude: Number(item.longitude),
      tableName: toTableName(item.id),
    });
  }

  return locations;
}

function selectLocations(
  locations: Location[],
  locationIds?: string[],
  allLocations = true,
): Location[] {
  if (locationIds && locationIds.length > 0) {
    const byId = new Map(locations.map((loc) => [loc.id, loc]));
    const result: Location[] = [];
    for (const id of locationIds) {
      const match = byId.get(id);
      if (match) {
        result.push(match);
      }
    }
    return result;
  }

  if (allLocations) {
    return locations;
  }

  return locations.slice(0, 1);
}

function registrationSql(locations: Location[]): string {
  const statements: string[] = [
    `CREATE LIGHTNING DATABASE OPEN_METEO_AIR_QUALITY
DESCRIBE BY "Open-Meteo air quality API";

CREATE SCHEMASTORE CONTAINER air_quality;`,
  ];

  for (const location of locations) {
    const endpoint = `${API_URL}?latitude=${location.latitude}&longitude=${location.longitude}&hourly=pm2_5,pm10&timezone=Asia%2FKuala_Lumpur`;
    statements.push(
      `CREATE LIGHTNING REST TABLE ${location.tableName}
FROM OPEN_METEO_AIR_QUALITY
REQUEST(
    endpoint "${endpoint}",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
) BODY ()`,
    );
  }

  return statements.join(";\n\n") + ";\n";
}

function querySql(locations: Location[]): string {
  const selects: string[] = [];

  for (const location of locations) {
    const safeName = location.name.replace(/'/g, "''");
    selects.push(
      `SELECT
    '${safeName}' AS location_name,
    ${location.latitude} AS requested_latitude,
    ${location.longitude} AS requested_longitude,
    observation_time,
    element_at(hourly.pm2_5, hour_index + 1) AS pm2_5_ug_m3,
    element_at(hourly.pm10, hour_index + 1) AS pm10_ug_m3
FROM OPEN_METEO_AIR_QUALITY.${location.tableName}
LATERAL VIEW posexplode(hourly.time) AS hour_index, observation_time`,
    );
  }

  const unionSql = selects.join("\nUNION ALL\n");
  return `CREATE SCHEMASTORE VIEW hourly_observations WITH CONTAINER air_quality AS\n${unionSql};\n`;
}

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
      shell: process.platform === "win32",
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zetaris-aq-"));
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

function parseCliArgs(): { locationIds: string[]; dryRun: boolean } {
  const args = process.argv.slice(2);
  const locationIds: string[] = [];
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--location") {
      if (i + 1 < args.length) {
        locationIds.push(args[i + 1]!);
        i++;
      }
    } else if (arg?.startsWith("--location=")) {
      locationIds.push(arg.slice("--location=".length));
    }
  }

  return { locationIds, dryRun };
}

async function main(): Promise<void> {
  const { locationIds, dryRun } = parseCliArgs();

  const locations = await readLocations();
  const selected = selectLocations(locations, locationIds, locationIds.length === 0);

  console.log(`Preparing Air Quality pipeline for ${selected.length} location(s)...`);

  const regSql = registrationSql(selected);
  const qSql = querySql(selected);

  if (dryRun) {
    console.log("[Dry run] Registration statements:");
    await runSqlText(regSql, { dryRun: true, skipExists: true });
    console.log("[Dry run] View statements:");
    await runSqlText(qSql, { dryRun: true });
    return;
  }

  console.log("Registering REST tables in Zetaris...");
  await runSqlText(regSql, { dryRun: false, skipExists: true });

  console.log(`Refreshing ${VIEW_NAME} view...`);
  try {
    const dropDir = await fs.mkdtemp(path.join(os.tmpdir(), "zetaris-aq-drop-"));
    const dropFile = path.join(dropDir, "drop_view.sql");
    try {
      await fs.writeFile(dropFile, `DROP VIEW IF EXISTS ${VIEW_NAME};`, "utf-8");
      await runCommand(PYTHON_BIN, ["scripts/run_sql.py", dropFile], ZETARIS_ROOT);
    } finally {
      await fs.rm(dropDir, { recursive: true, force: true });
    }
  } catch {
    // Drop view may fail if it does not exist yet; ignore and continue
  }

  await runSqlText(qSql, { dryRun: false });
  console.log(`✓ Air quality ingestion pipeline completed for ${selected.length} locations.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
