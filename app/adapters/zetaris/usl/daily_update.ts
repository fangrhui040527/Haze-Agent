#!/usr/bin/env node
/**
 * Malaysia Environmental USL — Daily Data Refresh Pipeline
 * ==============================================================================
 * Single entry point for updating the data in the Malaysia Environmental USL.
 *
 * Lifecycle behavior:
 * -------------------
 *   1. Open-Meteo Air Quality : refresh stored FileStore snapshots
 *   2. Data.gov.my Weather    : (Live REST — no local update needed)
 *   3. NASA FIRMS             : DAILY REFRESH (new fire detections, spatial tag)
 *   4. NASA POWER             : DAILY REFRESH (rolling date window, 345 locations)
 *
 * Windy is intentionally excluded: the Point Forecast API key is on the free
 * Testing tier (500 requests/day), so its CSVs are only refreshed on demand
 * via sources/windy/fetch_windy.ts.
 *
 * Flags:
 * ------
 *   --firms          Refresh NASA FIRMS only
 *   --power          Refresh NASA POWER only
 *   --air-quality    Refresh Open-Meteo air-quality snapshots only
 *   --test           Test mode: limit NASA POWER ingestion to "kuala-lumpur" only
 *   --skip-usl-sync  Skip re-activating the USL tables after the refresh
 *   --dry-run        Print actions without downloading or changing Zetaris
 *
 * Examples:
 * ---------
 *   node --experimental-strip-types app/zetaris/usl/daily_update.ts
 *   node --experimental-strip-types app/zetaris/usl/daily_update.ts --test
 *   node --experimental-strip-types app/zetaris/usl/daily_update.ts --firms
 *   node --experimental-strip-types app/zetaris/usl/daily_update.ts --power --dry-run
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const USL_ROOT = __dirname;
const SRC_ROOT = path.join(USL_ROOT, "..", "sources");
const ZETARIS_ROOT = path.join(USL_ROOT, "..");
const RUN_SQL = path.join(ZETARIS_ROOT, "scripts", "run_sql.py");

const PYTHON_BIN =
  process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");

const TEST_LOCATION_ID = "kuala-lumpur";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runCommand(
  command: string,
  args: string[],
  cwd: string = ZETARIS_ROOT,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`'${command} ${args.join(" ")}' exited with code ${code}`));
      }
    });
  });
}

/**
 * Run a TypeScript ingestion script via node --experimental-strip-types (or tsx).
 * Returns false when the script is missing or exits non-zero.
 */
