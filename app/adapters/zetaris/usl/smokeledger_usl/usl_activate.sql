-- Run after compiling the Environmental USL. These entities expose its
-- current source-backed locations, fires, PM2.5 and wind as a smoke-focused view.

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
FROM lightning.metastore.malaysia_env.malaysia_env_usl.air_quality_obs
UNION ALL
SELECT
    location_index,
    observation_time,
    'open_meteo_pm25' AS api_source,
    pm2_5_ug_m3,
    CAST(NULL AS DOUBLE) AS pm10_ug_m3
FROM lightning.metastore.malaysia_env.malaysia_env_usl.open_meteo_pm25_obs;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.wind AS
SELECT
    location_index,
    observation_time,
    level,
    wind_speed_ms,
    wind_direction_deg,
    u_ms,
    v_ms
FROM lightning.metastore.malaysia_env.malaysia_env_usl.open_meteo_wind_obs;
