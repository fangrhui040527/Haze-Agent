#!/usr/bin/env node
/**
 * Malaysia Unified Semantic Layer (USL) — End-to-End Initializer
 * ==============================================================================
 * Single-command initialization for the Malaysian Environmental and Legal
 * semantic layers.
 *
 * Target selection flags:
 * -----------------------
 *   --env-only       Bootstrap ONLY the Environmental USL (malaysia_env_usl)
 *   --law-only       Bootstrap ONLY the Law USL (malaysia_law_usl)
 *   (default)        Bootstrap both USLs
 *
 * Additional options:
 * -------------------
 *   --skip-power     Skip 345 NASA POWER tables for fast test bootstrapping
 *   --test           Test mode: only register KL for per-location sources
 *                    (1 location instead of all 345) for a fast smoke test
 *   --dry-run        Print actions and SQL commands without running them
 *
 * Examples:
 * ---------
 *   node --experimental-strip-types app/zetaris/usl/bootstrap_usl.ts
 *   node --experimental-strip-types app/zetaris/usl/bootstrap_usl.ts --env-only
 *   node --experimental-strip-types app/zetaris/usl/bootstrap_usl.ts --law-only
 *   node --experimental-strip-types app/zetaris/usl/bootstrap_usl.ts --env-only --skip-power
 *   node --experimental-strip-types app/zetaris/usl/bootstrap_usl.ts --test
 *   npx tsx app/zetaris/usl/bootstrap_usl.ts --law-only
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { envFileCandidates, loadEnvironment } from "../scripts/env-files.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const USL_ROOT = __dirname;
const SRC_ROOT = path.join(USL_ROOT, "..", "sources");
const ZETARIS_ROOT = path.join(USL_ROOT, "..");
const RUN_SQL = path.join(ZETARIS_ROOT, "scripts", "run_sql.py");

const LOCATIONS_CONTAINER_PATH = "/home/zetaris/customer-data/shared/locations";
const LAW_CONTAINER_PATH = "/home/zetaris/customer-data/shared/law";

// Windy register SQL carries a `${WINDY_API_KEY}` placeholder that must be
// filled from .env.local before it is sent. The key is never printed or logged.
const WINDY_SQL_DIR = path.join(SRC_ROOT, "windy", "sql");
const WINDY_API_KEY_PLACEHOLDER = "${WINDY_API_KEY}";

// Test mode (--test) limits per-location ingestion to this single location so a
// full bootstrap can be smoke-tested quickly instead of pulling all 345.
const TEST_LOCATION_ID = "kuala-lumpur";

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
    await runCommand("docker", ["exec", "-u", "root", container, "mkdir", "-p", dst]);
    await runCommand("docker", ["cp", `${src}/.`, `${container}:${dst}/`]);
    await runCommand("docker", ["exec", "-u", "root", container, "chown", "-R", "zetaris:zetaris", dst]);
    await runCommand("docker", ["exec", "-u", "root", container, "chmod", "-R", "777", dst]);
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
    throw new Error(`SQL file not found: ${sqlFile}`);
  }
  const rel = path.relative(USL_ROOT, sqlFile);
  console.log(`  ==> SQL: ${rel}`);

  const args = [RUN_SQL];
  if (skipExists) args.push("--skip-exists");
  if (dryRun) args.push("--dry-run");
  args.push(sqlFile);

  await runCommand(PYTHON_BIN, args, ZETARIS_ROOT);
}

/**
 * Read one value from the first .env.local found (repo root, then the enclosing
 * checkout). Returns undefined when the file or key is missing. Never logs the
 * value, so it is safe for secrets such as WINDY_API_KEY.
 */
function loadEnvLocalValue(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  for (const file of envFileCandidates()) {
    if (!fs.existsSync(file)) continue;
    for (const raw of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const idx = line.indexOf("=");
      if (line.slice(0, idx).trim() !== name) continue;
      let value = line.slice(idx + 1).trim();
      if (
        value.length >= 2 &&
        value[0] === value[value.length - 1] &&
        (value[0] === '"' || value[0] === "'")
      ) {
        value = value.slice(1, -1);
      }
      return value;
    }
  }
  return undefined;
}

