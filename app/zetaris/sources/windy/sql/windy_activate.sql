-- =============================================================================
-- Activate USL Fact Tables for Windy Point Forecast (Kuala Lumpur Default)
--
-- Model: malaysia_env_usl
-- Namespace: lightning.metastore.malaysia_env
-- Target Tables:
--   - windy_forecast_obs
--   - windy_air_quality_obs
--
-- Joins with USL location_dim on location_name = 'Kuala Lumpur' (location_index = 14).
-- =============================================================================

ACTIVATE USL TABLE lightning.metastore.malaysia_env.malaysia_env_usl.windy_forecast_obs AS
SELECT
    loc.location_index AS location_index,
    w.forecast_time AS forecast_time,
    w.temp_c AS temp_c,
    w.relative_humidity_pct AS relative_humidity_pct,
    w.pressure_hpa AS pressure_hpa,
    w.wind_speed_ms AS wind_speed_ms,
    w.wind_direction_deg AS wind_direction_deg,
    w.wind_gust_ms AS wind_gust_ms
FROM windy.gfs_forecast w
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON (w.location_name = loc.location_name OR loc.location_id = 'wp-kuala-lumpur');

ACTIVATE USL TABLE lightning.metastore.malaysia_env.malaysia_env_usl.windy_air_quality_obs AS
SELECT
    loc.location_index AS location_index,
    c.observation_time AS observation_time,
    c.pm2_5_ug_m3 AS pm2_5_ug_m3,
    c.pm10_ug_m3 AS pm10_ug_m3,
    c.aqi_us AS aqi_us,
    c.no2_ug_m3 AS no2_ug_m3,
    c.dust_ug_m3 AS dust_ug_m3
FROM windy.cams_air_quality c
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON (c.location_name = loc.location_name OR loc.location_id = 'wp-kuala-lumpur');
