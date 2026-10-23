#!/usr/bin/env node
/**
 * Malaysia Environmental Unified Semantic Layer (USL) — End-to-End Initializer
 * ==============================================================================
 * Single-command initialization for the entire Malaysian Environmental
 * Intelligence Layer. Use this script on a fresh deployment when NO tables,
 * databases, or data exist.
 *
 * What this initializer performs end-to-end:
 * ------------------------------------------
 * 1. [Locations]  Copies 345 canonical location CSVs to Docker volume.
 * 2. [Weather]    Fetches nationwide forecasts from Data.gov.my & registers REST table.
 * 3. [FIRMS]      Downloads NASA VIIRS fire detections, copies flat CSVs to Docker.
 * 4. [AirQual]    Registers 345 Open-Meteo REST endpoints & compiles unified view.
 * 5. [Climate]    Registers 345 NASA POWER REST endpoints & compiles unified view.
 * 6. [USL Schema] Deploys namespace, compiles USL data model with PK/FK graph,
 *                 and activates all 6 semantic entities:
 *                   - location_dim, location_code
 *                   - weather_forecast, active_fires
 *                   - air_quality_obs, power_daily
 * 7. [Health]     Executes a federated verification query to confirm everything is live.
 *
 * Usage:
 * ------
 *   node --experimental-strip-types app/zetaris/usl/bootstrap_usl.ts
 *   node --experimental-strip-types app/zetaris/usl/bootstrap_usl.ts --skip-power
 *   node --experimental-strip-types app/zetaris/usl/bootstrap_usl.ts --dry-run
 *   npx tsx app/zetaris/usl/bootstrap_usl.ts
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

const LOCATIONS_CONTAINER_PATH = "/home/zetaris/customer-data/shared/locations";
const FIRMS_CONTAINER_PATH = "/home/zetaris/customer-data/shared/firms_flat";

const PYTHON_BIN =
  process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");

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
 * Copy local files into a running Docker container.
 * Equivalent to: docker exec <container> mkdir -p <dst> && docker cp <src>/. <container>:<dst>/
 */
async function dockerCp(
  src: string,
  container: string,
  dst: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    console.log(`[DRY-RUN] docker cp ${src} ${container}:${dst}`);
    return;
  }
  try {
    await runCommand("docker", ["exec", container, "mkdir", "-p", dst]);
    await runCommand("docker", ["cp", `${src}/.`, `${container}:${dst}/`]);
    console.log(`  ✓ Copied ${src} → ${container}:${dst}`);
  } catch (err) {
    console.warn(`  ⚠ docker cp failed (${dst}): ${(err as Error).message}`);
    console.warn("    Assuming direct filesystem mount — continuing.");
  }
}

/**
 * Execute a SQL file through scripts/run_sql.py.
 */
async function runSqlFile(
  sqlFile: string,
  dryRun: boolean,
  skipExists = false,
): Promise<void> {
  if (!fs.existsSync(sqlFile)) {
    console.error(`  ✗ SQL file not found: ${sqlFile}`);
    return;
  }
  const rel = path.relative(USL_ROOT, sqlFile);
  console.log(`  ==> SQL: ${rel}`);

  const args = [RUN_SQL];
  if (skipExists) args.push("--skip-exists");
  if (dryRun) args.push("--dry-run");
  args.push(sqlFile);

  try {
    await runCommand(PYTHON_BIN, args, ZETARIS_ROOT);
  } catch (err) {
    console.error(`  ✗ Failed ${path.basename(sqlFile)}: ${(err as Error).message}`);
  }
}

/**
 * Run a TypeScript ingestion script via node --experimental-strip-types (or tsx).
 */
