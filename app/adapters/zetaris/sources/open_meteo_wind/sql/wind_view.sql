-- Example unified view for the Kuala Lumpur REST table.
-- The fetcher generates one SELECT per location and wind level.
CREATE SCHEMASTORE VIEW hourly_observations WITH CONTAINER open_meteo_wind AS
SELECT
    'kuala-lumpur' AS location_id,
    'Kuala Lumpur' AS location_name,
    CAST(3.1412 AS DOUBLE) AS requested_latitude,
    CAST(101.68653 AS DOUBLE) AS requested_longitude,
    CAST(observation_time AS TIMESTAMP) AS observation_time,
    '10m' AS level,
    CAST(element_at(hourly.wind_speed_10m, hour_index + 1) AS DOUBLE) AS wind_speed_ms,
    CAST(element_at(hourly.wind_direction_10m, hour_index + 1) AS DOUBLE) AS wind_direction_deg,
    -CAST(element_at(hourly.wind_speed_10m, hour_index + 1) AS DOUBLE)
      * SIN(RADIANS(CAST(element_at(hourly.wind_direction_10m, hour_index + 1) AS DOUBLE))) AS u_ms,
    -CAST(element_at(hourly.wind_speed_10m, hour_index + 1) AS DOUBLE)
      * COS(RADIANS(CAST(element_at(hourly.wind_direction_10m, hour_index + 1) AS DOUBLE))) AS v_ms
FROM OPEN_METEO_WIND_REST.wind_kuala_lumpur
LATERAL VIEW posexplode(hourly.time) AS hour_index, observation_time
UNION ALL
SELECT
    'kuala-lumpur' AS location_id,
    'Kuala Lumpur' AS location_name,
    CAST(3.1412 AS DOUBLE) AS requested_latitude,
    CAST(101.68653 AS DOUBLE) AS requested_longitude,
    CAST(observation_time AS TIMESTAMP) AS observation_time,
    '850hPa' AS level,
    CAST(element_at(hourly.wind_speed_850hPa, hour_index + 1) AS DOUBLE) AS wind_speed_ms,
    CAST(element_at(hourly.wind_direction_850hPa, hour_index + 1) AS DOUBLE) AS wind_direction_deg,
    -CAST(element_at(hourly.wind_speed_850hPa, hour_index + 1) AS DOUBLE)
      * SIN(RADIANS(CAST(element_at(hourly.wind_direction_850hPa, hour_index + 1) AS DOUBLE))) AS u_ms,
    -CAST(element_at(hourly.wind_speed_850hPa, hour_index + 1) AS DOUBLE)
      * COS(RADIANS(CAST(element_at(hourly.wind_direction_850hPa, hour_index + 1) AS DOUBLE))) AS v_ms
FROM OPEN_METEO_WIND_REST.wind_kuala_lumpur
LATERAL VIEW posexplode(hourly.time) AS hour_index, observation_time;
