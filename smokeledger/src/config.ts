// Settings from .env, plus every modelling assumption in one place so judges
// (and you) can see exactly what the numbers depend on.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env yet: fall back to defaults / real environment
}

const env = (key: string, fallback = ""): string => process.env[key] ?? fallback;

// SAMPLE_MODE=true enforces offline execution: embedded database seeded with the
// fictional sample episode, no Zetaris, no hosted model. Engines still run locally.
const sampleMode = env("SAMPLE_MODE", "false") === "true";
const stateDir = env("STATE_DIR", ".state");

export const CONFIG = {
  sampleMode,
  stateDir,
  port: Number(env("PORT", "8000")),
  logDir: env("LOG_DIR", "logs"),
  // postgres = Docker Postgres registered in Zetaris; pglite = embedded under STATE_DIR; memory = tests
  dbMode: (sampleMode ? (env("DB_MODE", "pglite") === "memory" ? "memory" : "pglite") : env("DB_MODE", "postgres")) as
    | "postgres"
    | "pglite"
    | "memory",
  pgUrl: env("PG_URL", "postgres://smokeledger:smokeledger@localhost:5433/smokeledger"),
  zetaris: {
    url: env("ZETARIS_REST_URL", "http://localhost:8888/api/v1.0").replace(/\/+$/, ""),
    orgId: env("ZETARIS_ORG_ID", "1"),
    apiKey: env("ZETARIS_API_KEY"),
    source: env("ZETARIS_SOURCE", "sl_pg"),
  },
  // In sample mode evidence queries run on the embedded store and Zetaris is reported as skipped.
  queryBackend: (sampleMode || env("QUERY_BACKEND", "zetaris") === "postgres" ? "postgres" : "zetaris") as
    | "zetaris"
    | "postgres",
  llm: {
    baseUrl: env("METERLESS_BASE_URL", "http://127.0.0.1:8088/v1").replace(/\/+$/, ""),
    token: env("METERLESS_RUNTIME_TOKEN"),
    app: env("METERLESS_APP", "smokeledger"),
    modelDeep: env("MODEL_DEEP", "meterless/auto"),
    modelJudge: env("MODEL_JUDGE", "meterless/auto"),
  },
  demoMode: env("DEMO_MODE", "true") !== "false",
  sandboxRecipient: env("SANDBOX_RECIPIENT", "you@example.com"),
  windGridStep: Number(env("WIND_GRID_STEP", "1.0")),
  geoDir: env("GEO_DIR", `${stateDir}/geo`),
  outboxDir: env("OUTBOX_DIR", `${stateDir}/outbox`),
  hmemDir: env("HMEM_DIR", `${stateDir}/hmem`),
  worldDir: env("WORLD_DIR", `${stateDir}/world`),
  limits: {
    runSeconds: 300, // whole-run hard deadline
    taskSeconds: 120, // one specialist task
    sourceSeconds: 60, // one source request (Zetaris); a local Spark-backed engine can be slow under load
    modelSeconds: 180, // one hosted model request; the judge on a reasoning model takes one to three minutes under load
    feedbackRounds: 2, // critic revision rounds
  },
};

export const APP = { name: "smokeledger-haze-harness", version: "0.7.0", workflowVersion: "haze-graph-1" };

export const HOUR = 3_600_000;

