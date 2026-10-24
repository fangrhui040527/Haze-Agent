-- Optional live Open-Meteo federation demo; run each statement separately.
-- These REST objects are independent of the stored SmokeLedger datasource.

CREATE LIGHTNING DATABASE OPENMETEO_REST DESCRIBE BY "Open-Meteo live air quality";

CREATE SCHEMASTORE CONTAINER smokeledger;

CREATE LIGHTNING REST TABLE batu_pahat_aq FROM OPENMETEO_REST REQUEST(
    endpoint "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=1.8548&longitude=102.9325&hourly=pm2_5&forecast_days=3&timezone=GMT",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
) BODY ();

CREATE SCHEMASTORE VIEW batu_pahat_pm25_live WITH CONTAINER smokeledger AS
SELECT 'Batu Pahat' AS town, ts AS valid_time, element_at(hourly.pm2_5, i + 1) AS pm25
FROM openmeteo_rest.batu_pahat_aq
LATERAL VIEW posexplode(hourly.time) t AS i, ts;

SELECT l.valid_time, l.pm25 AS live_model_pm25, t.lat, t.lon
FROM smokeledger.batu_pahat_pm25_live l
JOIN sl_pg.towns t ON t.town = l.town;
