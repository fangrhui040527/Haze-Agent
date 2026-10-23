-- =============================================================================
-- Windy Point Forecast REST Tables & Container Registration (Kuala Lumpur Default)
--
-- Exposes two point-forecast REST tables:
--   - GFS Weather Forecast (temperature, relative humidity, pressure, wind vectors)
--   - CAMS Air Quality Forecast (PM2.5, PM10, AQI, NO2, dust)
--
-- Coordinate Default:
--   Kuala Lumpur (Latitude: 3.1412, Longitude: 101.68653)
-- =============================================================================

CREATE LIGHTNING DATABASE WINDY_REST
DESCRIBE BY "Windy Point Forecast REST API";

CREATE SCHEMASTORE CONTAINER windy;

-- 1. GFS Numerical Weather Forecast for Kuala Lumpur
CREATE LIGHTNING REST TABLE windy_gfs_raw
FROM WINDY_REST
REQUEST(
    endpoint "https://api.windy.com/api/point-forecast/v2",
    method "post",
    response_type "json",
    http_encoding "JSON"
) HEADER (
    "Content-Type" "application/json"
) BODY (
    lat "3.1412",
    lon "101.68653",
    model "gfs",
    parameters "[\"wind\",\"temp\",\"rh\",\"pressure\",\"windGust\",\"precip\"]",
    levels "[\"surface\"]",
    key "${WINDY_API_KEY}"
);

-- 2. CAMS Atmospheric Composition & Air Quality for Kuala Lumpur
CREATE LIGHTNING REST TABLE windy_cams_raw
FROM WINDY_REST
REQUEST(
    endpoint "https://api.windy.com/api/point-forecast/v2",
    method "post",
    response_type "json",
    http_encoding "JSON"
) HEADER (
    "Content-Type" "application/json"
) BODY (
    lat "3.1412",
    lon "101.68653",
    model "cams",
    parameters "[\"pm2p5\",\"pm10\",\"aqi\",\"no2\",\"dustsm\"]",
    levels "[\"surface\"]",
    key "${WINDY_API_KEY}"
);
