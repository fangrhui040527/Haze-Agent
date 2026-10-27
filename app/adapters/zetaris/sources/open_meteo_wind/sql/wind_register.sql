-- Example registration for Kuala Lumpur.
-- The fetcher generates equivalent REST table definitions for selected locations.
CREATE LIGHTNING DATABASE OPEN_METEO_WIND_REST
DESCRIBE BY "Open-Meteo hourly wind forecast API";

CREATE SCHEMASTORE CONTAINER open_meteo_wind;

CREATE LIGHTNING REST TABLE wind_kuala_lumpur
FROM OPEN_METEO_WIND_REST
REQUEST(
    endpoint "https://api.open-meteo.com/v1/forecast?latitude=3.14120&longitude=101.68653&hourly=wind_speed_10m%2Cwind_direction_10m%2Cwind_speed_850hPa%2Cwind_direction_850hPa&wind_speed_unit=ms&past_days=1&forecast_days=3&timezone=GMT",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER () BODY ();
