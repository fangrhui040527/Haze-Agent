-- =============================================================================
-- Query Verified USL Dimension Tables: location_dim & location_code
-- =============================================================================

SELECT
    loc.location_index,
    loc.location_id,
    loc.location_name,
    loc.latitude,
    loc.longitude,
    lc.location_code,
    lc.code_type,
    lc.code_name
FROM lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_code lc
  ON loc.location_index = lc.location_index
WHERE loc.location_id = 'kuala-lumpur'
ORDER BY lc.location_code;
