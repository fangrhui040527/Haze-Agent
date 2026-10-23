-- =============================================================================
-- Query Verified USL Fact Table: air_quality_obs
-- =============================================================================

SELECT
    loc.location_index,
    loc.location_id,
    loc.location_name,
    aq.observation_time,
    aq.pm2_5_ug_m3,
    aq.pm10_ug_m3
FROM lightning.metastore.malaysia_env.malaysia_env_usl.air_quality_obs aq
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON aq.location_index = loc.location_index
WHERE loc.location_id = 'kuala-lumpur'
ORDER BY aq.observation_time DESC
LIMIT 10;
