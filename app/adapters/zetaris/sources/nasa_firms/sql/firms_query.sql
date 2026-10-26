-- =============================================================================
-- Query Verified USL Fact Table: active_fires
-- =============================================================================

SELECT
    loc.location_index,
    loc.location_id,
    loc.location_name,
    f.acq_myt,
    f.fire_latitude,
    f.fire_longitude,
    f.bright_ti4,
    f.frp,
    f.confidence,
    f.satellite,
    f.fire_source,
    f.daynight
FROM lightning.metastore.malaysia_env.malaysia_env_usl.active_fires f
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON f.location_index = loc.location_index
ORDER BY f.acq_myt DESC
LIMIT 10;
