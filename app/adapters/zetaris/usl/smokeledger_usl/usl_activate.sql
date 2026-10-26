-- Activate current environmental data without a PostgreSQL datasource.
-- The remaining schema entities are typed empty relations until an equivalent
-- non-PostgreSQL source is connected.

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.towns AS
SELECT
    COALESCE(CAST(location_name AS VARCHAR(200)), '') AS town,
    CAST(NULL AS VARCHAR(200)) AS district,
    CAST(NULL AS VARCHAR(200)) AS state,
    COALESCE(CAST(latitude AS DOUBLE), 0.0) AS lat,
    COALESCE(CAST(longitude AS DOUBLE), 0.0) AS lon
FROM lightning.metastore.malaysia_env.malaysia_env_usl.location_dim
WHERE location_name IS NOT NULL
  AND latitude IS NOT NULL
  AND longitude IS NOT NULL;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.fires AS
SELECT
    COALESCE(CAST(CONCAT(
        COALESCE(CAST(acq_utc AS VARCHAR(24)), ''),
        ':',
        COALESCE(CAST(fire_latitude AS VARCHAR(16)), ''),
        ':',
        COALESCE(CAST(fire_longitude AS VARCHAR(16)), '')
    ) AS VARCHAR(64)), '') AS fire_id,
    COALESCE(CAST(fire_latitude AS DOUBLE), 0.0) AS lat,
    COALESCE(CAST(fire_longitude AS DOUBLE), 0.0) AS lon,
    COALESCE(CAST(acq_utc AS TIMESTAMP), CURRENT_TIMESTAMP) AS acq_utc,
    COALESCE(CAST(frp AS DOUBLE), 0.0) AS frp,
    CAST(confidence AS VARCHAR(20)) AS confidence,
    CAST(satellite AS VARCHAR(50)) AS satellite,
    CAST(daynight AS VARCHAR(10)) AS daynight,
    CAST(NULL AS VARCHAR(200)) AS concession_id,
    CAST(NULL AS BOOLEAN) AS on_peat,
    CAST(NULL AS VARCHAR(255)) AS source_file,
    CAST(NULL AS TIMESTAMP) AS ingested_utc
FROM lightning.metastore.malaysia_env.malaysia_env_usl.active_fires
WHERE fire_latitude IS NOT NULL
  AND fire_longitude IS NOT NULL
  AND acq_utc IS NOT NULL
  AND frp IS NOT NULL;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.wind AS
SELECT
    CAST('surface' AS VARCHAR(20)) AS level,
    COALESCE(CAST(requested_latitude AS DOUBLE), 0.0) AS lat,
    COALESCE(CAST(requested_longitude AS DOUBLE), 0.0) AS lon,
    COALESCE(CAST(forecast_time AS TIMESTAMP), CURRENT_TIMESTAMP) AS valid_utc,
    COALESCE(CAST(wind_u_ms AS DOUBLE), 0.0) AS u,
    COALESCE(CAST(wind_v_ms AS DOUBLE), 0.0) AS v
FROM windy.gfs_forecast
WHERE requested_latitude IS NOT NULL
  AND requested_longitude IS NOT NULL
  AND forecast_time IS NOT NULL
  AND wind_u_ms IS NOT NULL
  AND wind_v_ms IS NOT NULL;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.pm25 AS
SELECT
    COALESCE(CAST(location_name AS VARCHAR(200)), '') AS town,
    COALESCE(CAST(observation_time AS TIMESTAMP), CURRENT_TIMESTAMP) AS valid_utc,
    CAST('model' AS VARCHAR(30)) AS kind,
    CAST(issued_utc AS TIMESTAMP) AS issued_utc,
    COALESCE(CAST(pm2_5_ug_m3 AS DOUBLE), 0.0) AS pm25,
    CAST('Open-Meteo' AS VARCHAR(100)) AS api_source,
    COALESCE(CAST(ingested_utc AS TIMESTAMP), CURRENT_TIMESTAMP) AS ingested_utc
