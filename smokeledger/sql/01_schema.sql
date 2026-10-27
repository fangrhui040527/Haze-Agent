-- SmokeLedger evidence store (Postgres). Run with: npm run sl -- db:init
-- Every table here is registered in Zetaris, so the agent's evidence
-- queries run through Zetaris and can be re-run by anyone.

CREATE TABLE IF NOT EXISTS towns (
  town       TEXT PRIMARY KEY,
  district   TEXT,
  state      TEXT,
  lat        DOUBLE PRECISION NOT NULL,
  lon        DOUBLE PRECISION NOT NULL
);

-- NASA FIRMS hotspots, overlaid with concession and peat maps at load time.
CREATE TABLE IF NOT EXISTS fires (
  fire_id        TEXT PRIMARY KEY,
  lat            DOUBLE PRECISION NOT NULL,
  lon            DOUBLE PRECISION NOT NULL,
  acq_utc        TIMESTAMPTZ NOT NULL,
  frp            DOUBLE PRECISION NOT NULL,
  confidence     TEXT,
  satellite      TEXT,
  daynight       TEXT,
  concession_id  TEXT,
  on_peat        BOOLEAN NOT NULL DEFAULT FALSE,
  source_file    TEXT,
  ingested_utc   TIMESTAMPTZ NOT NULL DEFAULT now()   -- when WE received it (drives heartbeat)
);
CREATE INDEX IF NOT EXISTS fires_time ON fires (acq_utc);
CREATE INDEX IF NOT EXISTS fires_concession ON fires (concession_id);

-- Open-Meteo hourly wind, stored as u/v components (m/s) on a regular grid.
CREATE TABLE IF NOT EXISTS wind (
  level      TEXT NOT NULL,            -- '850hPa' or '10m'
  lat        DOUBLE PRECISION NOT NULL,
  lon        DOUBLE PRECISION NOT NULL,
  valid_utc  TIMESTAMPTZ NOT NULL,
  u          DOUBLE PRECISION NOT NULL,
  v          DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (level, lat, lon, valid_utc)
);

