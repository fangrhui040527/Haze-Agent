-- Activate live Open-Meteo PM2.5 REST results in the environmental USL.
-- Compile/update malaysia_env_usl with usl/env_usl/usl_schema.sql first.
ACTIVATE USL TABLE lightning.metastore.malaysia_env.malaysia_env_usl.open_meteo_pm25_obs AS
SELECT
    loc.location_index AS location_index,
    CAST(obs.observation_time AS TIMESTAMP) AS observation_time,
    CAST(obs.pm2_5_ug_m3 AS DOUBLE) AS pm2_5_ug_m3
FROM open_meteo_pm25.hourly_observations obs
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON obs.location_id = loc.location_id;
