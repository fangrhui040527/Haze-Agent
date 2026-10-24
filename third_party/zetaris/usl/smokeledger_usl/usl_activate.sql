-- Run each ACTIVATE statement separately after compiling the USL.
-- These activations copy the currently registered sl_pg tables into the USL.

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.towns AS
SELECT
    CAST(town AS VARCHAR(200)) AS town,
    CAST(district AS VARCHAR(200)) AS district,
    CAST(state AS VARCHAR(200)) AS state,
    CAST(lat AS DOUBLE) AS lat,
    CAST(lon AS DOUBLE) AS lon
FROM sl_pg.towns;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.fires AS
SELECT
    CAST(fire_id AS VARCHAR(64)) AS fire_id,
    CAST(lat AS DOUBLE) AS lat,
    CAST(lon AS DOUBLE) AS lon,
    CAST(acq_utc AS TIMESTAMP) AS acq_utc,
    CAST(frp AS DOUBLE) AS frp,
    CAST(confidence AS VARCHAR(20)) AS confidence,
    CAST(satellite AS VARCHAR(50)) AS satellite,
    CAST(daynight AS VARCHAR(10)) AS daynight,
    CAST(concession_id AS VARCHAR(200)) AS concession_id,
    CAST(on_peat AS BOOLEAN) AS on_peat,
    CAST(source_file AS VARCHAR(255)) AS source_file,
    CAST(ingested_utc AS TIMESTAMP) AS ingested_utc
FROM sl_pg.fires;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.wind AS
SELECT
    CAST(level AS VARCHAR(20)) AS level,
    CAST(lat AS DOUBLE) AS lat,
    CAST(lon AS DOUBLE) AS lon,
    CAST(valid_utc AS TIMESTAMP) AS valid_utc,
    CAST(u AS DOUBLE) AS u,
    CAST(v AS DOUBLE) AS v
FROM sl_pg.wind;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.pm25 AS
SELECT
    CAST(town AS VARCHAR(200)) AS town,
    CAST(valid_utc AS TIMESTAMP) AS valid_utc,
    CAST(kind AS VARCHAR(30)) AS kind,
    CAST(issued_utc AS TIMESTAMP) AS issued_utc,
    CAST(pm25 AS DOUBLE) AS pm25,
    CAST(`source` AS VARCHAR(100)) AS api_source,
    CAST(ingested_utc AS TIMESTAMP) AS ingested_utc
FROM sl_pg.pm25;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.concessions AS
SELECT
    CAST(concession_id AS VARCHAR(200)) AS concession_id,
    CAST(name AS VARCHAR(500)) AS name,
    CAST(company AS VARCHAR(500)) AS company,
    CAST(group_name AS VARCHAR(500)) AS group_name,
    CAST(ctype AS VARCHAR(100)) AS ctype,
    CAST(country AS VARCHAR(100)) AS country,
    CAST(area_ha AS DOUBLE) AS area_ha,
    CAST(map_source AS VARCHAR(255)) AS map_source,
    CAST(map_date AS VARCHAR(50)) AS map_date
FROM sl_pg.concessions;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.companies AS
SELECT
    CAST(group_name AS VARCHAR(500)) AS group_name,
    CAST(parent_country AS VARCHAR(100)) AS parent_country,
    CAST(rspo_member AS BOOLEAN) AS rspo_member,
    CAST(grievance_contact AS VARCHAR(500)) AS grievance_contact,
    CAST(known_buyers AS STRING) AS known_buyers,
    CAST(notes AS STRING) AS notes
FROM sl_pg.companies;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.runs AS
SELECT
    CAST(run_id AS VARCHAR(200)) AS run_id,
    CAST(kind AS VARCHAR(30)) AS kind,
    CAST(town AS VARCHAR(200)) AS town,
    CAST(center_utc AS TIMESTAMP) AS center_utc,
    CAST(params AS STRING) AS params,
    CAST(created_utc AS TIMESTAMP) AS created_utc
FROM sl_pg.runs;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.trajectory_points AS
SELECT
    CAST(run_id AS VARCHAR(200)) AS run_id,
    CAST(member AS INT) AS member,
    CAST(scale AS DOUBLE) AS scale,
    CAST(level AS VARCHAR(20)) AS level,
    CAST(release_utc AS TIMESTAMP) AS release_utc,
    CAST(step_utc AS TIMESTAMP) AS step_utc,
    CAST(lat AS DOUBLE) AS lat,
    CAST(lon AS DOUBLE) AS lon
