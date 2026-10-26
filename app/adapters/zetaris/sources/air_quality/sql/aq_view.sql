-- =============================================================================
-- Open-Meteo Air Quality Hourly Observations Schemastore View
-- =============================================================================

CREATE SCHEMASTORE VIEW hourly_observations WITH CONTAINER air_quality AS
SELECT
    'kuala-lumpur' AS location_id,
    'Kuala Lumpur' AS location_name,
    3.1412 AS requested_latitude,
    101.68653 AS requested_longitude,
    observation_time,
    CAST(element_at(hourly.pm2_5, hour_index + 1) AS DOUBLE) AS pm2_5_ug_m3,
    CAST(element_at(hourly.pm10, hour_index + 1) AS DOUBLE) AS pm10_ug_m3,
    CAST(NULL AS TIMESTAMP) AS issued_utc,
    CAST(NULL AS TIMESTAMP) AS ingested_utc
FROM OPEN_METEO_AIR_QUALITY.aq_kuala_lumpur
LATERAL VIEW posexplode(hourly.time) AS hour_index, observation_time;
