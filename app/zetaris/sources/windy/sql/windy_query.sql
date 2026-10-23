-- =============================================================================
-- Query Verified USL Windy Forecast Tables: Kuala Lumpur
-- =============================================================================

-- 1. Query GFS Numerical Weather Forecast for Kuala Lumpur
SELECT
    loc.location_index,
    loc.location_id,
    loc.location_name,
    w.forecast_time,
    w.temp_c,
    w.relative_humidity_pct,
    w.pressure_hpa,
    w.wind_speed_ms,
    w.wind_direction_deg,
    w.wind_gust_ms
FROM lightning.metastore.malaysia_env.malaysia_env_usl.windy_forecast_obs w
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON w.location_index = loc.location_index
WHERE loc.location_id = 'kuala-lumpur'
ORDER BY w.forecast_time DESC
LIMIT 10;

-- 2. Query CAMS Air Quality Forecast for Kuala Lumpur
SELECT
    loc.location_index,
    loc.location_id,
    loc.location_name,
    c.observation_time,
    c.pm2_5_ug_m3,
    c.pm10_ug_m3,
    c.aqi_us,
    c.no2_ug_m3,
    c.dust_ug_m3
FROM lightning.metastore.malaysia_env.malaysia_env_usl.windy_air_quality_obs c
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON c.location_index = loc.location_index
WHERE loc.location_id = 'kuala-lumpur'
ORDER BY c.observation_time DESC
LIMIT 10;
