-- Activate live Open-Meteo wind REST results in the environmental USL.
-- Ensure malaysia_env_usl includes open_meteo_wind_obs before activating this table.
ACTIVATE USL TABLE lightning.metastore.malaysia_env.malaysia_env_usl.open_meteo_wind_obs AS
SELECT
    loc.location_index AS location_index,
    CAST(obs.observation_time AS TIMESTAMP) AS observation_time,
    CAST(obs.level AS VARCHAR(20)) AS level,
    CAST(obs.wind_speed_ms AS DOUBLE) AS wind_speed_ms,
    CAST(obs.wind_direction_deg AS DOUBLE) AS wind_direction_deg,
    CAST(obs.u_ms AS DOUBLE) AS u_ms,
    CAST(obs.v_ms AS DOUBLE) AS v_ms
FROM open_meteo_wind.hourly_observations obs
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON obs.location_id = loc.location_id;
