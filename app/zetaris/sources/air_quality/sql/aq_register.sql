-- =============================================================================
-- Open-Meteo Air Quality REST Table & Container Registration
-- =============================================================================

CREATE LIGHTNING DATABASE OPEN_METEO_AIR_QUALITY
DESCRIBE BY "Open-Meteo air quality API";

CREATE SCHEMASTORE CONTAINER air_quality;

-- Sample REST table registration (dynamically created for each canonical location):
CREATE LIGHTNING REST TABLE aq_kuala_lumpur
FROM OPEN_METEO_AIR_QUALITY
REQUEST(
    endpoint "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=3.1412&longitude=101.68653&hourly=pm2_5,pm10&timezone=Asia%2FKuala_Lumpur",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER () BODY ();
