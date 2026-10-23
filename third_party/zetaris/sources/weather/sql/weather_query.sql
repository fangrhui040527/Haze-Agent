-- =============================================================================
-- Query Verified USL Fact Table: weather_forecast
-- =============================================================================

SELECT
    loc.location_index,
    loc.location_name,
    lc.location_code,
    lc.code_type,
    w.forecast_date,
    w.morning_forecast,
    w.afternoon_forecast,
    w.night_forecast
FROM lightning.metastore.malaysia_env.malaysia_env_usl.weather_forecast w
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_code lc
  ON w.location_code = lc.location_code
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON lc.location_index = loc.location_index
WHERE loc.location_id = 'kuala-lumpur'
ORDER BY w.forecast_date DESC, lc.location_code
LIMIT 10;