-- Hourly PM2.5 per town. kind = 'observed' (ground stations) or 'model' (CAMS).
-- issued_utc = when a model forecast was fetched; NULL for observations and
-- for hindsight downloads (past_days). Backtests only use rows issued before "now".
CREATE TABLE IF NOT EXISTS pm25 (
  town        TEXT NOT NULL,
  valid_utc   TIMESTAMPTZ NOT NULL,
  kind        TEXT NOT NULL,
  issued_utc  TIMESTAMPTZ,
  pm25        DOUBLE PRECISION NOT NULL,
  source      TEXT,
  ingested_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pm25_key
  ON pm25 (town, valid_utc, kind, COALESCE(issued_utc, 'epoch'::timestamptz));

CREATE TABLE IF NOT EXISTS concessions (
  concession_id  TEXT PRIMARY KEY,
  name           TEXT,
  company        TEXT,
  group_name     TEXT,
  ctype          TEXT,                 -- oil palm, wood fiber, ...
  country        TEXT,
  area_ha        DOUBLE PRECISION,
  map_source     TEXT,                 -- where the boundary came from
  map_date       TEXT                  -- how old the boundary is (show it in every dossier)
);

-- Who owns/finances/buys from a group. You compile this (public reports, RSPO, Trase).
CREATE TABLE IF NOT EXISTS companies (
  group_name         TEXT PRIMARY KEY,
  parent_country     TEXT,
  rspo_member        BOOLEAN,
  grievance_contact  TEXT,
  known_buyers       TEXT,
  notes              TEXT
);

-- Trajectory runs (forward = warning, backward = attribution).
CREATE TABLE IF NOT EXISTS runs (
  run_id      TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,           -- 'backward' | 'forward'
  town        TEXT,
  center_utc  TIMESTAMPTZ NOT NULL,
  params      TEXT NOT NULL,           -- JSON
  created_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trajectory_points (
  run_id     TEXT NOT NULL,
  member     INTEGER NOT NULL,
  scale      DOUBLE PRECISION NOT NULL,
  level      TEXT NOT NULL,
  release_utc TIMESTAMPTZ NOT NULL,
  step_utc   TIMESTAMPTZ NOT NULL,
  lat        DOUBLE PRECISION NOT NULL,
  lon        DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS traj_run ON trajectory_points (run_id);

-- Backward attribution: how much each fire's smoke plausibly reached the town,
-- computed separately for each wind-scale variant (the spread is the uncertainty).
CREATE TABLE IF NOT EXISTS attribution (
  run_id   TEXT NOT NULL,
  fire_id  TEXT NOT NULL,
  scale    DOUBLE PRECISION NOT NULL,
  weight   DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (run_id, fire_id, scale)
);

-- Forward warning: projected 24 h PM2.5, API and closure probability per hour.
CREATE TABLE IF NOT EXISTS projections (
  run_id       TEXT NOT NULL,
  town         TEXT NOT NULL,
  valid_utc    TIMESTAMPTZ NOT NULL,
  pm25_hour    DOUBLE PRECISION,             -- best hourly PM2.5 for that hour (what workers breathe)
  pm25_24h     DOUBLE PRECISION,
  api          DOUBLE PRECISION,
  p_close      DOUBLE PRECISION,
  smoke_index  DOUBLE PRECISION,
  PRIMARY KEY (run_id, town, valid_utc)
);

-- Warn -> record -> escalate.
CREATE TABLE IF NOT EXISTS cases (
  case_id          TEXT PRIMARY KEY,
  concession_id    TEXT NOT NULL,
  status           TEXT NOT NULL,
  opened_utc       TIMESTAMPTZ NOT NULL,
  notified_utc     TIMESTAMPTZ,
  recheck_due_utc  TIMESTAMPTZ,
  escalated_utc    TIMESTAMPTZ,
  closed_utc       TIMESTAMPTZ,
  draft_path       TEXT
);

CREATE TABLE IF NOT EXISTS case_events (
  case_id       TEXT NOT NULL,
  at_utc        TIMESTAMPTZ NOT NULL,
  event         TEXT NOT NULL,
  detail        TEXT,                 -- JSON
  evidence_ids  TEXT                  -- comma-separated
);
CREATE INDEX IF NOT EXISTS case_events_case ON case_events (case_id);

-- Chain of custody: every query that backs a claim, with a hash of its result.
CREATE TABLE IF NOT EXISTS evidence (
  evidence_id   TEXT PRIMARY KEY,
  backend       TEXT NOT NULL,
  sql_text      TEXT NOT NULL,
  executed_utc  TIMESTAMPTZ NOT NULL,
  row_count     INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  rows_json     TEXT NOT NULL
);

-- Versioned workplace guidance used by WorkerShield. Every recommendation cites a
-- guidance row, so the critic can check it through Zetaris like any other evidence.
CREATE TABLE IF NOT EXISTS guidance (
  guidance_id   TEXT NOT NULL,
  version       TEXT NOT NULL,
  band          TEXT NOT NULL,
  api_min       DOUBLE PRECISION NOT NULL,
  api_max       DOUBLE PRECISION NOT NULL,
  action        TEXT NOT NULL,
  heavy_work    TEXT NOT NULL,        -- allowed | limit | postpone | stop
  status        TEXT NOT NULL,        -- 'placeholder' until replaced with reviewed official guidance
  source        TEXT NOT NULL,
  PRIMARY KEY (guidance_id, version, band)
);

-- One row per POST /run (also the idempotency record and the resume list).
CREATE TABLE IF NOT EXISTS agent_runs (
  run_id          TEXT PRIMARY KEY,
  parent_run_id   TEXT,
  decision_key    TEXT NOT NULL,
  status          TEXT NOT NULL,      -- running | success | partial | error
  mode            TEXT NOT NULL,
  request         TEXT NOT NULL,
  response        TEXT,
  snapshot_id     TEXT,
  watermark_utc   TIMESTAMPTZ,
  validity_start  TIMESTAMPTZ,
  validity_end    TIMESTAMPTZ,
  conclusion_status TEXT,             -- current | needs_review | stale | superseded | withdrawn | insufficient_evidence
  deadline_utc    TIMESTAMPTZ NOT NULL,
  created_utc     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_utc     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_runs_decision ON agent_runs (decision_key);
