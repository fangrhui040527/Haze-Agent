-- =============================================================================
-- Data.gov.my Official Weather Forecasts View (All 5 Code Types)
-- =============================================================================

CREATE SCHEMASTORE VIEW forecasts_all WITH CONTAINER weather AS
SELECT
    location.location_id   AS location_code,
    location.location_name AS location_name,
    date                   AS forecast_date,
    morning_forecast,
    afternoon_forecast,
    night_forecast
FROM DATA_GOV_MY_WEATHER.forecasts_raw;