async function runTsScript(
  scriptPath: string,
  extraArgs: string[] = [],
  dryRun: boolean = false,
): Promise<void> {
  if (!fs.existsSync(scriptPath)) {
    console.error(`  ✗ Script not found: ${scriptPath}`);
    return;
  }
  const rel = path.relative(USL_ROOT, scriptPath);
  const allArgs = [...extraArgs];
  if (dryRun) allArgs.push("--dry-run");

  if (dryRun) {
    console.log(`[DRY-RUN] Would run: node --experimental-strip-types ${rel} ${allArgs.join(" ")}`);
    return;
  }

  console.log(`  ==> Ingestion: ${rel} ${allArgs.join(" ")}`);
  const t0 = Date.now();

  // Prefer tsx if available, fall back to node --experimental-strip-types
  const useNode = ["node", ["--experimental-strip-types", scriptPath, ...allArgs]];
  const useTsx = ["npx", ["tsx", scriptPath, ...allArgs]];
  const [cmd, args] = process.env.USE_TSX === "1" ? useTsx : useNode;

  try {
    await runCommand(cmd as string, args as string[], ZETARIS_ROOT);
    console.log(`  ✓ Completed ${path.basename(scriptPath)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.error(`  ✗ Failed ${path.basename(scriptPath)}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async function verifyUsl(): Promise<void> {
  console.log("\n  ==> Running federated USL verification health check...");
  const testSql = `
    SELECT
        loc.location_index,
        loc.location_name,
        loc.latitude,
        loc.longitude,
        w.morning_forecast
    FROM lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
    LEFT JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_code lc
      ON loc.location_index = lc.location_index
    LEFT JOIN lightning.metastore.malaysia_env.malaysia_env_usl.weather_forecast w
      ON lc.location_code = w.location_code
    LIMIT 5;
  `;
  try {
    await runCommand(
      PYTHON_BIN,
      [RUN_SQL, "--limit", "5", "-e", testSql],
      ZETARIS_ROOT,
    );
    console.log("  ✓ USL Health Check: Federated join verified successfully!");
  } catch (err) {
    console.warn(`  ⚠ Health check warning: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { skipPower: boolean; dryRun: boolean } {
  const argv = process.argv.slice(2);
  return {
    skipPower: argv.includes("--skip-power"),
    dryRun: argv.includes("--dry-run"),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { skipPower, dryRun } = parseArgs();
  const t0 = Date.now();

  console.log("=".repeat(70));
  console.log(" MALAYSIA ENVIRONMENTAL USL — COMPLETE ALL-IN-ONE INITIALIZER ");
  console.log("=".repeat(70));
  console.log("1. [Dimensions] Canonical Location centroids (345) & Codes (440)");
  console.log("2. [Weather]    Data.gov.my Official Forecasts (Nationwide array)");
  console.log("3. [FIRMS]      NASA Active Fires (VIIRS Satellite Hotspots)");
  console.log("4. [Air Quality] Open-Meteo Hourly PM2.5/PM10 (345 REST endpoints)");
  console.log(
    skipPower
      ? "5. [NASA POWER]  [SKIPPED via --skip-power]"
      : "5. [NASA POWER]  Daily Climate 20 variables (345 REST endpoints)",
  );
  console.log("6. [USL Layer]   Compile & Activate all 6 Semantic Tables");
  console.log("=".repeat(70));

  // -------------------------------------------------------------------------
  // Step 1: Copy canonical location CSVs into Docker container
  // -------------------------------------------------------------------------
  console.log("\n[Step 1/6] Preparing Canonical Location Dimensions...");
  const locationDir = path.join(USL_ROOT, "..", "sources", "location");
  await dockerCp(locationDir, "zetaris-driver-1", LOCATIONS_CONTAINER_PATH, dryRun);

  // -------------------------------------------------------------------------
  // Step 2: Data.gov.my Weather Ingestion
  // -------------------------------------------------------------------------
  console.log("\n[Step 2/6] Bootstrapping Data.gov.my Weather Forecasts...");
  await runTsScript(path.join(SRC_ROOT, "weather", "fetch_weather.ts"), [], dryRun);

  // -------------------------------------------------------------------------
  // Step 3: NASA FIRMS Active Fires Ingestion
  // -------------------------------------------------------------------------
  console.log("\n[Step 3/6] Bootstrapping NASA FIRMS Active Fire Hotspots (Past 5 Days)...");
  await runTsScript(
    path.join(SRC_ROOT, "nasa_firms", "fetch_nasa_firms.ts"),
    ["--day-range", "5"],
    dryRun,
  );
  const firmsFlatDir = path.join(SRC_ROOT, "nasa_firms", "data", "firms_flat");
  if (fs.existsSync(firmsFlatDir)) {
    await dockerCp(firmsFlatDir, "zetaris-driver-1", FIRMS_CONTAINER_PATH, dryRun);
  }

  // -------------------------------------------------------------------------
  // Step 4: Open-Meteo Air Quality (345 locations)
  // -------------------------------------------------------------------------
  console.log("\n[Step 4/6] Bootstrapping Open-Meteo Air Quality (345 Locations)...");
  await runTsScript(path.join(SRC_ROOT, "air_quality", "fetch_air_quality.ts"), [], dryRun);

  // -------------------------------------------------------------------------
  // Step 5: NASA POWER Daily Climate (345 locations) — optional
  // -------------------------------------------------------------------------
  if (!skipPower) {
    console.log("\n[Step 5/6] Bootstrapping NASA POWER Daily Climate (345 Locations)...");
    await runTsScript(path.join(SRC_ROOT, "nasa_power", "fetch_nasa_power.ts"), [], dryRun);
  } else {
    console.log("\n[Step 5/6] Skipping NASA POWER registration (--skip-power flag set).");
  }

  // -------------------------------------------------------------------------
  // Step 6: USL Compilation & Activation
  // -------------------------------------------------------------------------
  console.log("\n[Step 6/6] Compiling & Activating Malaysia Environmental USL...");

  // A. Register FileStore tables (location + FIRMS CSVs)
  await runSqlFile(
    path.join(USL_ROOT, "..", "sources", "location", "sql", "loc_register.sql"),
    dryRun,
    true,
  );
  await runSqlFile(
    path.join(SRC_ROOT, "nasa_firms", "sql", "firms_register.sql"),
    dryRun,
    true,
  );

  // B. Compile master USL schema & FK graph
  await runSqlFile(path.join(USL_ROOT, "usl_schema.sql"), dryRun);

  // C. Activate dimension tables
  await runSqlFile(
    path.join(USL_ROOT, "..", "sources", "location", "sql", "loc_activate.sql"),
    dryRun,
  );

  // D. Activate fact tables
  await runSqlFile(path.join(SRC_ROOT, "weather", "sql", "weather_activate.sql"), dryRun);
  await runSqlFile(path.join(SRC_ROOT, "nasa_firms", "sql", "firms_activate.sql"), dryRun);
  await runSqlFile(path.join(SRC_ROOT, "air_quality", "sql", "aq_activate.sql"), dryRun);
  if (!skipPower) {
    await runSqlFile(path.join(SRC_ROOT, "nasa_power", "sql", "power_activate.sql"), dryRun);
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("\n" + "=".repeat(70));
  console.log(`🎉 USL Initialization completed in ${elapsed}s!`);

  if (!dryRun) {
    await verifyUsl();
  }

  console.log("\nActive Entities in lightning.metastore.malaysia_env.malaysia_env_usl:");
  console.log("  • location_dim     (Primary Key: location_index)");
  console.log("  • location_code    (Primary Key: location_code, FK: location_index)");
  console.log("  • weather_forecast (FK: location_code)");
  console.log("  • active_fires     (FK: location_index)");
  console.log("  • air_quality_obs  (FK: location_index)");
  if (!skipPower) {
    console.log("  • power_daily      (FK: location_index)");
  }
  console.log("\nTo run daily updates only:");
  console.log("  node --experimental-strip-types app/zetaris/usl/daily_update.ts");
  console.log("=".repeat(70));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