FROM air_quality.hourly_observations
WHERE location_name IS NOT NULL
  AND observation_time IS NOT NULL
  AND pm2_5_ug_m3 IS NOT NULL
  AND ingested_utc IS NOT NULL;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.concessions AS
SELECT
    COALESCE(CAST(NULL AS VARCHAR(200)), '') AS concession_id,
    CAST(NULL AS VARCHAR(500)) AS name,
    CAST(NULL AS VARCHAR(500)) AS company,
    CAST(NULL AS VARCHAR(500)) AS group_name,
    CAST(NULL AS VARCHAR(100)) AS ctype,
    CAST(NULL AS VARCHAR(100)) AS country,
    CAST(NULL AS DOUBLE) AS area_ha,
    CAST(NULL AS VARCHAR(255)) AS map_source,
    CAST(NULL AS VARCHAR(50)) AS map_date
WHERE 1 = 0;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.companies AS
SELECT
    COALESCE(CAST(NULL AS VARCHAR(500)), '') AS group_name,
    CAST(NULL AS VARCHAR(100)) AS parent_country,
    CAST(NULL AS BOOLEAN) AS rspo_member,
    CAST(NULL AS VARCHAR(500)) AS grievance_contact,
    CAST(NULL AS STRING) AS known_buyers,
    CAST(NULL AS STRING) AS notes
WHERE 1 = 0;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.runs AS
SELECT
    COALESCE(CAST(NULL AS VARCHAR(200)), '') AS run_id,
    COALESCE(CAST(NULL AS VARCHAR(30)), '') AS kind,
    CAST(NULL AS VARCHAR(200)) AS town,
    COALESCE(CAST(NULL AS TIMESTAMP), CURRENT_TIMESTAMP) AS center_utc,
    COALESCE(CAST(NULL AS STRING), '') AS params,
    COALESCE(CAST(NULL AS TIMESTAMP), CURRENT_TIMESTAMP) AS created_utc
WHERE 1 = 0;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.trajectory_points AS
SELECT
    COALESCE(CAST(NULL AS VARCHAR(200)), '') AS run_id,
    COALESCE(CAST(NULL AS INT), 0) AS member,
    COALESCE(CAST(NULL AS DOUBLE), 0.0) AS scale,
    COALESCE(CAST(NULL AS VARCHAR(20)), '') AS level,
    COALESCE(CAST(NULL AS TIMESTAMP), CURRENT_TIMESTAMP) AS release_utc,
    COALESCE(CAST(NULL AS TIMESTAMP), CURRENT_TIMESTAMP) AS step_utc,
    COALESCE(CAST(NULL AS DOUBLE), 0.0) AS lat,
    COALESCE(CAST(NULL AS DOUBLE), 0.0) AS lon
WHERE 1 = 0;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.attribution AS
SELECT
    COALESCE(CAST(NULL AS VARCHAR(200)), '') AS run_id,
    COALESCE(CAST(NULL AS VARCHAR(64)), '') AS fire_id,
    COALESCE(CAST(NULL AS DOUBLE), 0.0) AS scale,
    COALESCE(CAST(NULL AS DOUBLE), 0.0) AS weight
WHERE 1 = 0;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.projections AS
SELECT
    COALESCE(CAST(NULL AS VARCHAR(200)), '') AS run_id,
    COALESCE(CAST(NULL AS VARCHAR(200)), '') AS town,
    COALESCE(CAST(NULL AS TIMESTAMP), CURRENT_TIMESTAMP) AS valid_utc,
    CAST(NULL AS DOUBLE) AS pm25_hour,
    CAST(NULL AS DOUBLE) AS pm25_24h,
    CAST(NULL AS DOUBLE) AS api,
    CAST(NULL AS DOUBLE) AS p_close,
    CAST(NULL AS DOUBLE) AS smoke_index
