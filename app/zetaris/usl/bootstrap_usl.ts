#!/usr/bin/env node
/**
 * Malaysia Unified Semantic Layer (USL) — End-to-End Initializer
 * ==============================================================================
 * Single-command initialization for the Malaysian Environmental & Legal
 * Intelligence Layers.
 *
 * Target selection flags:
 * -----------------------
 *   --env-only       Bootstrap ONLY the Environmental USL (malaysia_env_usl)
 *   --law-only       Bootstrap ONLY the Law USL (malaysia_law_usl)
 *   (default)        Bootstrap BOTH Environmental and Law USLs
 *
 * Additional options:
 * -------------------
 *   --skip-power     Skip 345 NASA POWER tables for fast test bootstrapping
 *   --dry-run        Print actions and SQL commands without running them
 *
 * Examples:
 * ---------
 *   node --experimental-strip-types app/zetaris/usl/bootstrap_usl.ts
 *   node --experimental-strip-types app/zetaris/usl/bootstrap_usl.ts --env-only
 *   node --experimental-strip-types app/zetaris/usl/bootstrap_usl.ts --law-only
 *   node --experimental-strip-types app/zetaris/usl/bootstrap_usl.ts --env-only --skip-power
 *   npx tsx app/zetaris/usl/bootstrap_usl.ts --law-only
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
const LAW_CONTAINER_PATH = "/home/zetaris/customer-data/shared/law";

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
// Health checks
// ---------------------------------------------------------------------------

async function verifyEnvUsl(): Promise<void> {
  console.log("\n  ==> Running federated Environmental USL verification health check...");
  const envTestSql = `
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
      [RUN_SQL, "--limit", "5", "-e", envTestSql],
      ZETARIS_ROOT,
    );
    console.log("  ✓ Environmental USL: Federated join verified successfully!");
  } catch (err) {
    console.warn(`  ⚠ Environmental health check warning: ${(err as Error).message}`);
  }
}

async function verifyLawUsl(): Promise<void> {
  console.log("\n  ==> Running Law USL verification health check...");
  const lawTestSql = `
    SELECT
        doc.document_id,
        doc.instrument_code,
        p.page_number,
        p.is_provenance_page
    FROM lightning.metastore.malaysia_law.malaysia_law_usl.law_documents doc
    JOIN lightning.metastore.malaysia_law.malaysia_law_usl.law_pages p
      ON doc.document_id = p.document_id
    LIMIT 3;
  `;
  try {
    await runCommand(
      PYTHON_BIN,
      [RUN_SQL, "--limit", "3", "-e", lawTestSql],
      ZETARIS_ROOT,
    );
    console.log("  ✓ Law USL: Join verified successfully!");
  } catch (err) {
    console.warn(`  ⚠ Law health check warning: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  runEnv: boolean;
  runLaw: boolean;
  skipPower: boolean;
  dryRun: boolean;
}

function parseArgs(): CliOptions {
  const argv = process.argv.slice(2);
  const envOnly = argv.includes("--env-only") || argv.includes("--env");
  const lawOnly = argv.includes("--law-only") || argv.includes("--law");

  let runEnv = true;
  let runLaw = true;

  if (envOnly && !lawOnly) {
    runEnv = true;
    runLaw = false;
  } else if (lawOnly && !envOnly) {
    runEnv = false;
    runLaw = true;
  }

  return {
    runEnv,
    runLaw,
    skipPower: argv.includes("--skip-power"),
    dryRun: argv.includes("--dry-run"),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { runEnv, runLaw, skipPower, dryRun } = parseArgs();
  const t0 = Date.now();

  console.log("=".repeat(70));
  console.log(" MALAYSIA UNIFIED SEMANTIC LAYERS (USL) — INITIALIZER ");
  console.log("=".repeat(70));
  console.log(`Execution Mode: ${runEnv && runLaw ? "ALL (Environmental + Law)" : runEnv ? "ENVIRONMENTAL ONLY (--env-only)" : "LAW ONLY (--law-only)"}`);
  if (runEnv) {
    console.log("  • Environmental USL (malaysia_env_usl): Locations, Weather, FIRMS, Air Quality" + (skipPower ? " [POWER skipped]" : ", POWER"));
  }
  if (runLaw) {
    console.log("  • Law USL (malaysia_law_usl): Documents, Full-text Pages");
  }
  console.log("=".repeat(70));

  // =========================================================================
  // SECTION 1: ENVIRONMENTAL USL
  // =========================================================================
  if (runEnv) {
    console.log("\n>>> [1/2] BOOTSTRAPPING ENVIRONMENTAL USL (malaysia_env_usl) <<<");

    // 1. Locations
    console.log("\n[Env Step 1/6] Preparing Canonical Location Dimensions...");
    const locationDir = path.join(SRC_ROOT, "location");
    await dockerCp(locationDir, "zetaris-driver-1", LOCATIONS_CONTAINER_PATH, dryRun);

    // 2. Weather
    console.log("\n[Env Step 2/6] Bootstrapping Data.gov.my Weather Forecasts...");
    await runTsScript(path.join(SRC_ROOT, "weather", "fetch_weather.ts"), [], dryRun);

    // 3. FIRMS Active Fires
    console.log("\n[Env Step 3/6] Bootstrapping NASA FIRMS Active Fires (Past 5 Days)...");
    await runTsScript(
      path.join(SRC_ROOT, "nasa_firms", "fetch_nasa_firms.ts"),
      ["--day-range", "5"],
      dryRun,
    );
    const firmsFlatDir = path.join(SRC_ROOT, "nasa_firms", "data", "firms_flat");
    if (fs.existsSync(firmsFlatDir)) {
      await dockerCp(firmsFlatDir, "zetaris-driver-1", FIRMS_CONTAINER_PATH, dryRun);
    }

    // 4. Open-Meteo Air Quality
    console.log("\n[Env Step 4/6] Bootstrapping Open-Meteo Air Quality (345 Locations)...");
    await runTsScript(path.join(SRC_ROOT, "air_quality", "fetch_air_quality.ts"), [], dryRun);

    // 5. NASA POWER Daily Climate (optional)
    if (!skipPower) {
      console.log("\n[Env Step 5/6] Bootstrapping NASA POWER Daily Climate (345 Locations)...");
      await runTsScript(path.join(SRC_ROOT, "nasa_power", "fetch_nasa_power.ts"), [], dryRun);
    } else {
      console.log("\n[Env Step 5/6] Skipping NASA POWER registration (--skip-power flag set).");
    }

    // 6. Compilation & Activation
    console.log("\n[Env Step 6/6] Compiling & Activating Environmental USL...");
    await runSqlFile(path.join(SRC_ROOT, "location", "sql", "loc_register.sql"), dryRun, true);
    await runSqlFile(path.join(SRC_ROOT, "nasa_firms", "sql", "firms_register.sql"), dryRun, true);
    await runSqlFile(path.join(USL_ROOT, "env_usl", "usl_schema.sql"), dryRun);
    await runSqlFile(path.join(SRC_ROOT, "location", "sql", "loc_activate.sql"), dryRun);
    await runSqlFile(path.join(SRC_ROOT, "weather", "sql", "weather_activate.sql"), dryRun);
    await runSqlFile(path.join(SRC_ROOT, "nasa_firms", "sql", "firms_activate.sql"), dryRun);
    await runSqlFile(path.join(SRC_ROOT, "air_quality", "sql", "aq_activate.sql"), dryRun);
    if (!skipPower) {
      await runSqlFile(path.join(SRC_ROOT, "nasa_power", "sql", "power_activate.sql"), dryRun);
    }
  }

  // =========================================================================
  // SECTION 2: LAW USL
  // =========================================================================
  if (runLaw) {
    console.log("\n>>> [2/2] BOOTSTRAPPING LAW USL (malaysia_law_usl) <<<");

    // 1. Flatten & Copy
    console.log("\n[Law Step 1/2] Flattening Law JSON & Copying to Docker...");
    await runTsScript(path.join(SRC_ROOT, "law", "flatten_law_json.ts"), [], dryRun);
    const lawDataDir = path.join(SRC_ROOT, "law", "data");
    if (fs.existsSync(lawDataDir)) {
      await dockerCp(lawDataDir, "zetaris-driver-1", LAW_CONTAINER_PATH, dryRun);
    }

    // 2. Register, Compile & Activate
    console.log("\n[Law Step 2/2] Registering, Compiling & Activating Law USL...");
    await runSqlFile(path.join(SRC_ROOT, "law", "sql", "law_register.sql"), dryRun, true);
    await runSqlFile(path.join(USL_ROOT, "law_usl", "usl_schema.sql"), dryRun);
    await runSqlFile(path.join(SRC_ROOT, "law", "sql", "law_activate.sql"), dryRun);
  }

  // -------------------------------------------------------------------------
  // Summary & Health Checks
  // -------------------------------------------------------------------------
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("\n" + "=".repeat(70));
  console.log(`🎉 Bootstrap completed in ${elapsed}s!`);

  if (!dryRun) {
    if (runEnv) await verifyEnvUsl();
    if (runLaw) await verifyLawUsl();
  }

  if (runEnv) {
    console.log("\nActive Entities in lightning.metastore.malaysia_env.malaysia_env_usl:");
    console.log("  • location_dim     (Primary Key: location_index)");
    console.log("  • location_code    (Primary Key: location_code, FK: location_index)");
    console.log("  • weather_forecast (FK: location_code)");
    console.log("  • active_fires     (FK: location_index)");
    console.log("  • air_quality_obs  (FK: location_index)");
    if (!skipPower) {
      console.log("  • power_daily      (FK: location_index)");
    }
  }

  if (runLaw) {
    console.log("\nActive Entities in lightning.metastore.malaysia_law.malaysia_law_usl:");
    console.log("  • law_documents    (Primary Key: document_id)");
    console.log("  • law_pages        (Primary Key: (document_id, page_number), FK: document_id)");
  }

  console.log("=".repeat(70));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