async function runTsScript(
  scriptPath: string,
  extraArgs: string[] = [],
  dryRun: boolean = false,
): Promise<boolean> {
  if (!fs.existsSync(scriptPath)) {
    console.error(`  ✗ Script not found: ${scriptPath}`);
    return false;
  }
  const rel = path.relative(USL_ROOT, scriptPath);
  const allArgs = [...extraArgs];
  if (dryRun) allArgs.push("--dry-run");

  if (dryRun) {
    console.log(`[DRY-RUN] Would run: node --experimental-strip-types ${rel} ${allArgs.join(" ")}`);
    return true;
  }

  console.log(`  ==> Ingestion: ${rel} ${allArgs.join(" ")}`);
  const t0 = Date.now();

  const useNode = ["node", ["--experimental-strip-types", scriptPath, ...allArgs]];
  const useTsx = ["npx", ["tsx", scriptPath, ...allArgs]];
  const [cmd, args] = process.env.USE_TSX === "1" ? useTsx : useNode;

  try {
    await runCommand(cmd as string, args as string[], ZETARIS_ROOT);
    console.log(`  ✓ Completed ${path.basename(scriptPath)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return true;
  } catch (err) {
    console.error(`  ✗ Failed ${path.basename(scriptPath)}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Execute a SQL file through scripts/run_sql.py.
 * Returns false when the file is missing or the statement fails.
 */
async function runSqlFile(sqlFile: string, dryRun: boolean): Promise<boolean> {
  if (!fs.existsSync(sqlFile)) {
    console.error(`  ✗ SQL file not found: ${sqlFile}`);
    return false;
  }
  const rel = path.relative(USL_ROOT, sqlFile);
  console.log(`  ==> SQL: ${rel}`);

  const args = [RUN_SQL];
  if (dryRun) args.push("--dry-run");
  args.push(sqlFile);

  try {
    await runCommand(PYTHON_BIN, args, ZETARIS_ROOT);
    return true;
  } catch (err) {
    console.error(`  ✗ Failed ${path.basename(sqlFile)}: ${(err as Error).message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  updateAirQuality: boolean;
  updateFirms: boolean;
  updatePower: boolean;
  skipUslSync: boolean;
  testMode: boolean;
  dryRun: boolean;
}

function parseArgs(): CliOptions {
  const argv = process.argv.slice(2);
  const firms = argv.includes("--firms");
  const power = argv.includes("--power");
  const airQuality = argv.includes("--air-quality");
  const runAll = !(firms || power || airQuality);

  return {
    updateAirQuality: runAll || airQuality,
    updateFirms: runAll || firms,
    updatePower: runAll || power,
    skipUslSync: argv.includes("--skip-usl-sync"),
    testMode: argv.includes("--test"),
    dryRun: argv.includes("--dry-run"),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { updateFirms, updatePower, updateAirQuality, skipUslSync, testMode, dryRun } = parseArgs();
  const t0 = Date.now();

  console.log("=".repeat(65));
  console.log(" MALAYSIA ENVIRONMENTAL USL - DAILY DATA UPDATE PIPELINE ");
  console.log("=".repeat(65));
  if (testMode) {
    console.log(`Execution Mode: TEST (--test) — air quality and NASA POWER limited to "${TEST_LOCATION_ID}"`);
  }
  console.log("Data Source Behavior:");
  console.log(" • Open-Meteo Air Quality : stored FileStore snapshots; refresh explicitly");
  console.log(" • Data.gov.my Weather    : [LIVE] Zero sync needed (queries fetch today's forecast directly)");
  if (updateFirms) {
    console.log(" • NASA FIRMS             : [UPDATE] Fetching newest satellite passes & spatial joins...");
  }
  if (updatePower) {
    console.log(" • NASA POWER             : [UPDATE] Refreshing rolling observation dates & views...");
  }
  console.log("=".repeat(65));

  let success = true;

  if (updateAirQuality) {
    console.log("\nRefreshing Open-Meteo air-quality snapshots...");
    const ok = await runTsScript(
      path.join(SRC_ROOT, "air_quality", "fetch_air_quality.ts"),
      testMode ? ["--location", TEST_LOCATION_ID] : [],
      dryRun,
    );
    if (!ok) throw new Error("Air-quality snapshot refresh failed; USL activation was not attempted.");
  }

  // 1. Update NASA FIRMS
  // The source stages and publishes its own FileStore snapshot.
  if (updateFirms) {
    console.log("\n[1] Refreshing NASA FIRMS Active Fires (Past 5 Days)...");
    const ok = await runTsScript(
      path.join(SRC_ROOT, "nasa_firms", "fetch_nasa_firms.ts"),
      ["--day-range", "5"],
      dryRun,
    );
    if (!ok) success = false;
  }

  // 2. Update NASA POWER
  if (updatePower) {
    console.log(
      `\n[2] Refreshing NASA POWER Daily Climate ` +
        (testMode ? `(${TEST_LOCATION_ID} only)...` : "(345 Locations)..."),
    );
    const ok = await runTsScript(
      path.join(SRC_ROOT, "nasa_power", "fetch_nasa_power.ts"),
      testMode ? ["--location", TEST_LOCATION_ID] : [],
      dryRun,
    );
    if (!ok) success = false;
  }

  // 3. Re-activate the updated USL tables
  if (!skipUslSync) {
    console.log("\n[3] Re-activating updated USL tables...");
    if (updateAirQuality) {
      const ok = await runSqlFile(
        path.join(SRC_ROOT, "air_quality", "sql", "aq_activate.sql"),
        dryRun,
      );
      if (!ok && !dryRun) success = false;
    }
    if (updateFirms) {
      const ok = await runSqlFile(
        path.join(SRC_ROOT, "nasa_firms", "sql", "firms_activate.sql"),
        dryRun,
      );
      if (!ok && !dryRun) success = false;
    }
    if (updatePower) {
      const ok = await runSqlFile(
        path.join(SRC_ROOT, "nasa_power", "sql", "power_activate.sql"),
        dryRun,
      );
      if (!ok && !dryRun) success = false;
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("\n" + "=".repeat(65));
  if (success) {
    console.log(`✓ Daily update completed successfully in ${elapsed}s!`);
  } else {
    console.log(`⚠ Daily update completed with some errors in ${elapsed}s.`);
  }
  console.log("All four sources are ready for queries in Zetaris:");
  console.log(" • lightning.metastore.malaysia_env.malaysia_env_usl.air_quality_obs");
  console.log(" • lightning.metastore.malaysia_env.malaysia_env_usl.weather_forecast");
  console.log(" • lightning.metastore.malaysia_env.malaysia_env_usl.active_fires");
  console.log(" • lightning.metastore.malaysia_env.malaysia_env_usl.power_daily");
  console.log("=".repeat(65));

  if (!success) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
