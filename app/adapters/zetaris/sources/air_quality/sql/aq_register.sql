-- =============================================================================
-- Open-Meteo Air Quality REST registration example (Kuala Lumpur).
-- =============================================================================

CREATE LIGHTNING DATABASE OPEN_METEO_AIR_QUALITY
DESCRIBE BY "Open-Meteo hourly air quality API";

CREATE SCHEMASTORE CONTAINER air_quality;

CREATE LIGHTNING REST TABLE aq_kuala_lumpur
FROM OPEN_METEO_AIR_QUALITY
REQUEST(
    endpoint "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=3.14120&longitude=101.68653&hourly=pm2_5%2Cpm10&past_days=1&forecast_days=3&timezone=GMT",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER () BODY ();
