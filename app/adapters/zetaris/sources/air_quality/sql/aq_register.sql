-- =============================================================================
-- Open-Meteo Air Quality stored snapshot registration
-- =============================================================================

CREATE LIGHTNING DATABASE OPEN_METEO_AIR_QUALITY
DESCRIBE BY "Open-Meteo air quality stored snapshots";

CREATE SCHEMASTORE CONTAINER air_quality;

-- fetch_air_quality.ts publishes a complete CSV before executing this SQL.
-- Keep raw timestamps as UTC strings; only the typed view converts numbers.
CREATE LIGHTNING FILESTORE TABLE hourly_snapshot
FROM OPEN_METEO_AIR_QUALITY
FORMAT CSV OPTIONS (
    PATH "/home/zetaris/customer-data/shared/air_quality/snapshot.csv",
    header "true", inferSchema "false", nullValue ""
);

UPDATE LIGHTNING FILESTORE TABLE hourly_snapshot FROM OPEN_METEO_AIR_QUALITY OPTIONS (
    PATH "/home/zetaris/customer-data/shared/air_quality/snapshot.csv",
    header "true", inferSchema "false", nullValue ""
);

CREATE OR REPLACE SCHEMASTORE VIEW hourly_observations WITH CONTAINER air_quality AS
SELECT location_name,
    CAST(requested_latitude AS DOUBLE) AS requested_latitude,
    CAST(requested_longitude AS DOUBLE) AS requested_longitude,
    observation_time,
    CAST(pm2_5_ug_m3 AS DOUBLE) AS pm2_5_ug_m3,
    CAST(pm10_ug_m3 AS DOUBLE) AS pm10_ug_m3,
    ingested_utc,
    CAST(NULL AS TIMESTAMP) AS issued_utc
FROM OPEN_METEO_AIR_QUALITY.hourly_snapshot;
