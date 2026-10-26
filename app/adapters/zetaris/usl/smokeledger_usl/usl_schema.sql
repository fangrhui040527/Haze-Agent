-- =============================================================================
-- USL: smokeledger_usl
-- Unified semantic model for the durable SmokeLedger evidence store.
--
-- Source: PostgreSQL datasource sl_pg, registered by
-- legacy/smokeledger/sql/02_zetaris_register.sql.
-- All 15 semantic tables mirror the SmokeLedger PostgreSQL schema.
-- =============================================================================

CREATE NAMESPACE IF NOT EXISTS lightning.metastore.smokeledger;

COMPILE USL IF NOT EXISTS smokeledger_usl DEPLOY NAMESPACE lightning.metastore.smokeledger DDL
CREATE TABLE towns (
    town varchar(200) NOT NULL PRIMARY KEY,
    district varchar(200),
    state varchar(200),
    lat double NOT NULL,
    lon double NOT NULL
);
CREATE TABLE fires (
    fire_id varchar(64) NOT NULL PRIMARY KEY,
    lat double NOT NULL,
    lon double NOT NULL,
    acq_utc timestamp NOT NULL,
    frp double NOT NULL,
    confidence varchar(20),
    satellite varchar(50),
    daynight varchar(10),
    concession_id varchar(200),
    on_peat boolean NOT NULL,
    source_file varchar(255),
    ingested_utc timestamp NOT NULL
);
CREATE TABLE wind (
    level varchar(20) NOT NULL,
    lat double NOT NULL,
    lon double NOT NULL,
    valid_utc timestamp NOT NULL,
    u double NOT NULL,
    v double NOT NULL,
    PRIMARY KEY (level, lat, lon, valid_utc)
);
CREATE TABLE pm25 (
    town varchar(200) NOT NULL FOREIGN KEY REFERENCES towns(town),
    valid_utc timestamp NOT NULL,
    kind varchar(30) NOT NULL,
    issued_utc timestamp,
    pm25 double NOT NULL,
    api_source varchar(100),
    ingested_utc timestamp NOT NULL
);
CREATE TABLE concessions (
    concession_id varchar(200) NOT NULL PRIMARY KEY,
    name varchar(500),
    company varchar(500),
    group_name varchar(500),
    ctype varchar(100),
    country varchar(100),
    area_ha double,
    map_source varchar(255),
    map_date varchar(50)
);
CREATE TABLE companies (
    group_name varchar(500) NOT NULL PRIMARY KEY,
    parent_country varchar(100),
    rspo_member boolean,
    grievance_contact varchar(500),
    known_buyers string,
    notes string
);
CREATE TABLE runs (
    run_id varchar(200) NOT NULL PRIMARY KEY,
    kind varchar(30) NOT NULL,
    town varchar(200) FOREIGN KEY REFERENCES towns(town),
    center_utc timestamp NOT NULL,
    params string NOT NULL,
    created_utc timestamp NOT NULL
);
CREATE TABLE trajectory_points (
    run_id varchar(200) NOT NULL FOREIGN KEY REFERENCES runs(run_id),
    member int NOT NULL,
    scale double NOT NULL,
    level varchar(20) NOT NULL,
    release_utc timestamp NOT NULL,
    step_utc timestamp NOT NULL,
    lat double NOT NULL,
    lon double NOT NULL
);
CREATE TABLE attribution (
    run_id varchar(200) NOT NULL FOREIGN KEY REFERENCES runs(run_id),
    fire_id varchar(64) NOT NULL FOREIGN KEY REFERENCES fires(fire_id),
    scale double NOT NULL,
    weight double NOT NULL,
    PRIMARY KEY (run_id, fire_id, scale)
);
CREATE TABLE projections (
    run_id varchar(200) NOT NULL FOREIGN KEY REFERENCES runs(run_id),
    town varchar(200) NOT NULL FOREIGN KEY REFERENCES towns(town),
    valid_utc timestamp NOT NULL,
    pm25_hour double,
    pm25_24h double,
    api double,
    p_close double,
    smoke_index double,
    PRIMARY KEY (run_id, town, valid_utc)
);
CREATE TABLE cases (
    case_id varchar(200) NOT NULL PRIMARY KEY,
    concession_id varchar(200) NOT NULL FOREIGN KEY REFERENCES concessions(concession_id),
    status varchar(50) NOT NULL,
    opened_utc timestamp NOT NULL,
    notified_utc timestamp,
    recheck_due_utc timestamp,
    escalated_utc timestamp,
    closed_utc timestamp,
    draft_path varchar(1000)
);
CREATE TABLE case_events (
    case_id varchar(200) NOT NULL FOREIGN KEY REFERENCES cases(case_id),
    at_utc timestamp NOT NULL,
    event varchar(100) NOT NULL,
    detail string,
    evidence_ids string
);
CREATE TABLE evidence (
    evidence_id varchar(200) NOT NULL PRIMARY KEY,
    backend varchar(100) NOT NULL,
    sql_text string NOT NULL,
    executed_utc timestamp NOT NULL,
    row_count int NOT NULL,
    sha256 varchar(64) NOT NULL,
    rows_json string NOT NULL
);
CREATE TABLE guidance (
    guidance_id varchar(200) NOT NULL,
    version varchar(100) NOT NULL,
    band varchar(100) NOT NULL,
    api_min double NOT NULL,
    api_max double NOT NULL,
    action varchar(500) NOT NULL,
    heavy_work varchar(50) NOT NULL,
    status varchar(50) NOT NULL,
    guidance_source varchar(1000) NOT NULL,
    PRIMARY KEY (guidance_id, version, band)
);
CREATE TABLE agent_runs (
    run_id varchar(200) NOT NULL PRIMARY KEY,
    parent_run_id varchar(200),
    decision_key varchar(500) NOT NULL,
    status varchar(50) NOT NULL,
    mode varchar(50) NOT NULL,
    request string NOT NULL,
    response string,
    snapshot_id varchar(200),
    watermark_utc timestamp,
    validity_start timestamp,
    validity_end timestamp,
    conclusion_status varchar(50),
    deadline_utc timestamp NOT NULL,
    created_utc timestamp NOT NULL,
    updated_utc timestamp NOT NULL
);