// Modelling assumptions. All are simple, stated, and tunable.
export const PARAMS = {
  stepSeconds: 900, // integration step (15 min)
  backHours: 72, // how far back a backward trajectory runs
  forwardHours: 72, // how far ahead a forward trajectory runs
  releaseEveryHours: 3, // backward: release one trajectory set every N hours across the window
  ensemble: {
    // start-point jitter in degrees (lat, lon) and wind-speed scaling
    offsetsDeg: [
      [0, 0],
      [0.25, 0],
      [-0.25, 0],
      [0, 0.25],
      [0, -0.25],
    ] as [number, number][],
    windScales: [0.85, 1.0, 1.15],
  },
  kernel: {
    sigmaKm0: 25, // plume half-width at the receptor
    sigmaKmPerHour: 1.5, // uncertainty grows with travel time
    timeTolHours: 6, // a fire counts if seen within +/- this of the air passing over it
    peatTimeTolHours: 24, // peat smoulders for days
    maxSigmas: 3,
  },
  // ASSUMPTION: peat fires emit far more smoke per unit of fire radiative power
  // than surface fires. 3x is a placeholder; cite or tune it before you present.
  peatEmissionFactor: 3,
  // VIIRS confidence l/n/h; MODIS 0-100. Low-confidence detections are dropped.
  minModisConfidence: 30,
  forward: {
    clusterCellDeg: 0.25,
    maxClusters: 60,
    activeWindowHours: 24,
    // Smoke index = share of active fire emission whose plume passes near a town.
    smokeAlertIndex: 0.02,
  },
  api: {
    // PM2.5 24 h breakpoints [concLow, concHigh, apiLow, apiHigh].
    // DOE says its PM2.5 formula follows US EPA; these are the pre-2024 US EPA
    // breakpoints. VERIFY against DOE before presenting, and calibrate in the backtest.
    breakpoints: [
      [0.0, 12.0, 0, 50],
      [12.1, 35.4, 51, 100],
      [35.5, 55.4, 101, 150],
      [55.5, 150.4, 151, 200],
      [150.5, 250.4, 201, 300],
      [250.5, 350.4, 301, 400],
      [350.5, 500.4, 401, 500],
    ] as [number, number, number, number][],
    closeThreshold: 200, // MOE: schools close when API exceeds 200
    // Uncertainty of the projected API for the closure probability (uncalibrated).
    sigmaFrac: 0.2,
    sigmaMin: 15,
  },
  localUtcOffsetHours: 8, // Malaysia
  cases: {
    detectWindowHours: 24,
    graceHours: 6, // fires seen less than this after notice don't count against the holder
    recheckAfterHours: 24,
    resolveAfterQuietHours: 48,
  },
};

// Receptor towns. Coordinates are approximate town centres: replace them with
// the exact DOE station coordinates if you have them.
export const DEFAULT_TOWNS: { town: string; district: string; state: string; lat: number; lon: number }[] = [
  { town: "Batu Pahat", district: "Batu Pahat", state: "Johor", lat: 1.8548, lon: 102.9325 },
  { town: "Muar", district: "Muar", state: "Johor", lat: 2.0442, lon: 102.5689 },
  { town: "Johor Bahru", district: "Johor Bahru", state: "Johor", lat: 1.4927, lon: 103.7414 },
  { town: "Melaka", district: "Melaka Tengah", state: "Melaka", lat: 2.1896, lon: 102.2501 },
  { town: "Seremban", district: "Seremban", state: "Negeri Sembilan", lat: 2.7297, lon: 101.9381 },
  { town: "Shah Alam", district: "Petaling", state: "Selangor", lat: 3.0733, lon: 101.5185 },
  { town: "Klang", district: "Klang", state: "Selangor", lat: 3.0449, lon: 101.4456 },
  { town: "Kuala Lumpur", district: "Kuala Lumpur", state: "WP Kuala Lumpur", lat: 3.139, lon: 101.6869 },
  { town: "Ipoh", district: "Kinta", state: "Perak", lat: 4.5975, lon: 101.0901 },
  { town: "Kuantan", district: "Kuantan", state: "Pahang", lat: 3.8077, lon: 103.326 },
  { town: "Kuching", district: "Kuching", state: "Sarawak", lat: 1.5535, lon: 110.3593 },
  { town: "Serian", district: "Serian", state: "Sarawak", lat: 1.1667, lon: 110.5667 },
  { town: "Sri Aman", district: "Sri Aman", state: "Sarawak", lat: 1.2378, lon: 111.4621 },
  { town: "Sibu", district: "Sibu", state: "Sarawak", lat: 2.2873, lon: 111.8305 },
  { town: "Miri", district: "Miri", state: "Sarawak", lat: 4.3995, lon: 113.9914 },
];
