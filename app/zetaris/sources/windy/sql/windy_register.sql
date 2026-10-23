-- =============================================================================
-- Windy Point Forecast FileStore Tables & Container Registration (Kuala Lumpur Default)
--
-- Exposes two point-forecast FileStore tables:
--   - GFS Weather Forecast (temperature, relative humidity, pressure, wind vectors)
--   - CAMS Air Quality Forecast (PM2.5, PM10, AQI, NO2, dust)
--
-- Container Storage Path:
--   /home/zetaris/customer-data/shared/windy/
-- =============================================================================

CREATE LIGHTNING DATABASE WINDY_FILES
DESCRIBE BY "Windy Point Forecast CSV files";

CREATE SCHEMASTORE CONTAINER windy;

-- 1. GFS Numerical Weather Forecast for Kuala Lumpur
CREATE LIGHTNING FILESTORE TABLE windy_gfs_raw
FROM WINDY_FILES
FORMAT CSV
OPTIONS (
    PATH "/home/zetaris/customer-data/shared/windy/windy_gfs.csv",
    header "true",
    inferSchema "true"
);

-- 2. CAMS Atmospheric Composition & Air Quality for Kuala Lumpur
CREATE LIGHTNING FILESTORE TABLE windy_cams_raw
FROM WINDY_FILES
FORMAT CSV
OPTIONS (
    PATH "/home/zetaris/customer-data/shared/windy/windy_cams.csv",
    header "true",
    inferSchema "true"
);
