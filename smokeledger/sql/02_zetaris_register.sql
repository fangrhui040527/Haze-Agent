-- Run these in the Zetaris SQL Editor (http://localhost:3000), ONE statement at a time.
-- Prerequisites: `docker compose up -d` in this project, then `npm run sl -- db:init`.
--
-- host.docker.internal lets the Zetaris containers reach the Postgres port on your laptop.
-- Docker Desktop (Mac/Windows) provides it. On Linux, add
--   extra_hosts: ["host.docker.internal:host-gateway"]
-- to the Zetaris driver and api services, or use your machine's LAN IP instead.

-- 1. Register the SmokeLedger evidence store as a datasource (administrator only).
CREATE DATASOURCE sl_pg DESCRIBE BY "SmokeLedger haze evidence store" OPTIONS (
  jdbcdriver "org.postgresql.Driver",
  jdbcurl "jdbc:postgresql://host.docker.internal:5433/smokeledger",
  username "smokeledger",
  password "smokeledger",
  fetchsize "1000"
);

-- 2. Import every table's metadata.
REGISTER DATASOURCE TABLES FROM sl_pg;

-- 3. Check it works. Expect the town list you loaded.
SELECT town, lat, lon FROM sl_pg.towns;

-- If you add a table later, run REGISTER DATASOURCE TABLE "<name>" FROM sl_pg.
-- If rows look stale, run REFRESH DATASOURCE TABLES sl_pg (see the Zetaris
-- Lightning SQL guide, section 4.10).

-- ---------------------------------------------------------------------------
-- 4. OPTIONAL federation demo: a LIVE Open-Meteo source next to the stored data.
-- A Lightning REST table calls the API on every query, so keep it small.
-- Not tested on a live Zetaris yet: run each statement and check the result
-- before relying on it in the demo.
-- ---------------------------------------------------------------------------
CREATE LIGHTNING DATABASE OPENMETEO_REST DESCRIBE BY "Open-Meteo live air quality";

CREATE SCHEMASTORE CONTAINER smokeledger;

CREATE LIGHTNING REST TABLE batu_pahat_aq FROM OPENMETEO_REST REQUEST(
    endpoint "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=1.8548&longitude=102.9325&hourly=pm2_5&forecast_days=3&timezone=GMT",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
) BODY ();

-- Open-Meteo returns parallel arrays (hourly.time[], hourly.pm2_5[]), so explode
-- the time array with its position and pick the matching PM2.5 value.
CREATE SCHEMASTORE VIEW batu_pahat_pm25_live WITH CONTAINER smokeledger AS
SELECT 'Batu Pahat' AS town, ts AS valid_time, element_at(hourly.pm2_5, i + 1) AS pm25
FROM openmeteo_rest.batu_pahat_aq
LATERAL VIEW posexplode(hourly.time) t AS i, ts;

-- One query across both sources: live model PM2.5 next to the stored observations.
SELECT l.valid_time, l.pm25 AS live_model_pm25, t.lat, t.lon
FROM smokeledger.batu_pahat_pm25_live l
JOIN sl_pg.towns t ON t.town = l.town;