/**
 * Run the Windy register SQL, substituting the `${WINDY_API_KEY}` placeholder
 * with the value from .env.local. The filled SQL is written to a temp file, run
 * through scripts/run_sql.py, then deleted. The key is never printed or logged.
 */
async function runWindyRegister(dryRun: boolean): Promise<void> {
  const sqlFile = path.join(WINDY_SQL_DIR, "windy_register.sql");
  if (!fs.existsSync(sqlFile)) {
    throw new Error(`SQL file not found: ${sqlFile}`);
  }
  console.log(`  ==> SQL: ${path.relative(USL_ROOT, sqlFile)} (WINDY_API_KEY injected)`);

  const text = fs.readFileSync(sqlFile, "utf-8");

  if (dryRun) {
    console.log(
      `[DRY-RUN] Would run windy_register.sql with ${WINDY_API_KEY_PLACEHOLDER} filled from .env.local`,
    );
    return;
  }

  const key = loadEnvLocalValue("WINDY_API_KEY");
  if (!key) {
    throw new Error("WINDY_API_KEY is not set in the environment or configured .env files.");
  }

  const tempFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "zetaris-windy-")),
    "windy_register.sql",
  );
  try {
    fs.writeFileSync(tempFile, text.split(WINDY_API_KEY_PLACEHOLDER).join(key), "utf-8");
    await runCommand(PYTHON_BIN, [RUN_SQL, "--skip-exists", tempFile], ZETARIS_ROOT);
  } finally {
    fs.rmSync(path.dirname(tempFile), { recursive: true, force: true });
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
    throw new Error(`Script not found: ${scriptPath}`);
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

  const command =
    process.env.USE_TSX === "1"
      ? { name: "npx", args: ["tsx", scriptPath, ...allArgs] }
      : {
          name: "node",
          args: ["--experimental-strip-types", scriptPath, ...allArgs],
        };
  await runCommand(command.name, command.args, ZETARIS_ROOT);
  console.log(`  ✓ Completed ${path.basename(scriptPath)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

async function verifyEnvUsl(): Promise<void> {
  console.log("\n  ==> Running federated Environmental USL verification health check...");
  const envTestSql = [
    "SELECT loc.location_index, loc.location_name, loc.latitude, loc.longitude, w.morning_forecast",
    "FROM lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc",
    "LEFT JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_code lc ON loc.location_index = lc.location_index",
    "LEFT JOIN lightning.metastore.malaysia_env.malaysia_env_usl.weather_forecast w ON lc.location_code = w.location_code",
    "LIMIT 5;",
  ].join(" ");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zetaris-verify-env-"));
  const tmpFile = path.join(tmpDir, "verify.sql");
  try {
    fs.writeFileSync(tmpFile, envTestSql, "utf-8");
    await runCommand(PYTHON_BIN, [RUN_SQL, tmpFile], ZETARIS_ROOT);
    console.log("  ✓ Environmental USL: Federated join verified successfully!");
  } catch (err) {
    console.warn(`  ⚠ Environmental health check warning: ${(err as Error).message}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function verifyLawUsl(): Promise<void> {
  console.log("\n  ==> Running Law USL verification health check...");
  const lawTestSql = [
    "SELECT doc.document_id, doc.instrument_code, p.page_number, p.is_provenance_page",
    "FROM lightning.metastore.malaysia_law.malaysia_law_usl.law_documents doc",
    "JOIN lightning.metastore.malaysia_law.malaysia_law_usl.law_pages p ON doc.document_id = p.document_id",
    "LIMIT 3;",
  ].join(" ");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zetaris-verify-law-"));
  const tmpFile = path.join(tmpDir, "verify.sql");
  try {
    fs.writeFileSync(tmpFile, lawTestSql, "utf-8");
    await runCommand(PYTHON_BIN, [RUN_SQL, tmpFile], ZETARIS_ROOT);
    console.log("  ✓ Law USL: Join verified successfully!");
  } catch (err) {
    console.warn(`  ⚠ Law health check warning: ${(err as Error).message}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  runEnv: boolean;
  runLaw: boolean;
  skipPower: boolean;
  testMode: boolean;
  dryRun: boolean;
}

function parseArgs(): CliOptions {
  const argv = process.argv.slice(2);
  const envOnly = argv.includes("--env-only") || argv.includes("--env");
  const lawOnly = argv.includes("--law-only") || argv.includes("--law");
  if (argv.includes("--smokeledger-only")) {
    throw new Error(
      "The PostgreSQL-backed SmokeLedger bootstrap is not part of this Zetaris bootstrap.",
    );
  }
  const selectedLayer = envOnly || lawOnly;

  return {
    runEnv: !selectedLayer || envOnly,
    runLaw: !selectedLayer || lawOnly,
    skipPower: argv.includes("--skip-power"),
    testMode: argv.includes("--test"),
    dryRun: argv.includes("--dry-run"),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnvironment();
  const {
    runEnv,
    runLaw,
    skipPower,
    testMode,
    dryRun,
  } = parseArgs();
  const t0 = Date.now();
  const layers = [
    runEnv ? "Environmental" : null,
    runLaw ? "Law" : null,
  ].filter((layer): layer is string => layer !== null);

  console.log("=".repeat(70));
  console.log(" MALAYSIA UNIFIED SEMANTIC LAYERS (USL) — INITIALIZER ");
  console.log("=".repeat(70));
  console.log(`Execution Mode: ${layers.join(" + ")}`);
  if (testMode) {
    console.log(`Test Mode: ON (--test) — per-location REST sources limited to "${TEST_LOCATION_ID}"`);
  }
  if (runEnv) {
    console.log("  • Environmental USL (malaysia_env_usl): Locations, Weather, FIRMS, Air Quality, Open-Meteo PM2.5/Wind, Windy" + (skipPower ? " [POWER skipped]" : ", POWER"));
  }
  if (runLaw) {
    console.log("  • Law USL (malaysia_law_usl): Documents, Full-text Pages");
  }
  console.log("=".repeat(70));

  // =========================================================================
  // SECTION 1: ENVIRONMENTAL USL
  // =========================================================================
  if (runEnv) {
    console.log("\n>>> BOOTSTRAPPING ENVIRONMENTAL USL (malaysia_env_usl) <<<");

    // 1. Locations
    console.log("\n[Env Step 1/9] Preparing Canonical Location Dimensions...");
    const locationDir = path.join(SRC_ROOT, "location");
    await dockerCp(locationDir, "zetaris-driver-1", LOCATIONS_CONTAINER_PATH, dryRun);

    // 2. Weather
    // (Data.gov.my weather is a single nationwide REST feed, so there is no
    //  per-location download to limit in test mode.)
    console.log("\n[Env Step 2/9] Bootstrapping Data.gov.my Weather Forecasts...");
    await runTsScript(path.join(SRC_ROOT, "weather", "fetch_weather.ts"), [], dryRun);

    // 3. FIRMS Active Fires
    // NOTE: FIRMS uses two national bounding boxes (peninsular + east Malaysia) and does
    // NOT create per-location tables, so --location is never passed even in test mode.
    console.log("\n[Env Step 3/9] Bootstrapping NASA FIRMS Active Fires (Past 5 Days)...");
    await runTsScript(
      path.join(SRC_ROOT, "nasa_firms", "fetch_nasa_firms.ts"),
      ["--day-range", "5"],
      dryRun,
    );

    // 4. Open-Meteo Air Quality
    console.log(
      `\n[Env Step 4/9] Bootstrapping Open-Meteo Air Quality ` +
        (testMode ? `(${TEST_LOCATION_ID} only)...` : "(345 Locations)..."),
    );
    await runTsScript(
      path.join(SRC_ROOT, "air_quality", "fetch_air_quality.ts"),
      testMode ? ["--location", TEST_LOCATION_ID] : [],
      dryRun,
    );

    // 5. Open-Meteo PM2.5 live REST source
    console.log(
      `\n[Env Step 5/9] Bootstrapping Open-Meteo PM2.5 ` +
        (testMode ? `(${TEST_LOCATION_ID} only)...` : "(345 Locations)..."),
    );
    await runTsScript(
      path.join(SRC_ROOT, "open_meteo_pm25", "fetch_open_meteo_pm25.ts"),
      testMode ? ["--test"] : [],
      dryRun,
    );

    // 6. NASA POWER Daily Climate (optional)
    if (!skipPower) {
      console.log(
        `\n[Env Step 6/9] Bootstrapping NASA POWER Daily Climate ` +
          (testMode ? `(${TEST_LOCATION_ID} only)...` : "(345 Locations)..."),
      );
      await runTsScript(
        path.join(SRC_ROOT, "nasa_power", "fetch_nasa_power.ts"),
        testMode ? ["--location", TEST_LOCATION_ID] : [],
        dryRun,
      );
    } else {
      console.log("\n[Env Step 6/9] Skipping NASA POWER registration (--skip-power flag set).");
    }

    // 7. Open-Meteo hourly wind REST source
    console.log(
      `\n[Env Step 7/9] Bootstrapping Open-Meteo wind ` +
        (testMode ? `(${TEST_LOCATION_ID} only)...` : "(345 Locations)..."),
    );
    await runTsScript(
      path.join(SRC_ROOT, "open_meteo_wind", "fetch_open_meteo_wind.ts"),
      testMode ? ["--test"] : [],
      dryRun,
    );

    // 8. Windy Point Forecast (GFS weather + CAMS air quality, KL point)
    console.log("\n[Env Step 8/9] Fetching and staging Windy Point Forecast files...");
    await runTsScript(
      path.join(SRC_ROOT, "windy", "fetch_windy.ts"),
      ["--all", "--prepare-only"],
      dryRun,
    );
    console.log("Registering Windy FileStore tables and creating views...");
    await runWindyRegister(dryRun);
    await runSqlFile(path.join(WINDY_SQL_DIR, "windy_view.sql"), dryRun, true);

    // 9. Compilation & Activation
    console.log("\n[Env Step 9/9] Compiling & Activating Environmental USL...");
    await runSqlFile(path.join(SRC_ROOT, "location", "sql", "loc_register.sql"), dryRun, true);
    await runSqlFile(path.join(SRC_ROOT, "nasa_firms", "sql", "firms_register.sql"), dryRun, true);
    await runSqlFile(path.join(USL_ROOT, "env_usl", "usl_schema.sql"), dryRun);
    await runSqlFile(path.join(SRC_ROOT, "location", "sql", "loc_activate.sql"), dryRun);
    await runSqlFile(path.join(SRC_ROOT, "weather", "sql", "weather_activate.sql"), dryRun);
    await runSqlFile(path.join(SRC_ROOT, "nasa_firms", "sql", "firms_activate.sql"), dryRun);
    await runSqlFile(path.join(SRC_ROOT, "air_quality", "sql", "aq_activate.sql"), dryRun);
    await runSqlFile(path.join(SRC_ROOT, "open_meteo_pm25", "sql", "pm25_activate.sql"), dryRun);
    if (!skipPower) {
      await runSqlFile(path.join(SRC_ROOT, "nasa_power", "sql", "power_activate.sql"), dryRun);
    }
    await runSqlFile(path.join(SRC_ROOT, "open_meteo_wind", "sql", "wind_activate.sql"), dryRun);
    await runSqlFile(path.join(WINDY_SQL_DIR, "windy_activate.sql"), dryRun);
  }

  // =========================================================================
  // SECTION 2: LAW USL
  // =========================================================================
  if (runLaw) {
    console.log("\n>>> BOOTSTRAPPING LAW USL (malaysia_law_usl) <<<");

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
  if (testMode) {
    console.log(`⚠ Test mode was enabled: per-location REST sources registered for "${TEST_LOCATION_ID}" only.`);
  }

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
    console.log("  • air_quality_obs      (FK: location_index)");
    console.log("  • open_meteo_pm25_obs  (FK: location_index)");
    console.log("  • open_meteo_wind_obs  (FK: location_index)");
    if (!skipPower) {
      console.log("  • power_daily      (FK: location_index)");
    }
    console.log("  • windy_forecast_obs    (FK: location_index)");
    console.log("  • windy_air_quality_obs (FK: location_index)");
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
