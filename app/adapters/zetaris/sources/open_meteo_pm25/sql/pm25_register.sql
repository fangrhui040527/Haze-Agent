-- Example registration for Kuala Lumpur.
-- The fetcher generates equivalent REST table definitions for selected locations.
CREATE LIGHTNING DATABASE OPEN_METEO_PM25_REST
DESCRIBE BY "Open-Meteo hourly modeled PM2.5 API";

CREATE SCHEMASTORE CONTAINER open_meteo_pm25;

CREATE LIGHTNING REST TABLE pm25_kuala_lumpur
FROM OPEN_METEO_PM25_REST
REQUEST(
    endpoint "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=3.14120&longitude=101.68653&hourly=pm2_5&past_days=1&forecast_days=3&timezone=GMT",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER () BODY ();
