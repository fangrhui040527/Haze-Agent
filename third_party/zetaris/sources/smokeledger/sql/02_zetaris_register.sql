-- Run these in the Zetaris SQL Editor (http://localhost:3000), ONE statement at a time.
-- Prerequisites: `npm run db:init` in the project root.
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

-- 3. Check connectivity. This returns no rows until towns have been loaded.
SELECT town, lat, lon FROM sl_pg.towns;

-- If you add a table later, run REGISTER DATASOURCE TABLE "<name>" FROM sl_pg.
-- If rows look stale, run REFRESH DATASOURCE TABLES sl_pg (see the Zetaris
-- Lightning SQL guide, section 4.10).
