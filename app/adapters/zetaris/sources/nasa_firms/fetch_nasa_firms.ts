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
import { envFileCandidates } from "../../scripts/env-files.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ZETARIS_ROOT = path.resolve(__dirname, "../../");
const LOCATIONS_FILE = path.join(__dirname, "locations.json");
const DATA_DIR = path.join(__dirname, "data");
const CSV_DIR = path.join(DATA_DIR, "firms_csv");
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

export const REGISTER_SQL = `
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

UPDATE LIGHTNING FILESTORE TABLE active_fires
FROM NASA_FIRMS_FILES
OPTIONS (
    PATH "/home/zetaris/customer-data/shared/firms_flat",
    header "true",
    inferSchema "true"
);
`.trim();

// Cross-platform python executable detection
const PYTHON_BIN = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");

export interface LocationRecord {
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
  const envCandidates = envFileCandidates();

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
        if (process.env[key] === undefined) {
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

export function parseCsv(csvText: string): RawFirmsRecord[] {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error("NASA FIRMS returned an empty CSV response.");

  const header = lines[0]!.split(",").map((c) => c.trim().toLowerCase());
  if (!["latitude", "longitude", "acq_date", "acq_time", "satellite", "frp"].every((name) => header.includes(name))) {
    throw new Error("NASA FIRMS returned an invalid CSV header.");
  }
  const records: RawFirmsRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i]!.split(",").map((c) => c.trim());
    if (parts.length !== header.length) throw new Error("NASA FIRMS returned an invalid CSV row.");

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
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(r.acq_date) ||
      !/^\d{4}$/.test(paddedTime) || Number(hh) > 23 || Number(min) > 59 ||
      !Number.isFinite(utcDate.getTime()) || utcDate.toISOString().slice(0, 10) !== r.acq_date ||
      !Number.isFinite(Number(r.latitude)) || Math.abs(Number(r.latitude)) > 90 ||
      !Number.isFinite(Number(r.longitude)) || Math.abs(Number(r.longitude)) > 180 ||
      !r.latitude.trim() || !r.longitude.trim() || !r.frp.trim() ||
      !Number.isFinite(Number(r.frp)) || Number(r.frp) < 0
    ) {
      throw new Error("NASA FIRMS returned an invalid fire record.");
    }
    const acqUtcStr = `${r.acq_date} ${hh}:${min}:00+00:00`;

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

export async function fetchFirmsData(
  outputDir: string,
  locations: LocationRecord[],
  isFiltered: boolean,
  dayRange: number,
  mapKey: string,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  if (!mapKey) {
    throw new Error("FIRMS_MAP_KEY is required. Use --skip-api only to publish existing cached data.");
  }

  const seen = new Set<string>();
  let total = 0;

  const targets = isFiltered
    ? locations.map((location) => ({ coordinates: locationBbox(location), location }))
    : Object.values(MALAYSIA_REGIONS).map((coordinates) => ({ coordinates, location: undefined }));
  for (const target of targets) {
    for (const source of FIRMS_SOURCES) {
      const url = `${FIRMS_BASE}/${encodeURIComponent(mapKey)}/${source}/${target.coordinates.join(",")}/${dayRange}`;
      let response: Response;
      let text: string;
      try {
        response = await fetcher(url, { signal: AbortSignal.timeout(60_000), redirect: "error" });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("HTTP failure");
        }
        text = await response.text();
      } catch {
        // A transport error can contain the credential-bearing URL.
        throw new Error(`NASA FIRMS ${source} request failed; no new snapshot was published.`);
      }
      const records = parseCsv(text.replace(/^\ufeff/, ""));
      total += await writeOutput(normalize(records, source, target.location, locations), outputDir, seen);
    }
  }

  return total;
}

async function removeStagingDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  const relative = path.relative(path.resolve(DATA_DIR), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(resolved).startsWith(".firms-stage-")) {
    throw new Error("Refusing to remove a directory outside the FIRMS staging area.");
  }
  await fs.rm(resolved, { recursive: true, force: true });
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
      shell: false,
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
  const parentPath = path.posix.dirname(CONTAINER_PATH);
  const suffix = crypto.randomBytes(12).toString("hex");
  const staging = `${CONTAINER_PATH}.stage-${suffix}`;
  const backup = `${CONTAINER_PATH}.previous-${suffix}`;
  try {
    await runCommand("docker", ["exec", "-u", "root", container, "mkdir", "-p", parentPath], ZETARIS_ROOT);
    await runCommand("docker", ["exec", "-u", "root", container, "mkdir", "-p", staging], ZETARIS_ROOT);
    await runCommand("docker", ["cp", `${flatDir}${path.sep}.`, `${container}:${staging}/`], ZETARIS_ROOT);
    await runCommand("docker", ["exec", "-u", "root", container, "chown", "-R", "zetaris:zetaris", staging], ZETARIS_ROOT);
    await runCommand("docker", ["exec", "-u", "root", container, "chmod", "-R", "u=rwX,go=rX", staging], ZETARIS_ROOT);
    const swap = `set -eu
target="$1"
staging="$2"
backup="$3"
if [ -e "$target" ]; then mv "$target" "$backup"; fi
if mv "$staging" "$target"; then
  rm -rf -- "$backup"
else
  if [ -e "$backup" ]; then mv "$backup" "$target"; fi
  exit 1
fi`;
    await runCommand("docker", ["exec", "-u", "root", container, "sh", "-c", swap, "firms-swap", CONTAINER_PATH, staging, backup], ZETARIS_ROOT);
    console.log(`[Step] Published FIRMS flat CSVs to ${container}:${CONTAINER_PATH}/`);
  } catch {
    throw new Error("Publishing the NASA FIRMS snapshot to the Zetaris driver failed.");
  }
}

