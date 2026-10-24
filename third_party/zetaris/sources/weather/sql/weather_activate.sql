-- =============================================================================
-- Activate USL Fact Table: weather_forecast
--
-- Model: malaysia_env_usl
-- Namespace: lightning.metastore.malaysia_env
-- Target Table: weather_forecast
--
-- Source: DATA_GOV_MY_WEATHER.forecasts_raw (Data.gov.my REST API)
-- Joins with USL location_code on location_id = location_code.
-- Supports all 5 location types: State (St), Recreation Centre (Rc),
-- District (Ds), Town (Tn), and Division (Dv).
-- =============================================================================

ACTIVATE USL TABLE lightning.metastore.malaysia_env.malaysia_env_usl.weather_forecast AS
SELECT
    COALESCE(CAST(raw.location.location_id AS VARCHAR(10)), '') AS location_code,
    CAST(raw.date AS DATE) AS forecast_date,
    CAST(raw.location.location_name AS VARCHAR(200)) AS location_name,
    CAST(raw.morning_forecast AS VARCHAR(500)) AS morning_forecast,
    CAST(raw.afternoon_forecast AS VARCHAR(500)) AS afternoon_forecast,
    CAST(raw.night_forecast AS VARCHAR(500)) AS night_forecast
FROM DATA_GOV_MY_WEATHER.forecasts_raw raw
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_code lc
  ON raw.location.location_id = lc.location_code;
