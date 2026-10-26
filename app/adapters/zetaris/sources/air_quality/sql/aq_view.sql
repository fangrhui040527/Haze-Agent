CREATE OR REPLACE SCHEMASTORE VIEW hourly_observations WITH CONTAINER air_quality AS
SELECT
    location_name,
    CAST(requested_latitude AS DOUBLE) AS requested_latitude,
    CAST(requested_longitude AS DOUBLE) AS requested_longitude,
    observation_time,
    CAST(pm2_5_ug_m3 AS DOUBLE) AS pm2_5_ug_m3,
    CAST(pm10_ug_m3 AS DOUBLE) AS pm10_ug_m3,
    ingested_utc,
    CAST(NULL AS TIMESTAMP) AS issued_utc
FROM OPEN_METEO_AIR_QUALITY.hourly_snapshot;
