#!/usr/bin/env node
/**
 * Fetch & register Data.gov.my weather forecast data in Zetaris across
 * all 440 location codes (State, Recreation Centre, District, Town, Division).
 *
 * Creates:
 *   - Database: DATA_GOV_MY_WEATHER
 *   - Container: weather
 *   - REST table: forecasts_raw (connecting to https://api.data.gov.my/weather/forecast/)
 *   - View: weather.forecasts_all (capturing all 5 code types)
 *
 * Usage:
 *   node --experimental-strip-types app/zetaris/sources/weather/fetch_weather.ts
 *   node --experimental-strip-types app/zetaris/sources/weather/fetch_weather.ts --dry-run
 *   npx tsx app/zetaris/sources/weather/fetch_weather.ts
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ZETARIS_ROOT = path.resolve(__dirname, "../../");
const VIEW_NAME = "weather.forecasts_all";

const REGISTRATION_SQL = `
CREATE LIGHTNING DATABASE DATA_GOV_MY_WEATHER
DESCRIBE BY "Data.gov.my weather forecast API";

CREATE SCHEMASTORE CONTAINER weather;

CREATE LIGHTNING REST TABLE forecasts_raw
FROM DATA_GOV_MY_WEATHER
REQUEST(
    endpoint "https://api.data.gov.my/weather/forecast/",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER () BODY ();
`.trim();

const VIEW_SQL = `
CREATE SCHEMASTORE VIEW forecasts_all WITH CONTAINER weather AS
SELECT
    location.location_id   AS location_code,
    location.location_name AS location_name,
    date                   AS forecast_date,
    morning_forecast,
    afternoon_forecast,
    night_forecast
FROM DATA_GOV_MY_WEATHER.forecasts_raw;
`.trim();

interface RunSqlOptions {
  dryRun: boolean;
  skipExists?: boolean;
}

// On Linux / macOS, Python 3 is typically 'python3', whereas on Windows it is often 'python'.
// Respect PYTHON_BIN env var if user set one, or detect based on platform.
const PYTHON_BIN = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");

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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zetaris-weather-"));
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");

  if (isDryRun) {
    console.log("[Dry run] Weather registration:");
    await runSqlText(REGISTRATION_SQL, { dryRun: true, skipExists: true });
    console.log("[Dry run] Weather view (all 5 code types):");
    await runSqlText(VIEW_SQL, { dryRun: true });
    return;
  }

  console.log("Registering Data.gov.my weather REST table...");
  await runSqlText(REGISTRATION_SQL, { dryRun: false, skipExists: true });

  console.log("Refreshing weather.forecasts_all view across all 5 code types...");
  try {
    const dropDir = await fs.mkdtemp(path.join(os.tmpdir(), "zetaris-weather-drop-"));
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

  await runSqlText(VIEW_SQL, { dryRun: false });
  console.log("✓ Weather forecast ingestion pipeline completed for all location codes.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1)
});
