-- =============================================================================
-- USL: smokeledger_usl
-- Read-only smoke evidence model over the current Environmental USL.
--
-- This model uses current Zetaris source feeds and has no PostgreSQL dependency.
-- Stateful legacy tables (cases, runs, evidence, and agent_runs) are not source
-- data and are intentionally not represented here.
-- =============================================================================

CREATE NAMESPACE IF NOT EXISTS lightning.metastore;
CREATE NAMESPACE IF NOT EXISTS lightning.metastore.smokeledger;

COMPILE USL IF NOT EXISTS smokeledger_usl DEPLOY NAMESPACE lightning.metastore.smokeledger DDL
CREATE TABLE locations (
    location_index int NOT NULL PRIMARY KEY,
    location_id varchar(80),
    location_name varchar(200),
    latitude double,
    longitude double
);
CREATE TABLE fires (
    location_index int FOREIGN KEY REFERENCES locations(location_index),
    acq_utc timestamp,
    acq_myt timestamp,
    fire_latitude double,
    fire_longitude double,
    bright_ti4 double,
    frp double,
    confidence varchar(1),
    satellite varchar(50),
    instrument varchar(50),
    fire_source varchar(30),
    daynight varchar(1)
);
CREATE TABLE pm25 (
    location_index int FOREIGN KEY REFERENCES locations(location_index),
    observation_time timestamp,
    api_source varchar(50),
    pm2_5_ug_m3 double,
    pm10_ug_m3 double
);
CREATE TABLE wind (
    location_index int FOREIGN KEY REFERENCES locations(location_index),
    observation_time timestamp,
    level varchar(20),
    wind_speed_ms double,
    wind_direction_deg double,
    u_ms double,
    v_ms double
);
