-- =============================================================================
-- Windy Point Forecast Schemastore Views (Kuala Lumpur Default)
--
-- Unrolls time-series arrays into tabular rows:
--   - windy.gfs_forecast    : GFS weather, temperature in °C, humidity, wind speed & direction
--   - windy.cams_air_quality: CAMS air quality, PM2.5, PM10, AQI, NO2, dust
-- =============================================================================

CREATE SCHEMASTORE VIEW gfs_forecast WITH CONTAINER windy AS
SELECT
    'Kuala Lumpur' AS location_name,
    3.1412 AS requested_latitude,
    101.68653 AS requested_longitude,
    CAST(from_unixtime(CAST(epoch_ms / 1000 AS BIGINT)) AS TIMESTAMP) AS forecast_time,
    ROUND(CAST(element_at(`temp-surface`, idx + 1) - 273.15 AS DOUBLE), 2) AS temp_c,
    ROUND(CAST(element_at(`rh-surface`, idx + 1) AS DOUBLE), 2) AS relative_humidity_pct,
    ROUND(CAST(element_at(`pressure-surface`, idx + 1) / 100.0 AS DOUBLE), 2) AS pressure_hpa,
    ROUND(CAST(element_at(`wind_u-surface`, idx + 1) AS DOUBLE), 2) AS wind_u_ms,
    ROUND(CAST(element_at(`wind_v-surface`, idx + 1) AS DOUBLE), 2) AS wind_v_ms,
    ROUND(CAST(SQRT(POW(element_at(`wind_u-surface`, idx + 1), 2) + POW(element_at(`wind_v-surface`, idx + 1), 2)) AS DOUBLE), 2) AS wind_speed_ms,
    ROUND(CAST((DEGREES(ATAN2(-element_at(`wind_u-surface`, idx + 1), -element_at(`wind_v-surface`, idx + 1))) + 360) % 360 AS DOUBLE), 1) AS wind_direction_deg,
    ROUND(CAST(element_at(`gust-surface`, idx + 1) AS DOUBLE), 2) AS wind_gust_ms
FROM WINDY_REST.windy_gfs_raw
LATERAL VIEW posexplode(ts) AS idx, epoch_ms;

CREATE SCHEMASTORE VIEW cams_air_quality WITH CONTAINER windy AS
SELECT
    'Kuala Lumpur' AS location_name,
    3.1412 AS requested_latitude,
    101.68653 AS requested_longitude,
    CAST(from_unixtime(CAST(epoch_ms / 1000 AS BIGINT)) AS TIMESTAMP) AS observation_time,
    ROUND(CAST(element_at(`pm2p5-surface`, idx + 1) AS DOUBLE), 2) AS pm2_5_ug_m3,
    ROUND(CAST(element_at(`pm10-surface`, idx + 1) AS DOUBLE), 2) AS pm10_ug_m3,
    ROUND(CAST(element_at(`aqi_us-surface`, idx + 1) AS DOUBLE), 1) AS aqi_us,
    ROUND(CAST(element_at(`no2-surface`, idx + 1) AS DOUBLE), 2) AS no2_ug_m3,
    ROUND(CAST(element_at(`chem_dustsm-surface`, idx + 1) AS DOUBLE), 2) AS dust_ug_m3
FROM WINDY_REST.windy_cams_raw
LATERAL VIEW posexplode(ts) AS idx, epoch_ms;