WHERE 1 = 0;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.cases AS
SELECT
    COALESCE(CAST(NULL AS VARCHAR(200)), '') AS case_id,
    COALESCE(CAST(NULL AS VARCHAR(200)), '') AS concession_id,
    COALESCE(CAST(NULL AS VARCHAR(50)), '') AS status,
    COALESCE(CAST(NULL AS TIMESTAMP), CURRENT_TIMESTAMP) AS opened_utc,
    CAST(NULL AS TIMESTAMP) AS notified_utc,
    CAST(NULL AS TIMESTAMP) AS recheck_due_utc,
    CAST(NULL AS TIMESTAMP) AS escalated_utc,
    CAST(NULL AS TIMESTAMP) AS closed_utc,
    CAST(NULL AS VARCHAR(1000)) AS draft_path
WHERE 1 = 0;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.case_events AS
SELECT
    COALESCE(CAST(NULL AS VARCHAR(200)), '') AS case_id,
    COALESCE(CAST(NULL AS TIMESTAMP), CURRENT_TIMESTAMP) AS at_utc,
    COALESCE(CAST(NULL AS VARCHAR(100)), '') AS event,
    CAST(NULL AS STRING) AS detail,
    CAST(NULL AS STRING) AS evidence_ids
WHERE 1 = 0;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.evidence AS
SELECT
    COALESCE(CAST(NULL AS VARCHAR(200)), '') AS evidence_id,
    COALESCE(CAST(NULL AS VARCHAR(100)), '') AS backend,
    COALESCE(CAST(NULL AS STRING), '') AS sql_text,
    COALESCE(CAST(NULL AS TIMESTAMP), CURRENT_TIMESTAMP) AS executed_utc,
    COALESCE(CAST(NULL AS INT), 0) AS row_count,
    COALESCE(CAST(NULL AS VARCHAR(64)), '') AS sha256,
    COALESCE(CAST(NULL AS STRING), '') AS rows_json
WHERE 1 = 0;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.guidance AS
SELECT
    COALESCE(CAST(NULL AS VARCHAR(200)), '') AS guidance_id,
    COALESCE(CAST(NULL AS VARCHAR(100)), '') AS version,
    COALESCE(CAST(NULL AS VARCHAR(100)), '') AS band,
    COALESCE(CAST(NULL AS DOUBLE), 0.0) AS api_min,
    COALESCE(CAST(NULL AS DOUBLE), 0.0) AS api_max,
    COALESCE(CAST(NULL AS VARCHAR(500)), '') AS action,
    COALESCE(CAST(NULL AS VARCHAR(50)), '') AS heavy_work,
    COALESCE(CAST(NULL AS VARCHAR(50)), '') AS status,
    COALESCE(CAST(NULL AS VARCHAR(1000)), '') AS guidance_source
WHERE 1 = 0;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.agent_runs AS
SELECT
    COALESCE(CAST(NULL AS VARCHAR(200)), '') AS run_id,
    CAST(NULL AS VARCHAR(200)) AS parent_run_id,
    COALESCE(CAST(NULL AS VARCHAR(500)), '') AS decision_key,
    COALESCE(CAST(NULL AS VARCHAR(50)), '') AS status,
    COALESCE(CAST(NULL AS VARCHAR(50)), '') AS mode,
    COALESCE(CAST(NULL AS STRING), '') AS request,
    CAST(NULL AS STRING) AS response,
    CAST(NULL AS VARCHAR(200)) AS snapshot_id,
    CAST(NULL AS TIMESTAMP) AS watermark_utc,
    CAST(NULL AS TIMESTAMP) AS validity_start,
    CAST(NULL AS TIMESTAMP) AS validity_end,
    CAST(NULL AS VARCHAR(50)) AS conclusion_status,
    COALESCE(CAST(NULL AS TIMESTAMP), CURRENT_TIMESTAMP) AS deadline_utc,
    COALESCE(CAST(NULL AS TIMESTAMP), CURRENT_TIMESTAMP) AS created_utc,
    COALESCE(CAST(NULL AS TIMESTAMP), CURRENT_TIMESTAMP) AS updated_utc
WHERE 1 = 0;
