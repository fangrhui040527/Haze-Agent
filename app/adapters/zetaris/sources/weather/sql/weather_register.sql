-- =============================================================================
-- Data.gov.my Official Weather Forecast REST Table & Container Registration
-- =============================================================================

CREATE LIGHTNING DATABASE DATA_GOV_MY_WEATHER
DESCRIBE BY "Data.gov.my weather forecast API";

CREATE SCHEMASTORE CONTAINER weather;

CREATE LIGHTNING REST TABLE forecasts_raw
FROM DATA_GOV_MY_WEATHER
REQUEST(
    endpoint "https://api.data.gov.my/weather/forecast/",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER () BODY ();
