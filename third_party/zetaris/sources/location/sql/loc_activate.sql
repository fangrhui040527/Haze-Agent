-- =============================================================================
-- Activate USL Location Dimensions: location_dim & location_code
--
-- Model: malaysia_env_usl
-- Namespace: lightning.metastore.malaysia_env
--
-- Tables:
--   1. location_dim  (PK: location_index [1 - 345])
--   2. location_code (PK: location_code, FK: location_index [440 unique codes])
-- =============================================================================

ACTIVATE USL TABLE lightning.metastore.malaysia_env.malaysia_env_usl.location_dim AS
SELECT
    COALESCE(CAST(location_index AS INT), 0) AS location_index,
    CAST(location_id AS VARCHAR(80)) AS location_id,
    CAST(location_name AS VARCHAR(200)) AS location_name,
    CAST(latitude AS DOUBLE) AS latitude,
    CAST(longitude AS DOUBLE) AS longitude
FROM LOCATION_REF_DATA.location_ref;

ACTIVATE USL TABLE lightning.metastore.malaysia_env.malaysia_env_usl.location_code AS
SELECT
    COALESCE(CAST(location_code AS VARCHAR(10)), '') AS location_code,
    COALESCE(CAST(location_index AS INT), 0) AS location_index,
    CAST(code_type AS VARCHAR(30)) AS code_type,
    CAST(code_name AS VARCHAR(200)) AS code_name
FROM LOCATION_REF_DATA.location_code_ref;
