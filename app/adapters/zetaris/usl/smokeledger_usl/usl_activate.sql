-- Run after compiling the Environmental USL and publishing the wind source.
-- This view combines Environmental records with the independent wind feed.

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.locations AS
SELECT
    location_index,
    location_id,
    location_name,
    latitude,
    longitude
FROM lightning.metastore.malaysia_env.malaysia_env_usl.location_dim;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.fires AS
SELECT
    location_index,
    acq_utc,
    acq_myt,
    fire_latitude,
    fire_longitude,
    bright_ti4,
    frp,
    confidence,
    satellite,
    instrument,
    fire_source,
    daynight
FROM lightning.metastore.malaysia_env.malaysia_env_usl.active_fires;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.pm25 AS
SELECT
    location_index,
    observation_time,
    'open_meteo_air_quality' AS api_source,
    pm2_5_ug_m3,
    pm10_ug_m3
FROM lightning.metastore.malaysia_env.malaysia_env_usl.air_quality_obs;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.wind AS
SELECT
    loc.location_index AS location_index,
    CAST(w.observation_time AS TIMESTAMP) AS observation_time,
    CAST(w.level AS VARCHAR(20)) AS level,
    CAST(w.u AS DOUBLE) AS u_ms,
    CAST(w.v AS DOUBLE) AS v_ms,
    CAST(w.ingested_utc AS TIMESTAMP) AS ingested_utc
FROM wind.hourly_observations w
JOIN lightning.metastore.smokeledger.smokeledger_usl.locations loc
  ON w.location_name = loc.location_name;