async function registerTable(dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(REGISTER_SQL);
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zetaris-firms-"));
  const sqlFile = path.join(tempDir, "firms_register.sql");

  try {
    await fs.writeFile(sqlFile, REGISTER_SQL, "utf-8");
    const cmdArgs = ["scripts/run_sql.py", "--skip-exists"];
    cmdArgs.push(sqlFile);

    await runCommand(PYTHON_BIN, cmdArgs, ZETARIS_ROOT);
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(tempDir));
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(tempDir).startsWith("zetaris-firms-")) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}

export function parseCliArgs(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): {
  locationIds: string[];
  dayRange: number;
  container: string;
  skipApi: boolean;
  dryRun: boolean;
} {
  const locationIds: string[] = [];
  let dayRange = 3;
  let container = env.ZETARIS_DRIVER_CONTAINER || "zetaris-driver-1";
  let skipApi = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--skip-api") {
      skipApi = true;
    } else if (arg === "--day-range") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error("--day-range requires a number.");
      dayRange = Number(value);
    } else if (arg?.startsWith("--day-range=")) {
      dayRange = Number(arg.slice("--day-range=".length));
    } else if (arg === "--container") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error("--container requires a container name.");
      container = value;
    } else if (arg?.startsWith("--container=")) {
      container = arg.slice("--container=".length);
    } else if (arg === "--location") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error("--location requires a location id.");
      locationIds.push(value);
    } else if (arg?.startsWith("--location=")) {
      locationIds.push(arg.slice("--location=".length));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isInteger(dayRange) || dayRange < 1 || dayRange > 5) throw new Error("--day-range must be an integer from 1 to 5.");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) throw new Error("Invalid Zetaris driver container name.");
  if (locationIds.some((id) => !id.trim())) throw new Error("--location requires a location id.");

  return { locationIds, dayRange, container, skipApi, dryRun };
}

async function commitCache(staging: string, replaceCsv: boolean): Promise<void> {
  const names = replaceCsv ? ["firms_csv", "firms_flat"] : ["firms_flat"];
  const committed: Array<{ name: string; hadPrevious: boolean }> = [];
  try {
    for (const name of names) {
      const target = path.join(DATA_DIR, name);
      const previous = path.join(staging, `previous_${name}`);
      let hadPrevious = false;
      try {
        await fs.rename(target, previous);
        hadPrevious = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      try {
        await fs.rename(path.join(staging, name), target);
      } catch (error) {
        if (hadPrevious) await fs.rename(previous, target);
        throw error;
      }
      committed.push({ name, hadPrevious });
    }
  } catch (error) {
    for (const entry of committed.reverse()) {
      await fs.rename(path.join(DATA_DIR, entry.name), path.join(staging, entry.name));
      if (entry.hadPrevious) await fs.rename(path.join(staging, `previous_${entry.name}`), path.join(DATA_DIR, entry.name));
    }
    throw error;
  }
}

export async function main(): Promise<void> {
  await loadEnvironment();
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
        throw new Error(`Unknown location ID or name '${req}'.`);
      }
    }
  }

  if (dryRun) {
    console.log(`[Dry run] Would ${skipApi ? "reuse cached FIRMS CSVs" : `fetch ${dayRange} days of FIRMS data for ${isFiltered ? selected.map((location) => location.name).join(", ") : "Malaysia"}`} in a staging directory.`);
    console.log(`[Dry run] Would publish a complete snapshot to ${container}:${CONTAINER_PATH}.`);
    console.log("[Dry run] Registration statements:");
    await registerTable(true);
    return;
  }

  const mapKey = process.env.FIRMS_MAP_KEY;
  if (!skipApi && !mapKey) throw new Error("FIRMS_MAP_KEY is required. Use --skip-api only to publish existing cached data.");
  if (skipApi && (await getCsvFiles(CSV_DIR)).length === 0) throw new Error("No cached FIRMS CSV snapshot exists. Fetch data before using --skip-api.");
  await fs.mkdir(DATA_DIR, { recursive: true });
  const staging = await fs.mkdtemp(path.join(DATA_DIR, ".firms-stage-"));
  const stagedCsv = path.join(staging, "firms_csv");
  const stagedFlat = path.join(staging, "firms_flat");
  try {
    await fs.mkdir(stagedCsv);
    if (!skipApi) {
      const count = await fetchFirmsData(stagedCsv, selected, isFiltered, dayRange, mapKey!);
      console.log(`Fetched ${count} active fire records.`);
    }
    const count = await flattenCsv(skipApi ? CSV_DIR : stagedCsv, stagedFlat);
    if (count === 0) {
      const header = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight,source,region,location_id,acq_utc,acq_myt\n";
      // A header-only file represents a successful zero-fire response, never a failed download.
      await fs.writeFile(path.join(stagedFlat, "empty.csv"), header, "utf8");
      if (!skipApi) await fs.writeFile(path.join(stagedCsv, "empty.csv"), header, "utf8");
    }
    await publishToContainer(stagedFlat, container);
    await registerTable(false);
    await commitCache(staging, !skipApi);
    console.log("NASA FIRMS active fire ingestion completed.");
  } finally {
    await removeStagingDirectory(staging);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : "NASA FIRMS ingestion failed.");
    process.exitCode = 1;
  });
}
