#!/usr/bin/env node
/**
 * Fetch & register NASA FIRMS satellite active fire data in Zetaris
 * covering nationwide Malaysia (all 345 locations).
 *
 * Self-contained inside sources/nasa_firms/:
 *   - Stored locally at data/firms_csv/ and data/firms_flat/
 *   - Published to Zetaris container: /home/zetaris/customer-data/shared/firms_flat
 *   - Registered as Zetaris File Store table: NASA_FIRMS_FILES.active_fires
 *
 * Usage:
 *   node --experimental-strip-types app/zetaris/sources/nasa_firms/fetch_nasa_firms.ts
 *   node --experimental-strip-types app/zetaris/sources/nasa_firms/fetch_nasa_firms.ts --skip-api
 *   node --experimental-strip-types app/zetaris/sources/nasa_firms/fetch_nasa_firms.ts --dry-run
 *   npx tsx app/zetaris/sources/nasa_firms/fetch_nasa_firms.ts
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ZETARIS_ROOT = path.resolve(__dirname, "../../");
const LOCATIONS_FILE = path.join(__dirname, "locations.json");
const DATA_DIR = path.join(__dirname, "data");
const CSV_DIR = path.join(DATA_DIR, "firms_csv");
const FLAT_DIR = path.join(DATA_DIR, "firms_flat");
const CONTAINER_PATH = "/home/zetaris/customer-data/shared/firms_flat";

const FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";
const FIRMS_SOURCES = [
  "VIIRS_NOAA20_NRT",
  "VIIRS_NOAA21_NRT",
  "VIIRS_SNPP_NRT",
];

const MALAYSIA_REGIONS: Record<string, [number, number, number, number]> = {
  peninsular_malaysia: [99.5, 1.0, 104.5, 7.5],
  east_malaysia: [109.5, 0.8, 119.5, 7.5],
};

const LOCATION_BBOX_HALF = 0.25;

const REGISTER_SQL = `
CREATE LIGHTNING DATABASE NASA_FIRMS_FILES
DESCRIBE BY "NASA FIRMS active-fire CSV output";

CREATE LIGHTNING FILESTORE TABLE active_fires
FROM NASA_FIRMS_FILES
FORMAT CSV
OPTIONS (
    PATH "/home/zetaris/customer-data/shared/firms_flat",
    header "true",
    inferSchema "true"
);
`.trim();

// Cross-platform python executable detection
const PYTHON_BIN = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");

interface LocationRecord {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

interface RawFirmsRecord {
  latitude: string;
  longitude: string;
  bright_ti4: string;
  scan: string;
  track: string;
  acq_date: string;
  acq_time: string;
  satellite: string;
  instrument: string;
  confidence: string;
  version: string;
  bright_ti5: string;
  frp: string;
  daynight: string;
}

interface NormalizedRecord extends RawFirmsRecord {
  source: string;
  region: string;
  location_id: string;
  acq_utc: string;
  acq_myt: string;
}

function locationBbox(loc: LocationRecord): [number, number, number, number] {
  return [
    Math.round((loc.longitude - LOCATION_BBOX_HALF) * 10000) / 10000,
    Math.round((loc.latitude - LOCATION_BBOX_HALF) * 10000) / 10000,
    Math.round((loc.longitude + LOCATION_BBOX_HALF) * 10000) / 10000,
    Math.round((loc.latitude + LOCATION_BBOX_HALF) * 10000) / 10000,
  ];
}

async function loadEnvironment(): Promise<void> {
  const envCandidates = [
    path.join(ZETARIS_ROOT, ".env.local"),
    path.join(ZETARIS_ROOT, ".env"),
    path.join(ZETARIS_ROOT, "..", ".env.local"),
    path.join(ZETARIS_ROOT, "..", ".env"),
  ];

  for (const envPath of envCandidates) {
    try {
      const content = await fs.readFile(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
          continue;
        }
        const idx = trimmed.indexOf("=");
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    } catch {
      // ignore missing env files
    }
  }
}

async function readLocations(): Promise<LocationRecord[]> {
  const content = await fs.readFile(LOCATIONS_FILE, "utf-8");
  const raw = JSON.parse(content) as Array<{ id: string; name: string; latitude: number | string; longitude: number | string }>;
  return raw.map((item) => ({
    id: String(item.id),
    name: String(item.name).trim(),
    latitude: Number(item.latitude),
    longitude: Number(item.longitude),
  }));
}

function parseCsv(csvText: string): RawFirmsRecord[] {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return [];

  const header = lines[0]!.split(",").map((c) => c.trim().toLowerCase());
  const records: RawFirmsRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i]!.split(",").map((c) => c.trim());
    if (parts.length < header.length) continue;

    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]!] = parts[j] ?? "";
    }

    records.push({
      latitude: row["latitude"] ?? "",
      longitude: row["longitude"] ?? "",
      bright_ti4: row["bright_ti4"] ?? "",
      scan: row["scan"] ?? "",
      track: row["track"] ?? "",
      acq_date: row["acq_date"] ?? "",
      acq_time: row["acq_time"] ?? "",
      satellite: row["satellite"] ?? "",
      instrument: row["instrument"] ?? "",
      confidence: row["confidence"] ?? "",
      version: row["version"] ?? "",
      bright_ti5: row["bright_ti5"] ?? "",
      frp: row["frp"] ?? "",
      daynight: row["daynight"] ?? "",
    });
  }

  return records;
}

function assignNearestLocation(lat: number, lon: number, locations: LocationRecord[]): LocationRecord {
  let minD2 = Infinity;
  let nearest = locations[0]!;
  const radLat = (lat * Math.PI) / 180;
  const cosLat = Math.cos(radLat);

  for (const loc of locations) {
    const dLat = lat - loc.latitude;
    const dLon = (lon - loc.longitude) * cosLat;
    const d2 = dLat * dLat + dLon * dLon;
    if (d2 < minD2) {
      minD2 = d2;
      nearest = loc;
    }
  }

  return nearest;
}

function normalize(
  rawRecords: RawFirmsRecord[],
  source: string,
  loc?: LocationRecord,
  allLocations?: LocationRecord[],
): NormalizedRecord[] {
  return rawRecords.map((r) => {
    let region = "unknown";
    let locationId = "unknown";

    if (loc) {
      region = loc.name;
      locationId = loc.id;
    } else if (allLocations && allLocations.length > 0) {
      const nearest = assignNearestLocation(Number(r.latitude), Number(r.longitude), allLocations);
      region = nearest.name;
      locationId = nearest.id;
    }

    const paddedTime = r.acq_time.trim().padStart(4, "0");
    const yyyy = r.acq_date.slice(0, 4);
    const mm = r.acq_date.slice(5, 7);
    const dd = r.acq_date.slice(8, 10);
    const hh = paddedTime.slice(0, 2);
    const min = paddedTime.slice(2, 4);

    const utcIso = `${yyyy}-${mm}-${dd}T${hh}:${min}:00.000Z`;
    const utcDate = new Date(utcIso);

    const acqUtcStr = isNaN(utcDate.getTime())
      ? `${r.acq_date} ${paddedTime.slice(0, 2)}:${paddedTime.slice(2, 4)}:00+00:00`
      : `${r.acq_date} ${paddedTime.slice(0, 2)}:${paddedTime.slice(2, 4)}:00+00:00`;

    // MYT = UTC + 8 hours
    const mytDate = new Date(utcDate.getTime() + 8 * 60 * 60 * 1000);
    const mytYyyy = mytDate.getUTCFullYear();
    const mytMm = String(mytDate.getUTCMonth() + 1).padStart(2, "0");
    const mytDd = String(mytDate.getUTCDate()).padStart(2, "0");
    const mytHh = String(mytDate.getUTCHours()).padStart(2, "0");
    const mytMin = String(mytDate.getUTCMinutes()).padStart(2, "0");
    const acqMytStr = `${mytYyyy}-${mytMm}-${mytDd} ${mytHh}:${mytMin}:00+00:00`;

    return {
      ...r,
      acq_time: paddedTime,
      source,
      region,
      location_id: locationId,
      acq_utc: acqUtcStr,
      acq_myt: acqMytStr,
    };
  });
}

function dedupKey(r: NormalizedRecord): string {
  return `${r.latitude}|${r.longitude}|${r.acq_utc}|${r.satellite}`;
}

async function writeOutput(
  records: NormalizedRecord[],
  outputDir: string,
  seen: Set<string>,
): Promise<number> {
  const fresh = records.filter((r) => {
    const key = dedupKey(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (fresh.length === 0) return 0;

  const byDate = new Map<string, NormalizedRecord[]>();
  for (const r of fresh) {
    const list = byDate.get(r.acq_date) ?? [];
    list.push(r);
    byDate.set(r.acq_date, list);
  }

  const columns = [
    "latitude", "longitude", "bright_ti4", "scan", "track", "acq_date",
    "acq_time", "satellite", "instrument", "confidence", "version",
    "bright_ti5", "frp", "daynight", "source", "region", "location_id",
    "acq_utc", "acq_myt",
  ];

  for (const [date, dateRecords] of byDate.entries()) {
    const targetDir = path.join(outputDir, `acq_date=${date}`);
    await fs.mkdir(targetDir, { recursive: true });

    const nowIso = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
    const stem = `firms_${nowIso}_${crypto.randomBytes(16).toString("hex")}`;
    const csvTarget = path.join(targetDir, `${stem}.csv`);
    const csvTemp = path.join(targetDir, `${stem}.tmp`);

    const lines: string[] = [columns.join(",")];
    for (const r of dateRecords) {
      const row = [
        r.latitude, r.longitude, r.bright_ti4, r.scan, r.track, r.acq_date,
        r.acq_time, r.satellite, r.instrument, r.confidence, r.version,
        r.bright_ti5, r.frp, r.daynight, r.source, `"${r.region}"`, r.location_id,
        r.acq_utc, r.acq_myt,
      ];
      lines.push(row.join(","));
    }

    await fs.writeFile(csvTemp, lines.join("\n") + "\n", "utf-8");
    await fs.rename(csvTemp, csvTarget);
  }

  return fresh.length;
}

async function fetchFirmsData(
  outputDir: string,
  locations: LocationRecord[],
  isFiltered = false,
  dayRange = 1,
): Promise<number> {
  await loadEnvironment();
  const mapKey = process.env.FIRMS_MAP_KEY;
  if (!mapKey) {
    console.log("Note: FIRMS_MAP_KEY not set. Using existing local FIRMS data.");
    return 0;
  }

  const seen = new Set<string>();
  let total = 0;

  if (isFiltered) {
    for (const loc of locations) {
      const bbox = locationBbox(loc).join(",");
      for (const source of FIRMS_SOURCES) {
        const url = `${FIRMS_BASE}/${mapKey}/${source}/${bbox}/${dayRange}`;
        try {
          const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
          if (resp.ok) {
            const rawText = (await resp.text()).replace(/^\ufeff/, "");
            const records = parseCsv(rawText);
            if (records.length > 0) {
              const norm = normalize(records, source, loc);
              const written = await writeOutput(norm, outputDir, seen);
              total += written;
            }
          }
        } catch (e) {
          console.log(`Warning: Failed to fetch from FIRMS for ${loc.name} (${e instanceof Error ? e.message : e})`);
        }
      }
    }
  } else {
    for (const coords of Object.values(MALAYSIA_REGIONS)) {
      const bbox = coords.join(",");
      for (const source of FIRMS_SOURCES) {
        const url = `${FIRMS_BASE}/${mapKey}/${source}/${bbox}/${dayRange}`;
        try {
          const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
          if (resp.ok) {
            const rawText = (await resp.text()).replace(/^\ufeff/, "");
            const records = parseCsv(rawText);
            if (records.length > 0) {
              const norm = normalize(records, source, undefined, locations);
              const written = await writeOutput(norm, outputDir, seen);
              total += written;
            }
          }
        } catch (e) {
          console.log(`Warning: Failed to fetch from FIRMS (${e instanceof Error ? e.message : e})`);
        }
      }
    }
  }

  return total;
}

async function clearDataDir(dataDir: string): Promise<void> {
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.mkdir(path.join(dataDir, "firms_csv"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "firms_flat"), { recursive: true });
}

async function getCsvFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  let files: string[] = [];
  for (const entry of entries) {
    const res = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(await getCsvFiles(res));
    } else if (entry.isFile() && entry.name.endsWith(".csv")) {
      files.push(res);
    }
  }
  return files;
}

async function flattenCsv(partitionedDir: string, flatDir: string): Promise<number> {
  await fs.mkdir(flatDir, { recursive: true });
  const allCsvs = await getCsvFiles(partitionedDir);
  allCsvs.sort();

  let copied = 0;
  for (const src of allCsvs) {
    const filename = path.basename(src);
    const target = path.join(flatDir, filename);
    const temp = target + ".tmp";
    await fs.copyFile(src, temp);
    await fs.rename(temp, target);
    copied++;
  }

  return copied;
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

async function publishToContainer(flatDir: string, container: string): Promise<void> {
  try {
    await runCommand("docker", ["exec", container, "mkdir", "-p", CONTAINER_PATH], ZETARIS_ROOT);
    await runCommand("docker", ["exec", container, "sh", "-c", `rm -rf ${CONTAINER_PATH}/*`], ZETARIS_ROOT);
    await runCommand("docker", ["cp", `${flatDir}${path.sep}.`, `${container}:${CONTAINER_PATH}/`], ZETARIS_ROOT);
    console.log(`[Step] Published FIRMS flat CSVs to ${container}:${CONTAINER_PATH}/`);
  } catch (e) {
    console.log(`Note: Could not copy FIRMS CSVs to docker (${e instanceof Error ? e.message : e}). Ensure files exist at ${CONTAINER_PATH}/`);
  }
}

async function registerTable(dryRun: boolean): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zetaris-firms-"));
  const sqlFile = path.join(tempDir, "firms_register.sql");

  try {
    await fs.writeFile(sqlFile, REGISTER_SQL, "utf-8");
    const cmdArgs = ["scripts/run_sql.py", "--skip-exists"];
    if (dryRun) {
      cmdArgs.push("--dry-run");
    }
    cmdArgs.push(sqlFile);

    await runCommand(PYTHON_BIN, cmdArgs, ZETARIS_ROOT);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function parseCliArgs(): {
  locationIds: string[];
  dayRange: number;
  container: string;
  skipApi: boolean;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  const locationIds: string[] = [];
  let dayRange = 3;
  let container = "zetaris-driver-1";
  let skipApi = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--skip-api") {
      skipApi = true;
    } else if (arg === "--day-range") {
      if (i + 1 < args.length) {
        dayRange = parseInt(args[i + 1]!, 10) || 1;
        i++;
      }
    } else if (arg?.startsWith("--day-range=")) {
      dayRange = parseInt(arg.slice("--day-range=".length), 10) || 1;
    } else if (arg === "--container") {
      if (i + 1 < args.length) {
        container = args[i + 1]!;
        i++;
      }
    } else if (arg?.startsWith("--container=")) {
      container = arg.slice("--container=".length);
    } else if (arg === "--location") {
      if (i + 1 < args.length) {
        locationIds.push(args[i + 1]!);
        i++;
      }
    } else if (arg?.startsWith("--location=")) {
      locationIds.push(arg.slice("--location=".length));
    }
  }

  return { locationIds, dayRange, container, skipApi, dryRun };
}

async function main(): Promise<void> {
  const { locationIds, dayRange, container, skipApi, dryRun } = parseCliArgs();

  const allLocations = await readLocations();
  const isFiltered = locationIds.length > 0;
  let selected = allLocations;

  if (isFiltered) {
    const byId = new Map(allLocations.map((l) => [l.id.toLowerCase(), l]));
    const byName = new Map(allLocations.map((l) => [l.name.toLowerCase(), l]));
    selected = [];
    for (const req of locationIds) {
      const key = req.trim().toLowerCase();
      const match = byId.get(key) ?? byName.get(key);
      if (match) {
        selected.push(match);
      } else {
        console.error(`Unknown location ID or name '${req}'.`);
        process.exit(1);
      }
    }
  }

  if (!skipApi && !dryRun) {
    console.log(`Clearing previous local FIRMS data in ${DATA_DIR}...`);
    await clearDataDir(DATA_DIR);
    if (isFiltered) {
      const names = selected.map((l) => l.name).join(", ");
      console.log(`Checking NASA FIRMS active fires for specific location(s): ${names}...`);
    } else {
      console.log("Checking NASA FIRMS active fires for nationwide Malaysia...");
    }
    const fetched = await fetchFirmsData(CSV_DIR, selected, isFiltered, dayRange);
    console.log(`Fetched ${fetched} new active fire records.`);
  }

  console.log(`Flattening CSV partitions to ${FLAT_DIR}...`);
  const count = await flattenCsv(CSV_DIR, FLAT_DIR);
  console.log(`Flattened ${count} CSV files.`);

  if (dryRun) {
    console.log("[Dry run] Registration statements:");
    await registerTable(true);
    return;
  }

  console.log("Publishing FIRMS flat files to Zetaris container...");
  await publishToContainer(FLAT_DIR, container);

  console.log("Registering NASA_FIRMS_FILES.active_fires in Zetaris...");
  await registerTable(false);
  console.log("✓ NASA FIRMS active fire ingestion completed.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
