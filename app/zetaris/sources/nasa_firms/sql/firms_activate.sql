-- =============================================================================
-- Activate USL Fact Table: active_fires
--
-- Model: malaysia_env_usl
-- Namespace: lightning.metastore.malaysia_env
-- Target Table: active_fires
--
-- Source: NASA_FIRMS_FILES.active_fires (NASA FIRMS VIIRS NRT CSV)
-- Joins with USL location_dim on region = location_name to attach canonical location_index FK.
-- =============================================================================

ACTIVATE USL TABLE lightning.metastore.malaysia_env.malaysia_env_usl.active_fires AS
SELECT
    loc.location_index AS location_index,
    CAST(f.acq_utc AS TIMESTAMP) AS acq_utc,
    CAST(f.acq_myt AS TIMESTAMP) AS acq_myt,
    CAST(f.latitude AS DOUBLE) AS fire_latitude,
    CAST(f.longitude AS DOUBLE) AS fire_longitude,
    CAST(f.bright_ti4 AS DOUBLE) AS bright_ti4,
    CAST(f.frp AS DOUBLE) AS frp,
    CAST(f.confidence AS VARCHAR(1)) AS confidence,
    CAST(f.satellite AS VARCHAR(50)) AS satellite,
    CAST(f.instrument AS VARCHAR(50)) AS instrument,
    CAST(f.source AS VARCHAR(30)) AS fire_source,
    CAST(f.daynight AS VARCHAR(1)) AS daynight
FROM NASA_FIRMS_FILES.active_fires f
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON f.region = loc.location_name;
