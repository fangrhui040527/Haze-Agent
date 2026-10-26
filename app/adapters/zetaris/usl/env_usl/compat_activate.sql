-- Keep the legacy entity names available for deployed clients while sourcing
-- them from the current normalized Open-Meteo and Windy feeds.
ACTIVATE USL TABLE lightning.metastore.malaysia_env.malaysia_env_usl.open_meteo_pm25_obs AS
SELECT
    loc.location_index AS location_index,
    CAST(obs.observation_time AS TIMESTAMP) AS observation_time,
    CAST(obs.pm2_5_ug_m3 AS DOUBLE) AS pm2_5_ug_m3
FROM air_quality.hourly_observations obs
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON obs.location_name = loc.location_name;

ACTIVATE USL TABLE lightning.metastore.malaysia_env.malaysia_env_usl.open_meteo_wind_obs AS
SELECT
    loc.location_index AS location_index,
    CAST(w.forecast_time AS TIMESTAMP) AS observation_time,
    'surface' AS level,
    CAST(w.wind_speed_ms AS DOUBLE) AS wind_speed_ms,
    CAST(w.wind_direction_deg AS DOUBLE) AS wind_direction_deg,
    CAST(w.wind_u_ms AS DOUBLE) AS u_ms,
    CAST(w.wind_v_ms AS DOUBLE) AS v_ms
FROM windy.gfs_forecast w
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON (w.location_name = loc.location_name OR loc.location_id = 'wp-kuala-lumpur');
