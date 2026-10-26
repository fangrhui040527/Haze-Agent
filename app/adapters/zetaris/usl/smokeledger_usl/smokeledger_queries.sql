-- Run after compiling and activating the SmokeLedger USL.

-- Recent source-backed fire detections. fire_id is a stable key derived from
-- the source timestamp and coordinates; peat and concession attribution are unknown.
SELECT fire_id, acq_utc, lat, lon, frp, satellite, confidence, on_peat, concession_id
FROM lightning.metastore.smokeledger.smokeledger_usl.fires
ORDER BY acq_utc DESC
LIMIT 20;

-- Recent PM2.5 values, with source provenance preserved.
SELECT town, valid_utc, issued_utc, kind, pm25, api_source
FROM lightning.metastore.smokeledger.smokeledger_usl.pm25
ORDER BY valid_utc DESC
LIMIT 20;

-- Recent Windy surface wind forecasts.
SELECT lat, lon, valid_utc, u, v
FROM lightning.metastore.smokeledger.smokeledger_usl.wind
WHERE level = 'surface'
ORDER BY valid_utc DESC
LIMIT 20;

-- These operational entities are defined but currently have no non-PostgreSQL
-- backing source: concessions, companies, runs, trajectory_points, attribution,
-- projections, cases, case_events, evidence, guidance, and agent_runs.
