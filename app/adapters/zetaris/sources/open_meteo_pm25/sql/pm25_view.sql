-- Example unified view for the Kuala Lumpur REST table.
-- The fetcher generates one SELECT per registered location.
CREATE SCHEMASTORE VIEW hourly_observations WITH CONTAINER open_meteo_pm25 AS
SELECT
    'kuala-lumpur' AS location_id,
    'Kuala Lumpur' AS location_name,
    CAST(3.1412 AS DOUBLE) AS requested_latitude,
    CAST(101.68653 AS DOUBLE) AS requested_longitude,
    CAST(observation_time AS TIMESTAMP) AS observation_time,
    CAST(element_at(hourly.pm2_5, hour_index + 1) AS DOUBLE) AS pm2_5_ug_m3
FROM OPEN_METEO_PM25_REST.pm25_kuala_lumpur
LATERAL VIEW posexplode(hourly.time) AS hour_index, observation_time;
