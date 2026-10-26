-- Run after fetch_wind.ts has published snapshot.csv to the Zetaris driver.
CREATE LIGHTNING DATABASE OPEN_METEO_WIND DESCRIBE BY "Open-Meteo wind stored snapshots";
CREATE SCHEMASTORE CONTAINER wind;

CREATE LIGHTNING FILESTORE TABLE hourly_snapshot FROM OPEN_METEO_WIND FORMAT CSV OPTIONS (
    PATH "/home/zetaris/customer-data/shared/wind/snapshot.csv",
    header "true", inferSchema "false", nullValue ""
);

UPDATE LIGHTNING FILESTORE TABLE hourly_snapshot FROM OPEN_METEO_WIND OPTIONS (
    PATH "/home/zetaris/customer-data/shared/wind/snapshot.csv",
    header "true", inferSchema "false", nullValue ""
);

CREATE OR REPLACE SCHEMASTORE VIEW hourly_observations WITH CONTAINER wind AS
SELECT location_name,
    CAST(requested_latitude AS DOUBLE) AS requested_latitude,
    CAST(requested_longitude AS DOUBLE) AS requested_longitude,
    observation_time, level,
    CAST(u AS DOUBLE) AS u,
    CAST(v AS DOUBLE) AS v,
    ingested_utc,
    CAST(NULL AS TIMESTAMP) AS issued_utc
FROM OPEN_METEO_WIND.hourly_snapshot;
