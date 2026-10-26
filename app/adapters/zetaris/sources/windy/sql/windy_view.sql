-- =============================================================================
-- Windy Point Forecast Schemastore Views (Kuala Lumpur Default)
--
-- Exposes tabular forecast views:
--   - windy.gfs_forecast    : GFS weather, temperature in °C, humidity, wind speed & direction
--   - windy.cams_air_quality: CAMS air quality, PM2.5, PM10, AQI, NO2, dust
-- =============================================================================

DROP VIEW IF EXISTS windy.gfs_forecast;
DROP VIEW IF EXISTS windy.cams_air_quality;

CREATE SCHEMASTORE VIEW gfs_forecast WITH CONTAINER windy AS
SELECT
    location_name,
    CAST(requested_latitude AS DOUBLE) AS requested_latitude,
    CAST(requested_longitude AS DOUBLE) AS requested_longitude,
    CAST(forecast_time AS TIMESTAMP) AS forecast_time,
    CAST(temp_c AS DOUBLE) AS temp_c,
    CAST(relative_humidity_pct AS DOUBLE) AS relative_humidity_pct,
    CAST(pressure_hpa AS DOUBLE) AS pressure_hpa,
    CAST(wind_u_ms AS DOUBLE) AS wind_u_ms,
    CAST(wind_v_ms AS DOUBLE) AS wind_v_ms,
    CAST(wind_speed_ms AS DOUBLE) AS wind_speed_ms,
    CAST(wind_direction_deg AS DOUBLE) AS wind_direction_deg,
    CAST(wind_gust_ms AS DOUBLE) AS wind_gust_ms
FROM WINDY_FILES.windy_gfs_raw_v2;

CREATE SCHEMASTORE VIEW cams_air_quality WITH CONTAINER windy AS
SELECT
    location_name,
    CAST(requested_latitude AS DOUBLE) AS requested_latitude,
    CAST(requested_longitude AS DOUBLE) AS requested_longitude,
    CAST(observation_time AS TIMESTAMP) AS observation_time,
    CAST(pm2_5_ug_m3 AS DOUBLE) AS pm2_5_ug_m3,
    CAST(pm10_ug_m3 AS DOUBLE) AS pm10_ug_m3,
    CAST(aqi_us AS DOUBLE) AS aqi_us,
    CAST(no2_ug_m3 AS DOUBLE) AS no2_ug_m3,
    CAST(dust_ug_m3 AS DOUBLE) AS dust_ug_m3
FROM WINDY_FILES.windy_cams_raw_v2;