FROM sl_pg.trajectory_points;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.attribution AS
SELECT
    CAST(run_id AS VARCHAR(200)) AS run_id,
    CAST(fire_id AS VARCHAR(64)) AS fire_id,
    CAST(scale AS DOUBLE) AS scale,
    CAST(weight AS DOUBLE) AS weight
FROM sl_pg.attribution;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.projections AS
SELECT
    CAST(run_id AS VARCHAR(200)) AS run_id,
    CAST(town AS VARCHAR(200)) AS town,
    CAST(valid_utc AS TIMESTAMP) AS valid_utc,
    CAST(pm25_hour AS DOUBLE) AS pm25_hour,
    CAST(pm25_24h AS DOUBLE) AS pm25_24h,
    CAST(api AS DOUBLE) AS api,
    CAST(p_close AS DOUBLE) AS p_close,
    CAST(smoke_index AS DOUBLE) AS smoke_index
FROM sl_pg.projections;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.cases AS
SELECT
    CAST(case_id AS VARCHAR(200)) AS case_id,
    CAST(concession_id AS VARCHAR(200)) AS concession_id,
    CAST(status AS VARCHAR(50)) AS status,
    CAST(opened_utc AS TIMESTAMP) AS opened_utc,
    CAST(notified_utc AS TIMESTAMP) AS notified_utc,
    CAST(recheck_due_utc AS TIMESTAMP) AS recheck_due_utc,
    CAST(escalated_utc AS TIMESTAMP) AS escalated_utc,
    CAST(closed_utc AS TIMESTAMP) AS closed_utc,
    CAST(draft_path AS VARCHAR(1000)) AS draft_path
FROM sl_pg.cases;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.case_events AS
SELECT
    CAST(case_id AS VARCHAR(200)) AS case_id,
    CAST(at_utc AS TIMESTAMP) AS at_utc,
    CAST(event AS VARCHAR(100)) AS event,
    CAST(detail AS STRING) AS detail,
    CAST(evidence_ids AS STRING) AS evidence_ids
FROM sl_pg.case_events;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.evidence AS
SELECT
    CAST(evidence_id AS VARCHAR(200)) AS evidence_id,
    CAST(backend AS VARCHAR(100)) AS backend,
    CAST(sql_text AS STRING) AS sql_text,
    CAST(executed_utc AS TIMESTAMP) AS executed_utc,
    CAST(row_count AS INT) AS row_count,
    CAST(sha256 AS VARCHAR(64)) AS sha256,
    CAST(rows_json AS STRING) AS rows_json
FROM sl_pg.evidence;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.guidance AS
SELECT
    CAST(guidance_id AS VARCHAR(200)) AS guidance_id,
    CAST(version AS VARCHAR(100)) AS version,
    CAST(band AS VARCHAR(100)) AS band,
    CAST(api_min AS DOUBLE) AS api_min,
    CAST(api_max AS DOUBLE) AS api_max,
    CAST(action AS VARCHAR(500)) AS action,
    CAST(heavy_work AS VARCHAR(50)) AS heavy_work,
    CAST(status AS VARCHAR(50)) AS status,
    CAST(`source` AS VARCHAR(1000)) AS guidance_source
FROM sl_pg.guidance;

ACTIVATE USL TABLE lightning.metastore.smokeledger.smokeledger_usl.agent_runs AS
SELECT
    CAST(run_id AS VARCHAR(200)) AS run_id,
    CAST(parent_run_id AS VARCHAR(200)) AS parent_run_id,
    CAST(decision_key AS VARCHAR(500)) AS decision_key,
    CAST(status AS VARCHAR(50)) AS status,
    CAST(mode AS VARCHAR(50)) AS mode,
    CAST(request AS STRING) AS request,
    CAST(response AS STRING) AS response,
    CAST(snapshot_id AS VARCHAR(200)) AS snapshot_id,
    CAST(watermark_utc AS TIMESTAMP) AS watermark_utc,
    CAST(validity_start AS TIMESTAMP) AS validity_start,
    CAST(validity_end AS TIMESTAMP) AS validity_end,
    CAST(conclusion_status AS VARCHAR(50)) AS conclusion_status,
    CAST(deadline_utc AS TIMESTAMP) AS deadline_utc,
    CAST(created_utc AS TIMESTAMP) AS created_utc,
    CAST(updated_utc AS TIMESTAMP) AS updated_utc
FROM sl_pg.agent_runs;
