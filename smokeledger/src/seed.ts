// Startup preparation: schema, towns, versioned guidance, and (in SAMPLE_MODE) the
// fictional sample episode. Idempotent: safe to run on every start.
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.ts";
import { db, initSchema, insertMany } from "./db.ts";
import * as load from "./load.ts";
import { generateSample, UPDATE_ISSUED, UPDATE_TOWNS } from "./sample.ts";
import { GUIDANCE_ID, GUIDANCE_VERSION } from "./agents/workershield.ts";

const GUIDANCE_SOURCE =
  "PLACEHOLDER written for the hackathon demo. Not official DOSH or MOH guidance. Replace with reviewed DOSH workplace haze guidance before real use.";

export async function loadGuidance(): Promise<void> {
  const rows: [string, number, number, string, string][] = [
    ["good", 0, 50, "Normal work.", "allowed"],
    ["moderate", 51, 100, "Normal work; sensitive workers limit long heavy exertion.", "allowed"],
    ["unhealthy", 101, 200, "Limit heavy exertion, add rest breaks and rotate crews; provide respirators per employer policy.", "limit"],
    ["very unhealthy", 201, 300, "Postpone non-essential outdoor work; essential work only with respiratory protection and supervision.", "postpone"],
    ["hazardous", 301, 100000, "Stop outdoor work.", "stop"],
  ];
  await insertMany(
    "guidance",
    ["guidance_id", "version", "band", "api_min", "api_max", "action", "heavy_work", "status", "source"],
    rows.map(([b, mn, mx, a, h]) => [GUIDANCE_ID, GUIDANCE_VERSION, b, mn, mx, a, h, "placeholder", GUIDANCE_SOURCE]),
    "ON CONFLICT (guidance_id, version, band) DO NOTHING",
  );
}

export const sampleDir = () => path.join(CONFIG.stateDir, "sample");

export async function prepare(): Promise<{ seeded: boolean }> {
  await initSchema();
  await load.loadTowns();
  await loadGuidance();
  if (!CONFIG.sampleMode) return { seeded: false };
  const n = await db().query("SELECT count(*) AS n FROM fires");
  if (Number(n.rows[0].n) > 0) return { seeded: false };
  const dir = sampleDir();
  generateSample(dir);
  const f = (x: string) => path.join(dir, x);
  await load.loadConcessions(f("concessions.geojson"), { source: "SAMPLE (fictional) map", date: "2026" });
  load.loadPeat(f("peat.geojson"));
  await load.loadCompanies(f("companies.csv"));
  await load.loadFires([f("firms_viirs_snpp.csv")]);
  await load.loadWind(fs.readdirSync(dir).filter((x) => x.startsWith("wind_")).map(f));
  await load.loadPm25([f("pm25_model_hindsight.json")], { kind: "model", issued: null, source: "SAMPLE model (fictional)" });
  await load.loadPm25([f("pm25_observed_batu_pahat.csv")], { kind: "observed", issued: null, source: "SAMPLE observations (fictional)" });
  return { seeded: true };
}

/** Named fixtures a scenario can load mid-run (offline only). */
export async function loadFixture(name: string): Promise<string> {
  if (name !== "pm25_forecast_update") throw new Error(`Unknown fixture ${name}`);
  const file = path.join(sampleDir(), "pm25_forecast_update.json");
  if (!fs.existsSync(file)) generateSample(sampleDir());
  const n = await load.loadPm25([file], { kind: "model", issued: UPDATE_ISSUED, towns: UPDATE_TOWNS, source: "SAMPLE forecast update (fictional)" });
  return `Loaded ${n} rows of a newer forecast issued ${UPDATE_ISSUED} for ${UPDATE_TOWNS.join(", ")}`;
}
